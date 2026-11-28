# The precompile workload: while the package is precompiled (serve.jl builds the cache), one session is
# served and driven through a socket as an app would, so its code paths go into the cache with the types
# they meet. This is PrecompileTools' @compile_workload, written out because the runtime stays stdlib
# only: `@force_compile` compiles the workload instead of interpreting it, and every method instance
# inferred as a root (a call through runtime dispatch, which nothing in the package's own code reaches
# by inference) is precompiled so it goes into the cache too.

function workload()
    dir = mktempdir()
    path = joinpath(dir, "w.sock")
    # evaluating into a module from outside the package would break its precompilation
    server = @async serve(path, "session"; mod = Core.eval(@__MODULE__, :(module WorkloadSession end)))
    for _ in 1:500
        ispath(path) && break
        sleep(0.01)
    end
    conn = Connection(connect(path), ReentrantLock())
    n = 0
    function request(op, args = Dict{String,Any}(); fails = false)
        send(conn, Dict("id" => (n += 1), "op" => op, "args" => args))
        while true
            m = recv(conn)
            m === nothing && error("the workload's session closed")
            get(m, "id", nothing) == n && haskey(m, "ok") || continue
            m["ok"] == !fails || error("the workload's $op: $m")  # a broken workload fails the build, not a session
            return m
        end
    end
    try
        recv(conn)  # hello
        request("ping")
        request("lint", Dict("code" => "x = (1, 2"))
        request("eval", Dict("code" => "x = 1"))
        request("eval", Dict("code" => "v = [1.0, 2.0, 3.0]; println(\"hi\"); print(stderr, \"\"); v .* 2"))
        request("eval", Dict("code" => "d = Dict(\"a\" => 1); t = (1, \"two\"); s = \"text\"; m = [1 2; 3 4]; display(m); nothing"))
        request("eval", Dict("code" => "error(\"workload\")"); fails = true)
        request("eval", Dict("code" => """
            struct WorkloadFigure end
            Base.show(io::IO, ::MIME"application/vnd.paperboat.figure+json", ::WorkloadFigure) = print(io, "{\\"scene\\":{}}")
            WorkloadFigure()
            """))
        request("eval", Dict("code" => "1 + 1;"))
        request("complete", Dict("code" => "pri", "pos" => 3))
        request("complete", Dict("code" => "Base.sq", "pos" => 7))
        request("complete", Dict("code" => "\\alpha", "pos" => 6))
        request("variables")
    finally
        try
            request("shutdown")
        catch
        end
        close(conn.io)
        wait(server)
        popdisplay()  # serve's PBDisplay
        rm(dir; recursive = true, force = true)
        # nothing of the workload's session stays in the cache
        ROOT[] = nothing
        TARGET.conn, TARGET.id = nothing, nothing
        empty!(TYPES)
        empty!(TYPE_NAMES)
        TYPE_NAMES_MODULES[] = -1
    end
end

function precompile_roots(roots)
    for child in roots
        precompile(child.mi_info.mi.specTypes)
        precompile_roots(child.children)
    end
end

const TRACK_INFERENCE = isdefined(Core.Compiler, :__set_measure_typeinf) && isdefined(Core.Compiler, :Timings)

if ccall(:jl_generating_output, Cint, ()) == 1
    precompile(serve, (String, String))  # serve.jl's call (the workload's passes `mod`)
    if TRACK_INFERENCE
        Core.Compiler.Timings.reset_timings()
        Core.Compiler.__set_measure_typeinf(true)
    end
    try
        let
            Base.Experimental.@force_compile
            workload()
        end
    finally
        TRACK_INFERENCE && (Core.Compiler.__set_measure_typeinf(false); Core.Compiler.Timings.close_current_timer())
    end
    try
        TRACK_INFERENCE && precompile_roots(Core.Compiler.Timings._timings[1].children)
    catch e  # a Julia whose compiler keeps its timings otherwise: the cache has less, but still loads
        @warn "PaperboatRuntime: the workload's runtime-dispatched calls are not precompiled" exception = e
    end
end
