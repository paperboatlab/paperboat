Paperboat Launcher
==================

The **Paperboat Launcher** is the desktop window over the Paperboat CLI. It installs and
updates the Squero Studio apps, runs stations, manages optional toolkits and gives you a
console for any ``paperboat`` command without leaving the window.

The Launcher bundles the CLI and the C++ SDK, so installing it is a complete install. It
shares ``$PAPERBOAT_HOME`` with a separately installed CLI; apps, toolkits and stations
are the same in both.

Starting it
-----------

After installing the Launcher package (:ref:`paperboat-launcher`), start it from your
applications menu, or from a terminal:

.. code-block:: sh

   paperboat launcher

From a checkout, run it without installing the package:

.. code-block:: sh

   npm run electron -w @paperboat/launcher

The window
----------

The left rail has four pages:

.. list-table::
   :header-rows: 1
   :widths: 18 82

   * - Page
     - What it is for
   * - **Apps**
     - Install, launch and update Paperboat and the Squero Studio apps; see live
       sessions and start any station quickly.
   * - **Stations**
     - Browse station projects, run one, build it, verify it, package it as ``.pst``.
   * - **Toolkits**
     - Install, update and remove optional toolkits; browse the blocks they add.
   * - **Console**
     - Run any ``paperboat`` command, see its output and keep the history.

The top bar changes with the page. On **Apps** it carries the channel switch
(``release`` / ``beta`` / ``dev``), **Check for updates** and the version/status pill. On
**Stations** it has **Open .pst…**, **+ New** and the source filter. On **Toolkits** it has
**+ Install toolkit…** and the block-kind filter. The right end always has the theme
control.

:kbd:`Ctrl` + :kbd:`K` opens the command palette; :kbd:`Alt` + :kbd:`1` … :kbd:`4` jump
to Apps, Stations, Toolkits and Console.

Apps
----

The Apps page has three cards and an **Active Sessions** panel.

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Card
     - Actions
   * - **Paperboat**
     - **Launch** starts the web app (port 3047 by default) and opens it; **Stop** ends
       it; **Update** updates the CLI on the selected channel.
   * - **Squero Studio OM**
     - Pick a version (``dev`` or a release tag), **Install**, then **Launch** /
       **Open** / **Stop**; **Update** and **Uninstall** once installed.
   * - **Squero Studio MX**
     - The same, with its own version picker. MX also installs the Julia kernel and the
       shared UI it needs.

**Install an app.** Pick the version in the card's select, press **Install**, and watch
the inline feedback. The Launcher runs ``paperboat squero install <name>@<version>``; the
app's dependencies are installed first. **Update all** at the top of the page updates
every installed app; the version lists on the cards are refreshed when the page opens,
and **Check for updates** checks the CLI on the selected channel.

**Missing prerequisites.** If an app needs a tool that is not on ``PATH``, its card shows
``Needs: …`` with the missing names. Install them with your OS package manager (the
:ref:`installation` page lists what each app needs), then press **Install** again. The
Launcher does not install system packages itself.

**Installed or workspace.** An app from a checkout (for example, this repository's
neighbours) is marked **workspace**; it is already ready and is not reinstalled. An
installed app shows its version and can be uninstalled from the same card. Uninstalling
an app removes its folder from ``$PAPERBOAT_HOME/apps``; it does not touch your projects.

**Active Sessions.** Pick a station or an app in the quick-launch select and press
**Start**. The list shows each running or starting process with its port and URL:
**Open** opens the web app or the app's own window; **Restart** and **Stop** act on that
process; **Logs** jumps to the Console. **Stop all** ends every session.

Stations
--------

The Stations page lists the station projects Paperboat can run: examples, installed
stations and the built-in scratchpad. Use the filter box or the source switch
(``all`` / ``builtin`` / ``example`` / ``installed``).

.. list-table::
   :header-rows: 1
   :widths: 26 74

   * - Action
     - What it does
   * - **Open folder…**
     - Add a station project from a local folder to the list.
   * - **Open .pst…**
     - Open a packaged station: unpack it into the local station store or run it
       directly.
   * - **Open .psf…**
     - Open a saved Paperboat project in the web app.
   * - **New**
     - Scaffold a C++, Python or Julia station that passes ``paperboat check``.
   * - **Fetch examples**
     - Fetch the official example stations.

