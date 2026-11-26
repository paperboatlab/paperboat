// The Launcher on Electron against the real CLI (build/paperboat): a home and a registry of its own, a
// demo app whose launcher serves its folder over HTTP. Native folder dialogs are answered in the main process.

import {_electron as electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const here = new URL('.', import.meta.url).pathname;
const bin = process.env.PAPERBOAT_BIN || join(here, '../../../build/paperboat');
const home = mkdtempSync(join(tmpdir(), 'pb-launcher-'));
const checkout = join(home, 'demo-src'), project = join(home, 'hub'), data = join(home, 'data');
// one Launcher through the steps: a failed step skips the rest instead of starting them on a fresh home
test.describe.configure({mode: 'serial'});
let app: ElectronApplication;
let page: Page;

// for people to look at, not a check: a screen that can't be captured (Xvfb without a GPU) fails nothing
const shot = (name: string) => page.screenshot({path: join(here, '../test-results', `launcher-${name}.png`)}).catch(() => {});
const answerFolder = (dir: string) =>
  app.evaluate(({dialog}, d) => {
    dialog.showOpenDialog = (async () => ({canceled: false, filePaths: [d]})) as typeof dialog.showOpenDialog;
  }, dir);

test.beforeAll(async () => {
  for (const d of [join(checkout, 'bin'), project, data]) mkdirSync(d, {recursive: true});
  writeFileSync(join(data, 'apps.toml'), '[[apps]]\nname = "demo"\nlabel = "Demo"\nrepo = "x/demo"\ndescription = "A demo app"\nruntimes = ["python@3.12"]\nlaunch = "bin/serve"\nport = 47410\n');
  writeFileSync(join(checkout, 'bin/serve'), '#!/bin/sh\nexec python3 -m http.server "$3" --bind 127.0.0.1 --directory "$1"\n');
  chmodSync(join(checkout, 'bin/serve'), 0o755);
  writeFileSync(join(project, 'index.html'), '<title>demo hub</title>');
  app = await electron.launch({
    // CI runners: no setuid sandbox helper, no GPU under Xvfb
    args: [join(here, '..'), ...(process.env.CI ? ['--no-sandbox', '--disable-gpu'] : [])],
    env: {...process.env, PAPERBOAT_BIN: bin, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run'), PAPERBOAT_DATA_DIR: data, PAPERBOAT_BACKENDS: 'native'},
  });
  page = await app.firstWindow();
  await page.setViewportSize({width: 1440, height: 900});
});

test.afterAll(async () => {
  const env = {...process.env, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run')};
  for (const args of [['session', 'stop', '--all'], ['daemon', 'stop']])
    try {
      execFileSync(bin, args, {env, timeout: 15_000});
    } catch {}
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))]);
  rmSync(home, {recursive: true, force: true});
});

