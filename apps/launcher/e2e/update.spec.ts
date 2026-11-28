// Paperboat updating itself from the Launcher (pb#94, pb#61, pb#63), against the real CLI (build/paperboat) and a
// release of the test's own (GitHub is a folder, the packages file:// URLs). The CLI's install command is run by a
// stand-in that records it ($PAPERBOAT_UPDATE_RUNNER): nothing asks for a password or installs anything, and the
// relaunch is recorded in the main process instead of starting a second Launcher.

import {_electron as electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {connect, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const here = new URL('.', import.meta.url).pathname;
const bin = process.env.PAPERBOAT_BIN || join(here, '../../../build/paperboat');
const home = mkdtempSync(join(tmpdir(), 'pb-update-'));
const rel = join(home, 'release'), said = join(home, 'stub-said'), exitFile = join(home, 'stub-exit'), project = join(home, 'lab');
const env = {...process.env, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run'), XDG_DATA_HOME: join(home, 'xdg')};
test.describe.configure({mode: 'serial'});
let app: ElectronApplication;
let page: Page;
let holder: Socket | undefined;

const shot = (name: string) => page.screenshot({path: join(here, '../test-results', `update-${name}.png`)}).catch(() => {});
const version = execFileSync(bin, ['--version']).toString().trim().replace(/^paperboat /, '');
const toast = () => page.locator('.toast').last();
const daemonPid = () => {
  try {
    return JSON.parse(execFileSync(bin, ['daemon', 'status', '--json'], {env}).toString()).pid as number;
  } catch {
    return 0;
  }
};

// what the toast shows stays inside the window (pb#63)
async function inWindow() {
  const box = (await toast().boundingBox())!, size = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
}

test.beforeAll(async () => {
  mkdirSync(rel, {recursive: true});
  mkdirSync(project);
  const files = {'paperboat-cli-99.0.0-1.x86_64.rpm': 'cli', 'paperboat-devel-99.0.0-1.x86_64.rpm': 'devel', 'paperboat-launcher-99.0.0.x86_64.rpm': 'x'.repeat(4_000_000)};
  const assets = Object.entries(files).map(([name, body]) => {
    writeFileSync(join(rel, name), body);
    return {name, browser_download_url: `file://${join(rel, name)}`, size: body.length, digest: `sha256:${createHash('sha256').update(body).digest('hex')}`};
  });
  mkdirSync(join(home, 'github/repos/paperboatlab/paperboat'), {recursive: true});
  writeFileSync(join(home, 'github/repos/paperboatlab/paperboat/releases'), JSON.stringify([{tag_name: 'v99.0.0', html_url: 'https://example.org/v99', assets}]));
  // the stand-in for pkexec: records the command, exits with what stub-exit says (126: the password dialog dismissed)
  writeFileSync(join(home, 'stub'), `#!/bin/sh\necho "$@" >> ${said}\nexit $(cat ${exitFile} 2>/dev/null || echo 0)\n`);
  chmodSync(join(home, 'stub'), 0o755);
  app = await electron.launch({
    args: [join(here, '..'), ...(process.env.CI ? ['--no-sandbox', '--disable-gpu'] : [])],
    env: {...env, PAPERBOAT_BIN: bin, PAPERBOAT_BACKENDS: 'native', PAPERBOAT_GITHUB_API: `file://${join(home, 'github')}`,
      PAPERBOAT_UPDATE_SYSTEM: 'rpm x86_64 cli devel launcher', PAPERBOAT_UPDATE_RUNNER: join(home, 'stub')},
  });
  page = await app.firstWindow();
  await page.setViewportSize({width: 1100, height: 700});
});

test.afterAll(async () => {
  holder?.destroy();
  try {
    execFileSync(bin, ['daemon', 'stop'], {env, timeout: 15_000});
  } catch {}
  app?.process().kill();  // its quit is the test's stand-in by now
  await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15_000))]);
  rmSync(home, {recursive: true, force: true});
});

test('settings: automatic updates are off until asked, and never install on their own', async () => {
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', {name: 'Settings'});
  await settings.getByRole('button', {name: 'Launcher'}).click();
  const auto = settings.getByRole('radiogroup', {name: 'Automatic updates'});
  await expect(auto.getByRole('radio', {name: 'Off'})).toBeChecked();
  await expect(settings).toContainText('Nothing installs on its own');
  await shot('settings');
  await page.keyboard.press('Escape');
});

