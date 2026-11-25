import assert from 'node:assert/strict';
import {test} from 'node:test';
import {render} from 'ink-testing-library';
import {createClient, fakeTransport, CliError, type Job, type State, emptyState} from '@paperboat/client';
import {App} from '../src/App.tsx';
import {plain} from '../src/grid.ts';
import {markLines} from '../src/mark.ts';
import {spinner} from '../src/theme.ts';
import {asSlash, jobLines} from '../src/views.ts';

const help = [
  {id: 'app.list', name: 'app list', args: '', desc: 'The apps', group: 'Apps', app: '', alias: ['apps'], tui: false},
  {id: 'app.open', name: 'app open', args: '<app> [<folder>]', desc: 'Open an app', group: 'Apps', app: '', alias: [], tui: false},
  {id: 'paperboat.clear', name: 'clear', args: '', desc: 'Clear', group: 'Paperboat', app: '', alias: [], tui: true},
];
const apps = [{name: 'malachite', label: 'Malachite', description: 'Engineering notebook', installed: {version: '0.1.0', from: ''}, sessions: 0}];
const about = {paperboat: '0.2.0', channel: 'release', daemon: null};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
/** Until the frame matches (a loaded machine is slow), then the frame. */
async function until(frame: () => string | undefined, re: RegExp, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end && !re.test(frame() ?? ''); ) await tick(25);
  return frame() ?? '';
}
const text = (lines: ReturnType<typeof jobLines>) => lines.map(plain).join('\n');

async function tui(history: string[] = [], onHistory?: (l: string) => void) {
  const t = fakeTransport({
    help,
    'app list': apps,
    'session list': [],
    'app open': (argv: string[], _l: unknown, json?: boolean) => {
      if (argv[2] !== 'malachite') throw new CliError(`no app named ${argv[2]} in the registry; paperboat app list shows them`, 2);
      return json ? {} : 'started malachite-59210 on /hub · http://127.0.0.1:59210/\n';
    },
  });
  const client = createClient(t);
  await client.refresh();
  const r = render(<App client={client} about={about} cwd="/hub" glyphs={false} history={history} onHistory={onHistory} />);
  await tick();
  return {...r, t};
}

test('the mark: five rows of half blocks, the hull full width', () => {
  const m = markLines().map(plain);
  assert.equal(m.length, 5);
  assert.equal(m[3], '▄▄▄▄▄▄▄▄▄▄▄▄▄▄');
});

test('the spinner: Paperboat Glyphs, or the fallback turning every third frame', () => {
  assert.equal(spinner(0, true), '');
  assert.equal(spinner(6, true), '');
  assert.deepEqual([0, 3, 6, 9, 12, 15].map(f => spinner(f, false)), ['■', '◩', '◪', '◆', '◈', '■']);
});

test('the CLI hints read as TUI commands', () => {
  assert.equal(asSlash('installed malachite · paperboat app open malachite'), 'installed malachite · /app open malachite');
  assert.equal(asSlash('no command · `paperboat app install x` adds it'), 'no command · /app install x adds it');
});

test('views: the apps table, a failure in red with what to install', () => {
  const s: State = {...emptyState(), commands: help};
  const job = (p: Partial<Job>): Job => ({id: 1, line: '', command: '', state: 'done', output: [], started: 0, ...p});
  const t = text(jobLines(job({command: 'app.list', result: apps}), s, 80));
  assert.match(t, /┌ Apps ─+ 1 ┐/);
  assert.match(t, /Malachite {2,}0\.1\.0 {2,}installed {2,}Engineering notebook/);
  const f = text(jobLines(job({state: 'failed', error: "no command 'run'", app: 'simplicial'}), s, 80));
  assert.equal(f, "✗ no command 'run'\n  /app install simplicial adds it");
  assert.equal(text(jobLines(job({command: 'paperboat.channel', result: 'beta\n'}), s, 80)), '✓ beta');
});

test('the TUI: banner, the menu from the registry, a command run as the CLI words', async () => {
  const {lastFrame, stdin, t, unmount} = await tui();
  assert.match(lastFrame()!, /Paperboat 0\.2\.0/);
  assert.match(lastFrame()!, /release channel · \/hub/);
  stdin.write('/app o');
  await tick();
  assert.match(lastFrame()!, /app open <app> \[<folder>\] +Open an app/);
  stdin.write('\t');
  await tick();
  assert.match(lastFrame()!, /› \/app open /);
  stdin.write('mal');
  await tick();
  assert.match(lastFrame()!, /malachite +installed/);  // the argument's values with their state
  stdin.write('\t');
  await tick();
  stdin.write('\r');
  assert.match(await until(lastFrame, /✓ started/), /✓ started malachite-59210 on \/hub · http:\/\/127\.0\.0\.1:59210\//);
  assert.ok(t.calls.includes('app open malachite'));
  unmount();
});

test('the TUI: a failure, then history', async () => {
  const {lastFrame, stdin, unmount} = await tui();
  for (const ch of 'app open nope') stdin.write(ch);
  stdin.write('\r');
  assert.match(await until(lastFrame, /✗/), /✗ no app named nope in the registry; \/app list shows them/);
  stdin.write('\x1b[A');  // ↑
  await tick();
  assert.match(lastFrame()!, /› \/app open nope/);
  unmount();
});

test('the TUI: history from earlier runs, Ctrl+R search, new lines kept', async () => {
  const kept: string[] = [];
  const {lastFrame, stdin, t, unmount} = await tui(['/app open malachite', '/apps', '/session list'], l => kept.push(l));
  stdin.write('\x12');  // Ctrl+R
  for (const ch of 'mal') stdin.write(ch);
  assert.match(await until(lastFrame, /search mal/), /search mal .*\/app open malachite/);
  stdin.write('\x12');  // older: none, stays on the only match
  for (const ch of 'xyz') stdin.write(ch);
  assert.match(await until(lastFrame, /no match/), /search malxyz .*no match/);
  stdin.write('\x1b');  // Esc gives the line back
  await tick();
  assert.doesNotMatch(lastFrame()!, /search/);
  stdin.write('\x12');
  for (const ch of 'op') stdin.write(ch);
  assert.match(await until(lastFrame, /search op /), /\/app open malachite/);
  stdin.write('\r');
  await until(lastFrame, /started malachite/);
  assert.deepEqual(kept, ['/app open malachite']);  // a repeat of the newest line isn't kept twice
  assert.ok(t.calls.some(c => c.startsWith('app open malachite')));
  unmount();
});

test('the TUI: a paste with Enter in it runs each line', async () => {
  const {lastFrame, stdin, t, unmount} = await tui();
  stdin.write('/app open malachite\r/apps\r');
  const f = await until(lastFrame, /› \/apps[\s\S]*Malachite/);
  assert.match(f, /› \/app open malachite\n.*started malachite[\s\S]*› \/apps\n/);
  assert.ok(t.calls.some(c => c.startsWith('app open malachite')));
  unmount();
});
