import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../..");

function packageRoot(file: string): string {
  let dir = dirname(file);
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return existsSync(join(dir, "package.json")) ? dir : "";
}

function sharedFolders(): string[] {
  const folders: string[] = [];
  const add = (folder: string) => {
    if (folder && !folders.includes(folder)) folders.push(folder);
  };
  try {
    const shared = packageRoot(createRequire(import.meta.url).resolve("@paperboat/shared"));
    add(shared);
    if (!shared) return folders;
    const fromShared = createRequire(join(shared, "package.json"));
    for (const font of ["@fontsource/geist-sans", "@fontsource/geist-mono"]) {
      try {
        add(packageRoot(fromShared.resolve(font)));
      } catch {
        // use workspace copy
      }
    }
  } catch {
    // @paperboat/shared not installed
  }
  return folders;
}

function resolvePaperboatBin(): string {
  if (process.env.PAPERBOAT_BIN && existsSync(process.env.PAPERBOAT_BIN)) return process.env.PAPERBOAT_BIN;
  const exe = process.platform === "win32" ? "paperboat.exe" : "paperboat";
  for (const c of [join(repoRoot, "engine/build/tools", exe), join(repoRoot, "bin", exe)]) {
    if (existsSync(c)) return c;
  }
  return exe;
}

function paperboatHome(): string {
  if (process.env.PAPERBOAT_HOME) return process.env.PAPERBOAT_HOME;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "paperboat");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "paperboat");
}

