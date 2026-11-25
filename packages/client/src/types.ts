// What the paperboat CLI prints with --json (src/cli/main.cpp): the daemon's objects unchanged
// (docs/control.md) and the CLI's own for apps and sessions. The contract test (test/cli.test.ts)
// runs the real binary against these.

/** One registry command, as `paperboat help --json` lists it (commands.toml plus installed apps'). */
export interface Command {
  id: string;
  /** The words after `paperboat`; the TUI's `/<name>`. */
  name: string;
  /** Usage: `<required>`, `[optional]`, `a|b`, `--flag <value>`. */
  args: string;
  desc: string;
  group: string;
  /** The installed app it came with; "" for the platform's own. */
  app: string;
  alias: string[];
  /** The TUI's own (clear, quit): not a CLI command. */
  tui: boolean;
}

export interface App {
  name: string;
  label: string;
  description: string;
  /** null when not installed; `from` is the linked checkout, "" for a release. */
  installed: {version: string; from: string} | null;
  sessions: number;
  /** The runtimes it uses (`julia@1.11`). */
  runtimes: string[];
  repo: string;
}

/** An app server paperboat started on a folder. */
export interface Session {
  id: string;
  app: string;
  project: string;
  port: number;
  pid: number;
  url: string;
  log: string;
  started: number;
}

export interface Runtime {
  name: string;
  version: string;
  modes: string[];
  backends: Record<string, {usable: boolean; ready: boolean}>;
  [key: string]: unknown;
}

export interface RuntimeList {
  runtimes: Runtime[];
  errors: string[];
  backends: {name: string; available: boolean; detail: string; rootless: boolean; selinux: boolean}[];
}

/** A running instance: a kernel (mode session), a station or an exec. */
export interface Lease {
  id: string;
  runtime: string;
  mode: 'station' | 'session' | 'exec';
  owner: string;
  backend: string;
  state: 'starting' | 'running' | 'idle' | 'exited' | 'failed';
  error: string;
  project: string;
  uptime_s: number;
  idle_s: number;
  [key: string]: unknown;
}

/** A paperboatd event (`runtime events --json`). */
export interface RuntimeEvent {
  event: string;
  [key: string]: unknown;
}
