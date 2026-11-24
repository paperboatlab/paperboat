# Paperboat

The Paperboat platform: the `paperboat` CLI, the per-user runtime daemon `paperboatd`, and (soon) the
Paperboat Launcher. It runs the language runtimes the Paperboat apps need (Julia, Python,
OpenModelica) from pinned, isolated container images, with a native fallback. The apps themselves
(Simplicial, Articula, Julix) live in their own repositories.

**Design:** [ARCHITECTURE.md](ARCHITECTURE.md) · **Protocols:** [docs/control.md](docs/control.md)
(apps ↔ daemon), [docs/runtime.md](docs/runtime.md) (apps ↔ runtimes)

## Layout

```text
include/paperboat/   the runtime manager's API (manifest, catalog, policy, backend, manager, control)
src/lib/             its implementation
src/daemon/          paperboatd
src/cli/             paperboat and its command registry (commands.toml)
apps.toml            the app registry (empty for now)
toolkits.toml        the toolkit registry (simplicial-toolkit-*)
runtimes/            the shipped runtimes: runtime.toml and lib/ (the runtime library) each
images/              the runtime images' recipe and versions (published by CI to ghcr.io)
tests/               unit tests, and container tests against real podman
```

## Build

```sh
cmake -S . -B build -G Ninja && ninja -C build
./build/tests/paperboat_tests              # unit
./build/tests/paperboat_cli_tests          # the CLI against its registry
./build/tests/paperboat_container_tests    # needs podman; skipped without it
```

## Run

```sh
./build/paperboat help                     # every command (src/cli/commands.toml)
./build/paperboat runtimes                 # runtimes and where they can run
./build/paperboat package add python six --project ~/demo   # pulls the image if missing
./build/paperboat runtime ps
```

`paperboat` starts `paperboatd` on demand; `paperboat daemon stop` stops it.

## License

GPL-3.0 (see LICENSE)
