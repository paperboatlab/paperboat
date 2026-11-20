Concepts
========

The app and the station
-----------------------

The UI knows no domain. On connect a station sends what its app offers (a **catalog** of
blocks and station objects), the starters (a graph and a station) and how its Station
looks; the UI builds every page from that. The station runs what the user builds and
reports back. They speak JSON over one WebSocket (:doc:`protocol`).

.. code-block:: text

   UI (any station)                     station = engine + domain code
   ─────────────────                    ──────────────────────────────
   Station   ── station.set ─────────▶  station objects (props, links)
   Flow      ── graph.run ───────────▶  graph checked, blocks made, run
   Board ◀── signal ─────────────   monitors' samples
   Station   ◀── scene, scene.patch ─   what the station looks like now
   Console   ◀── log, node.state ────   what happened, and where

Station and Flow (ISA-88)
-------------------------

The **Station** is the equipment: the things a domain acts on, as **station objects**
with **properties** (a cart-pole's masses and initial angle, a photo's file, a spring's
stiffness). Properties are edited on the Station page only. Objects may **link** to each
other (a spring holds two masses).

The **Flow** is the procedure: a graph of **blocks** joined by **wires**. A station object
may spawn a **linked block** on the Flow page (same id), the only way a flow pushes on it
or reads it. A flow never sets a property.

Blocks
------

A block has a **definition** (``BlockDef``: type, label, kind, ports, params) and, when a
graph runs, an **instance** that owns its state. Kinds: ``source`` (pushes into the
domain), ``probe`` (reads it), ``function`` (computes), ``monitor`` (shows a value on the
Board as an instrument).

Ports have a **type**: ``signal`` (a value), ``step`` (control, in a Step flow), or a shape
such as ``image``, ``points`` or ``vector`` (an ordered numeric value on one wire; ``numbers``
remains a compatible name). A vector may declare its length and component labels/units. A
wire joins compatible ports of one type. **Mux** and **Demux** join numbers into a vector
and split one back out, and an **elementwise** block (Gain, Sum, Integrator, PID…) works
on a vector one element at a time, so a whole state is wired, scaled and integrated as one
line (see :ref:`elementwise`).

Definitions live in **code**, next to what the block does: C++ ``define_block``, Python
class attributes. The **toolkit** offers built-in packages of them (``base``, ``signal``, ``math``,
``board``, ``step``) and optional external toolkits such as ``control``
(``paperboat-toolkit-control``), ``opencv`` (``paperboat-toolkit-opencv``) and ``optimization``
(``paperboat-toolkit-optimization``);
a domain registers its own in a package
named after the domain. A **descriptor** (:doc:`descriptor`) picks which packages and
templates an app offers, customises them and holds the starters. It never defines a block.

.. _elementwise:

Elementwise blocks
------------------

A block marked ``elementwise`` (a catalog flag; its signal ports carry ``broadcast``) is
written for one number but takes a vector wire too: Gain on a 6-vector scales all six.
With only numbers in, it works as before. With a vector in, every vector into it must
have one length N, numbers broadcast to every element, and the outputs are vectors of N
with the input vector's component labels. Stateful ones keep one state per element: an
Integrator fed a 3-vector holds three integrals, a PID three controllers. The length is
found from the wires before the run, so a vector loop through an Integrator works; if it
can't be (a vector of a length known only at run time feeding an Integrator), the run fails
naming the block. A block's reference page says when it is elementwise.

Flow types and run styles
-------------------------

**Signal flow**: values flow along wires; blocks run in dependency order, every clock step
(``Clock``) or once (``Once``: a build, a query, an image pipeline). **Step flow**: control
passes along step wires from one block to the next (Start, When, Wait, If, Repeat, Stop,
and the domain's own steps); signal blocks still run each clock step and feed conditions.
**Story groups** make a Step flow read as a procedure: simulate, then check, then report.
See :doc:`flow`.

Domain state
------------

What a domain's blocks share during a run (a game, a document, a physical system) is its
**domain state**, a ``DomainState`` the engine makes fresh for each run, steps after each
clocked pass and draws on the Station. Station objects are per-thing state the user sets
up; the domain state is domain-wide state the station owns. Neither is required.

The principle
-------------

Paperboat is a framework, not a simulator: a station can be anything. Everything generic
(protocol, sessions, graph checks, runs, values, toolkit blocks) is the C++ engine's; a
station adds only its domain. Python binds the engine; it never re-implements it.
