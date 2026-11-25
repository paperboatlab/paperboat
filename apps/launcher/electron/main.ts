// The Launcher's main process: the window, and the bridge to the paperboat CLI (the only transport,
// @paperboat/client's cliTransport) for the sandboxed page. No logic of its own.

import {app, BrowserWindow, dialog, ipcMain, shell, type WebContents} from 'electron';
import {join} from 'node:path';
import {CliError, cliTransport} from '@paperboat/client';
import type {CallResult} from './bridge.ts';

const t = cliTransport(process.env.PAPERBOAT_BIN || 'paperboat');
const streams = new Map<number, () => void>();

function window(url: string, opts: {title: string; width?: number; height?: number}) {
  const w = new BrowserWindow({
    title: opts.title,
    width: opts.width ?? 1440,
    height: opts.height ?? 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f6f6f2',
    webPreferences: {preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false},
  });
  // links leave for the browser; the Launcher's page only navigates within itself
  w.webContents.setWindowOpenHandler(({url}) => (void shell.openExternal(url), {action: 'deny'}));
  void (url.startsWith('http') ? w.loadURL(url) : w.loadFile(url));
  return w;
}

ipcMain.handle('pb:call', async (e, id: number, argv: string[], json: boolean): Promise<CallResult> => {
  try {
    return {ok: true, value: await t.call(argv, line => e.sender.send('pb:line', id, line), json)};
  } catch (err) {
    const c = err instanceof CliError ? err : null;
    return {ok: false, error: (err as Error).message, code: c?.code ?? 1, extra: c?.extra ?? {}};
  }
});

ipcMain.on('pb:stream', (e, id: number, argv: string[]) => {
  const sender: WebContents = e.sender;
  const s = t.stream(argv, item => !sender.isDestroyed() && sender.send('pb:item', id, item));
  streams.set(id, s.stop);
  sender.once('destroyed', s.stop);
});
ipcMain.on('pb:stop', (_e, id: number) => {
  streams.get(id)?.();
  streams.delete(id);
});
ipcMain.on('pb:window', (_e, url: string, title: string) => {
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) window(url, {title});  // only a local app server
});
ipcMain.handle('pb:folder', async (e, title: string) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await (w ? dialog.showOpenDialog(w, {title, properties: ['openDirectory', 'createDirectory']}) : dialog.showOpenDialog({title, properties: ['openDirectory']}));
  return r.canceled ? null : r.filePaths[0];
});

app.setName('Paperboat Launcher');
app.whenReady().then(() => {
  window(join(__dirname, 'renderer', 'index.html'), {title: 'Paperboat Launcher'});
  app.on('activate', () => BrowserWindow.getAllWindows().length || window(join(__dirname, 'renderer', 'index.html'), {title: 'Paperboat Launcher'}));
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
