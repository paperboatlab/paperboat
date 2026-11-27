// The Launcher's main process: its window and the bridge to the paperboat CLI (the only transport,
// @paperboat/client's cliTransport) for its sandboxed page; and the apps' windows (Paperboat windows), each
// an app's local page with only the system's dialogs (app-preload.ts). One instance: `--open <url>
// [--title <t>]` (what `paperboat app open` runs) opens an app's window in the running Launcher; `--page <page>
// [--runtime <name>]` (`paperboat launcher`: an app's Manage runtimes…) opens or focuses the Launcher's window on
// that page. No logic of its own.

import {app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents} from 'electron';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {CliError, cliTransport} from '@paperboat/client';
import type {CallResult} from './bridge.ts';

const t = cliTransport(process.env.PAPERBOAT_BIN || 'paperboat');
const streams = new Map<number, () => void>();
const launcherPage = join(__dirname, 'renderer', 'index.html');
const appPages = new Set<number>();  // webContents ids of the apps' windows: never the CLI's channels
const isLocal = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url);

const appOf = (title: string) => title.split(/[\s·]/)[0].toLowerCase();
// a window's icon: its app's mark (the kit's marks/<app>/icon.png, copied with the page), else Paperboat's
const iconFor = (title: string) => {
  const own = join(__dirname, 'renderer', 'marks', appOf(title), 'icon.png');
  return existsSync(own) ? own : join(__dirname, 'renderer', 'marks', 'paperboat', 'icon.png');
};

