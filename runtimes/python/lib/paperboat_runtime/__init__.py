"""paperboat-runtime/0 for Python: a session (a live namespace) or a station (domain objects).

Stdlib only, so it runs in any CPython 3.10+ image with no network. The spec is docs/runtime.md in the
paperboat repository. Station files register their types:

    import paperboat_runtime as pb

    class Gain:
        def __init__(self, k=1.0): self.k = k
        def step(self, u): return [self.k * x for x in u]

    pb.register("gain", Gain, definition={"inputs": ["u"], "outputs": ["y"]})
"""

from __future__ import annotations

import ast
import ctypes
import io
import json
import mmap
import os
import platform
import queue
import rlcompleter
import signal
import site
import socket
import struct
import sys
import warnings
import threading
import traceback

PROTOCOL = "paperboat-runtime/0"
_LEN = struct.Struct("<I")

# --- station registry -------------------------------------------------------------------------

_types: dict[str, tuple[object, dict]] = {}


def register(name: str, constructor, definition: dict | None = None) -> None:
    """Make `constructor` available to `new` as `name`; `definition` is passed through to the client."""
    _types[name] = (constructor, dict(definition or {}))


_calling = threading.local()  # the connection whose request this thread runs


def log(text: str, level: str = "info") -> None:
    """A line for the client (Simplicial's Console) from station code, while it answers a request."""
    conn = getattr(_calling, "conn", None)
    if conn:
        conn.send({"type": "log", "level": level, "text": str(text)})
    else:
        print(text, file=sys.stderr)


# --- framing ----------------------------------------------------------------------------------


class Connection:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.write_lock = threading.Lock()

    def send(self, msg: dict) -> bool:
        data = json.dumps(msg, default=_jsonable, separators=(",", ":")).encode()
        try:
            with self.write_lock:
                self.sock.sendall(_LEN.pack(len(data)) + data)
            return True
        except OSError:
            return False

    def recv(self):
        head = self._exact(4)
        if head is None:
            return None
        body = self._exact(_LEN.unpack(head)[0])
        return None if body is None else json.loads(body)

    def _exact(self, n: int):
        buf = bytearray()
        while len(buf) < n:
            try:
                chunk = self.sock.recv(n - len(buf))
            except OSError:
                return None
            if not chunk:
                return None
            buf += chunk
        return bytes(buf)


def _jsonable(x):
    if hasattr(x, "tolist"):
        return x.tolist()
    if isinstance(x, (set, tuple)):
        return list(x)
    return repr(x)


def _error(e: BaseException) -> dict:
    return {"type": type(e).__name__, "message": str(e), "traceback": "".join(traceback.format_exception(e))}


# --- session ----------------------------------------------------------------------------------


class _Stream(io.TextIOBase):
    """sys.stdout/stderr during an eval: every write becomes a stream notification."""

    def __init__(self, name: str):
        self.name = name
        self.target: tuple[Connection, object] | None = None

    def writable(self):
        return True

    def write(self, text):
        if self.target and text:
            conn, rid = self.target
            conn.send({"type": "stream", "id": rid, "name": self.name, "text": text})
        return len(text)


def _mime(value) -> dict | None:
    if value is None:
        return None
    data = {"text/plain": repr(value)}
    for attr, mime in (("_repr_html_", "text/html"), ("_repr_svg_", "image/svg+xml"), ("_repr_png_", "image/png")):
        f = getattr(value, attr, None)
        if callable(f):
            try:
                out = f()
            except Exception:
                continue
            if out is None:
                continue
            if isinstance(out, bytes):
                import base64

                out = base64.b64encode(out).decode()
            data[mime] = out
    return data


