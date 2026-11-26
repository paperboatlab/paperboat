// What the pages may ask of the main process: the Launcher's page through window.paperboat (preload.ts),
// an app's page in a Paperboat window through window.paperboatShell (app-preload.ts). The kit mirrors Shell.

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
