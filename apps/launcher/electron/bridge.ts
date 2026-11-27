// What the pages may ask of the main process: the Launcher's page through window.paperboat (preload.ts),
// an app's page in a Paperboat window through window.paperboatShell (app-preload.ts), and every page its own
// window's keys through window.paperboatWindow (both). The kit mirrors Shell and WindowControls.

export interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: number;
  extra?: Record<string, unknown>;
}

export interface Bridge {
  /** `paperboat <argv> [--json]`; progress lines come to onLine. */
  call(argv: string[], json: boolean, onLine: (line: string) => void): Promise<CallResult>;
  /** A command printing JSON lines (`runtime events`); returns stop. */
  stream(argv: string[], onItem: (item: unknown) => void): () => void;
  /** An app's page in a window of its own. */
  openWindow(url: string, title: string): void;
  /** A folder the user picks, or null. */
  pickFolder(title: string): Promise<string | null>;
  /** Show a file or folder in the system's file manager. */
  reveal(path: string): void;
  /** `fn` on every `--page <page> [--runtime <name>]` a second start hands the running Launcher; returns stop. */
  onGoto(fn: (to: Goto) => void): () => void;
}

/** Where the Launcher's page goes (`paperboat launcher --page runtimes --runtime julia`). */
export interface Goto {
  page: string;
  runtime?: string;
}

/** An app's page in a Paperboat window: the system's dialogs and real paths, nothing else (no CLI). */
export interface Shell {
  /** A file the user picks (`types`: extensions without the dot, e.g. ["psf", "pst"]), or null. */
  pickFile(types?: string[], title?: string): Promise<string | null>;
  /** A folder the user picks, or null. */
  pickFolder(title?: string): Promise<string | null>;
  /** Where to save (`name`: the suggested file name), or null. */
  pickSave(name?: string, types?: string[], title?: string): Promise<string | null>;
  /** Show a file or folder in the system's file manager. */
  reveal(path: string): void;
}

/** A page's own window (no system title bar: the page's bar is the title bar; the kit's WindowKeys). */
export interface WindowControls {
  /** `process.platform`: "darwin", "win32", "linux". */
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  /** The window's zoom: the interface scale, 0.75, 1 or 1.25 (anything else is ignored). */
  setZoom(factor: number): void;
  /** `fn` now and on every maximize or restore; returns stop. */
  onMaximized(fn: (maximized: boolean) => void): () => void;
}
