// The Launcher's main process: its window and the bridge to the paperboat CLI (the only transport,
// @paperboat/client's cliTransport) for its sandboxed page; and the apps' windows (Paperboat windows), each
// an app's local page with only the system's dialogs (app-preload.ts). One instance: `--open <url>
// [--title <t>]` (what `paperboat app open` runs) opens an app's window in the running Launcher. No logic of its own.

import {app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents} from 'electron';
import {isAbsolute, join} from 'node:path';
import {CliError, cliTransport} from '@paperboat/client';
import type {CallResult} from './bridge.ts';

const t = cliTransport(process.env.PAPERBOAT_BIN || 'paperboat');
const streams = new Map<number, () => void>();
const launcherPage = join(__dirname, 'renderer', 'index.html');
const appPages = new Set<number>();  // webContents ids of the apps' windows: never the CLI's channels
const isLocal = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url);

function window(url: string, opts: {title: string; app?: boolean}) {
  const w = new BrowserWindow({
    title: opts.title,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f6f6f2',
    // no system title bar: the page's bar is it (the kit's WindowKeys); macOS keeps its lights, inside the bar
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? {trafficLightPosition: {x: 16, y: 22}} : {}),
    webPreferences: {
      preload: join(__dirname, opts.app ? 'app-preload.cjs' : 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: !opts.app,  // an app's live views (scopes, plots, runs) keep going behind other windows
    },
  });
  const tell = () => !w.webContents.isDestroyed() && w.webContents.send('win:maximized', w.isMaximized());
  w.on('maximize', tell);
  w.on('unmaximize', tell);
  if (opts.app) {
    const id = w.webContents.id;
    appPages.add(id);
    w.on('closed', () => appPages.delete(id));
  }
  // links leave for the browser; a page only navigates within itself
  w.webContents.setWindowOpenHandler(({url}) => (void shell.openExternal(url), {action: 'deny'}));
  void (url.startsWith('http') ? w.loadURL(url) : w.loadFile(url));
  return w;
}

/** `--open <url> [--title <t>]` from a command line: an app's local page, or null. */
function opened(argv: string[]) {
  const at = argv.indexOf('--open'), url = at < 0 ? '' : argv[at + 1] ?? '';
  if (!isLocal(url)) return null;
  const ti = argv.indexOf('--title');
  return {url, title: ti < 0 ? 'Paperboat' : argv[ti + 1] ?? 'Paperboat'};
}

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
  const r = await dialog.showSaveDialog(parent(e), {title: title || undefined, defaultPath: name || undefined, filters: filters(types)});
  return r.canceled || !r.filePath ? null : r.filePath;
});
ipcMain.on('app:reveal', (_e, path: unknown) => {
  if (typeof path === 'string' && isAbsolute(path)) shell.showItemInFolder(path);
});

app.setName('Paperboat Launcher');
// the Launcher keeps its state with its home, so a second home (a test's) is a second instance
if (process.env.PAPERBOAT_HOME) app.setPath('userData', join(process.env.PAPERBOAT_HOME, 'launcher'));
// a second start hands over its own command line as it was typed: the `argv` Chromium gives the first
// instance has the switches moved before the arguments, so `--open <url>` no longer has its url after it
if (!app.requestSingleInstanceLock({argv: process.argv})) app.quit();
else {
  // a second start hands its command line here: an app's window, or the Launcher's
  app.on('second-instance', (_e, argv, _cwd, data) => {
    const o = opened((data as {argv?: string[]} | undefined)?.argv ?? argv);
    if (o) return void window(o.url, {title: o.title, app: true});
    const w = BrowserWindow.getAllWindows().find(x => !appPages.has(x.webContents.id));
    if (w) return void (w.isMinimized() && w.restore(), w.focus());
    window(launcherPage, {title: 'Paperboat Launcher'});
  });
  app.whenReady().then(() => {
    const o = opened(process.argv);
    if (o) window(o.url, {title: o.title, app: true});
    else window(launcherPage, {title: 'Paperboat Launcher'});
    app.on('activate', () => BrowserWindow.getAllWindows().length || window(launcherPage, {title: 'Paperboat Launcher'}));
  });
}
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