def lint(code: str) -> dict:
    """Problems in a piece of code, from Python's own compiler: a syntax error, and its warnings (an invalid
    escape, `is` with a literal). Byte offsets, like `complete`. Only compiling, no namespace: it answers at
    once, even while a cell runs."""
    lines = code.splitlines(keepends=True)

    def at(line, col):  # 1-based line, 1-based character column -> byte offset
        if not line:
            return 0
        before = "".join(lines[: line - 1])
        return len(before.encode()) + len((lines[line - 1] if line <= len(lines) else "")[: max(0, (col or 1) - 1)].encode())

    problems = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            compile(code, "<cell>", "exec")
        except SyntaxError as e:
            start = at(e.lineno, e.offset)
            end = at(e.end_lineno, e.end_offset) if getattr(e, "end_lineno", None) else start
            problems.append({"from": start, "to": max(end, start), "severity": "error", "message": e.msg})
    for w in caught:
        if issubclass(w.category, SyntaxWarning):
            start = at(w.lineno, 1)
            problems.append({"from": start, "to": start + len((lines[w.lineno - 1] if w.lineno <= len(lines) else "").rstrip("\n").encode()),
                             "severity": "warning", "message": str(w.message)})
    return {"problems": problems}


class Session:
    """One namespace per process; evals run on the main thread so SIGINT can interrupt them."""

    def __init__(self):
        self.jobs: queue.Queue = queue.Queue()
        self.running = False
        self.stdout, self.stderr = _Stream("stdout"), _Stream("stderr")
        self.reset()

    def reset(self):
        self.ns = {"__name__": "__main__", "__builtins__": __builtins__}
        self.ns["display"] = self._display
        self.target = None

    def _display(self, value):
        if self.target:
            conn, rid = self.target
            conn.send({"type": "display", "id": rid, "data": _mime(value)})

    def eval(self, code: str, cell: str, conn: Connection, rid):
        tree = ast.parse(code, filename=cell, mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        self.target = (conn, rid)
        self.stdout.target = self.stderr.target = self.target
        saved = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = self.stdout, self.stderr
        try:
            exec(compile(tree, cell, "exec"), self.ns)
            value = eval(compile(last, cell, "eval"), self.ns) if last else None
        finally:
            sys.stdout, sys.stderr = saved
            self.stdout.target = self.stderr.target = self.target = None
        if value is not None:
            self.ns["_"] = value
        return {"data": _mime(value)}

    def complete(self, code: str, pos: int):
        text = code.encode()[:pos].decode(errors="ignore")
        start = len(text)
        while start > 0 and (text[start - 1].isalnum() or text[start - 1] in "_."):
            start -= 1
        word = text[start:]
        c = rlcompleter.Completer(self.ns)
        matches, i = [], 0
        while True:
            m = c.complete(word, i)
            if m is None or i > 500:
                break
            matches.append(m.rstrip("("))
            i += 1
        # byte offsets, as the request gave
        return {"matches": sorted(set(matches)), "start": len(text[:start].encode()), "end": pos}

    def variables(self):
        out = []
        for name, v in self.ns.items():
            if name.startswith("_") or name == "display" or type(v).__name__ in ("module", "function", "builtin_function_or_method", "type"):
                continue
            item = {"name": name, "type": type(v).__name__, "summary": repr(v)[:120]}
            try:
                item["size"] = len(v)
            except Exception:
                pass
            out.append(item)
        return out

    def interrupt(self) -> bool:
        if not self.running:
            return False
        os.kill(os.getpid(), signal.SIGINT)
        return True

    def main_loop(self):
        """The main thread: run eval jobs one at a time."""
        while True:
            try:
                job = self.jobs.get()
            except KeyboardInterrupt:  # an interrupt that arrived just after its eval ended
                continue
            if job is None:
                return
            conn, rid, fn = job
            self.running = True
            try:
                result = fn()
                reply = {"id": rid, "ok": True, "result": result}
            except KeyboardInterrupt as e:
                reply = {"id": rid, "ok": False, "error": {"type": "InterruptException", "message": "interrupted", "traceback": ""}}
            except BaseException as e:  # a cell may raise anything, SystemExit included
                reply = {"id": rid, "ok": False, "error": _error(e)}
            finally:
                self.running = False
            conn.send(reply)


# --- station ----------------------------------------------------------------------------------

_SYS_FUTEX = {"x86_64": 202, "aarch64": 98, "arm64": 98}.get(platform.machine(), 202)
_libc = ctypes.CDLL(None, use_errno=True)


def _futex(addr, op, val, timeout_ns=None):
    ts = None
    if timeout_ns is not None:
        ts = (ctypes.c_long * 2)(timeout_ns // 1_000_000_000, timeout_ns % 1_000_000_000)
    _libc.syscall(_SYS_FUTEX, addr, op, val, ts, None, 0)


class FastChannel(threading.Thread):
    """The shared-memory data plane of one connection (docs/runtime.md)."""

    def __init__(self, path: str, capacity: int, station: "Station", conn: Connection):
        super().__init__(daemon=True)
        self.slot = (64 + 8 * capacity + 63) // 64 * 64
        self.capacity = capacity
        fd = os.open(path, os.O_RDWR)
        self.mm = mmap.mmap(fd, 2 * self.slot)
        os.close(fd)
        base = ctypes.addressof(ctypes.c_char.from_buffer(self.mm))
        self.req_seq = ctypes.c_uint32.from_address(base)
        self.req_handle = ctypes.c_uint32.from_address(base + 4)
        self.req_n = ctypes.c_uint32.from_address(base + 8)
        self.req_vals = (ctypes.c_double * capacity).from_address(base + 64)
        self.rep_seq = ctypes.c_uint32.from_address(base + self.slot)
        self.rep_status = ctypes.c_uint32.from_address(base + self.slot + 4)
        self.rep_n = ctypes.c_uint32.from_address(base + self.slot + 8)
        self.rep_vals = (ctypes.c_double * capacity).from_address(base + self.slot + 64)
        self.station, self.conn = station, conn

    def run(self):
        seen = self.req_seq.value
        while True:
            spins = 0
            while self.req_seq.value == seen:
                spins += 1
                if spins > 200:
                    _futex(ctypes.byref(self.req_seq), 0, seen, 100_000_000)  # FUTEX_WAIT, wakes to recheck
            seen = self.req_seq.value
            if seen == 0xFFFFFFFF:
                return
            handle, n = self.req_handle.value, self.req_n.value
            try:
                obj, method = self.station.bound[handle]
                out = method(list(self.req_vals[:n]))
                out = out.tolist() if hasattr(out, "tolist") else list(out)
                if len(out) > self.capacity:
                    raise ValueError(f"{len(out)} outputs exceed the channel's capacity {self.capacity}")
                self.rep_vals[: len(out)] = [float(x) for x in out]
                self.rep_n.value, self.rep_status.value = len(out), 0
            except Exception as e:
                self.rep_n.value, self.rep_status.value = 0, 1
                self.conn.send({"type": "fast_error", "handle": handle, "message": f"{type(e).__name__}: {e}"})
            self.rep_seq.value = seen
            _futex(ctypes.byref(self.rep_seq), 1, 1)  # FUTEX_WAKE


class Station:
    """The objects of one connection."""

    def __init__(self, conn: Connection):
        self.conn = conn
        self.instances: dict[int, object] = {}
        self.bound: dict[int, tuple[object, object]] = {}
        self.next = 0
        self.channel: FastChannel | None = None

    def load(self, path: str):
        import runpy

        full = path if os.path.isabs(path) else os.path.join(os.environ.get("PAPERBOAT_PROJECT", os.getcwd()), path)
        folder = os.path.dirname(os.path.abspath(full))
        if folder not in sys.path:
            sys.path.insert(0, folder)  # the file imports the station's other modules
        runpy.run_path(full, run_name="__paperboat_station__")
        return {"types": [{"name": n, "definition": d} for n, (_, d) in _types.items()]}

    def new(self, type_: str, params: dict):
        if type_ not in _types:
            raise KeyError(f"no station type {type_!r} (registered: {', '.join(sorted(_types)) or 'none'})")
        self.next += 1
        self.instances[self.next] = _types[type_][0](**(params or {}))
        return {"instance": self.next}

    def call(self, instance: int, method: str, args: list):
        return getattr(self.instances[instance], method)(*(args or []))

    def drop(self, instance: int):
        self.instances.pop(instance, None)
        self.bound = {h: b for h, b in self.bound.items() if b[0] is not instance}
        return {}

    def shm(self, path: str, capacity: int):
        if self.channel:
            raise RuntimeError("this connection already has a shared-memory channel")
        ipc = os.environ.get("PAPERBOAT_IPC", "")
        full = path if os.path.isabs(path) else os.path.join(ipc, path)
        self.channel = FastChannel(full, int(capacity), self, self.conn)
        self.channel.start()
        return {}

    def bind(self, instance: int, method: str):
        obj = self.instances[instance]
        self.next += 1
        self.bound[self.next] = (obj, getattr(obj, method))
        return {"handle": self.next}


# --- server -----------------------------------------------------------------------------------


def _hello(mode: str) -> dict:
    return {
        "type": "hello",
        "protocol": PROTOCOL,
        "mode": mode,
        "runtime": {"name": "python", "version": platform.python_version()},
        "pid": os.getpid(),
        "transports": ["shm", "uds"],
        "ops": ["ping", "interrupt", "shutdown"]
        + ["lint"] + (["eval", "complete", "variables", "reset"] if mode == "session" else ["load", "new", "call", "drop", "shm", "bind"]),
    }


def _serve_connection(sock: socket.socket, mode: str, session: Session | None, stop: threading.Event):
    conn = Connection(sock)
    station = Station(conn) if mode == "station" else None
    _calling.conn = conn  # station requests run on this thread: log() answers here
    conn.send(_hello(mode))
    while True:
        msg = conn.recv()
        if msg is None:
            break
        rid, op, args = msg.get("id"), msg.get("op"), msg.get("args") or {}

        def reply(result=None, error=None):
            conn.send({"id": rid, "ok": error is None, **({"result": result} if error is None else {"error": error})})

        try:
            if op == "ping":
                reply({})
            elif op == "interrupt":
                reply({"interrupted": session.interrupt() if session else False})
            elif op == "shutdown":
                reply({})
                stop.set()
                if session:
                    session.jobs.put(None)
                break
            elif op == "lint":
                reply(lint(args["code"]))
            elif session and op == "eval":
                session.jobs.put((conn, rid, lambda a=args: session.eval(a["code"], a.get("cell", "<cell>"), conn, rid)))
            elif session and op in ("complete", "variables", "reset"):
                session.jobs.put((conn, rid, {
                    "complete": lambda a=args: session.complete(a["code"], int(a["pos"])),
                    "variables": session.variables,
                    "reset": lambda: (session.reset(), {})[1],
                }[op]))
            elif station and op == "load":
                reply(station.load(args["path"]))
            elif station and op == "new":
                reply(station.new(args["type"], args.get("params", {})))
            elif station and op == "call":
                reply(station.call(int(args["instance"]), args["method"], args.get("args", [])))
            elif station and op == "drop":
                reply(station.drop(int(args["instance"])))
            elif station and op == "shm":
                reply(station.shm(args["path"], args["capacity"]))
            elif station and op == "bind":
                reply(station.bind(int(args["instance"]), args["method"]))
            else:
                reply(error={"type": "UnknownOp", "message": f"no op {op!r} in {mode} mode", "traceback": ""})
        except Exception as e:
            reply(error=_error(e))
    if station and station.channel:
        station.channel = None  # its thread is a daemon; the client closes it with seq = 0xFFFFFFFF
    sock.close()


def _add_package_volume() -> None:
    """Put the project's package volume ($PAPERBOAT_DEPS/venv, where `paperboat package add python`
    installs) on sys.path, so session and station code imports what was added. Only the venv made
    for this interpreter's version counts: another version's wheels would not load."""
    deps = os.environ.get("PAPERBOAT_DEPS")
    if not deps:
        return
    venv = os.path.join(deps, "venv")
    for sp in (os.path.join(venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages"),
               os.path.join(venv, "Lib", "site-packages")):  # the Windows layout
        if os.path.isdir(sp) and sp not in sys.path:
            site.addsitedir(sp)  # also runs its .pth files (editable installs, namespace packages)
            return


def serve(path: str, mode: str) -> None:
    """Listen on `path` and serve until a client sends `shutdown` (or the container stops)."""
    _add_package_volume()
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path + ".tmp")
    os.rename(path + ".tmp", path)  # appears only when it can be connected to
    server.listen(16)
    stop = threading.Event()
    session = Session() if mode == "session" else None

    def accept():
        while not stop.is_set():
            try:
                s, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=_serve_connection, args=(s, mode, session, stop), daemon=True).start()

    if session:
        threading.Thread(target=accept, daemon=True).start()
        signal.signal(signal.SIGINT, signal.default_int_handler)  # an interrupt is a KeyboardInterrupt in the eval
        session.main_loop()
    else:
        threading.Thread(target=accept, daemon=True).start()
        stop.wait()
    server.close()
