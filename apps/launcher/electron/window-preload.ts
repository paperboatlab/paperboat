// window.paperboatWindow, the same in the Launcher's page and an app's: its own window's keys, nothing else.
import {contextBridge, ipcRenderer, webFrame} from 'electron';
import type {WindowControls} from './bridge.ts';

export function exposeWindow() {
  const controls: WindowControls = {
    platform: process.platform,
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    // the interface scale (the kit's useScale): the page's layout sees a real smaller or larger viewport
    setZoom: factor => [0.75, 1, 1.25].includes(factor) && webFrame.setZoomFactor(factor),
    onMaximized(fn) {
      const on = (_e: unknown, max: boolean) => fn(max);
      ipcRenderer.on('win:maximized', on);
      void ipcRenderer.invoke('win:is-maximized').then(fn);
      return () => void ipcRenderer.off('win:maximized', on);
    },
  };
  contextBridge.exposeInMainWorld('paperboatWindow', controls);
}
