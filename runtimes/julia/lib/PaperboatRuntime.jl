# paperboat-runtime/0 for Julia: a session (a live namespace) or a station (domain objects).
#
# Stdlib only (Sockets, Mmap, Base64, REPL), so it runs in the official Julia image with no network and
# needs no precompilation. The spec is docs/runtime.md in the paperboat repository. Station files call
#
#     struct Gain; k::Float64; end
#     Gain(; k = 1.0) = Gain(k)
#     step(g::Gain, u) = g.k .* u
#     PaperboatRuntime.register("gain", Gain; definition = Dict("inputs" => ["u"], "outputs" => ["y"]))
#
# Session evals run on the root task, where SIGINT is sent (the daemon's `interrupt`). I/O tasks are
# @async on the same thread: Julia runs its event loop only on thread 1, so sockets are serviced
# whenever a cell yields, prints or ends. Station calls run on the default pool (--threads=2).
module PaperboatRuntime

using Sockets, Mmap, Base64
import REPL

export register

const PROTOCOL = "paperboat-runtime/0"

# --- JSON (just enough: objects, arrays, strings, numbers, booleans, null) ---

module JSON

function write_json(io::IO, x)
    if x === nothing || x === missing
        print(io, "null")
    elseif x isa Bool
        print(io, x ? "true" : "false")
    elseif x isa Integer
        print(io, x)
    elseif x isa AbstractFloat
        isfinite(x) ? print(io, Float64(x)) : print(io, "null")
    elseif x isa AbstractString || x isa Symbol
        write_string(io, string(x))
    elseif x isa AbstractDict
        print(io, '{')
        first = true
        for (k, v) in x
            first || print(io, ',')
            first = false
            write_string(io, string(k))
            print(io, ':')
            write_json(io, v)
        end
        print(io, '}')
    elseif x isa Union{AbstractArray,Tuple}
        print(io, '[')
        for (i, v) in enumerate(x)
            i > 1 && print(io, ',')
            write_json(io, v)
        end
        print(io, ']')
    elseif x isa NamedTuple
        write_json(io, Dict(string(k) => v for (k, v) in pairs(x)))
    else
        write_string(io, repr(x))
    end
end

function write_string(io::IO, s::String)
    print(io, '"')
    for c in s
        if c == '"'
            print(io, "\\\"")
        elseif c == '\\'
            print(io, "\\\\")
        elseif c == '\n'
            print(io, "\\n")
        elseif c == '\r'
            print(io, "\\r")
        elseif c == '\t'
            print(io, "\\t")
        elseif c < ' '
            print(io, "\\u", string(UInt16(c); base = 16, pad = 4))
        else
            print(io, c)
        end
    end
    print(io, '"')
end

json(x) = sprint(write_json, x)

mutable struct Parser
    s::String
    i::Int
end

function skipws(p::Parser)
    while p.i <= ncodeunits(p.s) && codeunit(p.s, p.i) in (0x20, 0x09, 0x0a, 0x0d)
        p.i += 1
    end
end

peekc(p::Parser) = p.i <= ncodeunits(p.s) ? Char(codeunit(p.s, p.i)) : '\0'

function expect(p::Parser, word::String)
    ncodeunits(p.s) >= p.i + ncodeunits(word) - 1 && p.s[p.i:p.i+ncodeunits(word)-1] == word || error("bad JSON at $(p.i)")
    p.i += ncodeunits(word)
end

function value(p::Parser)
    skipws(p)
    c = peekc(p)
    if c == '{'
        p.i += 1
        d = Dict{String,Any}()
        skipws(p)
        peekc(p) == '}' && (p.i += 1; return d)
        while true
            skipws(p)
            k = str(p)
            skipws(p)
            peekc(p) == ':' || error("bad JSON at $(p.i)")
            p.i += 1
            d[k] = value(p)
            skipws(p)
            c = peekc(p)
            p.i += 1
            c == '}' && return d
            c == ',' || error("bad JSON at $(p.i)")
        end
    elseif c == '['
        p.i += 1
        a = Any[]
        skipws(p)
        peekc(p) == ']' && (p.i += 1; return a)
        while true
            push!(a, value(p))
            skipws(p)
            c = peekc(p)
            p.i += 1
            c == ']' && return a
            c == ',' || error("bad JSON at $(p.i)")
        end
    elseif c == '"'
        return str(p)
    elseif c == 't'
        expect(p, "true"); return true
    elseif c == 'f'
        expect(p, "false"); return false
    elseif c == 'n'
        expect(p, "null"); return nothing
    else
        start = p.i
        while p.i <= ncodeunits(p.s) && peekc(p) in "+-0123456789.eE"
            p.i += 1
        end
        t = p.s[start:p.i-1]
        return something(tryparse(Int, t), parse(Float64, t))
    end
