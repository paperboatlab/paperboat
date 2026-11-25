// The client: state, jobs and every action, for the Launcher and the TUI alike. An action is a
// command line, run as the CLI's own words (`app install malachite` → `paperboat app install
// malachite --json`); the client knows no command by name: the registry comes from the CLI.

import {findCommand, splitWords} from './completion.ts';
import type {App, Command, Lease, RuntimeEvent, RuntimeList, Session} from './types.ts';
import {CliError, type Transport} from './error.ts';

export interface Job {
  id: number;
  line: string;
  /** The registry command it runs, "" for a line no command matched. */
  command: string;
  state: 'running' | 'done' | 'failed';
  /** Progress lines as they come (the CLI's stderr). */
  output: string[];
  result?: unknown;
  error?: string;
  /** For an unknown word an app adds: the app to install. */
  app?: string;
  started: number;
  ended?: number;
}

export interface State {
  commands: Command[];
  apps: App[];
  sessions: Session[];
  runtimes: RuntimeList | null;
  instances: Lease[];
  /** The newest last, at most 200. */
  events: RuntimeEvent[];
  jobs: Job[];
  /** Why a list could not be refreshed, by list. */
  errors: Partial<Record<'commands' | 'apps' | 'sessions' | 'runtimes' | 'instances', string>>;
}

export const emptyState = (): State => ({commands: [], apps: [], sessions: [], runtimes: null, instances: [], events: [], jobs: [], errors: {}});

export interface Client {
  getState(): State;
  subscribe(listener: () => void): () => void;
  /** Re-read the lists; `runtimes` too (it starts paperboatd if it is not running). */
  refresh(opts?: {runtimes?: boolean}): Promise<void>;
  /** Run a command line; resolves with the finished job (failed jobs resolve too). `text`: the
   * result is the CLI's own words (a terminal shows them as they are). */
  run(line: string, opts?: {text?: boolean}): Promise<Job>;
  /** Follow paperboatd's events: instances refresh on each. Returns stop. */
  watch(): () => void;
}

export function createClient(t: Transport): Client {
  let state = emptyState();
  const listeners = new Set<() => void>();
  let nextJob = 1;
  const set = (patch: Partial<State> | ((s: State) => Partial<State>)) => {
    state = {...state, ...(typeof patch === 'function' ? patch(state) : patch)};
    for (const l of listeners) l();
  };
  const setJob = (id: number, patch: Partial<Job>) => set(s => ({jobs: s.jobs.map(j => (j.id === id ? {...j, ...patch} : j))}));

  const load = async <K extends keyof State['errors']>(key: K, argv: string[], pick: (j: unknown) => State[K]) => {
    try {
      const value = pick(await t.call(argv));
      set(s => ({[key]: value, errors: {...s.errors, [key]: undefined}}) as Partial<State>);
    } catch (e) {
      set(s => ({errors: {...s.errors, [key]: (e as Error).message}}));
    }
  };

  const refreshInstances = () => load('instances', ['runtime', 'ps'], j => j as Lease[]);

  const client: Client = {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async refresh(opts = {}) {
      await Promise.all([
        load('commands', ['help'], j => j as Command[]),
        load('apps', ['app', 'list'], j => j as App[]),
        load('sessions', ['session', 'list'], j => j as Session[]),
        ...(opts.runtimes ? [load('runtimes', ['runtime', 'list'], j => j as RuntimeList), refreshInstances()] : []),
      ]);
    },
    async run(line, opts = {}) {
      const words = splitWords(line);
      const found = findCommand(state.commands, words);
      const id = nextJob++;
      const job: Job = {id, line, command: found?.cmd.id ?? '', state: 'running', output: [], started: Date.now()};
      set(s => ({jobs: [...s.jobs, job]}));
      try {
        const result = await t.call(words, l => set(s => ({jobs: s.jobs.map(j => (j.id === id ? {...j, output: [...j.output, l]} : j))})), !opts.text);
        setJob(id, {state: 'done', result, ended: Date.now()});
      } catch (e) {
        const app = e instanceof CliError && typeof e.extra.app === 'string' ? e.extra.app : undefined;
        setJob(id, {state: 'failed', error: (e as Error).message, app, ended: Date.now()});
      }
      // ponytail: every list after every job; narrow it by command group if it ever shows
      await client.refresh({runtimes: state.runtimes !== null});
      return state.jobs.find(j => j.id === id)!;
    },
    watch() {
      const s = t.stream(['runtime', 'events'], item => {
        set(st => ({events: [...st.events, item as RuntimeEvent].slice(-200)}));
        void refreshInstances();
      });
      return s.stop;
    },
  };
  return client;
}
