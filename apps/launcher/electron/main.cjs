const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}
let mainWin = null;
let pendingPpkPath = "";

const tasks = [];
const activeChildren = new Map();
const logs = [];
let nextTaskId = 1;
let nextLogSeq = 1;

function paperboatHome() {
  if (process.env.PAPERBOAT_HOME) return process.env.PAPERBOAT_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "paperboat");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "paperboat");
}

function resolvePaperboatBin() {
  if (process.env.PAPERBOAT_BIN && fs.existsSync(process.env.PAPERBOAT_BIN)) {
    return process.env.PAPERBOAT_BIN;
  }
  const exe = process.platform === "win32" ? "paperboat.exe" : "paperboat";
  const candidates = [
    path.join(process.resourcesPath || "", "paperboat", "bin", exe),
    path.join(__dirname, "../../../bin", exe),
    path.join(__dirname, "../../../engine/build/tools", exe),
    path.join(__dirname, "../../../engine/build/tools/Release", exe),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return exe;
}

const PAPERBOAT_BIN = resolvePaperboatBin();
const CHILD_ENV = { ...process.env, PAPERBOAT_NO_CONSOLE: "1" };

function pushLog(taskId, tone, text) {
  const entry = { seq: nextLogSeq++, timeMs: Date.now(), taskId, tone, text };
  logs.push(entry);
  if (logs.length > 1200) logs.splice(0, logs.length - 1000);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("launcher:log", entry);
  }
}

function broadcastTasks() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("launcher:tasks", tasks.slice(-40));
  }
}

function runCliJson(args, fallback) {
  return new Promise((resolve) => {
    execFile(PAPERBOAT_BIN, args, { env: CHILD_ENV, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(fallback);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(fallback);
      }
    });
  });
}