end

function str(p::Parser)
    peekc(p) == '"' || error("bad JSON string at $(p.i)")
    p.i += 1
    io = IOBuffer()
    while true
        b = codeunit(p.s, p.i)
        if b == UInt8('"')
            p.i += 1
            return String(take!(io))
        elseif b == UInt8('\\')
            e = Char(codeunit(p.s, p.i + 1))
            p.i += 2
            if e == 'u'
                u = parse(UInt16, p.s[p.i:p.i+3]; base = 16)
                p.i += 4
                if 0xd800 <= u < 0xdc00 && peekc(p) == '\\'  # a surrogate pair
                    lo = parse(UInt16, p.s[p.i+2:p.i+5]; base = 16)
                    p.i += 6
                    print(io, Char(0x10000 + ((UInt32(u) - 0xd800) << 10) + (lo - 0xdc00)))
                else
                    print(io, Char(u))
                end
            else
                print(io, e == 'n' ? '\n' : e == 't' ? '\t' : e == 'r' ? '\r' : e == 'b' ? '\b' : e == 'f' ? '\f' : e)
            end
        else
            write(io, b)
            p.i += 1
        end
    end
end

parse_json(s::AbstractString) = value(Parser(String(s), 1))

end  # module JSON

# --- framing ---

mutable struct Connection
    io::IO
    lock::ReentrantLock
end

# SIGINT throws an InterruptException in whatever task thread 1 is in, and while a cell waits (sleep, I/O)
# that is one of these I/O tasks, not the root task where the cell runs. They pass it on to the root task
# (a waiting task woken with the exception), so the cell stops and the connection lives.
const ROOT = Ref{Union{Task,Nothing}}(nothing)  # the root task in session mode; a station has no cell to stop

function forward_interrupt()
    r = ROOT[]
    r === nothing || r === current_task() || istaskdone(r) || schedule(r, InterruptException(); error = true)
end

"""f(), again after an interrupt meant for the cell (forwarded to it): for a wait that consumed nothing."""
function uninterrupted(f)
    while true
        try
            return f()
        catch e
            e isa InterruptException || rethrow()
            forward_interrupt()
        end
    end
end

function send(c::Connection, msg)
    data = Vector{UInt8}(JSON.json(msg))
    uninterrupted(() -> lock(c.lock))
    try
        write(c.io, htol(UInt32(length(data))), data)
        flush(c.io)
        return true
    catch e
        # an interrupt while the write completes: libuv still has the bytes, so it is sent
        e isa InterruptException && (forward_interrupt(); return true)
        return false
    finally
        unlock(c.lock)
    end
end

function recv(c::Connection)
    try
        uninterrupted(() -> eof(c.io)) && return nothing
        n = ltoh(uninterrupted(() -> read(c.io, UInt32)))
        return JSON.parse_json(String(uninterrupted(() -> read(c.io, n))))
    catch
        return nothing
    end
end

errdict(e, bt = catch_backtrace()) = e isa LoadError ? errdict(e.error, bt) : Dict(
    "type" => string(nameof(typeof(e))),
    "message" => sprint(showerror, e),
    "traceback" => sprint(Base.show_backtrace, bt),
)

include(joinpath(@__DIR__, "Debugger.jl"))

# --- station registry ---

const TYPES = Dict{String,Tuple{Any,Dict{String,Any}}}()

"""register(name, constructor; definition): make `constructor` available to `new` as `name`."""
register(name::AbstractString, ctor; definition = Dict{String,Any}()) =
    (TYPES[String(name)] = (ctor, Dict{String,Any}(string(k) => v for (k, v) in definition)); nothing)

# --- session ---

mutable struct Target
    conn::Union{Nothing,Connection}
    id::Any
end
const TARGET = Target(nothing, nothing)

struct PBDisplay <: AbstractDisplay end
Base.display(::PBDisplay, x) = TARGET.conn === nothing ? throw(MethodError(display, (x,))) :
    send(TARGET.conn, Dict("type" => "display", "id" => TARGET.id, "data" => mime(x)))

