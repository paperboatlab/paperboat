/**
 * Pure launcher logic and data shapes (no DOM or network calls, unit-tested in test/model.test.ts).
 */

export type Channel = "release" | "beta" | "dev";

export interface RunningItem {
  kind: "backend" | "app";
  name: string;
  port: number;
  pid: number;
  url: string;
  engine?: string;
  domain?: string;
  detail?: string;
  started_at?: number;
}

export interface BackendStatusItem {
  name: string;
  state: "building" | "starting" | "running" | "failed";
  stage?: string;
  elapsed?: number;
  port: number;
  url?: string;
  error?: string;
}

export interface BackendInfo {
  name: string;
  language: string;
  port: number;
  dir: string;
  description: string;
  source: "builtin" | "example" | "installed" | string;
}

export interface AppInfo {
  name: string;
  repo: string;
  description: string;
  installed: boolean;
  checkout: boolean;
  version: string;
  deps: string[];
  dep_ranges?: Record<string, string>;
  built_with?: Record<string, string>;
  kind: "program" | "library";
  launch: string;
  port: number;
  missingPrerequisites?: string;
}

export interface ToolkitInfo {
  name: string;
  installed: boolean;
  builtin?: boolean;
  version?: string;
  description: string;
  repo?: string;
  blocks?: string[];
  requires?: string[];
}

export interface CommandSpec {
  name: string;
  summary: string;
  aliases: string[];
  subcommands: string[];
  flags: string[];
  arg: string;
}

export interface LauncherTaskEvent {
  event: string;
  name?: string;
  ok?: boolean;
  skipped?: boolean;
  message?: string;
  duration?: number;
  errors?: string[];
  warnings?: string[];
  package?: string;
  files?: number;
  total?: number;
  bytes?: number;
  dir?: string;
  version?: string;
}

export interface LauncherTask {
  id: number;
  label: string;
  args: string[];
  kind: "task" | "job";
  status: "running" | "done" | "failed" | "stopped";
  exitCode: number;
  startedAtMs: number;
  finishedAtMs: number;
  lastLine?: string;
  events: LauncherTaskEvent[];
}

export type BlockKind = "flow" | "station" | "board";

export interface BlockCardInfo {
  type: string;
  label: string;
  kind: BlockKind;
  group: string;
  description: string;
}

export interface LauncherLogLine {
  seq: number;
  timeMs: number;
  taskId: number;
  tone: "cmd" | "dim" | "ok" | "err" | "sig";
  text: string;
}

export interface LauncherStateSnapshot {
  version: string;
  channel: Channel;
  installType: string;
  homeDir: string;
  running: RunningItem[];
  status: BackendStatusItem[];
  backends: BackendInfo[];
  apps: AppInfo[];
  toolkits: ToolkitInfo[];
  commands: CommandSpec[];
  tasks: LauncherTask[];
}

export interface Candidate {
  value: string;
  detail: string;
  match: number[];
}

export function splitCommandWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote = "";
  let has = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (cur || has) words.push(cur);
  return words;
}

export function fuzzyMatch(query: string, text: string): { score: number; match: number[] } | null {
  if (!query) return { score: 0, match: [] };
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) {
    return { score: at === 0 ? 100 - text.length / 100 : 50, match: [...q].map((_, k) => at + k) };
  }
  const match: number[] = [];
  for (let i = 0, j = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) {
      match.push(i);
      j++;
    }
  }
  return match.length === q.length ? { score: 10 - match[match.length - 1] / 100, match } : null;
}

export function completeInput(
  line: string,
  commands: CommandSpec[],
  backends: BackendInfo[],
  apps: AppInfo[],
  toolkits: ToolkitInfo[],
): { candidates: Candidate[]; ghost: string; word: string } {
  const trimmedLeading = line.replace(/^\s+/, "");
  const parts = trimmedLeading.split(" ");
  const word = parts[parts.length - 1] ?? "";
  const index = parts.length - 1;
  const pool: { value: string; detail: string }[] = [];

  if (index === 0) {
    for (const c of commands) {
      pool.push({ value: c.name, detail: c.summary });
      if (word) {
        for (const a of c.aliases) pool.push({ value: a, detail: `alias for ${c.name}` });
      }
    }
    pool.push({ value: "clear", detail: "Clear console output" });
    pool.push({ value: "help", detail: "List CLI commands" });
  } else {
    const cmd = commands.find((c) => c.name === parts[0] || c.aliases.includes(parts[0]));
    if (cmd) {
      if (word.startsWith("-")) {
        for (const f of cmd.flags) pool.push({ value: f, detail: "flag" });
      } else if (cmd.subcommands.length > 0 && index === 1) {
        for (const s of cmd.subcommands) pool.push({ value: s, detail: `${cmd.name} subcommand` });
      } else if (cmd.arg === "backend" || cmd.arg === "target") {
        for (const b of backends) pool.push({ value: b.name, detail: `${b.language} · :${b.port}` });
        for (const a of apps) pool.push({ value: a.name, detail: `app · :${a.port}` });
      } else if (cmd.arg === "toolkit") {
        for (const t of toolkits) pool.push({ value: t.name, detail: t.builtin ? "built-in" : t.installed ? "installed" : "available" });
      } else if (cmd.name === "pkg") {
        for (const a of apps) pool.push({ value: a.name, detail: a.installed ? a.version : "not installed" });
      }
    }
  }

  const candidates = pool
    .map((p) => ({ p, m: fuzzyMatch(word, p.value) }))
    .flatMap(({ p, m }) => (m ? [{ value: p.value, detail: p.detail, match: m.match, score: m.score }] : []))
    .sort((a, b) => b.score - a.score)
    .map(({ value, detail, match }) => ({ value, detail, match }));

  const top = candidates[0];
  const ghost = word && top && top.value.startsWith(word) ? line + top.value.slice(word.length) : "";
  return { candidates: candidates.slice(0, 10), ghost, word };
}

