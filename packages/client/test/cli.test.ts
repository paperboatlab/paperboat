// The contract: the real paperboat binary's --json against the types. Needs a build
// ($PAPERBOAT_BIN, else <repo>/build/paperboat); skipped without one. No daemon.

import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {createClient} from '../src/client.ts';
import {cliTransport} from '../src/transport.ts';

const bin = process.env.PAPERBOAT_BIN || new URL('../../../build/paperboat', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'pb-client-'));
after(() => rmSync(home, {recursive: true, force: true}));
const t = cliTransport(bin, {...process.env, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run')});
const skip = existsSync(bin) ? false : `no paperboat build at ${bin}`;

test('help, apps and sessions have the shapes the client reads', {skip}, async () => {
  const c = createClient(t);
  await c.refresh();
  const s = c.getState();
  assert.deepEqual(s.errors, {commands: undefined, apps: undefined, sessions: undefined});
  for (const k of ['id', 'name', 'args', 'desc', 'group', 'app', 'alias', 'tui']) assert.ok(k in s.commands[0], k);
  assert.ok(s.commands.some(x => x.id === 'app.install'));
  const m = s.apps.find(a => a.name === 'malachite');
  assert.ok(m);
  assert.equal(m.installed, null);
  assert.equal(m.sessions, 0);
  assert.deepEqual(m.runtimes, ['julia@1.11', 'python@3.12']);
  assert.deepEqual(s.sessions, []);
});

test('a failure carries the CLI message', {skip}, async () => {
  const c = createClient(t);
  await c.refresh();
  const job = await c.run('app open malachite');
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /paperboat app install malachite/);
});

test('text mode: the CLI words, and its reason on failure', {skip}, async () => {
  const c = createClient(t);
  assert.match((await c.run('channel', {text: true})).result as string, /^release\n$/);
  const f = await c.run('app open malachite', {text: true});
  assert.match(f.error!, /^malachite is not installed/);
});
