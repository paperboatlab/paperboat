Writing a toolkit
=================

A toolkit is a package of blocks: the built-in ones in ``engine/toolkit/src/<package>/`` and the
optional ones, each in its own repository, installed into ``engine/toolkit/<package>/``. Import a
package in a descriptor (``import = ["signal", "math"]``) or use one template
(``use = "math/gain"``). Paperboat is not Simulink: ``base`` holds only what any domain needs;
everything else lives in the package of what it is about. List them with
``paperboat-catalog --templates``.

Every toolkit's blocks are documented on its own site, built from its catalog:
`base <https://paperboatlab.github.io/toolkits/base/>`_,
`signal <https://paperboatlab.github.io/toolkits/signal/>`_,
`math <https://paperboatlab.github.io/toolkits/math/>`_,
`string <https://paperboatlab.github.io/toolkits/string/>`_,
`list <https://paperboatlab.github.io/toolkits/list/>`_,
`dashboard <https://paperboatlab.github.io/toolkits/dashboard/>`_,
`step <https://paperboatlab.github.io/toolkits/step/>`_, and the optional
`control <https://paperboatlab.github.io/toolkits/control/>`_,
`optimization <https://paperboatlab.github.io/toolkits/optimization/>`_,
`opencv <https://paperboatlab.github.io/toolkits/opencv/>`_ and
`meshop <https://paperboatlab.github.io/toolkits/meshop/>`_.

Package structure
-----------------

A toolkit is one folder, each block is a folder in it, and everything of a block is in its
folder. Built-in packages live in ``engine/toolkit/src/<package>/``::

   engine/toolkit/src/math/
     toolkit.toml            name = "math"
     arithmetic_shared.hpp   a helper a few blocks share
     gain/
       gain.cpp              the block: defines paperboat::toolkit::math::add_gain(Registry&)
       icon.hpp              its look on the plate: a view.icon
       web/                  its UI, if it has one (see below)
       design.html           its design mockups and notes
     sum/
       sum.cpp
       icon.hpp

CMake finds each ``add_<folder name>`` from the folder names (``<block>/<block>.cpp``) and
generates the package-registration dispatcher, so a new block edits no list, manifest, registry
or description map. A block's implementation, ``BlockDef`` (including ``description``, ``view``
and its ``view.icon`` glyph) and registration stay in its folder. A manifest may add
``definitions = "blocks.toml"`` (``signal``) to embed blocks that are only TOML on a C++ parent in
the same package; they are registered after the folders. An explicit ``register = ["add_x", …]``
in the manifest replaces the folder rule. Delete the folder and the rest still builds and runs;
put it back and it works with no edit elsewhere.

