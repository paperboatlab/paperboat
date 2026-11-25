import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createClient} from '../src/client.ts';
import {fakeTransport} from '../src/fake.ts';
import {CliError} from '../src/transport.ts';

const help = [{id: 'app.install', name: 'app install', args: '<app>', desc: '', group: 'Apps', app: '', alias: [], tui: false}];
const apps = [{name: 'malachite', label: 'Malachite', description: '', installed: null, sessions: 0, runtimes: [], repo: ''}];

test('refresh fills the lists; a failing one keeps its error', async () => {
  const t = fakeTransport({help, 'app list': apps, 'session list': () => { throw new CliError('boom', 1); }});
  const c = createClient(t);
  await c.refresh();
  const s = c.getState();
  assert.equal(s.commands[0].id, 'app.install');
  assert.equal(s.apps[0].name, 'malachite');
  assert.equal(s.errors.sessions, 'boom');
  assert.equal(s.runtimes, null);  // not asked: it would start paperboatd
  assert.ok(!t.calls.includes('runtime list'));
});

test('run: the CLI words, progress lines, the result, then a refresh', async () => {
  let installed = false;
  const t = fakeTransport({
    help,
    'app list': () => apps.map(a => ({...a, installed: installed ? {version: '0.1.0', from: ''} : null})),
    'session list': [],
    'app install': (_argv: string[], onLine?: (l: string) => void) => {
      onLine?.('pulling julia@1.11…');
      installed = true;
      return {name: 'malachite'};
    },
  });
  const c = createClient(t);
  await c.refresh();
  let seen = 0;
  c.subscribe(() => seen++);
  const job = await c.run('app install malachite');
  assert.equal(job.state, 'done');
  assert.equal(job.command, 'app.install');
  assert.deepEqual(job.output, ['pulling julia@1.11…']);
  assert.deepEqual(job.result, {name: 'malachite'});
  assert.ok(t.calls.includes('app install malachite'));
  assert.deepEqual(c.getState().apps[0].installed, {version: '0.1.0', from: ''});
  assert.ok(seen > 2);
});

test('a failed run resolves with the reason and the app to install', async () => {
  const t = fakeTransport({help, 'app list': apps, 'session list': [], run: () => { throw new CliError("no command 'run'", 2, {app: 'simplicial'}); }});
  const c = createClient(t);
  const job = await c.run('run pendulum');
  assert.equal(job.state, 'failed');
  assert.equal(job.app, 'simplicial');
  assert.equal(job.command, '');
});

test('watch: events are kept and instances refresh', async () => {
  const t = fakeTransport({'runtime ps': [{id: 'l1', runtime: 'julia@1.11', mode: 'session', state: 'running'}]});
  const c = createClient(t);
  const stop = c.watch();
  t.emit({event: 'lease.acquired', lease: 'l1'});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(c.getState().events.length, 1);
  assert.equal(c.getState().instances[0].id, 'l1');
  stop();
});

test('run as text: the CLI words without --json', async () => {
  const t = fakeTransport({help, 'app list': apps, 'session list': [], about: (_a: string[], _l: unknown, json?: boolean) => (json ? {} : 'paperboat 0.2.0\n')});
  const c = createClient(t);
  assert.equal((await c.run('about', {text: true})).result, 'paperboat 0.2.0\n');
});
