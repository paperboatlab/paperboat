# paperboat-runtime/0

Between an app (the client) and a runtime process (Julia, Python, …) started by `paperboatd`. The
runtime **listens** on `$PAPERBOAT_IPC/runtime.sock` (in a container `/run/pb/runtime.sock`; on the
host, the lease's `ipc` folder); the client connects once the lease is running, retrying until the
manifest's `hello_timeout`. A runtime serves any number of connections, one after another or at once
(a warm station runtime is shared by its lease's holders).

Two modes, one library per language:

- **session**: a live namespace (Malachite notebooks, Julix). Shared by every connection to the
  process, so a client that reconnects finds its variables. Never pooled, never shared between leases.
- **station**: domain objects (Simplicial blocks). Each connection has its own objects.

## Control plane

Frames on the socket: `[u32 little-endian length][UTF-8 JSON]`. Each side may send at any time.

```text
runtime → client, first:  {"type":"hello","protocol":"paperboat-runtime/0","mode":"session",
                           "runtime":{"name":"julia","version":"1.11.9"},"pid":7,
                           "transports":["shm","uds"],"ops":[...]}
request                   {"id":1,"op":"eval","args":{...}}
reply                     {"id":1,"ok":true,"result":...}
                          {"id":1,"ok":false,"error":{"type":"UndefVarError","message":"...","traceback":"..."}}
notification              {"type":"stream","id":1,"name":"stdout","text":"..."}
                          {"type":"display","id":1,"data":{"text/plain":"...","image/png":"<base64>"}}
                          {"type":"log","level":"warn","text":"..."}
```

Requests on one connection run in order. To stop a running cell, a client asks the daemon:
`interrupt {lease}` on paperboat-control/0 sends SIGINT to the runtime process, which works however busy
the runtime is (Julia services its sockets only between steps of the code it runs, so a message could
wait behind a busy cell; IJulia and Jupyter interrupt the same way). The `interrupt` op here is the
best-effort fallback for a client without the daemon. Either way the interrupt lands at the code's
next safepoint: Python between bytecodes (and in blocking calls), Julia when the code allocates, yields
or does I/O. A Julia loop that does none of these cannot be interrupted (a Julia limitation, true of
its own REPL too); a client that sees no reply soon after an interrupt restarts the session (release
the lease, acquire a new one).

### Every mode

| op | args | result |
| --- | --- | --- |
| `ping` | – | `{}` |
| `interrupt` | – | `{"interrupted": bool}`; prefer the daemon's `interrupt` (above) |
| `shutdown` | – | `{}`, then the process exits |

### Session

| op | args | result |
| --- | --- | --- |
| `eval` | `code`, `cell?` (a label for tracebacks) | `{"data": {mime: text}}` or `{"data": null}` (no value / `nothing` / `None`); output arrives as `stream` and `display` notifications |
| `complete` | `code`, `pos` (byte offset) | `{"matches": [...], "start": n, "end": n}` |
| `variables` | – | `[{"name", "type", "summary", "size"?}]` |
| `reset` | – | `{}`: a fresh namespace |

`data` always has `text/plain`; it adds `text/html`, `image/png` (base64) or `image/svg+xml` when the
value can show itself that way (Julia `showable`; Python `_repr_html_`, `_repr_png_`, `_repr_svg_`).

### Station

| op | args | result |
| --- | --- | --- |
| `load` | `path` (a file, relative to the project) | `{"types": [{"name", "definition"}]}`: every type it registered |
| `new` | `type`, `params` (object) | `{"instance": n}` |
| `call` | `instance`, `method`, `args` (array) | the method's return value |
| `drop` | `instance` | `{}` |
| `shm` | `path` (a file in the lease's ipc folder, made by the client), `capacity` (doubles per slot) | `{}`: the fast path is open |
| `bind` | `instance`, `method` | `{"handle": n}` |

A station file registers its types: Julia `PaperboatRuntime.register("gain", Gain; definition=...)`,
Python `paperboat_runtime.register("gain", Gain, definition=...)`. `new` calls the constructor with the
params as keywords; `call` calls `method(instance, args...)` (Julia) or `instance.method(*args)`
(Python).

## Data plane: shared memory

For hot loops (a block's `step`, a model's `derivatives`), a bound method is called through a mapped
file instead of the socket. The client creates `<ipc>/<name>.shm` of `2 × slot` bytes,
`slot = 64 + 8 × capacity` rounded up to 64, sends `shm`, then `bind`.

```text
request slot (offset 0)        reply slot (offset slot)
  0  u32 seq                     0  u32 seq   (= the request's)
  4  u32 handle                  4  u32 status (0 ok, 1 error: the message follows as a
  8  u32 n                                      {"type":"fast_error","handle","message"} frame)
 64  f64[n] inputs               8  u32 n
                                64  f64[n] outputs
```

The client writes the inputs, then `seq` (release); the runtime waits for `seq` to change (a short
spin, then `FUTEX_WAIT` on the shared word), calls the method with a `Vector{Float64}` / `list[float]`
and answers in the reply slot the same way. `seq = 0xFFFFFFFF` closes the channel. Little-endian,
x86-64 and arm64. Measured: ~7 µs a call across a container with futex wake, ~1 µs spinning (RFC §3).
