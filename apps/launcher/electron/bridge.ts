// What the page may ask of the main process (preload.ts exposes it as window.paperboat).

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
