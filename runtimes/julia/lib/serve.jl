# Entry point: julia --threads=1,1 serve.jl <socket> [session|station]  (the mode defaults to $PAPERBOAT_MODE)
include(joinpath(@__DIR__, "PaperboatRuntime.jl"))
PaperboatRuntime.serve(ARGS[1], length(ARGS) > 1 ? ARGS[2] : get(ENV, "PAPERBOAT_MODE", "session"))