export function ppkDisplayName(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
  return base.replace(/\.ppk$/i, "").replace(/-[0-9]+\.[0-9]+.*$/, "") || "backend";
}

export function appDisplayTitle(name: string): string {
  if (name === "squero-studio-om") return "Squero Studio OM";
  if (name === "squero-studio-mx") return "Squero Studio MX";
  return name;
}

const FALLBACK_BLOCK_NOTES: Record<string, string> = {
  pid: "Proportional-integral-derivative controller with derivative filtering and anti-windup clamping.",
  integrator: "Continuous-time state integrator that accumulates its input signal over time.",
  lag: "First-order low-pass lag filter smoothing step changes with time constant tau.",
  delay: "Discrete sample delay shifting its input signal by a fixed number of steps.",
  transfer_fn: "Linear transfer function H(s) or H(z) from numerator and denominator polynomial coefficients.",
  state_space: "Continuous or discrete state-space system x' = Ax + Bu, y = Cx + Du.",
  lqr: "Linear-quadratic regulator gain solver for state-space control design.",
  kalman: "Linear state estimator combining model prediction and measurement updates.",
  mpc: "Receding-horizon model predictive control block solved at each step.",
  qp: "Convex quadratic program solver (1/2 x'Px + q'x subject to l <= Ax <= u).",
  lp: "Linear program solver minimizing c'x subject to linear inequality bounds.",
  nlp: "Nonlinear constrained optimization solver powered by Ipopt.",
  gray: "Converts an RGB/BGR image frame into single-channel grayscale.",
  blur: "Applies Gaussian spatial smoothing to reduce high-frequency image noise.",
  canny: "Detects crisp edges using gradient magnitude and non-maximum suppression.",
  threshold: "Segments an image into binary foreground and background regions.",
  load: "Loads a triangle surface mesh from STL, OBJ, or PLY geometry files.",
  mesh: "3D triangle mesh station object for spatial visualization and inspection.",
};

export function humanizeBlockName(id: string): string {
  const short = id.includes("/") ? id.split("/").pop()! : id;
  if (short.toLowerCase() === "pid") return "PID";
  if (short.toLowerCase() === "lqr") return "LQR";
  if (short.toLowerCase() === "mpc") return "MPC";
  if (short.toLowerCase() === "nmpc") return "NMPC";
  if (short.toLowerCase() === "qp") return "Solve QP";
  if (short.toLowerCase() === "lp") return "Solve LP";
  if (short.toLowerCase() === "nlp") return "Solve NLP";
  if (short.toLowerCase() === "zoh") return "Zero-order hold";
  if (short.toLowerCase() === "foh") return "First-order hold";
  if (short.toLowerCase() === "ema") return "Exponential moving average";
  const cleaned = short.replace(/_/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function buildToolkitBlockCards(
  toolkitName: string,
  inspectData?: {
    flow_blocks?: Array<{ type: string; label: string; description: string }>;
    station_blocks?: Array<{ type: string; label: string; description: string }>;
    dashboard_instruments?: Array<{ type: string; label: string; instrument?: string; description: string }>;
  } | null,
  fallbackNames?: string[],
): BlockCardInfo[] {
  const cards: BlockCardInfo[] = [];
  const push = (b: { type: string; label?: string; description?: string }, kind: BlockKind) => {
    const group = b.type.includes("/") ? b.type.split("/")[0] : toolkitName;
    const short = b.type.includes("/") ? b.type.split("/").pop()! : b.type;
    cards.push({
      type: b.type.includes("/") ? b.type : `${toolkitName}/${b.type}`,
      label: b.label || humanizeBlockName(b.type),
      kind,
      group,
      description:
        b.description?.trim() ||
        FALLBACK_BLOCK_NOTES[short] ||
        `${humanizeBlockName(short)} block in the ${toolkitName} toolkit.`,
    });
  };

  for (const b of inspectData?.flow_blocks ?? []) push(b, "flow");
  for (const b of inspectData?.station_blocks ?? []) push(b, "station");
  for (const b of inspectData?.dashboard_instruments ?? []) push(b, "board");

  if (cards.length === 0 && fallbackNames?.length) {
    for (const raw of fallbackNames) {
      push({ type: `${toolkitName}/${raw}`, label: humanizeBlockName(raw) }, "flow");
    }
  }
  return cards;
}
