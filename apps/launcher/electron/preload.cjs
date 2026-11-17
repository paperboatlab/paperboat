const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperboatLauncher", {
  isElectron: true,
  getState: () => ipcRenderer.invoke("launcher:state"),
  pollLogs: (since) => ipcRenderer.invoke("launcher:logs", since),
  execCli: (args, label, kind) => ipcRenderer.invoke("launcher:exec", { args, label, kind }),
  stopTask: (taskId) => ipcRenderer.invoke("launcher:stopTask", taskId),
  fetchVersions: (kind, name) => ipcRenderer.invoke("launcher:versions", kind, name),
  inspectToolkit: (name) => ipcRenderer.invoke("launcher:inspect", name),
  setChannel: (channel) => ipcRenderer.invoke("launcher:channel", channel),
  removeBackendDir: (dir) => ipcRenderer.invoke("launcher:removeBackend", dir),
  pickFile: (kind) => ipcRenderer.invoke("launcher:pickFile", kind),
  openExternalUrl: (url) => ipcRenderer.invoke("launcher:openUrl", url),
  openFolderPath: (dir) => ipcRenderer.invoke("launcher:openPath", dir),
  onLog: (fn) => {
    const handler = (_ev, entry) => fn(entry);
    ipcRenderer.on("launcher:log", handler);
    return () => ipcRenderer.off("launcher:log", handler);
  },
  onTasks: (fn) => {
    const handler = (_ev, list) => fn(list);
    ipcRenderer.on("launcher:tasks", handler);
    return () => ipcRenderer.off("launcher:tasks", handler);
  },
  onOpenPpk: (fn) => {
    const handler = (_ev, filePath) => fn(filePath);
    ipcRenderer.on("launcher:open-ppk", handler);
    return () => ipcRenderer.off("launcher:open-ppk", handler);
  },
});