# A figure an app draws itself (docs/runtime.md "Figures"): JSON with its scene, from a plotting library
# (JulixPlot). Sent instead of the value's images: each of those costs a render, and the app exports on demand.
const FIGURE = MIME"application/vnd.paperboat.figure+json"()

function mime(x)
    x === nothing && return nothing
    d = Dict{String,Any}("text/plain" => repr(MIME"text/plain"(), x; context = :limit => true))
    if showable(FIGURE, x)
        d[string(FIGURE)] = sprint(show, FIGURE, x)
        return d
    end
    for (m, key) in ((MIME"text/html"(), "text/html"), (MIME"image/svg+xml"(), "image/svg+xml"))
        showable(m, x) && (d[key] = repr(m, x))
    end
    showable(MIME"image/png"(), x) && (d["image/png"] = base64encode(io -> show(io, MIME"image/png"(), x)))
    return d
end

mutable struct Session
    mod::Module
    jobs::Channel{Any}
    running::Threads.Atomic{Bool}
end

newmodule() = Module(:Session)  # Module() defines eval and include in it
Session() = Session(newmodule(), Channel{Any}(Inf), Threads.Atomic{Bool}(false))

# The cell's output streams to the client while `f` runs; its displays go there too.
function capturing(f, conn::Connection, id)
    TARGET.conn, TARGET.id = conn, id
    out = Pipe()
    saved_out, saved_err = stdout, stderr
    redirect_stdout(out)
    redirect_stderr(out)
    forward = @async begin
        while !uninterrupted(() -> eof(out))
            text = String(uninterrupted(() -> readavailable(out)))
            isempty(text) || send(conn, Dict("type" => "stream", "id" => id, "name" => "stdout", "text" => text))
        end
    end
    try
        return f()
    finally
        Base.Libc.flush_cstdio()
        flush(stdout)
        redirect_stdout(saved_out)
        redirect_stderr(saved_err)
        close(out.in)
        wait(forward)
        TARGET.conn, TARGET.id = nothing, nothing
    end
end

function run_eval(s::Session, code::String, cell::String, conn::Connection, id)
    capturing(conn, id) do
        value = Base.include_string(s.mod, code, cell)
        answer(s, code, value)
    end
end

function answer(s::Session, code::String, value)
    REPL.ends_with_semicolon(code) && (value = nothing)
    value === nothing || Core.eval(s.mod, :(ans = $(QuoteNode(value))))
    Dict("data" => Base.invokelatest(mime, value))  # the latest world: a cell may define the show it returns
end

# --- debugging (docs/runtime.md "Debugging") ---

describe(pairs) = [Dict{String,Any}("name" => string(k), "type" => string(typeof(v)),
                                    "summary" => first(repr(v; context = :limit => true), 120)) for (k, v) in pairs]
# a frame's locals; the top-level frame's are the session's variables
frame_locals(s::Session, f) = f === nothing ? Any[] : f.name == "top-level" ? variables(s) : describe(Debugger.frame_locals(f.id))

"A debug eval: the cell's statements instrumented, pausing at breakpoints and steps until told to go on."
function run_debug(s::Session, code::String, cell::String, conn::Connection, id, breakpoints)
    D = Debugger
    D.set_breakpoints!(cell, breakpoints)
    D.reset_session!(s.mod, cell;
        on_pause = (reason, file, line, frames) -> send(conn, Dict("type" => "debug", "id" => id, "event" => "stopped",
            "reason" => reason, "file" => file, "line" => line,
            "frames" => [Dict("id" => f.id, "name" => f.name, "line" => f.line) for f in reverse(frames)],
            "locals" => frame_locals(s, isempty(frames) ? nothing : frames[end]))),
        on_resume = () -> send(conn, Dict("type" => "debug", "id" => id, "event" => "resumed")))
    try
        capturing(conn, id) do
            answer(s, code, D.run_statements(s.mod, code, cell))
        end
    catch e
        (e isa D.DebugStopException || e isa LoadError && e.error isa D.DebugStopException) || rethrow()
        Dict("data" => nothing, "stopped" => true)
    finally
        D.finish_session!()
    end
end

