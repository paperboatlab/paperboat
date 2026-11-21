<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/logo-dark.svg">
    <img src=".github/readme/logo-light.svg" width="300" alt="paperboat">
  </picture>
</h1>

A framework for engineering apps: set up a 2D or 3D Station, wire a Flow graph, run it and watch the
instruments live on the Board. Stations are written in C++, Python or Julia; the web UI and the
desktop Launcher have no domain code and build themselves from what the station sends.

**Docs:** <https://paperboatlab.github.io/paperboat/> (sources in [`docs/api/`](docs/api/), also in
the Help window (F1); [paperboatlab.github.io](https://paperboatlab.github.io/) hosts the engine,
every toolkit and every program)

![Paperboat demo in two parts. A 3D cart-pole: on the Station its initial angle theta0 is raised from 0.15 to 0.5 rad, the Flow page shows the two PIDs that balance it, Run is pressed on the Station, the cart swings back under the pole and centres, and the Board plots x and theta with their readouts. Then a 2D runner: on the Flow page the Jump strength goes from 10 to 12, Run is pressed on its Station, the runner jumps the crates, and the Board plots its jumps (y) and its height](.github/readme/demo.gif)

## Layout

```text
../paperboat-shared/      @paperboat/shared, the shared UI kit (sibling checkout for source builds)
../paperboat-examples/    optional numbered tutorial stations (01–10)
apps/web/                 Station, Flow and Board web app (React, Vite, TypeScript, three.js)
apps/launcher/            Paperboat Launcher desktop app (Electron, React, TypeScript)
apps/cli/                 interactive terminal console (Ink, TypeScript)
engine/                   C++20 engine, built-in toolkits, SDK headers and the paperboat CLI
python/                   Python bindings (paperboat._engine) for Python stations
protocol/                 paperboat/0 WebSocket specification, JSON Schema, smoke_test.py and golden.py
docs/                     Sphinx manual (docs/api/) and the shared site builder (docs/site/)
```

## Install

Download the **Paperboat Launcher** desktop installer (`.deb`, `.rpm`, `.dmg`, `.msi`) or the
standalone **Paperboat CLI** binary from the
[latest release](https://github.com/paperboatlab/paperboat/releases), or install the CLI into
`~/.local/share/paperboat` (`~/.local/bin/paperboat`) with the install script:

```sh
curl -fsSL https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.ps1 | iex
```

Pass `--beta` (`-Channel beta` on Windows) for prereleases or `--dev` to build the `dev` branch from
source. Switch channels at any time with `paperboat update --channel release|beta|dev`.

From a checkout (requires Git, CMake 3.25+, Ninja, a C++20 compiler, Python 3.11+ and Node.js 22,
with `../paperboat-shared` cloned alongside):

```sh
(cd ../paperboat-shared && npm install)
npm install
npm run build:release
cmake -S engine -B engine/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build engine/build
```

## Run

```sh
./bin/paperboat launcher                # open the Paperboat Launcher desktop app
./bin/paperboat start                   # web app on http://localhost:3047, scratchpad on ws://localhost:8765
./bin/paperboat run 02-cart-pole        # build and run a station on ws://localhost:8766
./bin/paperboat start squero-studio-om  # install (on first run) and start Squero Studio OM on http://localhost:59201
./bin/paperboat new my-rig              # scaffold a C++ station (--python or --julia for Python or Julia)
```

A station's libraries go in its own environment (`paperboat deps install`): see
[Adding a library to a station](https://paperboatlab.github.io/paperboat/dependencies.html).

The web app opens at `http://localhost:3047` (`?station=ws://localhost:<port>` connects to any
running station). Run `./bin/paperboat` with no arguments in a terminal to open the interactive
console.

## Check

```sh
./scripts/verify.sh --quick
ctest --test-dir engine/build --output-on-failure
npm test -w @paperboat/launcher
npm run docs
```

End-to-end browser checks (`npm run e2e` and `npm run e2e -w @paperboat/launcher`) drive headless
Chromium against a built engine and are run on demand or in CI.

## CI

| Check | What it runs | `dev` |
| --- | --- | --- |
| Engine | C++ build and the engine tests | [![engine](https://github.com/paperboatlab/paperboat/actions/workflows/engine.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/engine.yml?query=branch%3Adev) |
| Python | the bindings and the protocol schema | [![python](https://github.com/paperboatlab/paperboat/actions/workflows/python.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/python.yml?query=branch%3Adev) |
| Web and console | typecheck, tests and build of `apps/web`, `apps/launcher` and `apps/cli` | [![web](https://github.com/paperboatlab/paperboat/actions/workflows/web.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/web.yml?query=branch%3Adev) |
| End to end | the web app in headless Chromium against a real engine station | [![e2e](https://github.com/paperboatlab/paperboat/actions/workflows/e2e.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/e2e.yml?query=branch%3Adev) |
| Journey | the CLI across Linux, Windows and macOS | [![journey](https://github.com/paperboatlab/paperboat/actions/workflows/journey.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/journey.yml?query=branch%3Adev) |
| Release | CLI packages, Python wheels and Electron Launcher installers (`.deb`, `.rpm`, `.dmg`, `.msi`) | [![release](https://github.com/paperboatlab/paperboat/actions/workflows/release.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/release.yml?query=branch%3Adev) |
| Docs | the [API reference](https://paperboatlab.github.io/paperboat/), warnings as errors | [![docs](https://github.com/paperboatlab/paperboat/actions/workflows/docs.yml/badge.svg?branch=dev)](https://github.com/paperboatlab/paperboat/actions/workflows/docs.yml?query=branch%3Adev) |

Versioned in `engine/CMakeLists.txt` and tagged `vX.Y.Z[-alpha.N]` on the same `MAJOR.MINOR` line as
`@paperboat/shared`; see [`GUIDELINES.md`](GUIDELINES.md) §9.

## Licence

GNU General Public License version 3 (see [LICENSE](LICENSE)). Third-party notices for bundled math
and solver libraries live under [`engine/cmake/`](engine/cmake/). Optional toolkits carry their own
licences and are never bundled into release artifacts.