A block that needs its own UI keeps it in its ``web/`` folder
(``engine/toolkit/src/<package>/<block>/web/index.tsx``; an installed toolkit's
``engine/toolkit/<package>/<block>/web/index.tsx``, or ``<package>/web/index.tsx`` for one UI for
the whole package). The web app bundles every such entry and calls its ``register(host)`` export;
``host.registerInstrument(kind,
component, { size, order })`` adds a Dashboard instrument for monitors whose block says
``instrument = kind``. ``size`` is the cell size it opens at (``compact``, ``normal``, ``large``,
``xlarge``; default ``normal``) and ``order`` its place in the automatic order (readouts 0, pictures 1,
plots 2, the default). The component gets ``name``, ``kind``, ``latest``, ``idle``, ``vector``, ``params``,
``send`` and ``state`` (``state.traces`` is the history of every monitor's signals), and from the host
its ``size``, its ``inputs`` and the ``sources`` wired into them, its ``settings`` (a table kept in the
Board layout and saved with the project, set with ``onSettings``) and ``taps`` / ``onTap`` to wire an
output in. A block says how the run samples it with ``BlockDef::whole_vector`` (a vector is one sample)
and ``sample_per_input`` (one sample per wired input, tagged with it). Nothing in the engine or the web
app names the package::

   // engine/toolkit/opencv/view/web/index.tsx
   import type { ToolkitWebHost } from "@paperboat/host";   // the app, as types only
   import "./image.css";                                     // its own styles
   export function register(host: ToolkitWebHost) {
     host.registerInstrument("image", ImageInstrument, { size: "large", order: 1 });
   }

A ``web/`` folder also holds the block's components, CSS, tests (``*.test.ts``, run by the web
app's ``npm test``) and a ``package.json`` naming its own npm dependencies (the folder is an npm
workspace; the scope's names ``uplot``). The entries are bundled at build time: after installing a
toolkit with a ``web/`` folder, run ``npm install`` and rebuild the web app (the dev server picks it
up at once). A kind nothing registered shows a plain tile with its kind and latest value.

Optional toolkits
-----------------

Optional toolkits with external dependencies live in ``engine/toolkit/<package>/`` with the same
layout plus a ``toolkit.toml`` and a package-local ``CMakeLists.txt``. The engine discovers the
folder; the package's CMake file decides whether its dependency is available. The backend links and
registers an optional package explicitly.

On an installed paperboat (a package, or ``scripts/install.sh``) there is no engine to rebuild:
``toolkit install`` puts the toolkit in ``$PAPERBOAT_HOME/toolkits/<name>/`` (default
``~/.local/share/paperboat``), builds it as a plugin against the installed SDK
(``lib/libpaperboat_plugin_<name>``, loaded by the CLI and the backends at startup), bundles its
``web/index.ts(x)`` into ``web-dist/`` for the web app (which imports it at startup from
``/__paperboat/toolkits``), and writes ``lib/paperboat-toolkit.cmake``, through which
``find_package(Paperboat)`` gives a backend ``paperboat::toolkit_<name>``.

An optional toolkit can ship 1–3 examples at its repository root. ``toolkits.toml`` gives it a
``prefix`` (``ocv``, ``opt``) and ``paperboat toolkit install <name>`` copies the examples to
``engine/toolkit/<name>/examples/`` (``$PAPERBOAT_HOME/toolkits/<name>/examples/`` on an installed
paperboat); ``paperboat backends`` lists them and ``paperboat run ocv-01``
starts the first one. The prefix keeps them distinct from the numbered ``paperboat-examples``
curriculum.

The root ``toolkits.toml`` is a catalog, not an installer: its ``repo`` is a suggested source.
A backend's ``toolkits = [...]`` declares what it needs; ``paperboat check`` verifies the local
install and never downloads. Install from any repository or local folder with
``paperboat toolkit install <name> --repo <url>`` (or ``--path <dir>``).

Optional toolkits never enter an artifact. The engine is GPL-3.0-only; an optional toolkit
carries its own licence and is installed by the user. The ``.tar.gz``, the ``.zip``, the Python
wheel and the web bundle contain no file from ``engine/toolkit/<name>/``,
``share/paperboat/toolkit/`` or a ``*toolkit_<name>*`` library. ``scripts/check_bundle.py`` enforces
this on an install tree and on every package (pb#297), the release script and CI run it, and the
engine's ``ctest`` installs into a scratch prefix and checks that too. Installing one is the user's
choice, made explicitly, and never something a package does for them.

Analyses
--------

(pb#370) Some results describe a part of the graph, not a signal at time t: a
control loop's poles and margins, say. A package offers one in two halves, and the app owns the
entry point (**Analyse** in the selection dialog, **analyse** on a subsystem's head) and the
drawer. The engine half registers a ``toolkit::AnalysisTemplate`` (``analysis.hpp``):
``name`` (``"<package>/<analysis>"``), ``def`` (``label``, ``description``) and
``run(const AnalysisRequest&) → json``. The request holds the part's signal blocks made as a run
makes them (variables resolved), the wires between them, its ``inputs`` (u: inputs nothing in the
part feeds) and ``outputs`` (y: outputs read outside it, by a monitor, or not at all), the panel's
``options`` and the run step ``dt``; throw to report what is wrong. The catalog lists the analyses
of the packages a descriptor imports. The web half registers the panel that draws the result:
``host.registerAnalysis(name, Panel)``; ``Panel`` gets ``analysis``, ``target``, ``result``,
``error``, ``busy``, ``options`` and ``setOptions``, and the drawer asks again whenever the part,
its params, the variables or the options change. An analysis is offered only when both halves are
there, so the entry points appear only with a toolkit that provides one. A block can help a linear
analysis with ``Block::linearize(in)``, its ``LinearModel`` (A, B, C, D) at an operating point::

   registry.add(toolkit::AnalysisTemplate{
       .name = "control/linear",
       .def = {.label = "Linear analysis", .description = "Poles, zeros, Bode, margins, step"},
       .run = [](const toolkit::AnalysisRequest& req) { return analyse_linear(req); }});

Documentation
-------------

A toolkit's docs live in the toolkit folder, so they install with it and a block's page goes
when its folder goes::

   engine/toolkit/control/        or engine/toolkit/src/math/
     toolkit.toml
     docs/
       index.rst                  what the toolkit is for; a toctree with blocks/index
       install.rst, guides/ …     anything else, optional
       blocks/<type>.rst          a block's prose, when the block has no folder of its own
     pid/
       pid.cpp
       doc.rst                    the block's prose, optional

The block pages are generated: ``docs/site/build.py`` takes the toolkit's catalog (the
``BlockDef`` list a backend sends; ``paperboat-catalog`` dumps it) and writes a page per block
with its description, block graphic (compact plate and card), ports and params, and the block's
``doc.rst`` (or ``docs/blocks/<type>.rst``) as its prose. Write only what the catalog can't say. Build a toolkit's site locally with::

   python3 docs/site/build.py engine/toolkit/src/math/docs /tmp/math \
       --name toolkits/math --engine engine/build/tools/paperboat-catalog --blocks engine/toolkit/src/math

The org site (``paperboatlab.github.io``) builds every toolkit's site this way and publishes it
under ``/toolkits/<name>/``, with its ``help.json``: the apps' Help window searches it and shows
a block's prose under the block's live reference.
