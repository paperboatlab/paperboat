// The page's only door: window.paperboat (electron/bridge.ts).
import {contextBridge, ipcRenderer} from 'electron';
import type {Bridge} from './bridge.ts';

let next = 1;
const lines = new Map<number, (l: string) => void>();
const items = new Map<number, (i: unknown) => void>();
ipcRenderer.on('pb:line', (_e, id: number, l: string) => lines.get(id)?.(l));
ipcRenderer.on('pb:item', (_e, id: number, i: unknown) => items.get(id)?.(i));

const bridge: Bridge = {
  async call(argv, json, onLine) {
    const id = next++;
    lines.set(id, onLine);
    try {
      return await ipcRenderer.invoke('pb:call', id, argv, json);
    } finally {
      lines.delete(id);
    }
  },
  stream(argv, onItem) {
    const id = next++;
    items.set(id, onItem);
    ipcRenderer.send('pb:stream', id, argv);
    return () => {
      items.delete(id);
      ipcRenderer.send('pb:stop', id);
    };
  },
  openWindow: (url, title) => ipcRenderer.send('pb:window', url, title),
  pickFolder: title => ipcRenderer.invoke('pb:folder', title),
};
contextBridge.exposeInMainWorld('paperboat', bridge);