"The `debug` op: answered by the reader at once, while a debug eval waits for it."
function debug_op(s::Session, args)
    D, cmd = Debugger, String(get(args, "command", ""))
    if cmd in ("continue", "over", "into", "out", "pause", "stop")
        D.STATE.active || return Dict("running" => false)
        D.request_command!(Symbol(cmd))
        return Dict("running" => true)
    elseif cmd == "breakpoints"
        D.set_breakpoints!(String(args["file"]), args["breakpoints"])
        return Dict()
    elseif cmd == "locals"
        D.STATE.paused || error("not paused")
        return Dict("locals" => frame_locals(s, D.frame(Int(args["frame"]))))
    elseif cmd == "eval"
        D.STATE.paused || error("not paused")
        f = D.frame(Int(args["frame"]))
        v = f === nothing || f.name == "top-level" ? Core.eval(s.mod, Meta.parse(String(args["code"]))) : D.eval_in_frame(f.id, String(args["code"]))
        return Dict("type" => string(typeof(v)), "summary" => first(repr(v; context = :limit => true), 400))
    end
    error("debug command is continue, over, into, out, pause, stop, breakpoints, locals or eval")
end

# Problems in a piece of code, from Julia's own parser (JuliaSyntax, inside Base since 1.10): byte offsets
# like `complete`. Only parsing, no namespace: it answers at once, even while a cell runs.
function lint(code::String)
    JS = Base.JuliaSyntax
    ps = JS.ParseStream(code)
    JS.parse!(ps; rule = :all)
    problems = [Dict("from" => JS.first_byte(d) - 1, "to" => JS.last_byte(d),
                     "severity" => d.level == :error ? "error" : d.level == :warning ? "warning" : "info", "message" => d.message)
                for d in ps.diagnostics]
    Dict("problems" => problems)
end

function complete(s::Session, code::String, pos::Int)
    comps, range, _ = REPL.REPLCompletions.completions(code, pos, s.mod)
    matches = unique!(sort!([REPL.REPLCompletions.completion_text(c) for c in comps]))
    Dict("matches" => matches, "start" => first(range) - 1, "end" => pos)
end

function variables(s::Session)
    out = Any[]
    for n in names(s.mod; all = true)
        name = string(n)
        (startswith(name, '#') || n in (:eval, :include, :Session, :ans)) && continue
        isdefined(s.mod, n) || continue
        v = getfield(s.mod, n)
        (v isa Module || v isa Function || v isa Type) && continue
        item = Dict{String,Any}("name" => name, "type" => string(typeof(v)),
                                "summary" => first(repr(v; context = :limit => true), 120))
        applicable(length, v) && !(v isa AbstractString) && try item["size"] = length(v) catch end
        push!(out, item)
    end
    out
end

function interrupt(s::Session)
    s.running[] || return false
    ccall(:kill, Cint, (Cint, Cint), getpid(), 2)  # SIGINT: an InterruptException, passed on to the root task
    return true
end

function main_loop(s::Session)
    while true
        job = try
            take!(s.jobs)
        catch e
            e isa InterruptException ? continue : rethrow()
        end
        job === nothing && return
        conn, id, f = job
        s.running[] = true
        reply = try
            Dict("id" => id, "ok" => true, "result" => Base.invokelatest(f))
        catch e
            if e isa InterruptException
                Dict("id" => id, "ok" => false, "error" => Dict("type" => "InterruptException", "message" => "interrupted", "traceback" => ""))
            else
                Dict("id" => id, "ok" => false, "error" => errdict(e))
            end
        finally
            s.running[] = false
        end
        send(conn, reply)
    end
end

# --- station ---

mutable struct Station
    conn::Connection
    mod::Module
    instances::Dict{Int,Any}
    bound::Dict{Int,Tuple{Any,Any}}
    next::Int
    channel::Any
end

Station(conn) = Station(conn, Module(:Station), Dict{Int,Any}(), Dict{Int,Tuple{Any,Any}}(), 0, nothing)

function load!(st::Station, path::String)
    full = isabspath(path) ? path : joinpath(get(ENV, "PAPERBOAT_PROJECT", pwd()), path)
    Core.eval(st.mod, :(const PaperboatRuntime = $(@__MODULE__)))
    Base.include(st.mod, full)
    Dict("types" => [Dict("name" => n, "definition" => d) for (n, (_, d)) in TYPES])
end

function new!(st::Station, type::String, params)
    haskey(TYPES, type) || error("no station type \"$type\" (registered: $(join(sort!(collect(keys(TYPES))), ", ")))")
    ctor = TYPES[type][1]
    kw = (Symbol(k) => v for (k, v) in (params === nothing ? Dict() : params))
    st.next += 1
    st.instances[st.next] = Base.invokelatest(ctor; kw...)
    Dict("instance" => st.next)
end

