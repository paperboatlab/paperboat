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
process.env.XDG_DATA_HOME = join(home, 'xdg');  // an installed app's desktop entry lands here, never in the user's
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
  writeFileSync(join(checkout, 'bin/serve'), '#!/bin/sh\n# no folder (the Start page): serve the demo hub anyway\n[ "$1" = --port ] && set -- "' + project + '" "$@"\nexec python3 -m http.server "$3" --bind 127.0.0.1 --directory "$1"\n');
  chmodSync(join(checkout, 'bin/serve'), 0o755);
  writeFileSync(join(project, 'index.html'), '<title>demo hub</title>');
  // the demo brings a Stations group, as Simplicial does: `station list` from a fixed list, every other word echoed
  const stations = [['scratchpad', 'builtin', 'cpp'], ['02-cart-pole', 'installed', 'cpp'], ['01-smart-thermostat', 'installed', 'python'], ['pendulum', 'installed', 'julia']]
    .map(([name, source, language], i) => ({name, source, language, description: `the ${name} station`, dir: join(home, 'stations', name), port: 8765 + i}));
  writeFileSync(join(checkout, 'commands.toml'), 'cli = "bin/stations"\n' + [['station.list', 'station list', ''], ['station.check', 'check', '<station>'], ['station.run', 'run', '<station>']]
    .map(([id, name, args]) => `[[command]]\nid = "${id}"\nname = "${name}"\nargs = "${args}"\ndesc = "${name}"\ngroup = "Stations"\n`).join(''));
  writeFileSync(join(checkout, 'bin/stations'), `#!/bin/sh\n[ "$1 $2" = "station list" ] && exec echo '${JSON.stringify(stations)}'\necho "stations got: $*"\n`);
  chmodSync(join(checkout, 'bin/stations'), 0o755);
  // julia natively is a script that keeps the names Pkg.add and Pkg.rm get, in the folder's package volume
  mkdirSync(join(home, 'fakebin'));
  writeFileSync(join(home, 'fakebin/julia'), '#!/bin/sh\nf="$PAPERBOAT_DEPS/added"; touch "$f"\n' +
    'case "$3" in *\'Pkg.add(Pkg.PackageSpec(name="\'*) n=${3#*name=\\"}; echo "${n%%\\"*}" >> "$f";; esac\n' +
    'case "$3" in *\'Pkg.rm("\'*) n=${3#*Pkg.rm(\\"}; grep -vx "${n%%\\"*}" "$f" > "$f.t"; mv "$f.t" "$f";; esac\n' +
    'sed "s/^/PKG /;s/$/ 1.10.0/" "$f"\n');
  chmodSync(join(home, 'fakebin/julia'), 0o755);
  // GitHub is a folder: General's Registry.toml, DataFrames' folder in it, its repository
  const general = join(home, 'github/repos/JuliaRegistries/General/contents');
  mkdirSync(join(general, 'D/DataFrames'), {recursive: true});
  mkdirSync(join(home, 'github/repos/JuliaData'), {recursive: true});
  writeFileSync(join(general, 'Registry.toml'), '[packages]\na93c6f00-e57d-5684-b7b6-d8193f3e46c0 = { name = "DataFrames", path = "D/DataFrames" }\n' +
    '864edb3b-99cc-5e75-8d2d-829cb0a9cfe8 = { name = "DataStructures", path = "D/DataStructures" }\n');
  writeFileSync(join(general, 'D/DataFrames/Package.toml'), 'name = "DataFrames"\nrepo = "https://github.com/JuliaData/DataFrames.jl.git"\n');
  writeFileSync(join(general, 'D/DataFrames/Versions.toml'), '["1.9.0"]\n["1.10.0"]\n');
  writeFileSync(join(home, 'github/repos/JuliaData/DataFrames.jl'), JSON.stringify({description: 'In-memory tabular data', stargazers_count: 1845, topics: ['data', 'julia']}));
  app = await electron.launch({
    // CI runners: no setuid sandbox helper, no GPU under Xvfb
    args: [join(here, '..'), ...(process.env.CI ? ['--no-sandbox', '--disable-gpu'] : [])],
    env: {...process.env, PAPERBOAT_BIN: bin, PAPERBOAT_HOME: home, PAPERBOAT_RUNTIME_DIR: join(home, 'run'), PAPERBOAT_DATA_DIR: data, PAPERBOAT_BACKENDS: 'native',
      PATH: `${join(home, 'fakebin')}:${process.env.PATH}`, PAPERBOAT_GITHUB_API: `file://${join(home, 'github')}`},
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

  // Open asks for nothing: the app starts on its Start page, as a double click on its icon does
  const opened = app.waitForEvent('window');
  await card.getByRole('button', {name: 'Open'}).click();
  const w = await opened;
  await expect.poll(() => w.url()).toMatch(/^http:\/\/127\.0\.0\.1:47410\//);
  await expect(w).toHaveTitle('demo hub');
  // an app's window: the system's dialogs (window.paperboatShell), never the CLI (window.paperboat)
  expect(await w.evaluate(() => [typeof (window as {paperboatShell?: unknown}).paperboatShell, typeof (window as {paperboat?: unknown}).paperboat])).toEqual(['object', 'undefined']);

  const row = page.locator('table.t tr', {hasText: 'demo-47410'});
  await expect(row).toContainText('running');
  await expect(card).toContainText('running · :47410');
  await shot('apps-running');
  // its last window closed, the app's server ends
  await w.close();
  await expect(page.locator('table.t tr', {hasText: 'demo-47410'})).toHaveCount(0, {timeout: 15_000});
  await expect(page.getByText('Nothing is running.')).toBeVisible();
});

test('stations: the list by source, one in detail, its keys run its commands', async () => {
  await page.keyboard.press('Alt+2');
  await expect(page.getByRole('group', {name: 'Built-in'})).toContainText('scratchpad');
  await expect(page.getByRole('group', {name: 'Installed'}).locator('.kr')).toHaveCount(3);
  await expect(page.getByRole('group', {name: 'Installed'})).toContainText('jl');
  await expect(page.getByRole('button', {name: 'Fetch examples'})).toHaveCount(0);  // examples open from each app's Ctrl+K
  await page.locator('.kr', {hasText: '02-cart-pole'}).click();
  await expect(page.locator('.dname')).toHaveText('02-cart-pole');
  await expect(page.locator('.dmeta')).toContainText('ws://127.0.0.1:8766');
  await expect(page.getByRole('button', {name: 'Build', exact: true})).toBeVisible();  // C++ only
  await shot('stations');
  await page.getByRole('button', {name: 'Check', exact: true}).click();
  await expect(page.locator('.toast').last()).toContainText('stations got: check 02-cart-pole');
  await page.locator('.kr', {hasText: '01-smart-thermostat'}).click();
  await expect(page.getByRole('button', {name: 'Build', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Uninstall…'})).toBeVisible();  // installed ones only
  await page.locator('.kr', {hasText: 'scratchpad'}).click();
  await expect(page.getByRole('button', {name: /Uninstall/})).toHaveCount(0);
  await page.keyboard.press('Alt+1');
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
  // julia's packages: a folder, then General through the CLI (a folder here), an add, the folder listed after
  await page.locator('.kr', {hasText: 'julia'}).click();
  await page.getByRole('tab', {name: /Packages/}).click();
  await answerFolder(project);
  await page.getByRole('button', {name: /Choose a folder/}).click();
  await page.getByRole('menuitem', {name: /Other folder/}).click();
  await expect(page.locator('.pk')).toContainText('No packages in this folder yet');
  await page.getByRole('tab', {name: 'registry'}).click();
  await expect(page.locator('.pk-results')).toContainText('DifferentialEquations');  // the shelf
  await page.getByRole('textbox', {name: 'Search General'}).fill('data');
  await expect(page.locator('.pk-results')).toContainText('DataStructures');
  await page.locator('.pk-name', {hasText: 'DataFrames'}).click();
  await expect(page.locator('.pk-card')).toContainText('In-memory tabular data');
  await expect(page.locator('.pk-card')).toContainText('1845 stars');
  await expect(page.locator('.pk-card')).toContainText('topics: data, julia');
  await expect(page.locator('.pk-card .tag').first()).toHaveText('1.10.0');
  await shot('packages');
  await page.getByRole('button', {name: 'Add DataFrames'}).click();
  await expect(page.locator('.pk-card')).toContainText('installed');
  await page.getByRole('tab', {name: 'environment'}).click();
  await expect(page.locator('.pk-pkg')).toContainText('DataFrames');
  await page.locator('.folder .pick').click();
  await expect(page.getByRole('menu', {name: 'Folders'})).toContainText('With packages');
  await shot('folders');
  await page.keyboard.press('Escape');
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

test('settings: the theme, the channel and the keys, from the rail foot or Ctrl+,', async () => {
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings'});
  await settings.getByRole('radio', {name: 'Dark'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot('settings-general');
  await settings.getByRole('button', {name: 'Launcher'}).click();
  await expect(settings.getByRole('radiogroup', {name: 'Update channel'})).toBeVisible();
  await settings.getByRole('button', {name: 'Shortcuts'}).click();
  await expect(settings).toContainText('Ctrl K');
  await shot('settings-shortcuts');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await settings.getByRole('radio', {name: 'System'}).click();
  await page.keyboard.press('Escape');
});

test('settings: the interface scale zooms the window, its keys stay in sight', async () => {
  await page.setViewportSize({width: 1366, height: 768});
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', {name: 'Settings'});
  const zoom = () => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  for (const [name, factor] of [['Large', 1.25], ['Compact', 0.75], ['Default', 1]] as const) {
    await settings.getByRole('radio', {name: new RegExp(`^${name}`)}).click();
    await expect.poll(zoom).toBeCloseTo(factor);
    await expect(page.locator('html')).not.toHaveAttribute('style', /zoom/);  // the window zooms, not CSS
    // and its least width with it: the page never lays out narrower than at Default
    expect(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getMinimumSize()[0])).toBe(Math.round(960 * factor));
    await page.keyboard.press('Escape');
    if (process.platform !== 'darwin') {
      const keys = page.locator('.window-keys').boundingBox(), width = await page.evaluate(() => innerWidth);
      expect((await keys)!.x + (await keys)!.width).toBeLessThanOrEqual(width);
    }
    await shot(`scale-${factor * 100}`);
    await page.keyboard.press('Control+,');
  }
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 1440, height: 900});
});

test('window keys: the bar is the title bar, its keys act on the window', async () => {
  await expect(page.locator('html')).toHaveAttribute('data-window', process.platform);
  if (process.platform === 'darwin') return void (await expect(page.locator('.window-keys')).toHaveCount(0));
  // Xvfb has no window manager to maximize: the window's own methods say what was asked
  await app.evaluate(({BrowserWindow}) => {
    const w = BrowserWindow.getAllWindows()[0];
    const asked: string[] = ((globalThis as {asked?: string[]}).asked = []);
    let max = false;
    w.isMaximized = () => max;
    w.maximize = () => void (asked.push('maximize'), (max = true), w.emit('maximize'));
    w.unmaximize = () => void (asked.push('unmaximize'), (max = false), w.emit('unmaximize'));
  });
  const keys = page.getByRole('group', {name: 'Window'});
  await keys.getByRole('button', {name: 'Maximize'}).click();
  await expect(keys.getByRole('button', {name: 'Restore'})).toBeVisible();
  await keys.getByRole('button', {name: 'Restore'}).click();
  await expect(keys.getByRole('button', {name: 'Maximize'})).toBeVisible();
  await page.locator('.frame > .bar .wt').dblclick();
  expect(await app.evaluate(() => (globalThis as {asked?: string[]}).asked)).toEqual(['maximize', 'unmaximize', 'maximize']);
});
