# paperboat-control/0

The API of `paperboatd`. One JSON object per line over a Unix socket
(`$PAPERBOAT_RUNTIME_DIR`, else `$XDG_RUNTIME_DIR/paperboat`, else `<tmp>/paperboat-<uid>`, then
`/control.sock`; mode 0600).

```text
request   {"id": 1, "op": "acquire", "args": {...}}
response  {"id": 1, "ok": true, "result": {...}}   |   {"id": 1, "ok": false, "error": "message"}
event     {"event": "runtime.started", ...}         (after "subscribe"; pull progress always)
```

A lease belongs to the connection that acquired it: closing the connection releases it.

## Operations

| op | args | result |
| --- | --- | --- |
| `hello` | – | `protocol`, `version`, `daemon` (`<boot id>:<pid>`), `pid`, `backends` |
| `backends` | – | `[{name, available, detail, rootless, selinux}]` |
| `runtimes.list` | – | `{runtimes: [manifest + backends.<name>.{usable, ready}], errors, backends}` |
| `pull` | `runtime`, `backend?` | `{runtime, backend, image}`; `pull.progress` events meanwhile |
| `acquire` | `runtime`, `mode` (`station`\|`session`\|`exec`), `command?` (exec), `project?`, `work?`, `policy?`, `backend?`, `owner?`, `allow_unpinned?`, `allow_unverified?` | a lease |
| `release` | `lease` | `{}` |
| `ps` | – | `[lease]` |
| `stats` | `lease` | `{lease, stats: {cpu_percent, memory_bytes, pids}}` (−1 = unavailable) |
| `interrupt` | `lease` | `{delivered}`: SIGINT to the runtime process (podman/docker `kill`, or `kill(2)` natively) |
| `logs` | `lease`, `tail?` | `{text}`; an ended lease keeps its last output |
| `prune` | `dry_run?` | `{removed: [{path, project}], dry_run}` |
| `subscribe` | – | `{}`; this connection now receives every event |
| `shutdown` | – | `{}`; the daemon stops every instance and exits |

A **lease**: `id`, `runtime`, `mode`, `owner`, `backend`, `state` (`starting`, `running`, `idle`,
`exited`, `failed`), `error`, `instance`, `project`, `work`, `deps`, `ipc` (the host folder mounted at
the manifest's `mounts.ipc`; the runtime listens there on `runtime.sock`), `digest`, `verified`
(`signature`, `unsigned`, `skipped`, `native`), `isolation` (the flags in effect), `policy`, `weakened`,
`holders`, `uptime_s`, `idle_s`. `digest`, `isolation` and the runtime id are what a run record keeps.

A **policy** (only ever weakens the defaults): `network`, `devices` (`["/dev/video0"]`), `gpu`,
`ipc_host`, `writable_project`.

## Events

`lease.acquired` (`reused`), `lease.released`, `runtime.pulling`, `runtime.pulled`,
`runtime.pull_failed`, `runtime.started`, `runtime.stopped` (`reason`: released, idle, daemon
stopping), `runtime.exited` (`exit_code`, `state`, `error`), `runtime.failed` (a start that failed),
`runtime.reaped`, `runtime.verified`, `runtime.unverified` (`reason`), `policy.weakened` (`what`).

## Runtime manifests

`runtime.toml` (or `<name>.runtime.toml`) in a catalog folder: the shipped `share/paperboat/runtimes`,
`$PAPERBOAT_HOME/runtimes`, `$PAPERBOAT_RUNTIMES_PATH`, and `paperboatd --runtimes DIR`.

```toml
name     = "julia"                 # lowercase, digits, '-'
version  = "1.11.9"
protocol = "paperboat-runtime/0"
modes    = ["station", "session", "exec"]

[image]
ref    = "ghcr.io/paperboatlab/paperboat-runtime-julia:1.11.6-r1"
digest = "sha256:…"                # the multi-arch index; what runs
arch   = ["amd64", "arm64"]
signer = "^https://github.com/paperboatlab/paperboat/"   # optional: cosign keyless identity (regexp)
issuer = "https://token.actions.githubusercontent.com"   # the default

[entry]                            # argv per mode; exec takes the caller's command
station = ["julia", "--startup-file=no", "--threads=2", "{lib}/serve.jl", "{ipc}/runtime.sock", "station"]

[mounts]                           # defaults shown
project = "/work/project"
deps    = "/work/deps"
work    = "/work/out"
ipc     = "/run/pb"

[env]
JULIA_DEPOT_PATH = "/work/deps:"

[limits]
memory = "4g"
cpus   = 2
pids   = 512

[capabilities]
transports    = ["shm", "uds", "stdio"]
granularities = ["step", "segment", "subgraph", "block"]

[native]                           # the native backend's recipe
requires = "julia"
entry.station = ["julia", "--startup-file=no", "--threads=2", "{lib}/serve.jl", "{ipc}/runtime.sock", "station"]

[healthcheck]
hello_timeout = "60s"
```

Placeholders in `entry`: `{ipc}`, `{project}`, `{deps}`, `{work}`, `{lib}` (container paths; host
paths for native), `{lease}` (the instance name), `{runtime}` (native: the manifest's folder).
`<manifest folder>/lib/`, when present, is the runtime library: copied by the daemon and mounted
read-only at `mounts.lib` (default `/opt/pb`). The runtime gets `PAPERBOAT_IPC`, `PAPERBOAT_MODE`,
`PAPERBOAT_DEPS` (the project's package volume) and, with a project, `PAPERBOAT_PROJECT`.
