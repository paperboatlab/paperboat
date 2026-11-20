Technical Manual
================

This technical manual details the underlying architecture, execution semantics, protocol
mechanics, and extensibility model of the Paperboat framework.

While the :doc:`user_manual` addresses the day-to-day operation of the web interface, this
document serves developers, systems engineers, and contributors implementing stations,
embedding the engine, or authoring custom toolkits.

Architecture Overview
---------------------

Paperboat is architected as four decoupled layers:

.. code-block:: text

   ┌─────────────────────────────────────────────────────────────┐
   │ React Web Client (@paperboat/web)                           │
   │ Zero-domain UI, dynamic catalog rendering, WebGL 3D scene   │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ WebSocket (paperboat/0)
   ┌──────────────────────────────▼──────────────────────────────┐
   │ C++ Core Engine (paperboat::core)                           │
   │ Topological scheduler, session manager, HTTP/WS server      │
   ├──────────────────────────────┬──────────────────────────────┤
   │ C++ Toolkit (paperboat::toolkit)  │ Python Bindings (pybind11)  │
   │ Standard blocks, math, generators │ paperboat._engine extension │
   └──────────────────────────────┴──────────────────────────────┘

1. **C++ Core Engine (`paperboat::core`)**: High-performance, portable C++20 engine that
   manages graph compilation, cycle detection, topological execution scheduling, run clock
   stepping, and network sessions. It owns no domain physics or visual rendering logic.
2. **Standard Toolkit (`paperboat::toolkit`)**: Modular library of reusable block primitives
   (`base`, `signal`, `math`, `board`, `step`), plus optional external toolkits such as
   `control` (`paperboat-toolkit-control`).
3. **Python Bindings (`paperboat._engine`)**: Native C-extension bindings exposing the C++
   scheduler and data types to Python stations with zero protocol serialization overhead.
4. **Web Frontend (`apps/web`)**: A domain-agnostic React/TypeScript interface that builds its
   entire UI dynamically from the station's declared catalog and starter definitions.

The Scratchpad Station
~~~~~~~~~~~~~~~~~~~~~~

`engine/scratchpad` is a station made only of the first two layers: it embeds a descriptor
that imports `base`, `math`, `signal`, `board` and every optional toolkit installed in
the checkout, and defines no domain blocks. It serves on 8765, the default station port the
web app connects to, so Flow and Board work with no domain; the Station page is hidden
(there is no scene to draw). Each optional toolkit is linked and registered when it is
installed, so its blocks join the palette; the scratchpad loads without any of them. It is an
ordinary `paperboat::core::Station`; a domain station differs only in its catalog and
starters. `paperboat start` launches it with the web app; run it alone with
`npm run station:scratchpad` (or the installed `paperboat-scratchpad` binary).

Mixed Step and Signal Flow
~~~~~~~~~~~~~~~~~~~~~~~~~~

A top-level sheet may carry both layers; it remains one sheet. Per clock step:

1. Every signal block outside a story is evaluated in dependency order.
2. Step paths advance from their hats; each step block reads its signal inputs when it
   runs. Its outputs are visible to the next step block on the path in the same tick.
3. A story on an active path runs its internal signal blocks; it is a state, active only
   while the path is at it. `reset` recreates its blocks on entry.
4. Outside signal blocks and monitors see step/story outputs on the next tick. This is the
   same one-tick boundary linked blocks have, and keeps ordering deterministic.

`flow_mismatch` accepts a step block on a Signal sheet and a signal-only block on a Step
sheet at the top level; a story still runs only signal blocks. The engine selects the step
executor from the presence of step ports/stories, not from the sheet's label. `step/signal_step`
is the explicit 0/1-signal → step converter, and `step/step_signal` the way back: a path passing
through sets its held signal output `y` to `value`.

Fault Containment Principle
~~~~~~~~~~~~~~~~~~~~~~~~~~~

A fundamental guarantee of the Paperboat engine is that **a user's graph or block error
never crashes the station process**.

- Divide-by-zero, out-of-bounds array access, or uncaught exceptions thrown during a block's
  `step()` call are trapped by the execution harness.
- The engine isolates the error, tags the offending node ID, emits a `node.state = "failed"`
  event, logs an attributed error message, and transitions the run to status `failed`.
- The station remains online, accepting subsequent graph edits from the client.

The WebSocket Protocol (`paperboat/0`)
--------------------------------------

Communication between the web UI and the station is multiplexed over a single HTTP/WebSocket
connection. Every message is a structured JSON payload tagged with a `type` string. The
authoritative schema is specified in :file:`protocol/schema/paperboat-0.schema.json`.

Connection Handshake
~~~~~~~~~~~~~~~~~~~~

Upon establishing the WebSocket connection, the station initializes the client state in a
strict, ordered sequence:

.. code-block:: text

   Client                                            Station
     │                                                  │
     │ ────────────── WebSocket Connect ───────────────▶│
     │                                                  │
     │ ◀───────────── hello ────────────────────────────│ (engine name, Paperboat version, protocol, view mode)
     │ ◀───────────── catalog ──────────────────────────│ (available block & object definitions)
     │ ◀───────────── graph.load ───────────────────────│ (starter graph topology)
     │ ◀───────────── station.load ─────────────────────│ (starter station objects)
     │ ◀───────────── scene ────────────────────────────│ (initial 3D/2D visual entities)
     │                                                  │

Execution Lifecycle
~~~~~~~~~~~~~~~~~~~

When the user initiates a run, the client serializes the graph and active station into a
`graph.run` payload:

.. code-block:: text

   Client                                            Station
     │                                                  │
     │ ────────────── graph.run ───────────────────────▶│ (nodes, edges, groups, station overrides)
     │ ◀───────────── run.started ──────────────────────│ (acknowledgement with run ID)
     │                                                  │
     │ ◀─ stream ─── signal (monitor telemetry) ────────│ (per clock tick; every pass for a Scope)
     │ ◀─ stream ─── scene.patch (entity transforms) ───│ (emitted per clock tick)
     │ ◀─ stream ─── node.state (running / done) ───────│ (step flow transitions)
     │ ◀─ stream ─── run.progress (fraction 0..1) ──────│ (periodic progress update)
     │                                                  │
     │ ◀───────────── run.finished ─────────────────────│ (status: "done" | "failed" | "cancelled")
     │                                                  │

Interactive Control Messages
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

While a run is active, the client can dispatch real-time events:

- `run.cancel`: Immediately signals the scheduler to abort execution.
- `run.speed`: Changes the run's speed (`{ speed: 4 }`; `0` is as fast as it can). Pacing
  re-anchors at the moment of the change, so the run goes on from where it is at the new
  speed, and the station answers with `run.speed` (`run`, `speed`) once it took it.
- `input`: Forwards raw keyboard events (`{ key: "ArrowUp", down: true }`) to any active
  `Key` blocks in the flow.
- `station.set`: Transmits edited station properties from the Station panel. The station
  recomputes geometries and responds with an updated `scene` payload.

Differential Scene Updates (`scene.patch`)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

To sustain 60 FPS visual animation across complex 3D scenes without saturation of WebSocket
bandwidth, Paperboat employs differential entity updates:

- The initial `scene` message sends complete entity definitions (geometry type, dimensions,
  color, baseline position, rotation).
- Each subsequent simulation tick emits `scene.patch`, which carries **only modified fields**
  keyed by entity ID:

  .. code-block:: json

     {
       "type": "scene.patch",
       "entities": {
         "pendulum-bob": { "pos": [0.85, 1.42, 0.0], "rot": [0.0, 0.0, 0.73] },
         "spring-wire": { "to": [0.85, 1.42, 0.0] }
       }
     }

Engine Execution Semantics
--------------------------

Graph Compilation & Topological Ordering
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

When `graph.run` arrives, `paperboat::core::prepare_graph` validates the topology before any
block is instantiated:

1. **Catalog Verification**: Every node's `type` is resolved against the loaded `Catalog`.
   Missing types are retained in client memory as "missing" nodes, but will fail validation.