function launcherDevApi(): Plugin {
  const bin = resolvePaperboatBin();
  const childEnv = { ...process.env, PAPERBOAT_NO_CONSOLE: "1" };
  const tasks: Array<Record<string, unknown>> = [];
  const activeChildren = new Map<number, ChildProcess>();
  const logs: Array<{ seq: number; timeMs: number; taskId: number; tone: string; text: string }> = [];
  let nextTaskId = 1;
  let nextLogSeq = 1;

  const pushLog = (taskId: number, tone: string, text: string) => {
    logs.push({ seq: nextLogSeq++, timeMs: Date.now(), taskId, tone, text });
    if (logs.length > 1000) logs.splice(0, logs.length - 800);
  };

  const runCliJson = <T>(args: string[], fallback: T): Promise<T> =>
    new Promise((resolvePromise) => {
      execFile(bin, args, { env: childEnv, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) return resolvePromise(fallback);
        try {
          resolvePromise(JSON.parse(stdout) as T);
        } catch {
          resolvePromise(fallback);
        }
      });
    });

  const runCliLines = (args: string[]): Promise<string[]> =>
    new Promise((resolvePromise) => {
      execFile(bin, args, { env: childEnv, timeout: 15000 }, (err, stdout) => {
        if (err || !stdout) return resolvePromise([]);
        resolvePromise(
          stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      });
    });

  const readChannel = (): string => {
    try {
      const ch = readFileSync(join(paperboatHome(), "channel"), "utf8").trim();
      if (ch === "release" || ch === "beta" || ch === "dev") return ch;
      if (ch === "main") return "dev";
    } catch {
      // default
    }
    return "release";
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolvePromise) => {
      let raw = "";
      req.on("data", (c) => {
        raw += String(c);
      });
      req.on("end", () => {
        try {
          resolvePromise(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          resolvePromise({});
        }
      });
    });

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const attach = (middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }) => {
    middlewares.use((req, res, next) => {
      const urlStr = req.url || "";
      if (!urlStr.startsWith("/__launcher/")) return next();
      const url = new URL(urlStr, "http://localhost");

      void (async () => {
        if (req.method === "GET" && url.pathname === "/__launcher/state") {
          const [verLines, running, statusDoc, stations, appsAll, toolkits, commands] = await Promise.all([
            runCliLines(["--version"]),
            runCliJson<unknown[]>(["list", "--json"], []),
            runCliJson<{ stations?: unknown[] }>(["status", "--json"], { stations: [] }),
            runCliJson<unknown[]>(["stations", "--json"], []),
            runCliJson<Array<{ name: string }>>(["squero", "list", "--json"], []),
            runCliJson<unknown[]>(["toolkit", "list", "--json"], []),
            runCliJson<unknown[]>(["commands", "--json"], []),
          ]);
          const version = (verLines[0] || "0.1.4").replace(/^paperboat\s+/, "");
          const userApps = (Array.isArray(appsAll) ? appsAll : []).filter(
            (a) => a.name === "squero-studio-om" || a.name === "squero-studio-mx",
          );
          return sendJson(res, 200, {
            version,
            channel: readChannel(),
            installType: existsSync(join(repoRoot, ".git")) ? `git checkout (${repoRoot})` : `desktop app (${bin})`,
            homeDir: paperboatHome(),
            running: Array.isArray(running) ? running : [],
            status: Array.isArray(statusDoc?.stations) ? statusDoc.stations : [],
            stations: Array.isArray(stations) ? stations : [],
            apps: userApps,
            toolkits: Array.isArray(toolkits) ? toolkits : [],
            commands: Array.isArray(commands) ? commands : [],
            tasks: tasks.slice(-40),
          });
        }

        if (req.method === "GET" && url.pathname === "/__launcher/logs") {
          const since = Number(url.searchParams.get("since") || 0);
          const lines = logs.filter((l) => l.seq > since);
          const latest = lines.length ? lines[lines.length - 1].seq : since;
          return sendJson(res, 200, { seq: latest, lines, tasks: tasks.slice(-40) });
        }

        if (req.method === "GET" && url.pathname === "/__launcher/versions") {
          const kind = url.searchParams.get("kind");
          const name = url.searchParams.get("name") || "";
          const versions = await runCliLines(kind === "toolkit" ? ["toolkit", "versions", name] : ["squero", "versions", name]);
          return sendJson(res, 200, { versions });
        }

        if (req.method === "GET" && url.pathname === "/__launcher/inspect") {
          const name = url.searchParams.get("toolkit") || "control";
          const data = await runCliJson<Record<string, unknown>>(["toolkit", "list", name, "--json"], {});
          return sendJson(res, 200, data);
        }

        if (req.method === "POST" && url.pathname === "/__launcher/channel") {
          const body = await readBody(req);
          const ch = String(body.channel || "release");
          if (ch !== "release" && ch !== "beta" && ch !== "dev") return sendJson(res, 400, { error: "invalid channel" });
          const home = paperboatHome();
          mkdirSync(home, { recursive: true });
          writeFileSync(join(home, "channel"), ch, "utf8");
          pushLog(0, "ok", `channel set to ${ch}`);
          return sendJson(res, 200, { ok: true, channel: ch });
        }

        if (req.method === "POST" && url.pathname === "/__launcher/exec") {
          const body = await readBody(req);
          const args = Array.isArray(body.args) ? body.args.map(String) : [];
          if (!args.length) return sendJson(res, 400, { error: "args required" });
          const taskId = nextTaskId++;
          const task: Record<string, unknown> = {
            id: taskId,
            label: String(body.label || `paperboat ${args[0]}`),
            args,
            kind: body.kind === "job" ? "job" : "task",
            status: "running",
            exitCode: -1,
            startedAtMs: Date.now(),
            finishedAtMs: 0,
            lastLine: "",
            events: [] as unknown[],
          };
          tasks.push(task);
          pushLog(taskId, "cmd", `paperboat ${args.join(" ")}`);
          const child = spawn(bin, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
          activeChildren.set(taskId, child);
          const handleStream = (stream: "stdout" | "stderr") => {
            let buf = "";
            return (chunk: Buffer) => {
              buf += chunk.toString("utf8");
              const parts = buf.split(/\r?\n/);
              buf = parts.pop() ?? "";
              for (const line of parts) {
                if (!line) continue;
                if (stream === "stdout" && line.startsWith("{")) {
                  try {
                    const ev = JSON.parse(line) as Record<string, unknown>;
                    if (ev && typeof ev === "object" && "event" in ev) {
                      (task.events as unknown[]).push(ev);
                      continue;
                    }
                  } catch {
                    // plain log
                  }
                }
                task.lastLine = line.trim();
                pushLog(taskId, stream === "stderr" || /\[FAIL\]|error:/i.test(line) ? "err" : "ok", line);
              }
            };
          };
          child.stdout?.on("data", handleStream("stdout"));
          child.stderr?.on("data", handleStream("stderr"));
          child.on("close", (code) => {
            activeChildren.delete(taskId);
            task.exitCode = code ?? 1;
            task.finishedAtMs = Date.now();
            if (task.status !== "stopped") task.status = task.exitCode === 0 ? "done" : "failed";
            pushLog(taskId, task.exitCode === 0 ? "ok" : "err", `[ok] ${String(task.label)} finished`);
          });
          return sendJson(res, 200, { ok: true, taskId });
        }

        if (req.method === "POST" && url.pathname === "/__launcher/stop-task") {
          const body = await readBody(req);
          const id = Number(body.taskId);
          const child = activeChildren.get(id);
          const task = tasks.find((t) => t.id === id);
          if (child && task) {
            task.status = "stopped";
            child.kill("SIGTERM");
          }
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "POST" && url.pathname === "/__launcher/remove-station") {
          const body = await readBody(req);
          const base = realpathSync(join(paperboatHome(), "stations"));
          const target = realpathSync(String(body.dir || ""));
          const rel = relative(base, target);
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
            return sendJson(res, 400, { error: `Can only uninstall stations inside ${base}` });
          }
          rmSync(target, { recursive: true, force: true });
          pushLog(0, "ok", `removed station ${basename(target)}`);
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "POST" && (url.pathname === "/__launcher/open-url" || url.pathname === "/__launcher/open-path" || url.pathname === "/__launcher/pick-file")) {
          return sendJson(res, 200, { ok: true, path: "", cancelled: true });
        }

        sendJson(res, 404, { error: "not found" });
      })();
    });
  };

  return {
    name: "paperboat-launcher-dev-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), launcherDevApi()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 3049,
    fs: { allow: [searchForWorkspaceRoot(here), ...sharedFolders()] },
  },
});
