// An app's page in a Paperboat window: its only door, window.paperboatShell (bridge.ts Shell). No CLI.
import {contextBridge, ipcRenderer} from 'electron';
import type {Shell} from './bridge.ts';

const shell: Shell = {
  pickFile: (types, title) => ipcRenderer.invoke('app:file', types ?? [], title ?? ''),
  pickFolder: title => ipcRenderer.invoke('app:folder', title ?? ''),
  pickSave: (name, types, title) => ipcRenderer.invoke('app:save', name ?? '', types ?? [], title ?? ''),
  reveal: path => ipcRenderer.send('app:reveal', path),
};
contextBridge.exposeInMainWorld('paperboatShell', shell);
