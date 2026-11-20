# Adding a library to a station

A station declares its dependencies next to `station.toml`; `paperboat deps install` creates an
isolated environment for it, so the host's Python or Julia environment is never used.

## Python

```
my-station/
  station.toml          # language = "python"
  requirements.txt      # pinned packages, e.g. numpy==2.1.3
  server.py
  .venv/                # created by paperboat deps install (not packed)
```

```sh
paperboat deps install my-station
paperboat run my-station
```

`deps install` runs `python3 -m venv .venv` and `.venv/bin/python -m pip install -r
requirements.txt`. `paperboat check` fails with `Python dependencies are not installed: run
paperboat deps install` when `requirements.txt` lists packages but `.venv` is missing (a file
with only comments, as `paperboat new` writes it, needs no environment). `paperboat pack` includes
`requirements.txt` and excludes `.venv/`.

`$PAPERBOAT_PYTHON` still selects a different interpreter; the station venv wins when it exists.

## Julia

```
my-station/
  station.toml          # language = "julia"
  Project.toml
  Manifest.toml
  server.jl
  .julia/               # created by paperboat deps install (not packed)
```

```sh
paperboat deps install my-station
```

`deps install` runs `julia --project=. -e 'using Pkg; Pkg.instantiate()'` with
`JULIA_DEPOT_PATH=<station>/.julia`, `JULIA_PROJECT=<station>`, `JULIA_LOAD_PATH="@:@stdlib"` and
`JULIA_NUM_THREADS=1`. The host `~/.julia` and `@v1.11` environment are not used. `paperboat check`
fails when `Project.toml` exists without `Manifest.toml`.

`paperboat run` starts `julia --startup-file=no --project=<station> server.jl` with the same
environment; `paperboat check` and `pack` work for a Julia station. See
`docs/api/julia.rst` for the block API and the host pump.

## C++

C++ dependencies are CMake packages or optional toolkits. Declare required toolkits in
`toolkit_requirements.toml` and link the rest from the station `CMakeLists.txt`; there is no
runtime package install.

## What is packed

`.pst` includes the lockfiles (`requirements.txt`, `Project.toml`, `Manifest.toml`) and excludes
the environments (`.venv/`, `.julia/`, `build/`). An air-gapped install can copy the environment
next to the station or use a container.
