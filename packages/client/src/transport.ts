// The one way to Paperboat: the paperboat CLI with --json. In Electron this runs in the main process
// behind IPC; in the TUI in-process; tests use a fake.

import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

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
  /** `paperboat <argv> --json`: its output parsed. Progress lines (stderr) go to `onLine`. */
  call(argv: string[], onLine?: (line: string) => void): Promise<unknown>;
  /** A command printing one JSON object a line until stopped (`runtime events`). */
  stream(argv: string[], onItem: (item: unknown) => void): {stop(): void; done: Promise<void>};
}

/** The CLI at `bin` (default: $PAPERBOAT_BIN, else `paperboat` on PATH). */
export function cliTransport(bin = process.env.PAPERBOAT_BIN || 'paperboat', env: NodeJS.ProcessEnv = process.env): Transport {
  return {
    call(argv, onLine) {
      return new Promise((resolve, reject) => {
        const p = spawn(bin, [...argv, '--json'], {env, stdio: ['ignore', 'pipe', 'pipe']});
        let out = '';
        let err = '';
        p.stdout.on('data', d => (out += d));
        createInterface({input: p.stderr}).on('line', l => {
          err += l + '\n';
          onLine?.(l);
        });
        p.on('error', e => reject(new CliError(`${bin} could not start: ${e.message}`, 127)));
        p.on('close', code => {
          let j: unknown;
          try {
            j = out.trim() ? JSON.parse(out) : null;
          } catch {
            return reject(new CliError(err.trim() || `paperboat ${argv.join(' ')}: not JSON`, code ?? 1));
          }
          if (code === 0) return resolve(j);
          const {error, ...extra} = (j ?? {}) as {error?: string};
          reject(new CliError(error ?? (err.trim() || `paperboat ${argv.join(' ')} failed (${code})`), code ?? 1, extra));
        });
      });
    },
    stream(argv, onItem) {
      const p = spawn(bin, [...argv, '--json'], {env, stdio: ['ignore', 'pipe', 'ignore']});
      createInterface({input: p.stdout}).on('line', l => {
        try {
          onItem(JSON.parse(l));
        } catch {
          // not an item: skip
        }
      });
      const done = new Promise<void>(r => p.on('close', () => r()));
      return {stop: () => void p.kill(), done};
    },
  };
}
