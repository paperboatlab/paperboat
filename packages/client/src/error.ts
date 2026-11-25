// The transport's shape and its error: no Node here, so a page (the Launcher's) can use them.

export class CliError extends Error {
  readonly code: number;
  /** The rest of the CLI's error object (`app` for an unknown word an app adds). */
  readonly extra: Record<string, unknown>;
  constructor(message: string, code: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export interface Transport {
  /** `paperboat <argv> --json`: its output parsed; `json: false`, the CLI's own text. Progress lines
   * (stderr) go to `onLine`. */
  call(argv: string[], onLine?: (line: string) => void, json?: boolean): Promise<unknown>;
  /** A command printing one JSON object a line until stopped (`runtime events`). */
  stream(argv: string[], onItem: (item: unknown) => void): {stop(): void; done: Promise<void>};
}