// Linux: GNOME on Wayland takes a window's icon and dock place from the desktop entry its app id names. Chromium
// reads CHROME_DESKTOP as each window is made: an app with its entry (`paperboat app install` writes
// paperboat-<app>.desktop) is its own app in the dock, in this one process; one without stays Paperboat's.
const entryOf = (app: string) => {
  const dirs = [process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
  const name = `paperboat-${app}.desktop`;
  return process.platform === 'linux' && dirs.some(d => existsSync(join(d, 'applications', name))) ? name : null;
};

// An app's server ends with its last window (user, 2026-11-26): `paperboat session stop <app>-<port>`, detached so
// it outlives this process when that window was the last of all. A server that isn't a session (a dev one) stays.
const origins = new Map<number, string>();  // app windows: webContents id → the page's origin
function lastClosed(app: string, origin: string) {
  if ([...origins.values()].includes(origin)) return;
  spawn(process.env.PAPERBOAT_BIN || 'paperboat', ['session', 'stop', `${app}-${new URL(origin).port}`], {detached: true, stdio: 'ignore'})
    .on('error', () => {}).unref();
}

// a window's least size at Default; the scale widens it (win:zoom)
const MIN_WIDTH = 960, MIN_HEIGHT = 600;

function window(url: string, opts: {title: string; app?: boolean; query?: Record<string, string>}) {
  const desktop = process.env.CHROME_DESKTOP, entry = opts.app ? entryOf(appOf(opts.title)) : null;
  if (entry) process.env.CHROME_DESKTOP = entry;
  const w = new BrowserWindow({
    title: opts.title,
    icon: iconFor(opts.app ? opts.title : 'paperboat'),
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#f6f6f2',
    // no system title bar: the page's bar is it (the kit's WindowKeys); macOS keeps its lights, inside the bar
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? {trafficLightPosition: {x: 16, y: 22}} : {}),
    webPreferences: {
      preload: join(__dirname, opts.app ? 'app-preload.cjs' : 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: !opts.app,  // an app's live views (scopes, plots, runs) keep going behind other windows
    },
  });
  if (entry) desktop === undefined ? delete process.env.CHROME_DESKTOP : (process.env.CHROME_DESKTOP = desktop);
  const tell = () => !w.webContents.isDestroyed() && w.webContents.send('win:maximized', w.isMaximized());
  w.on('maximize', tell);
  w.on('unmaximize', tell);
  if (opts.app) {
    const id = w.webContents.id, origin = new URL(url).origin;
    appPages.add(id);
    origins.set(id, origin);
    w.on('closed', () => (appPages.delete(id), origins.delete(id), lastClosed(appOf(opts.title), origin)));
    // a page that is busy or holds unsaved work says so (beforeunload): ask before closing it
    w.webContents.on('will-prevent-unload', e => {
      const close = dialog.showMessageBoxSync(w, {type: 'question', buttons: ['Keep open', 'Close anyway'], defaultId: 0, cancelId: 0,
        message: `${opts.title} is still working`, detail: 'Closing now stops it; what it is doing or hasn\'t saved is lost.'}) === 1;
      if (close) e.preventDefault();
    });
  }
  // links leave for the browser; a page only navigates within itself. An app's link to a local page (Malachite's
  // Open in Simplicial: window.open(url, label)) is another app's page: a Paperboat window, named by the frame name
  w.webContents.setWindowOpenHandler(({url, frameName}) => {
    if (opts.app && isLocal(url) && frameName && frameName !== '_blank') window(url, {title: frameName, app: true});
    else void shell.openExternal(url);
    return {action: 'deny'};
  });
  void (url.startsWith('http') ? w.loadURL(url) : w.loadFile(url, {query: opts.query}));
  return w;
}

/** `--open <url> [--title <t>]` from a command line: an app's local page, or null. */
function opened(argv: string[]) {
  const at = argv.indexOf('--open'), url = at < 0 ? '' : argv[at + 1] ?? '';
  if (!isLocal(url)) return null;
  const ti = argv.indexOf('--title');
  return {url, title: ti < 0 ? 'Paperboat' : argv[ti + 1] ?? 'Paperboat'};
}

/** `--page <page> [--runtime <name>]` from a command line: where the Launcher's page goes, or null. */
function goto(argv: string[]) {
  const at = argv.indexOf('--page'), page = at < 0 ? '' : argv[at + 1] ?? '';
  if (!/^[a-z]+$/.test(page)) return null;
  const ri = argv.indexOf('--runtime'), runtime = ri < 0 ? '' : argv[ri + 1] ?? '';
  return {page, ...(/^[\w.@-]+$/.test(runtime) ? {runtime} : {})};
}
// the Launcher's window, on that page: the query when it is made, launcher:goto when it is there
const launcherWindow = (to: ReturnType<typeof goto>) => window(launcherPage, {title: 'Paperboat Launcher', query: to ?? undefined});

// the Launcher page's channels: refused to an app's window
const launcherOnly = (e: IpcMainEvent | IpcMainInvokeEvent) => {
  if (appPages.has(e.sender.id)) throw new Error('not for an app window');
};

ipcMain.handle('pb:call', async (e, id: number, argv: string[], json: boolean): Promise<CallResult> => {
  launcherOnly(e);
  try {
    return {ok: true, value: await t.call(argv, line => e.sender.send('pb:line', id, line), json)};
  } catch (err) {
    const c = err instanceof CliError ? err : null;
    return {ok: false, error: (err as Error).message, code: c?.code ?? 1, extra: c?.extra ?? {}};
  }
});
ipcMain.on('pb:stream', (e, id: number, argv: string[]) => {
  launcherOnly(e);
  const sender: WebContents = e.sender;
  const s = t.stream(argv, item => !sender.isDestroyed() && sender.send('pb:item', id, item));
  streams.set(id, s.stop);
  sender.once('destroyed', s.stop);
});
ipcMain.on('pb:stop', (_e, id: number) => {
  streams.get(id)?.();
  streams.delete(id);
});
ipcMain.on('pb:window', (e, url: string, title: string) => {
  launcherOnly(e);
  if (isLocal(url)) window(url, {title, app: true});
});
ipcMain.handle('pb:folder', async (e, title: string) => {
  launcherOnly(e);
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await (w ? dialog.showOpenDialog(w, {title, properties: ['openDirectory', 'createDirectory']}) : dialog.showOpenDialog({title, properties: ['openDirectory']}));
  return r.canceled ? null : r.filePaths[0];
});

// every page's own window keys (WindowKeys): only the window the page is in
const own = (e: IpcMainEvent | IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
ipcMain.on('win:minimize', e => own(e)?.minimize());
ipcMain.on('win:maximize', e => {
  const w = own(e);
  if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('win:close', e => own(e)?.close());
// the interface scale (the kit's useScale): the page zooms, and the window's least width with it, so the page
// never lays out narrower than at Default (Large keeps the bar's window keys in sight)
ipcMain.on('win:zoom', (e, factor: unknown) => {
  if (factor !== 0.75 && factor !== 1 && factor !== 1.25) return;
  e.sender.setZoomFactor(factor);
  const w = own(e), least = Math.round(MIN_WIDTH * factor);
  if (!w) return;
  w.setMinimumSize(least, MIN_HEIGHT);
  const [width, height] = w.getSize();
  if (width < least && !w.isMaximized()) w.setSize(least, height);
});
ipcMain.handle('win:is-maximized', e => own(e)?.isMaximized() ?? false);

// an app's window: the system's dialogs, parented to it, and real paths
const filters = (types: string[]) => (types.length ? [{name: types.map(x => `.${x}`).join(', '), extensions: types}, {name: 'All files', extensions: ['*']}] : []);
const parent = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)!;
ipcMain.handle('app:file', async (e, types: string[], title: string) => {
  const r = await dialog.showOpenDialog(parent(e), {title: title || undefined, properties: ['openFile'], filters: filters(types)});
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:folder', async (e, title: string) => {
  const r = await dialog.showOpenDialog(parent(e), {title: title || undefined, properties: ['openDirectory', 'createDirectory']});
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:save', async (e, name: string, types: string[], title: string) => {
  // a taken name asks before replacing: macOS and Windows always do, GTK only when told
  const r = await dialog.showSaveDialog(parent(e), {title: title || undefined, defaultPath: name || undefined, filters: filters(types),
    properties: ['showOverwriteConfirmation', 'createDirectory']});
  return r.canceled || !r.filePath ? null : r.filePath;
});
ipcMain.on('app:reveal', (_e, path: unknown) => {
  if (typeof path === 'string' && isAbsolute(path)) shell.showItemInFolder(path);
});

app.setName('Paperboat Launcher');
// the Launcher keeps its state with its home, so a second home (a test's) is a second instance
if (process.env.PAPERBOAT_HOME) app.setPath('userData', join(process.env.PAPERBOAT_HOME, 'launcher'));
// `--version`: the version and out, before any window or lock (the packages' start check).
// A second start hands over its own command line as it was typed: the `argv` Chromium gives the first
// instance has the switches moved before the arguments, so `--open <url>` no longer has its url after it
if (process.argv.includes('--version')) (console.log(app.getVersion()), app.exit(0));
else if (!app.requestSingleInstanceLock({argv: process.argv})) app.quit();
else {
  // a second start hands its command line here: an app's window, or the Launcher's
  app.on('second-instance', (_e, chromium, _cwd, data) => {
    const argv = (data as {argv?: string[]} | undefined)?.argv ?? chromium;
    const o = opened(argv);
    if (o) return void window(o.url, {title: o.title, app: true});
    const to = goto(argv);
    const w = BrowserWindow.getAllWindows().find(x => !appPages.has(x.webContents.id));
    if (!w) return void launcherWindow(to);
    if (to) w.webContents.send('launcher:goto', to);
    w.isMinimized() && w.restore();
    w.focus();
  });
  app.whenReady().then(() => {
    const o = opened(process.argv);
    if (o) window(o.url, {title: o.title, app: true});
    else launcherWindow(goto(process.argv));
    app.on('activate', () => BrowserWindow.getAllWindows().length || launcherWindow(null));
  });
}
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
