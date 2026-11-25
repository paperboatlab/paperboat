// The one way to Paperboat: the paperboat CLI with --json. In Electron this runs in the main process
// behind IPC; in the TUI in-process; tests use a fake.

import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export {CliError, type Transport} from './error.ts';
import {CliError, type Transport} from './error.ts';

/** The CLI at `bin` (default: $PAPERBOAT_BIN, else `paperboat` on PATH). */
export function cliTransport(bin = process.env.PAPERBOAT_BIN || 'paperboat', env: NodeJS.ProcessEnv = process.env): Transport {
  return {
    call(argv, onLine, json = true) {
      return new Promise((resolve, reject) => {
        const p = spawn(bin, json ? [...argv, '--json'] : argv, {env, stdio: ['ignore', 'pipe', 'pipe']});
        let out = '';
        let err = '';
        p.stdout.on('data', d => (out += d));
        createInterface({input: p.stderr}).on('line', l => {
          err += l + '\n';
          onLine?.(l);
        });
        p.on('error', e => reject(new CliError(`${bin} could not start: ${e.message}`, 127)));
        p.on('close', code => {
          if (!json) {
            if (code === 0) return resolve(out);
            // the CLI says why on stderr as `paperboat: <why>`
            return reject(new CliError(err.trim().replace(/^paperboat: /, '') || `paperboat ${argv.join(' ')} failed (${code})`, code ?? 1));
          }
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
