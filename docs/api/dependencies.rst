Adding a library to a station
=============================

A station declares its dependencies next to ``station.toml``; ``paperboat deps install`` creates an
isolated environment for it, so the host's Python or Julia environment is never used.

Python
------

.. code-block:: text

   my-station/
     station.toml          # language = "python"
     requirements.txt      # pinned packages, e.g. numpy==2.1.3
     server.py
     .venv/                # created by paperboat deps install (not packed)

.. code-block:: sh

   paperboat deps install my-station
   paperboat run my-station

``deps install`` runs ``python3 -m venv .venv`` and ``.venv/bin/python -m pip install -r
requirements.txt``. ``paperboat check`` fails with ``Python dependencies are not installed: run
paperboat deps install`` when ``requirements.txt`` lists packages but ``.venv`` is missing (a file
with only comments, as ``paperboat new`` writes it, needs no environment).

Import the package in a block as usual (``import numpy as np`` at the top of ``domain/blocks.py``).

``$PAPERBOAT_PYTHON`` still selects a different interpreter; the station venv wins when it exists.
The host's ``PYTHONPATH`` and ``PYTHONHOME`` never reach a station: its ``PYTHONPATH`` holds only
the ``paperboat`` package.

Julia
-----

.. code-block:: text

   my-station/
     station.toml          # language = "julia"
     Project.toml
     Manifest.toml
     server.jl
     .julia/               # created by paperboat deps install (not packed)

.. code-block:: sh

   paperboat deps install my-station

Add a package with ``Pkg.add`` in the station's own environment, then ``using`` it in a block:

.. code-block:: sh

   JULIA_DEPOT_PATH=.julia julia --project=. -e 'using Pkg; Pkg.add("StaticArrays")'

``deps install`` runs ``julia --project=. -e 'using Pkg; Pkg.instantiate()'`` with
``JULIA_DEPOT_PATH=<station>/.julia``, ``JULIA_PROJECT=<station>``, ``JULIA_LOAD_PATH="@:@stdlib"``
and ``JULIA_NUM_THREADS=1``. The host ``~/.julia`` and ``@v1.11`` environment are not used, and the
host's ``JULIA_*`` variables are overridden. ``paperboat check`` fails when ``Project.toml`` exists
without ``Manifest.toml``.

``paperboat run`` starts ``julia --startup-file=no --project=<station> server.jl`` with the same
environment; ``paperboat check`` and ``pack`` work for a Julia station. See :doc:`julia` for the
block API and the host pump.

C++
---

C++ dependencies are CMake packages or optional toolkits. A block every domain could use belongs in
a toolkit: declare it in ``toolkit_requirements.toml``. A library only your domain needs is linked
from the station's ``CMakeLists.txt`` (``find_package`` and ``target_link_libraries`` on the station
executable). There is no runtime package install.

What is packed
--------------

``paperboat pack`` includes the lockfiles (``requirements.txt``, ``pyproject.toml``,
``Project.toml``, ``Manifest.toml``) and excludes the environments (``.venv/``, ``.julia/``,
``build/``); it says so after packing.

Offline and air-gapped installs
-------------------------------

``paperboat pack --bundle-deps`` adds what an offline install needs:

- **Python:** wheels for every requirement, built with ``pip wheel`` into ``wheels/``. On the
  target, ``paperboat deps install`` sees ``wheels/`` and installs from it with ``--no-index``.
- **Julia:** the station's ``.julia/`` depot (run ``paperboat deps install`` before packing).
  ``Pkg.instantiate`` on the target finds every package already there.

Wheels match the packing machine's platform and Python version. For a different target, or for the
strongest isolation, run the station in a container.
