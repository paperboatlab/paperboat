import type { Channel, LauncherLogLine, LauncherStateSnapshot, LauncherTask } from "./model";

export interface PollLogsResponse {
  seq: number;
  lines: LauncherLogLine[];
  tasks: LauncherTask[];
}

export interface InspectResult {
  name: string;
  builtin: boolean;
  installed: boolean;
  station_blocks?: Array<{ type: string; label: string; description: string }>;
  flow_blocks?: Array<{ type: string; label: string; description: string }>;
  dashboard_instruments?: Array<{ type: string; label: string; instrument: string; description: string }>;
}

interface ElectronBridge {
  isElectron: boolean;
  getState: () => Promise<LauncherStateSnapshot>;
  pollLogs: (since: number) => Promise<PollLogsResponse>;
  execCli: (args: string[], label?: string, kind?: "task" | "job") => Promise<{ ok: boolean; taskId: number }>;
  stopTask: (taskId: number) => Promise<{ ok: boolean }>;
  fetchVersions: (kind: "app" | "toolkit", name: string) => Promise<{ versions: string[] }>;
  inspectToolkit: (name: string) => Promise<InspectResult>;
  setChannel: (channel: Channel) => Promise<{ ok: boolean; channel: Channel }>;
  removeBackendDir: (dir: string) => Promise<{ ok: boolean; error?: string }>;
  pickFile: (kind: "ppk" | "ppj" | "dir") => Promise<{ ok: boolean; path: string; cancelled: boolean }>;
  openExternalUrl: (url: string) => Promise<{ ok: boolean }>;
  openFolderPath: (dir: string) => Promise<{ ok: boolean }>;
  onLog: (fn: (entry: LauncherLogLine) => void) => () => void;
  onTasks: (fn: (list: LauncherTask[]) => void) => () => void;
  onOpenPpk: (fn: (filePath: string) => void) => () => void;
}

const bridge = (): ElectronBridge | undefined =>
  (window as unknown as { paperboatLauncher?: ElectronBridge }).paperboatLauncher;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const isElectron = () => Boolean(bridge()?.isElectron);

export const fetchState = () => bridge()?.getState() ?? getJson<LauncherStateSnapshot>("/__launcher/state");

export const pollLogs = (since: number) => bridge()?.pollLogs(since) ?? getJson<PollLogsResponse>(`/__launcher/logs?since=${since}`);

export const execCli = (args: string[], label?: string, kind: "task" | "job" = "task") =>
  bridge()?.execCli(args, label, kind) ?? postJson<{ ok: boolean; taskId: number }>("/__launcher/exec", { args, label, kind });

export const stopTask = (taskId: number) =>
  bridge()?.stopTask(taskId) ?? postJson<{ ok: boolean }>("/__launcher/stop-task", { taskId });

export const fetchVersions = (kind: "app" | "toolkit", name: string) =>
  bridge()?.fetchVersions(kind, name) ?? getJson<{ versions: string[] }>(`/__launcher/versions?kind=${kind}&name=${encodeURIComponent(name)}`);

export const inspectToolkit = (name: string) =>
  bridge()?.inspectToolkit(name) ?? getJson<InspectResult>(`/__launcher/inspect?toolkit=${encodeURIComponent(name)}`);

export const setChannel = (channel: Channel) =>
  bridge()?.setChannel(channel) ?? postJson<{ ok: boolean; channel: Channel }>("/__launcher/channel", { channel });

export const removeBackendDir = (dir: string) =>
  bridge()?.removeBackendDir(dir) ?? postJson<{ ok: boolean; error?: string }>("/__launcher/remove-backend", { dir });

export const openExternalUrl = (url: string) =>
  bridge()?.openExternalUrl(url) ?? postJson<{ ok: boolean }>("/__launcher/open-url", { url });

export const openFolderPath = (path: string) =>
  bridge()?.openFolderPath(path) ?? postJson<{ ok: boolean }>("/__launcher/open-path", { path });

export const pickFile = (kind: "ppk" | "ppj" | "dir") =>
  bridge()?.pickFile(kind) ?? postJson<{ ok: boolean; path: string; cancelled: boolean }>("/__launcher/pick-file", { kind });

export const subscribeElectron = (handlers: {
  onLog: (entry: LauncherLogLine) => void;
  onTasks: (list: LauncherTask[]) => void;
  onOpenPpk: (filePath: string) => void;
}): (() => void) => {
  const b = bridge();
  if (!b) return () => {};
  const u1 = b.onLog(handlers.onLog);
  const u2 = b.onTasks(handlers.onTasks);
  const u3 = b.onOpenPpk(handlers.onOpenPpk);
  return () => {
    u1();
    u2();
    u3();
  };
};
