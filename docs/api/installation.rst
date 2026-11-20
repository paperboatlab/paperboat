.. _installation:

Installation
============

Paperboat has two front doors:

- the **Paperboat CLI** (``paperboat``) for a terminal, scripts and CI; and
- the **Paperboat Launcher**, a desktop window over the same CLI for installing apps,
  toolkits and backends.

You can install either one. The Launcher bundles the CLI, so it is a complete install by
itself; installing both is fine and they share the same ``$PAPERBOAT_HOME``.

.. list-table::
   :header-rows: 1
   :widths: 24 34 42

   * - If you want to…
     - Install
     - Then
   * - run backends, build projects, use scripts or CI
     - the CLI (and the C++ development package, ``paperboat-dev`` / ``paperboat-devel``)
     - read :ref:`paperboat-cli` and :ref:`paperboat-dev`
   * - work from a desktop app, install Squero Studio, manage toolkits
     - the Launcher
     - read :ref:`paperboat-launcher` and :doc:`launcher`
   * - develop Paperboat itself
     - a checkout of the repository
     - see :ref:`from-checkout`

Supported platforms
-------------------

The prebuilt releases target:

.. list-table::
   :header-rows: 1
   :widths: 16 30 54

   * - Platform
     - Packages
     - Notes
   * - Linux x86_64
     - ``.deb``, ``.rpm``, ``.tar.gz``, one-file binary
     - Built on Ubuntu 22.04 (glibc 2.35); runs on Debian 12, Ubuntu 22.04+ and recent Fedora.
   * - macOS arm64
     - ``.dmg``, ``.tar.gz``, one-file binary
     - Apple Silicon. Intel Macs build from source.
   * - Windows x64
     - ``.msi``, ``.zip``, one-file ``.exe``
     - Windows 10/11.

Other architectures (Linux arm64, Intel macOS, Windows on ARM) are supported from a source
checkout; the release does not publish prebuilt packages for them.

.. _prerequisites:

Prerequisites
-------------

The CLI and the Launcher need almost nothing themselves. The build tools are needed when
Paperboat builds **for you**: a C++ backend, an app, a toolkit, or the ``dev`` channel.

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - You are installing or running…
     - It needs
   * - the prebuilt CLI (Linux/macOS)
     - ``curl`` or ``wget``, and ``tar``. No compiler, Node.js or Python for the CLI
       commands themselves. The interactive console needs Node.js 22+ on ``PATH``.
   * - the prebuilt CLI (Windows)
     - PowerShell 5 or newer. No compiler, Node.js or Python for the CLI commands
       themselves. The interactive console needs Node.js 22+ on ``PATH``.
   * - the Launcher
     - the matching OS package: ``.deb``/``.rpm`` on Linux, ``.dmg`` on macOS, ``.msi``
       on Windows, and a desktop session (X11 or Wayland on Linux). The Launcher is an
       Electron app and bundles the CLI; it does not need Node.js or a Python
       installation.
   * - the CLI ``dev`` channel or a source build
     - Git, CMake 3.25+, Ninja (recommended), a C++20 compiler (GCC 12+/Clang 17+ or
       MSVC 2022), Node.js 22+ with npm, and Python 3.11+ for the bindings.
   * - C++ backends
     - CMake 3.25+, Ninja (recommended), and a C++20 compiler. On Linux, the packaged SDK
       asks for ``g++ >= 12``; GCC 13+ or Clang 17+ is the comfortable baseline.
   * - Python backends
     - Python 3.11+. The release ships ``paperboat._engine`` for CPython 3.11 and, through
       the stable ABI, for CPython 3.12 and later. ``pip`` is only needed for the
       backend's own packages.
   * - Julia backends
     - Julia 1.11+, then ``paperboat deps install`` in the backend folder.
   * - Squero Studio OM
     - Git, Node.js 22+/npm, CMake 3.25+, Ninja, a C++20 compiler, and either OpenModelica
       ``omc`` or Podman/Docker.
   * - Squero Studio MX
     - Git, Node.js 22+/npm, and either Podman/Docker for the Julia kernel image or
       Julia 1.11+.
   * - the OpenCV toolkit
     - The OpenCV development headers (``libopencv-dev`` on Debian/Ubuntu,
       ``opencv-devel`` on Fedora, ``opencv`` on Homebrew), plus CMake and a C++20
       compiler.
   * - the mesh toolkit
     - CMake 3.25+ and a C++20 compiler. VCGlib and Eigen are downloaded when they are
       not already present.
   * - the control or optimization toolkit
     - CMake and a C++20 compiler; no extra system library is required.

