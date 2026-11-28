# Entry point: julia --threads=1,1 serve.jl <socket> [session|station]  (the mode defaults to $PAPERBOAT_MODE)
#
# lib/ is the PaperboatRuntime package (Project.toml, src/). Its precompiled image (with the workload in
# precompile.jl: serve, eval, complete, variables, figures) lives in the first depot, the project's deps
# volume: loaded from there it starts with nothing to compile. When there is none for this source yet,
# the runtime runs from source as before and builds one for the next start, in the background.
module PaperboatServe

const LIB = @__DIR__
const PKG = Base.PkgId(Base.UUID("8602d567-8f2c-598b-a56b-b3f42504237f"), "PaperboatRuntime")

# The package alone on the load path: the session's project must not decide what PaperboatRuntime is.
function with_lib_path(f)
    saved = copy(LOAD_PATH)
    copy!(LOAD_PATH, [LIB, "@stdlib"])
    try
        return f()
    finally
        copy!(LOAD_PATH, saved)
    end
end

function writable(dir)
    try
        mkpath(joinpath(dir, "compiled"))
        probe = joinpath(dir, "compiled", ".pb-probe-$(getpid())")
        touch(probe); rm(probe)
        return true
    catch
        return false
    end
end

# A lower-priority julia that builds the cache in DEPOT_PATH[1] (with Base's pidfile lock, so sessions
# that start together build it once). Its flags are this process's (julia_cmd), which the cache must match.
function build_cache()
    (isempty(DEPOT_PATH) || !writable(DEPOT_PATH[1])) && return
    # a build stopped with its session (the container ends) leaves its temporary files: an hour on, none is building
    dir = joinpath(DEPOT_PATH[1], "compiled", "v$(VERSION.major).$(VERSION.minor)", PKG.name)
    for f in (isdir(dir) ? readdir(dir; join = true) : String[])
        startswith(basename(f), "jl_") && time() - mtime(f) > 3600 && rm(f; force = true)
    end
    script = """
        ccall(:setpriority, Cint, (Cint, Cuint, Cint), 0, 0, 19)  # only what the session leaves idle
        Base.require($(repr(PKG)))
        """
    env = copy(ENV)
    env["JULIA_LOAD_PATH"] = LIB * (Sys.iswindows() ? ";" : ":") * "@stdlib"
    for k in ("PAPERBOAT_PROJECT", "PAPERBOAT_MODE", "JULIA_PROJECT")  # the workload is no session of a project
        delete!(env, k)
    end
    cmd = setenv(`$(Base.julia_cmd()) --startup-file=no --threads=1 -e $script`, env)
    try
        run(pipeline(cmd; stdin = devnull, stdout = devnull, stderr = stderr); wait = false)
    catch e
        println(stderr, "paperboat: could not precompile the runtime: ", sprint(showerror, e))
    end
end

function load()
    isdefined(Base, :isprecompiled) || return Base.include(Main, joinpath(LIB, "PaperboatRuntime.jl"))  # Julia < 1.10
    cached = with_lib_path() do
        try
            Base.isprecompiled(PKG) ? Base.require(PKG) : nothing
        catch e
            println(stderr, "paperboat: the precompiled runtime did not load (", sprint(showerror, e), "); running from source")
            nothing
        end
    end
    cached === nothing || return cached
    build_cache()
    Base.include(Main, joinpath(LIB, "PaperboatRuntime.jl"))
end

end  # module PaperboatServe

const PaperboatRuntime = PaperboatServe.load()
PaperboatRuntime.serve(ARGS[1], length(ARGS) > 1 ? ARGS[2] : get(ENV, "PAPERBOAT_MODE", "session"))
