# App servers

What `paperboat` tells an app's server when it starts one (`app open`, `example open`, `session
restart`), and what the server can ask of it back. The server is a native process, its own process
group, with its output in `<runtime dir>/sessions/<app>-<port>.log`.

```text
<launch> [<folder>] --port <port>        cwd: the folder (none: $HOME, the Start page)
```

## Examples (pb#85)

An example is opened where it is: a paperboat-examples checkout, `$PAPERBOAT_EXAMPLES_DIR`, or
GitHub's copy in `<home>/cache/examples`. Its server is told so explicitly; it doesn't need to work it
out from where the folder is.

| what | where |
| --- | --- |
| `PAPERBOAT_EXAMPLE=<id>` | the server's environment, when `example open <id>` started it (`hubs/lab`, `julix/02-plots`). Never set otherwise: a server started for a plain folder or a copy (`example copy --open`) has none, even when paperboat itself was run with one |
| `"example": "<id>"` | the session's record (`session list --json`, `app open --json`); `""` for a plain folder |
| `?example=<id>&name=<name>[&to=<folder>][&cache=1]` | the page's URL, as before (pb#75), for the kit's `ExampleBanner` |
| `root` | every entry of `example list --json` (and `example open --json`): the folder the examples are in, so a server can tell whether a folder is an example's without knowing the rules for finding them |

`example open` reuses a running session on the example's folder only when that session was opened as
the same example; a server started on the same folder by `app open` is a different session (and `app
open` on the folder finds that one, not the example's). `session restart` keeps `PAPERBOAT_EXAMPLE`.

A server that has `PAPERBOAT_EXAMPLE` asks paperboatd for its runtimes with `"readonly": true`
(`acquire`, [control.md](control.md#read-only-projects-examples-pb85)): the runtime can read and run
the example but not write into it, on every backend (podman/docker `:ro`, Landlock on Linux,
`sandbox-exec` on macOS, else refused), and its working directory is the lease's own work folder, so
outputs written by relative path land there. A write into the example fails with an error that says it
is read-only and to copy it.

## What each app should switch to

Today each app works out "this is an example" from the folder's location and protects it in its UI and
its server. With the above, each can drop the guess:

- **Simplicial** (simplicial#73): read `PAPERBOAT_EXAMPLE` in `start_session` instead of matching the
  folder against `cache/examples` and `PAPERBOAT_EXAMPLES_DIR`; show the banner and Copy from it even in
  a window opened without `?example=`; acquire stations on an example with `"readonly": true`.
- **Julix** (julix#45): read `PAPERBOAT_EXAMPLE` instead of `cache/examples`, `PAPERBOAT_EXAMPLES_DIR`
  and `example list`; acquire its session runtimes with `"readonly": true` and drop the temporary copy
  of the example for native runs (relative writes go to the lease's work folder, and absolute writes
  into the example now fail too).
- **Malachite** (malachite#73): read `PAPERBOAT_EXAMPLE` for a hub opened as an example instead of
  working it out; acquire the hub's runtimes with `"readonly": true`.
- **Articula** (articula#57): read `PAPERBOAT_EXAMPLE` for the "this is an example" state; pass
  `"readonly": true` with the omc lease so the native omc backend is held to it as well (the container
  mount is `:ro` already).

Any app: `example list --json`'s `root` replaces a copy of paperboat's rules for where examples live.
