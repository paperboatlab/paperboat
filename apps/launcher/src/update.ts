// Updating Paperboat from the Launcher (pb#94, pb#61, pb#63): `update --check --json` and `update --install --yes
// --json` in words for toasts, and what a restart has to restart. The CLI does the work; nothing here installs.
import {compareVersions} from '@paperboatlab/ui';
import type {Lease, Session} from '@paperboat/client/browser';

/** `update --check --json` */
export interface Check {
  channel: string;
  current: string;
  newest: {version: string; url: string} | null;
  update: boolean;
  /** --install can install it here (Paperboat is from a package); absent when there is nothing newer */
  installable?: boolean;
}

/** `update --install --yes --json`, once it installed */
export interface Installed extends Check {
  installed?: string;
  files?: string[];
  daemon?: {version: string; older: boolean; instances: Lease[]} | null;
}

/** Settings › Launcher › Automatic updates: never installs on its own. */
export type AutoUpdate = 'off' | 'ask';
export const isAutoUpdate = (v: unknown): v is AutoUpdate => v === 'off' || v === 'ask';
/** "Check and ask" looks this often (and once at start). */
export const CHECK_EVERY_MS = 6 * 3600_000;

/** The check as a toast's words, never the CLI's text (pb#63). */
export function checkWords(c: Check): {title: string; detail: string} {
  if (c.channel === 'dev') return {title: 'The dev channel builds from main', detail: 'update your checkout'};
  if (!c.newest) return {title: `No releases on the ${c.channel} channel yet`, detail: `you have ${c.current}`};
  if (!c.update) return {title: 'Paperboat is up to date', detail: `${c.current} · ${c.channel} channel`};
  return {title: `Paperboat ${c.newest.version} is out`, detail: `you have ${c.current} · ${c.channel} channel`};
}

// paperboat-launcher-0.2.0-beta.10.x86_64.rpm → paperboat-launcher: short enough for a toast
const pkgName = (file: string) => /^(paperboat(?:-[a-z]+)?)[-_]\d/.exec(file)?.[1] ?? file;

/** A progress line of `update --install` (its stderr) in words, or null for the installer's own lines. */
export function progressWords(line: string): string | null {
  let m = /^downloading (\S+?)(?:: ([\d.]+) of ([\d.]+) MB)?$/.exec(line);
  if (m) return m[2] ? `Downloading ${pkgName(m[1])}: ${m[2]} of ${m[3]} MB` : `Downloading ${pkgName(m[1])}`;
  if ((m = /^checked (\S+): SHA-256 matches/.exec(line))) return `${pkgName(m[1])}: SHA-256 checked`;
  if (/^installing: /.test(line)) return 'Installing: the system asks for your password';
  return null;
}

/** What a restart restarts once `cli` is the version on disk: the Launcher when it runs an older one, paperboatd
 *  when it does. A checkout's Launcher is its package.json's 0.2.0, never older than a 0.2.0 beta. */
export function restartNeeds(cli: string, launcher: string, daemon?: string | null) {
  const older = (v: string) => compareVersions(cli, v) > 0;
  return {launcher: older(launcher), daemon: !!daemon && older(daemon)};
}
export type Needs = ReturnType<typeof restartNeeds>;

// a warm station that idles holds nobody's work
const alive = (l: Lease) => l.state === 'running' || l.state === 'starting';

/** What restarting paperboatd ends, one line each: its instances, with the app that holds each. */
export function endsWords(instances: Lease[], sessions: Session[]): string[] {
  return instances.filter(alive).map(l => {
    const who = sessions.find(s => s.app === l.owner || s.project === l.project);
    return `${l.runtime.replace('@', ' ')}${who ? ` for ${who.app}` : l.owner ? ` for ${l.owner}` : ''}${l.project ? ` on ${l.project}` : ''}`;
  });
}
export const running = (instances: Lease[]) => instances.filter(alive).length;