You also need network access to GitHub (releases and repositories), and to npm, PyPI and
the Julia registry when an app or backend installs its own dependencies. The Julia kernel
image comes from ``ghcr.io``.

These requirements apply whether you use the CLI or the Launcher. The Launcher does not
bundle compilers or language runtimes: when it installs an app, toolkit or backend, it
runs the same install and build commands through its bundled CLI.

.. _paperboat-cli:

The Paperboat CLI
-----------------

One line, Linux and macOS
~~~~~~~~~~~~~~~~~~~~~~~~~

The install script puts the CLI in ``$PAPERBOAT_HOME`` (default
``~/.local/share/paperboat``), links it from ``~/.local/bin/paperboat``, and leaves the SDK
next to it:

.. code-block:: sh

   curl -fsSL https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.sh | sh

Example output (the version and paths vary):

.. code-block:: text

   $ curl -fsSL https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.sh | sh
   installing paperboat-0.1.5-Linux-x86_64.tar.gz…
   paperboat → /home/you/.local/share/paperboat/self/0.1.5/bin/paperboat
   add /home/you/.local/bin to PATH: export PATH="$HOME/.local/bin:$PATH"
   installed paperboat 0.1.5

If ``paperboat`` is not found afterwards, add the printed directory to your shell's
``PATH``.

Windows
~~~~~~~

.. code-block:: powershell

   irm https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.ps1 | iex

The script installs under ``%LOCALAPPDATA%\paperboat``, creates
``%LOCALAPPDATA%\paperboat\bin\paperboat.cmd`` and adds that folder to the user's
``PATH``. Open a new terminal after the first install.

To pass a channel or version, run the downloaded script as a script block:

.. code-block:: powershell

   $install = irm https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.ps1
   & ([scriptblock]::Create($install)) -Channel beta

Channels and versions
~~~~~~~~~~~~~~~~~~~~~

The default is the newest stable release. Three channels are available:

.. list-table::
   :header-rows: 1
   :widths: 18 34 48

   * - Channel
     - Linux/macOS
     - What it does
   * - ``release``
     - ``--release`` (default)
     - Downloads the newest stable release's prebuilt archive.
   * - ``beta``
     - ``--beta``
     - Includes prereleases (alpha, beta, release candidate).
   * - ``dev``
     - ``--dev`` (or ``--main``)
     - Clones the ``dev`` branch and builds it from source. Needs the build tools in
       :ref:`prerequisites`.

On Windows the install script downloads release archives; use ``-Channel beta`` for
prereleases. To build the ``dev`` branch on Windows, use a source checkout
(:ref:`from-checkout`).

.. code-block:: sh

   INSTALL=https://raw.githubusercontent.com/paperboatlab/paperboat/HEAD/scripts/install.sh

   # prereleases
   curl -fsSL "$INSTALL" | sh -s -- --beta

   # build the dev branch (Git, CMake, Node.js, a compiler)
   curl -fsSL "$INSTALL" | sh -s -- --dev

   # a specific release, or an archive you already downloaded
   curl -fsSL "$INSTALL" | sh -s -- --version 0.1.5
   curl -fsSL "$INSTALL" | sh -s -- --archive paperboat-0.1.5-Linux-x86_64.tar.gz

   # report what is installed and what is available; change nothing
   curl -fsSL "$INSTALL" | sh -s -- --check

