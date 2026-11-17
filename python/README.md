# paperboat (Python bindings)

Python bindings for the [Paperboat](../README.md) C++20 engine (`paperboat._engine`, built with
nanobind). Write a backend's domain blocks and state in Python while the C++ engine loads the
descriptor, schedules the graph, runs built-in toolkit blocks and serves the `paperboat/0`
protocol.

**Docs:** <https://paperboatlab.github.io/paperboat/python.html> (sources in [`../docs/api/`](../docs/api/))

## Use

```python
import paperboat

class Force(paperboat.Block):
    type, label, kind = "F1", "F1 · Force on mass", "source"
    inputs = ["force"]

    def step(self, ctx, inputs):
        ctx.state.force += inputs.get("force", 0.0)
        return {}

class MassSpring(paperboat.DomainState):
    def step(self, ctx): ...
    def entities(self): return [...]

paperboat.serve(paperboat.Backend(
    engine="mass-spring",
    descriptor="descriptor.toml",
    blocks=[Force],
    state=MassSpring,
    mode="clock",
    port=8765,
))
```

## Build

Requires Python 3.11+ (`python3-devel`), CMake 3.25+ and a C++20 compiler (prepackaged releases
already ship `paperboat._engine` in `lib/paperboat/python`):

```sh
npm run build:python
pip install ./python
```

## Check

```sh
pytest python/tests
```
