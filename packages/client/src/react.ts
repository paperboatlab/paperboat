// Hooks for Ink and React DOM alike.

import {useCallback, useSyncExternalStore} from 'react';
import type {Client, State} from './client.ts';

/** A slice of the state; re-renders when that slice changes. */
export function useStore<T>(client: Client, select: (s: State) => T): T {
  return useSyncExternalStore(client.subscribe, () => select(client.getState()));
}

/** Run a command line. */
export function useRun(client: Client): (line: string) => ReturnType<Client['run']> {
  return useCallback((line: string) => client.run(line), [client]);
}
