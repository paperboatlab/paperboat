// A transport for tests: answers by command line, records what was called.

import {CliError, type Transport} from './transport.ts';

export type Answer = unknown | ((argv: string[], onLine?: (l: string) => void, json?: boolean) => unknown);

export function fakeTransport(answers: Record<string, Answer>): Transport & {calls: string[]; emit(item: unknown): void} {
  const streams = new Set<(item: unknown) => void>();
  const calls: string[] = [];
  return {
    calls,
    emit: item => streams.forEach(f => f(item)),
    async call(argv, onLine, json = true) {
      const key = argv.join(' ');
      calls.push(key);
      const words = Object.keys(answers).filter(k => key === k || key.startsWith(k + ' ')).sort((a, b) => b.length - a.length)[0];
      if (words === undefined) throw new CliError(`no command '${argv[0]}' · paperboat help lists them`, 2);
      const a = answers[words];
      return typeof a === 'function' ? a(argv, onLine, json) : structuredClone(a);
    },
    stream(_argv, onItem) {
      streams.add(onItem);
      return {stop: () => void streams.delete(onItem), done: Promise.resolve()};
    },
  };
}
