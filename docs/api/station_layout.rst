Station Layout & Packaging
==========================

A Paperboat station is a self-contained domain service written in C++ or Python. It supplies domain-specific physics, models, algorithms, and visualization scenes to the Paperboat engine.

Every station directory follows a standard layout defined by a ``station.toml`` manifest. Stations can be verified with ``paperboat check`` and packaged into portable archives (``.pst``) with ``paperboat pack``.

.. note::
   The station manifest schema is currently **format = 0** (pre-1.0). The schema formalises existing conventions and may evolve as packaging and extension capabilities expand.

Standard Directory Layout
-------------------------

A complete station folder contains the following structure:

.. code-block:: text

   my-station/
   ├── station.toml          # Package and runtime manifest (format = 0)
   ├── descriptor.toml       # Domain blocks, station objects, and starter flow
   ├── domain/               # Domain source files (C++ or Python)
   │   ├── ...
   ├── CMakeLists.txt        # C++ build definition (for C++ stations)
   │   # or server.py / pyproject.toml (for Python stations)
   ├── main.cpp              # C++ main entrypoint (for C++ stations)
   ├── expected.json         # Headless golden test assertions (optional)
   ├── data/                 # Static assets, models, or sample datasets (optional)
   ├── .paperboatignore      # File exclusions for packaging (optional)
   └── README.md             # Documentation and usage notes

Station Manifest (``station.toml``)
-----------------------------------

The ``station.toml`` file at the root of the station folder configures identification, runtime entry points, and verification settings.

.. code-block:: toml

   [station]
   format = 0
   name = "cart-pole"
   version = "0.1.0"
   engine = ">=0.1"
   language = "cpp"
   run = "build/paperboat-cart-pole"
   port = 8766
   descriptor = "descriptor.toml"
   solver = "rk4"                   # optional: default solver ("rk4", "rk45", "rk2", "euler", "discrete", "cvode", "ida")
   toolkits = ["opencv"]            # optional: required toolkits

   [run.solver_options]             # optional: the solver's options (#196)
   rtol = 1e-7                      # rk45, cvode, ida: tolerances, smallest and largest sub-step
   max_step = 0.001
   sub_steps = 4                    # rk4, rk2, euler: fixed sub-steps per clock step

   [test]
   golden = "expected.json"         # optional: golden test specification

Field Reference
~~~~~~~~~~~~~~~

``[station].format``
  *Required integer*. The manifest schema format version. Must be ``0`` in current releases.

``[station].name``
  *Required string*. Unique identifier for the station (e.g. ``"cart-pole"``, ``"parts"``). Used in packaging and discovery.

``[station].version``
  *String*. Semantic version of the station (default: ``"0.1.0"``).

``[station].engine``
  *String*. Version constraint for the Paperboat engine/protocol compatibility (e.g. ``">=0.1"``).

``[station].language``
  *Required string*. The station runtime language: ``"cpp"`` or ``"python"``.

``[station].run``
  *Required string*. Relative path to the compiled binary (e.g. ``"build/paperboat-parts"``) or entry script (e.g. ``"server.py"``). The CLI passes ``--port <N>`` and optional variables when starting the process.

``[station].port``
  *Integer*. Default TCP WebSocket port for the station (e.g. ``8766``).

``[station].descriptor``
  *String*. Relative path to the domain descriptor file (default: ``"descriptor.toml"``).

``[station].solver``
  *Optional string*. Default numerical ODE solver for simulation runs and dynamic models (``"rk4"``, ``"rk45"``, ``"rk2"``, ``"euler"``, ``"discrete"``, or the implicit ``"cvode"`` and ``"ida"`` for stiff systems: SUNDIALS, see :cpp:func:`paperboat::toolkit::solve::make`). May also be placed under ``[run].solver``. If the built-in solvers API or continuous blocks/models are used and unspecified, defaults to ``"rk4"``. It is the run's solver: every block and station object whose own ``solver`` is ``auto`` uses it, until the Run menu picks another.

``[run.solver_options]``
  *Optional table*. The run's solver options: ``rtol``, ``atol``, ``min_step``, ``max_step``, ``max_steps`` (``rk45``, ``cvode``, ``ida``) and ``sub_steps`` (``rk4``, ``rk2``, ``euler``); see :cpp:struct:`paperboat::toolkit::solve::Options`. ``paperboat`` passes ``[run]`` to the station it starts (``PAPERBOAT_RUN``), which announces it in ``hello.run``; Run > Solver settings… overrides it per run.

``[station].toolkits``
  *Optional list of strings*. Optional toolkits this station requires (e.g. ``["opencv"]``), or ``["__all__"]`` to import and require all toolkits and built-in packages available in the Paperboat repository. ``paperboat check`` verifies that each is installed locally and reports what is missing; it never downloads. Install one from any repository or local folder with ``paperboat toolkit install <name> --repo <url>`` (or ``--path <dir>``); ``toolkits.toml`` only suggests a source.

``[test].golden``
  *Optional string*. Path to the golden test expectations file (e.g. ``"expected.json"``) for headless verification.

Verification (``paperboat check``)
----------------------------------

The unified CLI provides ``paperboat check`` to validate a station through a four-stage pipeline:

.. code-block:: bash

   paperboat check [path] [--fast] [--json]

Stages
~~~~~~

1. **Manifest & Layout**: Validates ``station.toml`` syntax and fields (including ``solver`` against supported algorithms), verifies that descriptor, build files, and golden files exist, checks toolkit prerequisites, and validates descriptor syntax with line-accurate error reporting.
2. **Catalog & Block Completeness**: Confirms that all templates imported or referenced in ``[[blocks]]`` and ``[graph]`` exist either in built-in toolkits, declared optional toolkits, or domain code. When ``toolkit = ["__all__"]`` or ``import = ["__all__"]`` is specified, all built-in packages (``base``, ``board``, ``list``, ``math``, ``signal``, ``step``, ``string``) and installed toolkits are loaded into the catalog. Also checks whether the built-in solvers API or continuous blocks/models are used, ensures a valid solver is resolved, and verifies solver instantiation.
3. **Live Protocol Smoke Test**: Builds C++ stations incrementally or prepares the Python environment, allocates an isolated ephemeral TCP port, spawns the station, and runs ``protocol/smoke_test.py`` over WebSockets. Skipped if ``--fast`` is specified.
4. **Golden Run Comparison**: Executes the starter flow headless (``--run``), validates all emitted events against JSON Schema, and verifies output tolerances and signals against ``expected.json``. Skipped if ``--fast`` is specified or no golden test is declared.

Packaging (``paperboat pack`` & ``unpack``)
-------------------------------------------

Pack a Station
~~~~~~~~~~~~~~

.. code-block:: bash

   paperboat pack [path] [--out <archive.pst>]

Runs a fast verification check on the station, strips build junk (``build/``, ``__pycache__/``, ``.venv/``, ``*.o``, ``*.so``, and patterns in ``.paperboatignore``), calculates SHA-256 integrity digests for all included files, and creates an archive named ``<name>-<version>.pst``.

Unpack a Station
~~~~~~~~~~~~~~~~

.. code-block:: bash

   paperboat unpack <archive.pst> [--dir <target_dir>]

Extracts the archive into the target directory, validates all extracted files against the embedded ``PACKAGE.json`` SHA-256 digests, and executes a verification check to ensure the station is immediately ready to run.