``--source`` builds a release tag from source. ``--dev`` and ``--source`` put the checkout
in ``$PAPERBOAT_HOME/src/paperboat`` and reuse it on the next update.

Packages and single files
~~~~~~~~~~~~~~~~~~~~~~~~~

The release also publishes the CLI as a ``.deb``, an ``.rpm``, a ``.tar.gz``, a ``.zip``
and a one-file binary. The ``.tar.gz`` and ``.zip`` contain both the runtime and the C++
SDK, so no separate development package is needed. The one-file binary is a launcher that
installs its own runtime on first run:

.. code-block:: sh

   # Linux: the package, not the Launcher package
   sudo apt install ./paperboat_<version>_amd64.deb
   # or: sudo dnf install ./paperboat-<version>-1.x86_64.rpm

   # one-file Linux binary
   chmod +x paperboat-0.1.5-Linux-x86_64
   ./paperboat-0.1.5-Linux-x86_64 --version

The release page is https://github.com/paperboatlab/paperboat/releases.

.. _paperboat-dev:

The C++ development package
---------------------------

The ``.deb`` and ``.rpm`` split the install in two:

- ``paperboat`` — the CLI, the web app and the runtime libraries;
- ``paperboat-dev`` on Debian/Ubuntu or ``paperboat-devel`` on Fedora/RHEL — the headers,
  libraries and ``paperboatConfig.cmake`` for building C++ backends and toolkits against
  the installed engine.

Install both when you build C++ code from distribution packages:

.. code-block:: sh

   # Debian/Ubuntu
   sudo apt install ./paperboat_<version>_amd64.deb ./paperboat-dev_<version>_amd64.deb

   # Fedora/RHEL
   sudo dnf install ./paperboat-<version>-1.x86_64.rpm ./paperboat-devel-<version>-1.x86_64.rpm

The development package depends on ``paperboat``, CMake 3.25+ and a C++ compiler.
``paperboat build`` finds the SDK with ``find_package(Paperboat CONFIG)``; the installed
CMake package takes care of the include paths, libraries and the C++20 requirement.

You do **not** need the development package when you installed from ``install.sh``, a
``.tar.gz``/``.zip``, or the Launcher: those trees already contain the SDK.

Verify the install
~~~~~~~~~~~~~~~~~~

.. code-block:: text

   $ paperboat --version
   paperboat 0.1.5
   $ paperboat commands
   start     Start the web app, or a backend or program (start [backend|program])
   stop      Stop the web app, or a backend or program (stop [backend|program])
   restart   Restart the web app, or a backend or program
   run       Build and run a backend (or .ppk) in the foreground
   open      Open a saved project file (.ppj, .paperboat.json)
   …

With no arguments on a terminal, ``paperboat`` opens the interactive console. It is the
same commands with completion and background jobs:

.. code-block:: text

   $ paperboat
   › status
   › run 02-cart-pole
   › toolkit list
   › top

.. note::

   ``PAPERBOAT_NO_CONSOLE=1`` keeps the plain prompt instead of the interactive console.
   The console needs Node.js 22+ on ``PATH``; the release ships its JavaScript bundle,
   not Node itself. Without Node, ``paperboat`` falls back to the plain prompt.

Where it installs
~~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - Variable
     - Default
   * - ``PAPERBOAT_HOME``
     - ``~/.local/share/paperboat`` on Linux/macOS (``$XDG_DATA_HOME/paperboat`` if
       ``XDG_DATA_HOME`` is set); ``%LOCALAPPDATA%\paperboat`` on Windows. Holds
       ``self/<version>/``, ``src/paperboat``, ``apps/`` and ``toolkits/``.
   * - ``PAPERBOAT_BIN``
     - ``~/.local/bin`` on Linux/macOS; ``%LOCALAPPDATA%\paperboat\bin`` on Windows. The
       ``paperboat`` link or ``paperboat.cmd`` lives here.
   * - ``PAPERBOAT_ARCHIVE``
     - Optional: an offline release archive for the one-file binary's first run.