2. **Type Compatibility**: Port types must match across wires:
   - `signal` → `signal`
   - `step` → `step`
   - `vector` → `vector` (with matching component lengths)
   - `vector` → an elementwise block's `signal` port (marked `broadcast`)
   - `numbers` (a list of numbers, #24) → `numbers`, `vector` or a `broadcast` port, one unit
   - `points` (a list of points, #24) → `points`, coordinates per point and their units matching
3. **Algebraic Loops**: A loop broken by a block that reads its inputs after the pass (a
   block without feedthrough such as `Delay` or `Integrator`, a `Step` block, or a Station
   object's linked block: `read()` before the pass, `step()` after) is ordinary feedback. A
   cycle of feedthrough blocks is an algebraic loop: the sort groups its blocks (a `Loop` in
   `Graph::loops`), tears it at the first block left in graph order, and runs them together.
   Each pass, as the run reaches the loop, it solves for the torn outputs by Newton's method
   with a Jacobian of differences, then runs the loop's blocks once from the solution. Solving
   calls a stateless block's `step` many times per pass, and a block with state's
   `Block::outputs_for` (its outputs for these inputs, its state untouched), as Simulink splits
   output from update. An instance whose outputs don't depend on its inputs this step
   (`Block::feedthrough()` false: a strictly proper transfer function) is not in any loop.
   Torn outputs carry numbers or vectors. A block with state and no `outputs_for`, a singular
   loop or one that doesn't converge in 50 iterations fails the run naming a block in it.
4. **Vector Lanes**: An elementwise block (`BlockDef::elementwise`) fed a vector, straight or
   through other elementwise blocks, runs as N lanes: N instances, each given its element of
   every vector input and every number input whole, their outputs gathered into vectors of N.
   N is resolved from the wires alone, iterating to a fixed point (a block's length only grows
   from "numbers" to a vector of N), so an Integrator in a vector loop knows N before its first
   step. Two vectors of different lengths into one block fail here, naming the block and port;
   a length known only at run time into a block without feedthrough fails here too. The block's
   outputs then become vector ports of N, so a wire from one into a plain `signal` port is
   refused, and a wire into a vector port of another length is too.
5. **Topological Sort**: The execution sequence is determined via Kahn's algorithm, producing
   an execution order where every block's inputs are fully resolved before its `step()` method
   is called.

Dynamic Port Derivation (`inputs_from` & `ports_from`)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Certain blocks determine their ports dynamically based on text configuration rather than
static declarations:

- `ports_from = "signs"`: Used by algebraic summing junctions (`math/sum`). Each character
  in a sign string (e.g., `"+-+ "` generates ports `a`, `b`, `c` with their respective signs).
- `ports_from = "names"` and `outputs_from = "names"`: Mux's inputs and Demux's outputs, one
  per name in a space- or comma-separated list (`"x v theta"`), units by position from a
  `units` param; the vector port on the other side gets one component per name. Bad names fail
  the run on the block. The UI derives the same ports (`ports.ts`); both are checked against
  one fixture (`engine/tests/data/ports.json`).
- `inputs_from = "f"`: Used by free expression function blocks (`signal/function`). The engine
  invokes `Expression::free_names(text)` to scan identifier tokens in appearance order:

  - Scientific notation exponents (such as `1.5e-3`) are recognized and skipped.
  - Built-in constants (`pi`, `e`) and mathematical functions (`sin`, `cos`, `clamp`) are
    distinguished from variables.
  - The variable `t` is recognized as the simulation clock. If `t` is wired, it reads the
    external signal; if left unwired, it automatically binds to `Context::t`.
  - All other free variable identifiers become typed input ports defaulting to `0.0` when
    unwired.

Run Styles
~~~~~~~~~~

Paperboat supports three distinct execution models:

1. **Clocked Signal Flow (`ClockRun`)**:
   Fixed time step `dt` across duration `T`. Discrete-time update loop per tick:

   - Increment simulation clock: :math:`t \leftarrow t + dt`.
   - Evaluate signal blocks in topological dependency order.
   - For each station object, invoke `step(ctx, in)` using inputs gathered from linked blocks.
   - Evaluate domain-level state `DomainState::step(ctx)`.
   - Sample Monitor blocks and dispatch `signal` packets. A Scope gets one on every pass
     (the Graph and readouts wait for its frame); with a Scope in the graph the run's
     clock is the smallest solver step, so those packets are the solver's points.
   - Compute scene differential changes and dispatch `scene.patch`.

2. **Step Flow (`StepRun`)**:
   Token-passing discrete event execution.

   - Hat blocks (like `Start` or `When`) initiate concurrent execution paths.
   - Blocks implement `enter(ctx)` and `tick(ctx, in)`. When a block completes its task, it
     indicates which outgoing step wire the token should traverse next.
   - Story groups act as atomic procedural steps, executing their internal signal subgraphs
     for a prescribed duration before passing control to the subsequent step.

3. **Once Flow (`OnceRun`)**:
   Non-clocked, single-pass batch execution.

   - Suitable for CAD model generation, build automation, dataset extraction, or image
     processing pipelines.

Run Replay
~~~~~~~~~~

Replay is an app-side view of the last run (#284); the engine keeps sending the same
`signal` and `scene.patch` messages it always did.

- **Samples** live in the trace store (`apps/web/src/traces.ts`), a typed-array ring per
  channel. `valuesAt(node, t)` is the latest sample at or before `t` (a zero-order hold);
  `span()` and `step()` give the scrubber's ends and its :math:`\Delta t`. Text samples are
  not stored, so a readout falls back to its latest value.
- **Station motion** lives beside it in `ReplayStore` (`apps/web/src/replay.ts`): the scene
  on screen when `run.started` arrived (the base), then each `scene.patch` at the run clock.
  `entitiesAt(t)` rebuilds the base with the patches up to `t`. The built-in Scene and a web
  Station both read that scene; the web Station receives it as a normal `scene` message.
- **The playhead** is `EngineState.replay` (`{active, playing, time, from, to, speed}`), driven
  by the reducer's own `replay.*` actions, not by the station. While it is open, Board
  readouts, wire probes into monitors (`node:port`) and Scope needles read `t`; live, they
  read the latest message.
- **Records**: `paperboat run --record <dir>` and `paperboat open … --record <dir>` set
  `PAPERBOAT_RECORD` for the station; `engine/core/src/record.cpp` keeps the run's `signal`
  and `scene.patch` messages (and the `graph.run` request) and writes `<dir>/record.json` when
  `run.finished` arrives. The CLI adds the version, command line and station version to the
  environment. In the app, `File > Save run record…` writes `{paperboat: 0, run, channels,
  scene}` and `File > Open run record…` loads channels and scene patches into the stores; it
  accepts the engine's `signals` array too, so both files open.

The Descriptor System (`descriptor.toml`)
-----------------------------------------

The descriptor file defines the metadata, palette offerings, and starter configurations
for a station app. It is strictly declarative: **it never defines block implementations**,
which reside exclusively in C++ or Python code.

Schema Breakdown
~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 22 78

   * - Field
     - Description
   * - `domain`
     - Domain namespace string (e.g., `"robotics"`). Blocks registered under this package
       are imported automatically into the palette.
   * - `import`
     - Array of toolkit packages to load into the catalog (e.g., `["base", "signal", "math", "board"]`).
   * - `[[blocks]]`
     - Customizes or specializes a block template. May override `label`, `defaults`, or
       supply a custom `config` expression to specialize an extensible parent (such as `signal/generator`).
   * - `[[objects]]`
     - Declares station object templates, property defaults, and linked block associations.
   * - `[graph]`
     - Defines the initial starter flow topology (`nodes`, `edges`, `groups`).
   * - `[station]`
     - Defines initial station objects, scene camera view presets (`2d`, `3d`, or `web`),
       coordinate extents, and whether the Station page is shown by default (`visible`).
   * - `[board]`
     - Declares the default layout of instrument tiles, section groupings, and formatted
       label cards.

Extending Parent Blocks in Descriptors
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

A station can generate specialized domain blocks directly in TOML by extending parent
templates without writing C++ code:

.. code-block:: toml

   [[blocks]]
   use = "signal/generator"
   type = "chirp"
   label = "Chirp Signal"
   params = { f0 = 1.0, f1 = 10.0, sweep_time = 5.0 }
   config = { f = "sin(2 * pi * (f0 + (f1 - f0) / sweep_time * t) * t)" }

Station Pipeline & Web Stations
-------------------------------

Built-in 3D / 2D Entity System
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The built-in station renderer represents scenes as collections of basic geometric entities:

- `box`: Dimensions :math:`[s_x, s_y, s_z]`, transform :math:`[p_x, p_y, p_z]`, rotation Euler angles :math:`[r_x, r_y, r_z]`, color hex or RGB array.
- `sphere`: Radius :math:`r`, center transform :math:`[p_x, p_y, p_z]`.
- `line`: Segment from :math:`\mathbf{p}_1` to :math:`\mathbf{p}_2`, stroke width, color.
- `image`: Aspect ratio, texture URL or data URI, billboard orientation.

Web Stations (Custom HTML5 / WebGL)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

For domains requiring specialized visual presentations (such as GIS mapping, architectural
CAD, or custom HTML5 games), stations can provide a custom web station:

1. Configure `descriptor.toml`:

   .. code-block:: toml

      [station]
      view = "web"
      page = "station/index.html"

2. The C++ engine serves the contents of the station's `station/` directory over HTTP on the
   station port.
3. The client embeds the page in a secure, sandboxed iframe.
4. The client injects the communication bridge at `/paperboat/station.js`:

   .. code-block:: html

      <canvas id="canvas"></canvas>
      <script src="/paperboat/station.js"></script>
      <script>
        paperboat.on("entities", (entities) => {
          renderCustomScene(entities);
        });
        paperboat.on("signal", (sig) => {
          updateLiveGauges(sig);
        });
      </script>

The bridge enforces strict security boundaries: the iframe has no parent DOM access and
communicates exclusively through structured message passing.

Project Serialization Format
----------------------------

Projects are serialized as formatted JSON (``*.psf``):

.. code-block:: json

   {
     "paperboat": 0,
     "station": "mass-spring",
     "flow": {
       "nodes": [{ "id": "sine-1", "type": "sine", "pos": [120, 80], "params": { "freq": 1.5 } }],
       "edges": [{ "from": ["sine-1", "y"], "to": ["mass-1", "force"] }]
     },
     "station": {
       "objects": [{ "id": "mass-1", "type": "mass", "props": { "m": 2.5, "k": 40.0 } }]
     },
     "variables": [
       { "name": "damping", "type": "number", "value": 0.15, "unit": "N*s/m" }
     ],
     "board": {
       "instruments": [{ "block": "plot-1", "size": "large", "at": [0, 0] }]
     },
     "run": {
       "duration": 15.0
     }
   }

Properties matching default values are omitted, producing clean, compact diffs ideal for
version control in Git.
