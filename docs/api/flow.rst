The Flow
========

Graphs
------

A graph is blocks (nodes) and wires (edges), sent with ``graph.run``. The backend checks it
against its catalog and station, makes an instance of each block, and runs it.

- **A wire joins ports of one type** (step to step, signal to signal, image to image). A
  signal input takes one wire; a step output leads to one block.
- **An unconnected input reads as 0** (absent from ``in``). A missing param takes its
  default.
- **A signal loop through blocks with feedthrough is an algebraic loop, solved each pass.**
  A loop through a linked block, a step block or a block without feedthrough (they read
  their inputs after the pass) is an ordinary feedback loop. In an algebraic loop the engine
  tears a wire and solves for its value (Newton's method), so ``y = 2 (r - y)`` gives
  ``y = 2r/3``. A block with state takes part through ``Block::outputs_for`` (transfer
  functions and PID do), and a strictly proper transfer function has no feedthrough at all, as
  in Simulink. A block with state that can't, a loop with no single solution (a gain of 1 around it) or one that doesn't converge fails the run, naming
  a block in it.
- **A run never crashes the backend.** A bad graph or a failing block fails the run with
  an error ``log`` and ``run.finished`` ``failed``.

Signal flow
-----------

Blocks run in dependency order. With the ``Clock`` run style they run every clock step
(``dt``) for ``duration`` seconds; after each pass station objects step under their linked
blocks' inputs, then the domain state steps (and may end the run). With ``Once`` they run a
single time, and wires may carry lists, tables, text or handles.

Step flow
---------

A graph with step ports is a Step flow. **Hats** (blocks with step outputs and no step
input: Start, When) start **paths**. A path is at one block at a time: the engine calls
the block's ``enter`` when the path arrives and ``tick`` each clock step until it names the
step output to leave by. Signal blocks still run each clock step first and feed
conditions. Several paths run side by side; a path reaching a block another path is in
waits; Stop ends the run. ``node.state`` reports ``running`` and ``done`` for each block a
path passes.

Groups
------

``graph.groups`` holds groups of blocks (a block is in at most one). Groups nest (``parent``). A
subsystem's or story's ports are the wires crossing its edge, plus any listed in ``expose``
(``{ side = "in" | "out", to = [node, port], name? }``): ports shown on the block with no wire yet,
and the name the user gave a port (absent: ``node.port``). In the UI, select a block inside an open
group and use **Expose port**; removing the last wire across the edge exposes its port, so it stays;
inside, double-click an In or Out pill's name to rename the port, × removes it. Copy and paste take
a group with everything in it.

**Visual groups** tidy the canvas. The backend runs their blocks as if ungrouped, in the
sheet's flow type. Collapsed, the UI draws a group as one block whose ports are the wires
crossing its edge.

**Story groups** are steps. A story's id is a node with step ports ``in`` and ``next``, and
its blocks (signal blocks only) run only while a path is at it: once per clock step for
``params.seconds`` (``0``: once), then the path leaves by ``next``. What they computed stays
on their outputs, so the next story reads the results. With ``params.reset`` its blocks
are made afresh each time a path arrives, so a story in a loop starts over. A test
procedure reads as
``Start → Pull test (6 s) → Check (once)`` (``paperboat-examples/chain-python``); an
animation as ``Start → Walk a square → Spin (2 s) → Report (once)``
(``paperboat-examples/animation-python``, where Walk a square is a visual group of step
blocks and Spin a story around a signal block that turns the actor while it runs).

.. code-block:: json

   {"groups": [{"id": "pull test", "kind": "story", "nodes": ["pull", "x of mass-2"], "params": {"seconds": 6}},
               {"id": "check", "kind": "story", "nodes": ["limit", "overloaded"]}]}

A node may also carry ``unfolded: true``: the UI shows a block that has a plate as its card on the
canvas (the user pressed **unfold**). Like ``pos``, ``ports`` and ``rotation``, backends ignore it.

Lost and failing blocks
-----------------------

A block whose type the backend doesn't offer (an old graph, a block renamed in code)
stays on the canvas as a red **missing** block, with its type, params and wires; a run
with it fails and names it. When a block fails a run (an unknown type, an error it
throws, a bad wire's end), the backend sends ``node.state`` ``failed`` for it and puts its
id in the error ``log`` (``node``); the UI marks it, and the Console line links to it.

The canvas survives a backend coming back: if the user changed the graph since the same
backend loaded it, the graph stays and is checked against the new catalog.

Commented and bypassed blocks
-----------------------------

Nodes in ``graph.nodes`` may optionally declare ``commented: true`` alongside an optional
``comment_mode`` (``"out"`` or ``"through"``, defaulting to ``"out"``):

- **Comment out** (``"out"``): The engine excludes the block from the execution schedule and
  dependency ordering. Downstream blocks connected to its output ports receive default unsupplied
  values (e.g. ``0.0``). Feedback cycles passing through commented-out blocks are not
  algebraic loops. In Step flows, tokens reaching a commented-out step block terminate
  cleanly.
- **Comment through / bypass** (``"through"``): The engine bypasses the block's internal calculation.
  For single-input single-output (SISO) blocks or blocks with identically named input and output
  ports, incoming signals pass directly to matching outputs. In Step flows, step execution tokens
  immediately pass through to the ``next`` output.
- **Block notes**: Nodes can carry a ``comment`` string for documentation and design rationale,
  stored in the project file without affecting execution.