test('check: the newest release in words, inside the window; nothing downloads before Update now', async () => {
  await page.getByRole('button', {name: 'Check for updates'}).click();
  await expect(toast()).toContainText('Paperboat 99.0.0 is out');
  await expect(toast()).toContainText(`you have ${version} · release channel`);
  await expect(toast().getByRole('button', {name: 'Update now'})).toBeVisible();
  await inWindow();
  await shot('check');
  await toast().getByRole('button', {name: 'Later'}).click();
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(existsSync(said)).toBe(false);
  expect(existsSync(join(home, 'cache/updates'))).toBe(false);
});

test('update now, the password refused: nothing changed, and it says so', async () => {
  writeFileSync(exitFile, '126');
  await page.getByRole('button', {name: 'Check for updates'}).click();
  await toast().getByRole('button', {name: 'Update now'}).click();
  await expect(toast()).toContainText('Paperboat was not updated');
  await expect(toast()).toContainText(`nothing changed: you still have ${version}`);
  await inWindow();
  await shot('cancelled');
  const cache = join(home, 'cache/updates/99.0.0');
  expect(readFileSync(said, 'utf8').trim()).toBe(`pkexec dnf install -y ${['paperboat-cli-99.0.0-1.x86_64.rpm', 'paperboat-devel-99.0.0-1.x86_64.rpm', 'paperboat-launcher-99.0.0.x86_64.rpm'].map(f => join(cache, f)).join(' ')}`);
  rmSync(said);
  await toast().getByRole('button', {name: 'Dismiss'}).click();
});

test('update now, installed: the restart says what it ends, then restarts paperboatd and the Launcher', async () => {
  writeFileSync(exitFile, '0');
  // a runtime at work in paperboatd (an app's kernel): restarting the old paperboatd ends it
  execFileSync(bin, ['runtime', 'list'], {env: {...env, PAPERBOAT_BACKENDS: 'native'}});
  holder = connect(join(home, 'run', 'control.sock')).on('data', () => {}).on('error', () => {});
  holder.write(JSON.stringify({id: 1, op: 'acquire', args: {runtime: 'python@3.12', mode: 'session', backend: 'native', owner: 'demo', project}}) + '\n');
  await page.keyboard.press('Alt+3');
  await expect(page.getByRole('banner').locator('.pill.live')).toContainText('1 running');
  await page.keyboard.press('Alt+1');

  const pid = daemonPid();
  expect(pid).toBeGreaterThan(0);
  await page.getByRole('button', {name: 'Check for updates'}).click();
  await toast().getByRole('button', {name: 'Update now'}).click();
  await expect(toast()).toContainText('Paperboat 99.0.0 is installed');
  await expect(toast()).toContainText('restart to use it');
  await inWindow();
  await shot('installed');
  expect(existsSync(join(home, 'cache/updates/99.0.0'))).toBe(false);  // the packages go once installed

  await app.evaluate(({app: a}) => {
    const g = globalThis as {relaunched?: boolean};
    a.relaunch = () => void (g.relaunched = true);
    a.quit = () => {};
  });
  await toast().getByRole('button', {name: 'Restart'}).click();
  const ask = page.getByRole('dialog', {name: 'Restart for Paperboat 99.0.0'});
  await expect(ask).toContainText('paperboatd still runs the version before');
  await expect(ask).toContainText(`python 3.12 for demo on ${project}`);
  await shot('restart');
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await expect(ask).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as {relaunched?: boolean}).relaunched ?? false)).toBe(false);

  await page.getByRole('button', {name: /^Notifications/}).click();
  await page.getByRole('dialog', {name: 'Notifications'}).getByRole('button', {name: 'Restart'}).first().click();
  await ask.getByRole('button', {name: 'Restart now'}).click();
  await expect.poll(() => app.evaluate(() => (globalThis as {relaunched?: boolean}).relaunched ?? false)).toBe(true);
  // the old paperboatd stopped (the Launcher's next ask starts a new one), and with it the runtime it ran
  await expect.poll(() => daemonPid()).not.toBe(pid);
  await expect.poll(() => JSON.parse(execFileSync(bin, ['runtime', 'ps', '--json'], {env: {...env, PAPERBOAT_BACKENDS: 'native'}}).toString()).length).toBe(0);
});
