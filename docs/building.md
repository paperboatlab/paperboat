# Building from source

What to install to build and check the Paperboat repositories from a checkout: the platform
(`paperboat`), the UI kit (`paperboat-ui`) and the apps (`simplicial`, `articula`, `julix`,
`malachite`). The commands are the ones each repository's `.github/workflows/ci.yml` runs.

Julia, Python and OpenModelica are **not** on this list: they run in containers that `paperboatd`
pulls on first use. The C++ libraries (nlohmann/json, toml++, IXWebSocket, Eigen, Boost.Math,
SUNDIALS, Catch2) are not either: CMake downloads them on the first configure, so that one needs
the network.

## Toolchain

| Tool | Version | Needed for |
| --- | --- | --- |
| Git, with an SSH key on GitHub | any | every app: `package-lock.json` pins `@paperboatlab/ui` as `git+ssh://git@github.com/paperboatlab/paperboat-ui.git#<commit>` |
| Node.js and npm | ≥ 22.18 (`engines`) | every repository: the apps, the kit, the platform's client, TUI and Launcher |
| CMake | ≥ 3.25 | `paperboat`, `simplicial/engine`, `articula/server` |
| Ninja | any | the C++ builds (`-G Ninja`) |
| A C++20 compiler | GCC ≥ 14 on Linux; Xcode ≥ 16.3 on macOS (its libc++ has `std::jthread`) | the C++ builds |
| Podman (or Docker) | rootless | running the runtimes; `paperboat_container_tests` |
| Python 3 | any | `simplicial`: `protocol/gen_ts.py --check` |

Optional, for one check each:

| Tool | Needed for |
| --- | --- |
| `rpmbuild` | `cpack -G RPM` (the `paperboat-cli` and `paperboat-devel` packages) |
| Chromium (`chromium`, `google-chrome`, the Flatpak, or `CHROME=<binary>`) | `simplicial`'s `npm run e2e`; skipped without one |
| Xvfb (`xvfb-run`) | the Launcher's Electron e2e on a machine with no display |
| Sphinx and the `shibuya` theme (`pip install sphinx shibuya`) | building an app's `docs/` the way the org site does |
| OpenCV and Ipopt (development packages) | the optional toolkits `simplicial-toolkit-opencv` and `-optimization` |
| Julia | the `native` backend's tests; skipped without it |

### Fedora

```sh
sudo dnf install -y git nodejs npm cmake ninja-build gcc-c++ podman python3
sudo dnf install -y rpm-build chromium xorg-x11-server-Xvfb    # optional
```

### Ubuntu 24.04

```sh
sudo apt-get install -y git cmake ninja-build g++-14 podman python3
export CXX=g++-14 CC=gcc-14   # the default g++ 13 is too old
```

Ubuntu's `nodejs` package is older than Node 22: install Node 22 from <https://nodejs.org> or with a
version manager (nvm, fnm).

### macOS

Install Xcode 16.3 or newer (or its Command Line Tools), then:

```sh
brew install git node cmake ninja podman
podman machine init && podman machine start
```

## Workspace

Clone the repositories side by side. The workspace root holds the shared agent docs
(`paperboatlab/paperboat-agent-docs`, copied up by its `scripts/sync.sh`):

```text
paperboat/        the platform: CLI, paperboatd, client, TUI, Launcher
paperboat-ui/     the UI kit
simplicial/  articula/  julix/  malachite/
```

## Build and check

**`paperboat`**

```sh
cmake -S . -B build -G Ninja && ninja -C build
./build/tests/paperboat_tests
./build/tests/paperboat_cli_tests
./build/tests/paperboat_container_tests       # needs podman
npm ci
npm run typecheck -w @paperboat/client && npm test -w @paperboat/client
npm run typecheck -w @paperboat/cli && npm test -w @paperboat/cli && npm run build -w @paperboat/cli
npm run typecheck -w @paperboat/launcher && npm run build -w @paperboat/launcher
npm run e2e -w @paperboat/launcher            # xvfb-run -a … without a display
```

**`paperboat-ui`**

```sh
npm ci && npm run typecheck && npm test && npm run demo
```

**`simplicial`**

```sh
cmake -S engine -B engine/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DPAPERBOAT_BUILD_TESTS=ON
cmake --build engine/build && ctest --test-dir engine/build --output-on-failure
python3 protocol/gen_ts.py --check
npm ci && npm run typecheck && npm test && npm run build
npm run e2e                                   # needs Chromium and the engine build
```

**`articula`**

```sh
npm ci && npm run typecheck && npm test && npm run build
cmake -S server -B server/build -G Ninja -DCMAKE_BUILD_TYPE=Debug -DARTICULA_BUILD_TESTS=ON
cmake --build server/build && server/build/articula_tests
```

**`julix`, `malachite`**

```sh
npm ci && npm run typecheck && npm test && npm run build
```

## Using your own `paperboatd`

The apps and some tests look for `paperboatd` on `PATH` (the `paperboat-cli` package) or in
`PAPERBOATD`. Point them at the platform you built:

```sh
export PAPERBOATD="$PWD/paperboat/build/paperboatd"
```

Without it these are skipped, not failed: `simplicial`'s remote-station test ("no paperboatd") and
`articula`'s omc tests ("omc not installed"). The first run pulls the runtime's image (Julia,
Python or OpenModelica), which takes a while.

These skips are expected on any machine: the Python debugger tests ("no debugger for python yet"),
and the `native` Julia tests when Julia is not installed.