function runCliLines(args) {
  return new Promise((resolve) => {
    execFile(PAPERBOAT_BIN, args, { env: CHILD_ENV, timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

function readChannel() {
  try {
    const ch = fs.readFileSync(path.join(paperboatHome(), "channel"), "utf8").trim();
    if (ch === "release" || ch === "beta" || ch === "dev") return ch;
    if (ch === "main") return "dev";
  } catch {
    // default
  }
  return "release";
}

function readVersion() {
  return new Promise((resolve) => {
    execFile(PAPERBOAT_BIN, ["--version"], { env: CHILD_ENV, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve("0.1.4");
      resolve(stdout.trim().replace(/^paperboat\s+/, ""));
    });
  });
}

function detectInstallType() {
  const repoRoot = path.resolve(__dirname, "../../..");
  if (fs.existsSync(path.join(repoRoot, ".git"))) return `git checkout (${repoRoot})`;
  return `desktop app (${PAPERBOAT_BIN})`;
}

function readMissingPrereqs(appEntry) {
  // Missing prerequisites are surfaced when `pkg install` runs or from appEntry if present.
  return appEntry.missingPrerequisites || "";
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 580,
    title: "Paperboat Launcher",
    autoHideMenuBar: true,
    backgroundColor: "#dcdcd8",
    icon: path.join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWin = win;
  if (isDev) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.webContents.on("did-finish-load", () => {
    if (pendingPpkPath) {
      win.webContents.send("launcher:open-ppk", pendingPpkPath);
      pendingPpkPath = "";
    }
  });

  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
  });
}

function checkArgForPpk(argv) {
  for (const a of argv) {
    if (typeof a === "string" && a.toLowerCase().endsWith(".ppk") && fs.existsSync(a)) {
      return a;
    }
  }
  return "";
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingPpkPath = checkArgForPpk(process.argv.slice(1));

  app.on("second-instance", (_event, argv) => {
    const ppk = checkArgForPpk(argv);
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
      if (ppk) mainWin.webContents.send("launcher:open-ppk", ppk);
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (filePath.toLowerCase().endsWith(".ppk")) {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("launcher:open-ppk", filePath);
      else pendingPpkPath = filePath;
    }
  });

  app.whenReady().then(() => {
    pushLog(0, "dim", `paperboat launcher · binary ${PAPERBOAT_BIN}`);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

/* ---- IPC Handlers -------------------------------------------------------- */
ipcMain.handle("launcher:state", async () => {
  const [version, running, statusDoc, backends, appsAll, toolkits, commands] = await Promise.all([
    readVersion(),
    runCliJson(["list", "--json"], []),
    runCliJson(["status", "--json"], { backends: [] }),
    runCliJson(["backends", "--json"], []),
    runCliJson(["pkg", "list", "--json"], []),
    runCliJson(["toolkit", "list", "--json"], []),
    runCliJson(["commands", "--json"], []),
  ]);

  const userApps = (Array.isArray(appsAll) ? appsAll : [])
    .filter((a) => a.name === "squero-studio-om" || a.name === "squero-studio-mx")
    .map((a) => ({ ...a, missingPrerequisites: readMissingPrereqs(a) }));

  return {
    version,
    channel: readChannel(),
    installType: detectInstallType(),
    homeDir: paperboatHome(),
    running: Array.isArray(running) ? running : [],
    status: Array.isArray(statusDoc?.backends) ? statusDoc.backends : [],
    backends: Array.isArray(backends) ? backends : [],
    apps: userApps,
    toolkits: Array.isArray(toolkits) ? toolkits : [],
    commands: Array.isArray(commands) ? commands : [],
    tasks: tasks.slice(-40),
  };
});

ipcMain.handle("launcher:logs", (_event, since) => {
  const s = Number(since) || 0;
  const lines = logs.filter((l) => l.seq > s);
  const latest = lines.length ? lines[lines.length - 1].seq : s;
  return { seq: latest, lines, tasks: tasks.slice(-40) };
});

ipcMain.handle("launcher:exec", (_event, payload) => {
  const args = Array.isArray(payload?.args) ? payload.args.map(String) : [];
  if (!args.length) throw new Error("args array required");
  const task = {
    id: nextTaskId++,
    label: String(payload?.label || `paperboat ${args[0]}`),
    args,
    kind: payload?.kind === "job" ? "job" : "task",
    status: "running",
    exitCode: -1,
    startedAtMs: Date.now(),
    finishedAtMs: 0,
    events: [],
  };
  tasks.push(task);
  if (tasks.length > 50) tasks.shift();
  pushLog(task.id, "cmd", `paperboat ${args.join(" ")}`);
  broadcastTasks();

  const child = spawn(PAPERBOAT_BIN, args, { env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
  activeChildren.set(task.id, child);

  const handleChunk = (stream) => {
    let buf = "";
    return (chunk) => {
      buf += chunk.toString("utf8");
      const linesOut = buf.split(/\r?\n/);
      buf = linesOut.pop() ?? "";
      for (const line of linesOut) {
        if (!line) continue;
        if (stream === "stdout" && line.startsWith("{")) {
          try {
            const ev = JSON.parse(line);
            if (ev && typeof ev === "object" && "event" in ev) {
              task.events.push(ev);
              broadcastTasks();
              continue;
            }
          } catch {
            // fall through to plain log line
          }
        }
        const tone =
          stream === "stderr" || /\[FAIL\]|error:/i.test(line)
            ? "err"
            : /\[ok\]|ready|running on/i.test(line)
              ? "ok"
              : "dim";
        task.lastLine = line.trim();
        pushLog(task.id, tone, line);
        broadcastTasks();
      }
    };
  };

  child.stdout?.on("data", handleChunk("stdout"));
  child.stderr?.on("data", handleChunk("stderr"));
  child.on("close", (code) => {
    activeChildren.delete(task.id);
    task.exitCode = code ?? 1;
    task.finishedAtMs = Date.now();
    if (task.status !== "stopped") task.status = task.exitCode === 0 ? "done" : "failed";
    pushLog(task.id, task.exitCode === 0 ? "ok" : "err", task.exitCode === 0 ? `[ok] ${task.label} finished` : `[exit ${task.exitCode}] ${task.label}`);
    broadcastTasks();
  });

  return { ok: true, taskId: task.id };
});

ipcMain.handle("launcher:stopTask", (_event, taskId) => {
  const child = activeChildren.get(Number(taskId));
  const task = tasks.find((t) => t.id === Number(taskId));
  if (!child || !task) return { ok: false };
  task.status = "stopped";
  child.kill("SIGTERM");
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  broadcastTasks();
  return { ok: true };
});

ipcMain.handle("launcher:versions", (_event, kind, name) =>
  runCliLines(kind === "toolkit" ? ["toolkit", "versions", String(name)] : ["pkg", "versions", String(name)]).then((versions) => ({ versions })),
);

ipcMain.handle("launcher:inspect", (_event, name) =>
  runCliJson(["toolkit", "list", String(name), "--json"], {}),
);

ipcMain.handle("launcher:channel", (_event, ch) => {
  if (ch !== "release" && ch !== "beta" && ch !== "dev") throw new Error("invalid channel");
  const home = paperboatHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "channel"), ch, "utf8");
  pushLog(0, "ok", `channel set to ${ch}`);
  return { ok: true, channel: ch };
});

ipcMain.handle("launcher:removeBackend", async (_event, dir) => {
  const base = fs.realpathSync(path.join(paperboatHome(), "backends"));
  const target = fs.realpathSync(String(dir));
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Can only uninstall backends inside ${base}`);
  }
  await new Promise((resolve) => execFile(PAPERBOAT_BIN, ["stop", target], { env: CHILD_ENV }, () => resolve()));
  fs.rmSync(target, { recursive: true, force: true });
  pushLog(0, "ok", `removed backend ${path.basename(target)}`);
  return { ok: true };
});

ipcMain.handle("launcher:pickFile", async (_event, kind) => {
  const opts =
    kind === "dir"
      ? { title: "Select Backend Folder", properties: ["openDirectory"] }
      : kind === "ppk"
        ? { title: "Open Paperboat Backend (.ppk)", properties: ["openFile"], filters: [{ name: "Paperboat Package", extensions: ["ppk"] }] }
        : { title: "Open Paperboat Project (.ppj)", properties: ["openFile"], filters: [{ name: "Paperboat Project", extensions: ["ppj", "json"] }] };
  const res = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts);
  const picked = res.canceled ? "" : (res.filePaths[0] || "");
  return { ok: true, path: picked, cancelled: !picked };
});

ipcMain.handle("launcher:openUrl", (_event, url) => {
  if (!String(url).startsWith("http://") && !String(url).startsWith("https://")) throw new Error("invalid url");
  return shell.openExternal(String(url)).then(() => ({ ok: true }));
});

ipcMain.handle("launcher:openPath", (_event, p) =>
  shell.openPath(String(p)).then((err) => {
    if (err) throw new Error(err);
    return { ok: true };
  }),
);
