# The package's entry file: the runtime itself is ../PaperboatRuntime.jl, which serve.jl can also run from source.
Base.include(@__MODULE__, joinpath(dirname(@__DIR__), "PaperboatRuntime.jl"))