``paperboat pkg`` installs apps and toolkits under ``$PAPERBOAT_HOME``, so installing a
toolkit or an app never needs administrator rights. Only the system packages (the CLI
``.deb``/``.rpm`` or the Launcher) do.

Updating and switching versions
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. code-block:: sh

   paperboat update --check                 # show installed and available versions
   paperboat update                         # update on the current channel
   paperboat update --channel release       # switch to stable
   paperboat update --channel beta          # switch to prereleases
   paperboat update --channel dev           # switch to dev (builds from source)
   paperboat update --no-build              # update files without rebuilding
   paperboat use --list                     # list side-by-side runtime versions
   paperboat use 0.1.5                      # switch active runtime under $PAPERBOAT_HOME/self/

``paperboat update`` manages releases directly in C++ without invoking ``install.sh`` or
``install.ps1``. Each managed runtime is installed side-by-side under
``$PAPERBOAT_HOME/self/<version>/``, and ``paperboat use`` switches the active link or
Windows shim between installed versions.

.. _paperboat-launcher:

The Paperboat Launcher
----------------------

The Launcher is a desktop window over the CLI. It bundles the CLI and SDK, so a Launcher
install can build and run backends, apps and toolkits without a separate CLI install.
The two share ``$PAPERBOAT_HOME``.

Linux
~~~~~

Install the ``.deb`` or ``.rpm`` from the release page:

.. code-block:: sh

   sudo apt install ./paperboat-launcher-<version>-x64.deb
   # or: sudo dnf install ./paperboat-launcher-<version>-x64.rpm

The package installs ``/opt/Paperboat Launcher/paperboat-launcher`` and a desktop entry.
Start it from the applications menu, or with ``paperboat launcher`` once the CLI is
installed.

macOS
~~~~~

Open ``Paperboat-Launcher-<version>-arm64.dmg`` and drag **Paperboat Launcher** to
**Applications** (the GPL-3.0 licence notice is included as ``LICENSE.txt`` inside the
disk image). The build is currently unsigned; if macOS refuses the first launch, use
**right-click → Open** once. Code signing and notarization are tracked separately.

Windows
~~~~~~~

Run ``Paperboat-Launcher-<version>-x64.msi``. The setup wizard presents the GPL-3.0
licence, lets you pick the per-user install folder, creates desktop and Start-menu
shortcuts, and offers to launch **Paperboat Launcher** when it finishes.

The first window
~~~~~~~~~~~~~~~~

The Launcher opens on **Apps**. The left rail switches between Apps, Backends, Toolkits
and Console; the top bar carries the page's controls, the version/status pill and the
theme control. On Apps it also carries the channel switch; :kbd:`Ctrl` + :kbd:`K` opens
the command palette from anywhere. There is no first-run wizard: the Apps page is the
starting point.

.. seealso::

   :doc:`launcher` — a page-by-page guide to installing apps, running backends, managing
   toolkits and using the console.

.. _from-checkout:

From a checkout
---------------

To build Paperboat itself, clone ``paperboat`` and ``paperboat-shared`` side by side:

.. code-block:: sh

   git clone https://github.com/paperboatlab/paperboat.git
   git clone https://github.com/paperboatlab/paperboat-shared.git
   cd paperboat
   (cd ../paperboat-shared && npm install)
   npm install
   npm run build:release
   cmake -S engine -B engine/build -G Ninja -DCMAKE_BUILD_TYPE=Release
   cmake --build engine/build

Then run ``./bin/paperboat``. A checkout defaults to the ``dev`` branch; release packages
are built from tagged commits. The Launcher can also run from the checkout:

.. code-block:: sh

   npm run electron -w @paperboat/launcher

Next steps
----------

- :doc:`quickstart` — create a backend and run it.
- :doc:`launcher` — the Launcher, page by page.
- :doc:`user_manual` — the Station, Flow and Board.