# the latest world: since Julia 1.12 bindings have world ages, and a station defines its methods after
# the server loop started (a plain getfield there would still see Base.step, not the station's step)
methodof(obj, name) = Base.invokelatest(getglobal, parentmodule(typeof(obj)), Symbol(name))

call!(st::Station, instance::Int, method::String, args) =
    Base.invokelatest(methodof(st.instances[instance], method), st.instances[instance], (args === nothing ? () : args)...)

function bind!(st::Station, instance::Int, method::String)
    obj = st.instances[instance]
    st.next += 1
    st.bound[st.next] = (obj, methodof(obj, method))
    Dict("handle" => st.next)
end

const SYS_futex = Sys.ARCH === :aarch64 ? 98 : 202
struct Timespec
    sec::Clong
    nsec::Clong
end
futex_wait(p::Ptr{UInt32}, v::UInt32) =
    (ts = Ref(Timespec(0, 50_000_000));
     ccall(:syscall, Clong, (Clong, Ptr{UInt32}, Cint, UInt32, Ref{Timespec}, Ptr{Cvoid}, Cint), SYS_futex, p, 0, v, ts, C_NULL, 0))
futex_wake(p::Ptr{UInt32}) =
    ccall(:syscall, Clong, (Clong, Ptr{UInt32}, Cint, UInt32, Ptr{Cvoid}, Ptr{Cvoid}, Cint), SYS_futex, p, 1, UInt32(1), C_NULL, C_NULL, 0)
load_acq(p::Ptr{UInt32}) = Core.Intrinsics.atomic_pointerref(p, :acquire)
store_rel(p::Ptr{UInt32}, v::UInt32) = Core.Intrinsics.atomic_pointerset(p, v, :release)

function shm!(st::Station, path::String, capacity::Int)
    st.channel === nothing || error("this connection already has a shared-memory channel")
    full = isabspath(path) ? path : joinpath(get(ENV, "PAPERBOAT_IPC", pwd()), path)
    slot = (64 + 8capacity + 63) ÷ 64 * 64
    mem = open(io -> Mmap.mmap(io, Vector{UInt8}, 2slot), full, "r+")
    st.channel = mem
    Threads.@spawn :default fast_loop(st, mem, slot, capacity)
    Dict{String,Any}()
end

function fast_loop(st::Station, mem::Vector{UInt8}, slot::Int, capacity::Int)
    GC.@preserve mem begin
        base = pointer(mem)
        req_seq, rep_seq = Ptr{UInt32}(base), Ptr{UInt32}(base + slot)
        req_handle, req_n = Ptr{UInt32}(base + 4), Ptr{UInt32}(base + 8)
        rep_status, rep_n = Ptr{UInt32}(base + slot + 4), Ptr{UInt32}(base + slot + 8)
        req_vals = unsafe_wrap(Array, Ptr{Float64}(base + 64), capacity)
        rep_vals = unsafe_wrap(Array, Ptr{Float64}(base + slot + 64), capacity)
        seen = load_acq(req_seq)
        while true
            spins = 0
            while (now = load_acq(req_seq)) == seen
                spins += 1
                if spins > 200
                    futex_wait(req_seq, seen)
                    yield()  # other connections' channels share this thread
                end
            end
            seen = now
            seen == typemax(UInt32) && return
            handle = Int(unsafe_load(req_handle))
            n = Int(unsafe_load(req_n))
            try
                obj, f = st.bound[handle]
                out = Base.invokelatest(f, obj, req_vals[1:n])
                length(out) <= capacity || error("$(length(out)) outputs exceed the channel's capacity $capacity")
                for i in eachindex(out)
                    rep_vals[i] = Float64(out[i])
                end
                unsafe_store!(rep_n, UInt32(length(out)))
                unsafe_store!(rep_status, UInt32(0))
            catch e
                unsafe_store!(rep_n, UInt32(0))
                unsafe_store!(rep_status, UInt32(1))
                send(st.conn, Dict("type" => "fast_error", "handle" => handle, "message" => sprint(showerror, e)))
            end
            store_rel(rep_seq, seen)
            futex_wake(rep_seq)
        end
    end
end

# On the default pool, so domain code never blocks the event loop on thread 1.
ondefault(f) = fetch(Threads.@spawn :default f())

# --- server ---

hello(mode) = Dict(
    "type" => "hello", "protocol" => PROTOCOL, "mode" => mode,
    "runtime" => Dict("name" => "julia", "version" => string(VERSION)),
    "pid" => getpid(), "transports" => ["shm", "uds"],
    "ops" => vcat(["ping", "interrupt", "shutdown"],
                  vcat(["lint"], mode == "session" ? ["eval", "complete", "variables", "reset"] : ["load", "new", "call", "drop", "shm", "bind"])),
)

