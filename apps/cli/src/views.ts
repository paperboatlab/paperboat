// What a finished command shows: lists from --json as the mockup draws them, anything else in the
// CLI's own words. Pure: (job, state, width) → lines, so tests read them as text.

import type {App, Command, Job, Lease, RuntimeList, Session, State} from '@paperboat/client';
import {box, col, seg, table, type Line} from './grid.ts';
import {accent, C} from './theme.ts';

const ok = (t: string, color = C.p): Line => [seg('✓ ', color), seg(t, C.fg)];
const note = (t: string): Line => [seg(t, C.mu)];
const ago = (s: number) => (s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`);
/** The CLI's hints, as the TUI types them: `paperboat app open x` → `/app open x`. */
export const asSlash = (t: string) => t.replace(/`paperboat ([^`]+)`/g, '/$1').replace(/\bpaperboat (?=[a-z])/g, '/');

type View = (result: unknown, s: State, w: number) => Line[];

function apps(r: unknown, _s: State, w: number): Line[] {
  const list = r as App[];
  if (!list.length) return [note('No apps in the registry yet.')];
  const rows = list.map(a => {
    const state = a.sessions ? 'running' : a.installed ? 'installed' : 'available';
    const ver = !a.installed ? '' : a.installed.from ? 'checkout' : a.installed.version;
    return [[seg(a.label || a.name, accent(a.name), true)], [seg(ver)], [seg(state, a.sessions ? accent(a.name) : a.installed ? C.fg : C.mu)], [seg(a.description, C.mu)]];
  });
  return box('Apps', String(list.length), table(rows, [16, 10, 10, 200]), w);
}

function sessions(r: unknown, _s: State, w: number): Line[] {
  const list = r as Session[];
  if (!list.length) return [note('Nothing is running.')];
  const now = Date.now() / 1000;
  const rows = list.map(x => [[seg(x.id, accent(x.app), true)], [seg(x.url)], [seg(ago(now - x.started), C.mu)], [seg(x.project, C.mu)]]);
  return box('Sessions', String(list.length), table(rows, [24, 26, 6, 200]), w);
}

function runtimes(r: unknown, s: State, w: number): Line[] {
  const {runtimes: list, backends} = r as RuntimeList;
  const rows = list.map(rt => {
    const b = Object.values(rt.backends ?? {});
    const st = b.some(x => x.usable && x.ready) ? 'ready' : b.some(x => x.usable) ? 'not pulled' : 'no backend';
    const n = s.instances.filter(l => l.runtime.startsWith(rt.name + '@') && l.state !== 'exited').length;
    return [[seg(rt.name, C.fg, true)], [seg(rt.version)], [seg(st, st === 'ready' ? C.fg : C.mu)], [seg(n ? `${n} running` : '', C.p)]];
  });
  const be = backends.map(b => (b.available ? `${b.name}${b.rootless ? ' rootless' : ''}${b.selinux ? ' SELinux' : ''}` : `${b.name} not installed`)).join(' · ');
  return [...box('Runtimes', `${list.length} in the catalog`, table(rows, [12, 10, 12, 12]), w), note('  ' + be)];
}

function instances(r: unknown, _s: State, w: number): Line[] {
  const list = r as Lease[];
  if (!list.length) return [note('No runtime is running.')];
  const app = (o: string) => o.split(':')[0];
  const rows = list.map(l => [
    [seg(l.id, C.fg, true)],
    [seg(l.runtime)],
    [seg(l.mode === 'session' ? 'kernel' : l.mode, C.mu)],
    [seg(l.owner, accent(app(l.owner)))],
    [seg(l.state, l.state === 'failed' ? C.bad : l.state === 'running' ? accent(app(l.owner)) : C.mu)],
    [seg(ago(l.uptime_s ?? 0), C.mu)],
  ]);
  return box('Instances', String(list.length), table(rows, [12, 16, 8, 14, 9, 8]), w);
}

function toolkits(r: unknown, _s: State, w: number): Line[] {
  const list = r as {name: string; kind: string; installed: boolean; description: string}[];
  const rows = list.map(t => [[seg(t.name, C.fg, true)], [seg(t.kind, C.mu)], [seg(t.installed ? 'installed' : 'available', t.installed ? C.fg : C.mu)], [seg(t.description, C.mu)]]);
  return box('Toolkits', String(list.length), table(rows, [16, 10, 10, 200]), w);
}

const logs: View = (r, _s, w) => {
  const {id, lease, text} = r as {id?: string; lease?: string; text: string};
  const lines = text.replace(/\n$/, '').split('\n').slice(-30);
  return box(id ?? lease ?? 'logs', 'last lines', lines.map(l => note(l)), w);
};

/** /help: the registry, by group. */
export function help(commands: Command[], w: number): Line[] {
  const shown = commands.filter(c => !c.tui || c.name !== 'help');
  const groups = [...new Set(shown.map(c => c.group))];
  const rows: Line[] = groups.flatMap((g, i) => [
    ...(i ? [[] as Line] : []),
    note(g),
    ...shown.filter(c => c.group === g).map(c => [...col('/' + c.name + (c.args ? ' ' + c.args : ''), 46, C.fg, true), seg(' '), seg(c.desc, C.mu)]),
  ]);
  return box('Commands', `${shown.length} · the same as paperboat <command> in a shell`, rows, w);
}

/** The commands drawn from --json; every other one shows the CLI's text. */
export const JSON_VIEWS: Record<string, View> = {
  'app.list': apps,
  'session.list': sessions,
  'runtime.list': runtimes,
  'runtime.ps': instances,
  'toolkit.list': toolkits,
  'session.logs': logs,
  'runtime.logs': logs,
};

/** A finished job's lines. */
export function jobLines(job: Job, s: State, w: number): Line[] {
  if (job.state === 'failed') {
    const [first, ...rest] = (job.error ?? 'failed').split('\n');
    return [
      [seg('✗ ', C.bad), seg(asSlash(first), C.bad)],
      ...rest.map(l => note('  ' + l)),
      ...(job.app ? [note(`  /app install ${job.app} adds it`)] : []),
    ];
  }
  if (job.command === 'paperboat.help') return help(s.commands, w);
  const view = JSON_VIEWS[job.command];
  if (view) return view(job.result, s, w);
  const text = String(job.result ?? '').replace(/\n$/, '');
  if (!text) return [ok('done')];
  const [first, ...rest] = text.split('\n');
  return [ok(asSlash(first)), ...rest.map(l => [seg('  ' + asSlash(l), C.fg)])];
}
