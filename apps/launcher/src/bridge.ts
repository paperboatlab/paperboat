// The page's transport: the main process runs the CLI (electron/main.ts) through window.paperboat.
import {CliError, type Transport} from '@paperboat/client/browser';
import type {Bridge} from '../electron/bridge.ts';

declare global {
  interface Window {
    paperboat: Bridge;
  }
}

export const bridge = () => window.paperboat;

export function bridgeTransport(b: Bridge = window.paperboat): Transport {
  return {
    async call(argv, onLine, json = true) {
      const r = await b.call(argv, json, l => onLine?.(l));
      if (!r.ok) throw new CliError(r.error ?? 'failed', r.code ?? 1, r.extra ?? {});
      return r.value;
    },
    stream(argv, onItem) {
      return {stop: b.stream(argv, onItem), done: new Promise(() => {})};
    },
  };
}