function serve_connection(io, mode::String, session, stop::Threads.Event)
    conn = Connection(io, ReentrantLock())
    station = mode == "station" ? Station(conn) : nothing
    send(conn, hello(mode))
    while true
        msg = recv(conn)
        msg === nothing && break
        id, op = get(msg, "id", nothing), get(msg, "op", "")
        args = something(get(msg, "args", nothing), Dict{String,Any}())
        ok(r) = send(conn, Dict("id" => id, "ok" => true, "result" => r))
        fail(e, bt) = send(conn, Dict("id" => id, "ok" => false, "error" => errdict(e, bt)))
        try
            if op == "ping"
                ok(Dict())
            elseif op == "interrupt"
                ok(Dict("interrupted" => session === nothing ? false : interrupt(session)))
            elseif op == "shutdown"
                ok(Dict())
                notify(stop)
                session === nothing || put!(session.jobs, nothing)
                break
            elseif op == "lint"
                ok(lint(String(args["code"])))
            elseif session !== nothing && op == "eval"
                code, cell = String(args["code"]), String(get(args, "cell", "cell"))
                if get(args, "debug", false) === true
                    bps = something(get(args, "breakpoints", nothing), Any[])
                    put!(session.jobs, (conn, id, () -> run_debug(session, code, cell, conn, id, bps)))
                else
                    put!(session.jobs, (conn, id, () -> run_eval(session, code, cell, conn, id)))
                end
            elseif session !== nothing && op == "debug"
                ok(debug_op(session, args))
            elseif session !== nothing && op == "complete"
                code, pos = String(args["code"]), Int(args["pos"])
                put!(session.jobs, (conn, id, () -> complete(session, code, pos)))
            elseif session !== nothing && op == "variables"
                put!(session.jobs, (conn, id, () -> variables(session)))
            elseif session !== nothing && op == "reset"
                put!(session.jobs, (conn, id, () -> (session.mod = newmodule(); Dict())))
            elseif station !== nothing && op == "load"
                ok(ondefault(() -> load!(station, String(args["path"]))))
            elseif station !== nothing && op == "new"
                ok(ondefault(() -> new!(station, String(args["type"]), get(args, "params", nothing))))
            elseif station !== nothing && op == "call"
                ok(ondefault(() -> call!(station, Int(args["instance"]), String(args["method"]), get(args, "args", nothing))))
            elseif station !== nothing && op == "drop"
                obj = pop!(station.instances, Int(args["instance"]), nothing)
                filter!(kv -> kv[2][1] !== obj, station.bound)
                ok(Dict())
            elseif station !== nothing && op == "shm"
                ok(shm!(station, String(args["path"]), Int(args["capacity"])))
            elseif station !== nothing && op == "bind"
                ok(bind!(station, Int(args["instance"]), String(args["method"])))
            else
                send(conn, Dict("id" => id, "ok" => false, "error" => Dict("type" => "UnknownOp", "message" => "no op \"$op\" in $mode mode", "traceback" => "")))
            end
        catch e
            fail(e isa TaskFailedException ? e.task.result : e, catch_backtrace())
        end
    end
    close(io)
end

"""serve(path, mode): listen on `path` and serve until a client sends `shutdown`."""
function serve(path::String, mode::String)
    Base.exit_on_sigint(false)
    ispath(path) && rm(path)
    tmp = path * ".tmp"
    ispath(tmp) && rm(tmp)
    server = listen(tmp)
    mv(tmp, path; force = true)  # appears only when it can be connected to
    stop = Threads.Event()
    session = mode == "session" ? Session() : nothing
    if session !== nothing
        pushdisplay(PBDisplay())
        # the project's environment, as `julia --project`: what `paperboat add julia …` put there loads with `using`
        project = get(ENV, "PAPERBOAT_PROJECT", "")
        isempty(project) || (Base.ACTIVE_PROJECT[] = project)
    end
    @async begin
        while !stop.set
            sock = try
                uninterrupted(() -> accept(server))
            catch
                break
            end
            @async serve_connection(sock, mode, session, stop)
        end
    end
    if session !== nothing
        ROOT[] = current_task()
        main_loop(session)  # the root task: where the cell's interrupt is sent
    else
        wait(stop)
    end
    close(server)
    ispath(path) && rm(path)
end

end  # module PaperboatRuntime
