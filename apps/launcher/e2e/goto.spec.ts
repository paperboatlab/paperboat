// `paperboat launcher --page <page> [--runtime <name>]` (an app's Manage runtimes…, pb#69): a first start lands
// on that page and runtime; a second start hands its page to the running Launcher, which goes there.

import {_electron as electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const bin = process.env.PAPERBOAT_BIN || join(here, '../../../build/paperboat');
const home = mkdtempSync(join(tmpdir(), 'pb-goto-'));
const env = {...process.env, PAPERBOAT_BIN: bin, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run'), PAPERBOAT_BACKENDS: 'native'};
const args = (...more: string[]) => [join(here, '..'), ...(process.env.CI ? ['--no-sandbox', '--disable-gpu'] : []), ...more];
test.describe.configure({mode: 'serial'});
let app: ElectronApplication;
let page: Page;

// a second start, as `paperboat launcher` runs it: it hands its command line over and quits
const again = (...more: string[]) =>
  new Promise<number | null>(done => spawn(createRequire(import.meta.url)('electron') as string, args(...more), {env, stdio: 'ignore'}).on('exit', done));
const on = (label: string) => expect(page.getByRole('button', {name: label, exact: true})).toHaveAttribute('aria-current', 'page');

test.beforeAll(async () => {
  app = await electron.launch({args: args('--page', 'runtimes', '--runtime', 'python'), env});
  page = await app.firstWindow();
});

test.afterAll(async () => {
  try {
    execFileSync(bin, ['daemon', 'stop'], {env, timeout: 15_000});
  } catch {}
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))]);
  rmSync(home, {recursive: true, force: true});
});

test('a first start with --page runtimes --runtime python lands there', async () => {
  await on('Runtimes');
  await expect(page.locator('.dname')).toContainText('python');
});

test('a second start takes the running Launcher to its page and runtime', async () => {
  expect(await again('--page', 'console')).toBe(0);
  await on('Console');
  expect(await again('--page', 'runtimes', '--runtime', 'julia')).toBe(0);
  await on('Runtimes');
  await expect(page.locator('.dname')).toContainText('julia');
  expect(app.windows()).toHaveLength(1);  // the same window, focused
});