test('apps: install a checkout, open it in its own window, stop it', async () => {
  const card = page.locator('.acard.app-demo');
  await expect(card).toContainText('available');
  await expect(card).toContainText('python 3.12');
  await shot('apps');
  await answerFolder(checkout);
  await card.getByRole('button', {name: 'More'}).click();
  await page.getByRole('menuitem', {name: /Install from a folder/}).click();
  await expect(card).toContainText('your checkout');

  await answerFolder(project);
  const opened = app.waitForEvent('window');
  await card.getByRole('button', {name: 'Open'}).click();
  const w = await opened;
  await expect.poll(() => w.url()).toMatch(/^http:\/\/127\.0\.0\.1:47410\//);
  await expect(w).toHaveTitle('demo hub');
  // an app's window: the system's dialogs (window.paperboatShell), never the CLI (window.paperboat)
  expect(await w.evaluate(() => [typeof (window as {paperboatShell?: unknown}).paperboatShell, typeof (window as {paperboat?: unknown}).paperboat])).toEqual(['object', 'undefined']);
  await w.close();

  const row = page.locator('table.t tr', {hasText: 'demo-47410'});
  await expect(row).toContainText('running');
  await expect(card).toContainText('running · :47410');
  await shot('apps-running');
  await row.getByRole('button', {name: 'Stop'}).click();
  await expect(page.locator('table.t tr', {hasText: 'demo-47410'})).toHaveCount(0);
  await expect(page.getByText('Nothing is running.')).toBeVisible();
});

test('a failure says why: no release to install', async () => {
  await page.locator('.acard.app-demo').getByRole('button', {name: 'More'}).click();
  await page.keyboard.press('Escape');
  execFileSync(bin, ['app', 'uninstall', 'demo'], {env: {...process.env, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run'), PAPERBOAT_DATA_DIR: data}});
  await page.keyboard.press('Alt+4');
  await page.keyboard.press('Alt+1');
  const card = page.locator('.acard.app-demo');
  await expect(card).toContainText('available');
  await card.getByRole('button', {name: 'Install'}).click();
  await expect(page.locator('.toast.failed')).toContainText(/Installing Demo: failed/);
  // the bar's bell keeps it, with the start of the session from the first test
  await page.getByRole('button', {name: /^Notifications/}).click();
  const notes = page.getByRole('dialog', {name: 'Notifications'});
  await expect(notes.locator('li.failed')).toContainText('Installing Demo: failed');
  await expect(notes).toContainText('Demo started');
  await shot('notifications');
  await page.keyboard.press('Escape');
  await expect(notes).toHaveCount(0);
});

test('runtimes: the catalog, where they run, a runtime in detail', async () => {
  await page.keyboard.press('Alt+3');
  await expect(page.locator('.kr', {hasText: 'julia'})).toBeVisible();
  await expect(page.locator('.backends')).toContainText('native');
  await page.locator('.kr', {hasText: 'python'}).click();
  await expect(page.locator('.dname')).toContainText('python');
  await page.getByRole('tab', {name: /Image/}).click();
  await expect(page.locator('.facts2')).toContainText('paperboat-runtime/0');
  await shot('runtimes');
  await page.getByRole('tab', {name: /Events/}).click();
  await page.getByRole('tab', {name: /Running/}).click();
});

test('Ctrl+K reaches every command; one without arguments runs, one with them fills the Console', async () => {
  const commands = JSON.parse(execFileSync(bin, ['help', '--json'], {env: {...process.env, PAPERBOAT_HOME: home, PAPERBOAT_DATA_DIR: data}}).toString()) as {name: string; tui: boolean}[];
  await page.keyboard.press('Control+k');
  const box = page.getByRole('combobox');
  for (const c of commands.filter(x => !x.tui)) {
    await box.fill(c.name);
    await expect(page.locator('.search-row').first(), c.name).toContainText(c.name);
  }
  await box.fill('app open');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', {name: 'Command'})).toHaveValue('app open ');
  await shot('console');
});

test('console: a command line with completion, the CLI words back', async () => {
  const input = page.getByRole('textbox', {name: 'Command'});
  await input.fill('app li');
  await expect(page.getByRole('option', {selected: true})).toContainText('app list');
  await input.press('Tab');
  await expect(input).toHaveValue('app list');
  await input.press('Enter');
  await expect(page.locator('.transcript .entry').last()).toContainText(/demo\s+available/);
  await input.fill('app open nope');
  await input.press('Enter');
  await expect(page.locator('.transcript .entry').last()).toContainText('no app named nope');
  await shot('console-run');
});

test('about: the versions, from the rail foot', async () => {
  const version = execFileSync(bin, ['--version']).toString().trim().replace(/^paperboat /, '');
  await page.getByRole('button', {name: 'About', exact: true}).click();
  const about = page.getByRole('dialog', {name: 'About'});
  await expect(about).toContainText(`Version ${version}`);
  await expect(about).toContainText(`Launcher ${JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version}`);
  await expect(about).toContainText('Electron');
  await shot('about');
  await page.keyboard.press('Escape');
  await expect(about).toHaveCount(0);
});
