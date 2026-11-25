import assert from 'node:assert/strict';
import {test} from 'node:test';
import {complete, edit, findCommand, fuzzy, ghost, splitWords, usage, type Sources} from '../src/completion.ts';
import type {Command} from '../src/types.ts';

const cmd = (id: string, name: string, args = '', alias: string[] = []): Command => ({id, name, args, desc: id, group: 'G', app: '', alias, tui: false});
const commands = [
  cmd('app.list', 'app list', '', ['apps']),
  cmd('app.open', 'app open', '<app> [<folder>] [--no-open]'),
  cmd('app.install', 'app install', '<app>[@<version>] | <app> --from <folder>'),
  cmd('session.stop', 'session stop', '<session>|--all'),
  cmd('runtime.pull', 'runtime pull', '<runtime>'),
];
const sources: Sources = {
  commands,
  args: {app: [{value: 'malachite', detail: 'installed'}, {value: 'simplicial', detail: 'available'}], session: [{value: 'malachite-30474', detail: ''}]},
  listDir: dir => (dir === 'pro/' ? [{value: 'hub/', detail: ''}, {value: 'notes/', detail: ''}] : [{value: 'pro/', detail: ''}]),
};

test('fuzzy: prefix beats substring beats subsequence', () => {
  assert.ok(fuzzy('app', 'app list')!.score > fuzzy('list', 'app list')!.score);
  assert.ok(fuzzy('list', 'app list')!.score > fuzzy('apl', 'app list')!.score);
  assert.equal(fuzzy('xyz', 'app list'), null);
});

test('splitWords groups quotes', () => assert.deepEqual(splitWords(`app open malachite "my hub"`), ['app', 'open', 'malachite', 'my hub']));

test('findCommand takes the longest name or alias, as the CLI parses', () => {
  assert.equal(findCommand(commands, ['app', 'open', 'x'])?.cmd.id, 'app.open');
  assert.equal(findCommand(commands, ['apps'])?.used, 1);
  assert.equal(findCommand(commands, ['app']), null);
});

test('usage: positional names and flags', () => {
  assert.deepEqual(usage('<app> [<folder>] [--no-open]'), {positional: ['app', 'folder'], flags: ['--no-open']});
  assert.deepEqual(usage('<app>[@<version>] | <app> --from <folder>'), {positional: ['app'], flags: ['--from']});
  assert.deepEqual(usage('<session>|--all'), {positional: ['session'], flags: ['--all']});
});

test('complete: command names, then argument values, flags and folders', () => {
  assert.equal(complete('app in', sources).candidates[0].value, 'app install');
  assert.equal(complete('', sources).candidates.length, 6);  // five names and an alias
  const a = complete('app open mal', sources);
  assert.deepEqual([a.candidates[0].value, a.from], ['malachite', 9]);
  assert.equal(complete('app open ', sources).candidates.length, 2);
  assert.deepEqual(complete('app open malachite pro/', sources).candidates.map(c => c.value), ['pro/hub/', 'pro/notes/']);
  assert.deepEqual(complete('app open malachite --no', sources).candidates.map(c => c.value), ['--no-open']);
  assert.deepEqual(complete('session stop m', sources).candidates.map(c => c.value), ['malachite-30474']);
  assert.equal(complete('runtime pull ', sources).candidates.length, 0);  // no values known: nothing offered
});

test('ghost: history first, then the top completion', () => {
  assert.equal(ghost('app o', ['app open malachite'], sources), 'pen malachite');
  assert.equal(ghost('app ope', [], sources), 'n');
  assert.equal(ghost('', ['x'], sources), '');
});

test('edit: keys on the line', () => {
  assert.deepEqual(edit({text: 'app open', cursor: 8}, {input: 'w', ctrl: true}), {text: 'app ', cursor: 4});
  assert.deepEqual(edit({text: 'ap', cursor: 2}, {input: 'p\n'}), {text: 'app ', cursor: 4});
  assert.equal(edit({text: '', cursor: 0}, {input: 'x', ctrl: true}), null);
});