Select a station to open its sheet:

- **Run** starts it on the selected port (with **Options** for ``--no-build``,
  ``--clean``, ``--time``, ``--verbose`` and ``--var key=value``). While it runs, the
  button changes to **Open in Paperboat**, **Restart** and **Stop**.
- **Build** and **Rebuild (--clean)** compile a C++ station. Python and Julia stations
  show **Install dependencies** instead.
- **Pack .pst** writes a portable station package.
- **Verification** runs the four stages of ``paperboat check`` — manifest, catalog,
  smoke and golden — with a green/red step for each. **Fast** skips the slower stages.
- **Open folder** reveals the project; an installed station also has **Uninstall**.

The built-in scratchpad is a prebuilt station: it has no source build, check or package
actions, but it can be run and opened like any other.

Toolkits
--------

The Toolkits page shows the built-in packages and the optional toolkits in the catalog.
A dot and a badge say whether an optional toolkit is installed; the panel counts what is
installed and lists the blocks it adds.

- Pick a version from the select and press **Install**. The toolkit is built as a plugin
  against the installed SDK, so the engine does not rebuild.
- **Update** moves an installed toolkit to a newer version; **Uninstall** removes it and
  its blocks. Built-in packages cannot be uninstalled.
- **+ Install toolkit…** installs from a Git repository or a local folder; this is the
  path for a toolkit that is not in the catalog.
- **Update all** updates every installed optional toolkit.
- The block cards show each block's label, type, kind (flow, station or board) and
  description. The search box and the **Kind** switch narrow the list.

Installing a toolkit makes its blocks available to stations that import its package. The
block cards on this page show what it adds; start the station again so it loads the new
plugin.

Console
-------

The Console runs the same commands you would type in a shell:

.. code-block:: text

   paperboat› status
   paperboat› pkg list
   paperboat› toolkit list
   paperboat› stations

The prompt completes commands and names with :kbd:`Tab`; :kbd:`→` accepts the grey
suggestion; :kbd:`↑` and :kbd:`↓` walk the history. **Help** prints the CLI reference,
**Clear** empties the view, **Copy all** copies the transcript, and **Stop active CLI
task** cancels the command that is running. **Logs** on a card or a session also lands
here.

The Console is not a second implementation: it calls the bundled ``paperboat`` binary and
shows its output. A command that works in the CLI works here.

Keys
----

.. list-table::
   :header-rows: 1
   :widths: 26 74

   * - Key
     - Action
   * - :kbd:`Ctrl` + :kbd:`K`
     - Command palette: search every action on the current page.
   * - :kbd:`Ctrl` + :kbd:`O`
     - Open a ``.pst`` package.
   * - :kbd:`Ctrl` + :kbd:`N`
     - New station project.
   * - :kbd:`Alt` + :kbd:`1` … :kbd:`4`
     - Apps, Stations, Toolkits, Console.
   * - :kbd:`Escape`
     - Close the open dialog.
   * - :kbd:`Tab`, :kbd:`→`, :kbd:`↑`, :kbd:`↓`
     - Completion, accept suggestion, history (in the Console prompt).

Storage and cleanup
-------------------

Apps, toolkits and stations live under ``$PAPERBOAT_HOME`` (default
``~/.local/share/paperboat`` on Linux/macOS, ``%LOCALAPPDATA%\paperboat`` on Windows).
Removing an app or toolkit from the Launcher removes that folder; your own projects,
``.psf`` files and station folders elsewhere are never touched. Uninstalling the
Launcher package leaves ``$PAPERBOAT_HOME`` in place; delete it by hand for a clean
slate.

If something fails
------------------

- **``Needs: …`` on an app card.** A build tool or runtime is missing. Install it and
  retry; :ref:`installation` lists the requirement for each app.
- **A build or install fails.** Open the Console or the task's **Logs**; the last lines
  are kept there. The same command in a terminal shows the full output.
- **A station is still starting.** A C++ station compiles before it serves. The status
  pill and the session row show the stage; ``paperboat status`` in the Console gives the
  same detail as JSON.
- **The port is taken.** Change the station's port in its Run sheet. The apps use their
  own ports (OM 59201, MX 59202); the session row shows the URL they actually opened.

.. seealso::

   :ref:`installation` — CLI, development package and Launcher installs, with all
   prerequisites.
