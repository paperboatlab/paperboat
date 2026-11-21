import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  AppBar,
  BarEnd,
  CommandSearch,
  Logo,
  StatusPill,
  Switch,
  Wordmark,
  useThemeChoice,
  type Theme,
} from "@paperboat/shared/components";
import * as api from "./api";
import {
  appDisplayTitle,
  buildToolkitBlockCards,
  completeInput,
  pstDisplayName,
  splitCommandWords,
  type AppInfo,
  type StationInfo,
  type BlockCardInfo,
  type BlockKind,
  type Channel,
  type LauncherLogLine,
  type LauncherStateSnapshot,
  type LauncherTask,
  type ToolkitInfo,
} from "./model";

type LauncherPage = "apps" | "stations" | "toolkits" | "cli";
type ModalKind = null | "palette" | "pst" | "folder" | "new-station" | "custom-toolkit" | "about";
type MenuId = "file" | "edit" | "view" | "model" | "run";
type MenuCommand = Parameters<typeof AppBar>[0]["commands"][number];

interface PageMeta {
  id: LauncherPage;
  label: string;
  hint: string;
}

const LAUNCHER_PAGES: PageMeta[] = [
  { id: "apps", label: "Apps", hint: "Paperboat, Squero Studio OM & MX, and running sessions" },
  { id: "stations", label: "Stations", hint: "Run, build, check, and package stations (.pst)" },
  { id: "toolkits", label: "Toolkits", hint: "Engine toolkits and block catalog cards" },
  { id: "cli", label: "Paperboat CLI", hint: "Interactive Paperboat CLI and live logs" },
];

const CHANNEL_OPTIONS: { value: Channel; label: string; hint: string }[] = [
  { value: "release", label: "release", hint: "Stable tagged releases" },
  { value: "beta", label: "beta", hint: "Prereleases and release candidates" },
  { value: "dev", label: "dev", hint: "Latest development branch (dev)" },
];

const STATION_FILTER_OPTIONS: { value: "all" | "builtin" | "example" | "installed"; label: string }[] = [
  { value: "all", label: "all" },
  { value: "builtin", label: "builtin" },
  { value: "example", label: "example" },
  { value: "installed", label: "installed" },
];

const BLOCK_KIND_OPTIONS: { value: "all" | BlockKind; label: string }[] = [
  { value: "all", label: "all" },
  { value: "flow", label: "flow" },
  { value: "station", label: "station" },
  { value: "board", label: "board" },
];

interface StationRunOpts {
  port: number;
  noBuild: boolean;
  clean: boolean;
  time: boolean;
  verbose: boolean;
  vars: string[];
}

interface CardFeedback {
  taskId: number;
  status: "busy" | "ok" | "err";
  text: string;
}

const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const GLIDE = "top var(--slide), bottom var(--slide), left var(--slide), right var(--slide)";
const PAD = 8;

const isPrebuiltStation = (b: { source?: string; dir: string }): boolean =>
  b.source === "builtin" && /[/\\]paperboat-scratchpad(?:\.exe)?$/i.test(b.dir);

const stationFolder = (b: { source?: string; dir: string }): string =>
  isPrebuiltStation(b) ? b.dir.replace(/[/\\][^/\\]+$/, "") || b.dir : b.dir;

function LauncherPageIcon({ page }: { page: LauncherPage }) {
  return (
    <svg className="page-icon" viewBox="0 0 18 18" aria-hidden="true">
      {page === "apps" ? (
        <>
          <rect x="2" y="2" width="6" height="6" rx="1" />
          <rect x="10" y="2" width="6" height="6" rx="1" />
          <rect x="2" y="10" width="6" height="6" rx="1" />
          <rect x="10" y="10" width="6" height="6" rx="1" />
        </>
      ) : page === "stations" ? (
        <>
          <path d="M9 2l6 3.5v7L9 16l-6-3.5v-7z" />
          <path d="M3 5.5L9 9l6-3.5M9 9v7" />
        </>
      ) : page === "toolkits" ? (
        <>
          <rect x="1.5" y="3" width="5" height="4" rx="1" />
          <rect x="11.5" y="11" width="5" height="4" rx="1" />
          <path d="M6.5 5h3v8h2" />
        </>
      ) : (
        <>
          <rect x="2" y="3" width="14" height="12" rx="1.5" />
          <path d="M5.5 7l2.5 2-2.5 2" />
          <path d="M9.5 11h3" />
        </>
      )}
    </svg>
  );
}

function LauncherRail({
  page,
  onPage,
  badges,
}: {
  page: LauncherPage;
  onPage: (p: LauncherPage) => void;
  badges: Partial<Record<LauncherPage, { text: string; live?: boolean }>>;
}) {
  const rail = useRef<HTMLElement>(null);
  const brackets = useRef<HTMLSpanElement[]>([]);
  const at = Math.max(0, LAUNCHER_PAGES.findIndex((p) => p.id === page));
  const was = useRef(-1);
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const atRef = useRef(at);
  atRef.current = at;

  useLayoutEffect(() => {
    const r = rail.current;
    if (!r) return;
    const place = (dir: number) => {
      const face = r.querySelectorAll<HTMLElement>(".rail-face")[atRef.current];
      if (!face) return;
      const rb = r.getBoundingClientRect();
      const fb = face.getBoundingClientRect();
      const across = rb.height >= rb.width;
      const faces = [...r.querySelectorAll<HTMLElement>(".rail-face")].map((f) => f.getBoundingClientRect());
      const side = across
        ? Math.max(2, (rb.width - Math.max(...faces.map((f) => f.width))) / 2 - PAD)
        : fb.left - rb.left - PAD;
      const band = Math.max(2, (rb.height - fb.height) / 2 - PAD);
      const box = {
        top: across ? fb.top - rb.top - PAD : band,
        bottom: across ? rb.bottom - fb.bottom - PAD : band,
        left: side,
        right: across ? side : rb.right - fb.right - PAD,
      };
      const still = !dir || reduceMotion();
      brackets.current.forEach((el, k) => {
        if (!el) return;
        el.style.transition = still ? "none" : GLIDE;
        el.style.top = `${box.top}px`;
        el.style.bottom = `${box.bottom}px`;
        if (k === 0) el.style.left = `${box.left}px`;
        else el.style.right = `${box.right}px`;
      });
    };
    place(was.current >= 0 ? Math.sign(at - was.current) : 0);
    was.current = at;
    let started = false;
    const ro = new ResizeObserver(() => (started ? place(0) : (started = true)));
    ro.observe(r);
    return () => ro.disconnect();
  }, [at]);

  useLayoutEffect(() => {
    const r = rail.current;
    if (!r) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - last < 450 || Math.abs(e.deltaY) < 4) return;
      last = now;
      const next = Math.max(0, Math.min(LAUNCHER_PAGES.length - 1, atRef.current + Math.sign(e.deltaY)));
      if (next !== atRef.current) onPageRef.current(LAUNCHER_PAGES[next].id);
    };
    r.addEventListener("wheel", onWheel, { passive: false });
    return () => r.removeEventListener("wheel", onWheel);
  }, []);

  const onKey = (e: ReactKeyboardEvent) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(LAUNCHER_PAGES.length - 1, at + d));
    onPage(LAUNCHER_PAGES[next].id);
    rail.current?.querySelectorAll<HTMLElement>(".rail-item")[next]?.focus();
  };

  return (
    <nav ref={rail} className="rail" aria-label="Launcher pages" onKeyDown={onKey}>
      <span ref={(el) => void (el && (brackets.current[0] = el))} className="rail-bracket open" aria-hidden="true" />
      <span ref={(el) => void (el && (brackets.current[1] = el))} className="rail-bracket close" aria-hidden="true" />
      {LAUNCHER_PAGES.map((p, i) => {
        const badge = badges[p.id];
        return (
          <button
            key={p.id}
            type="button"
            className={`rail-item${p.id === page ? " current" : ""}`}
            aria-current={p.id === page ? "page" : undefined}
            tabIndex={p.id === page ? 0 : -1}
            title={`${p.hint} (Alt+${i + 1})`}
            onClick={() => onPage(p.id)}
          >
            {badge && <span className={`rail-badge${badge.live ? " live" : ""}`}>{badge.text}</span>}
            <span className="rail-face">
              <LauncherPageIcon page={p.id} />
              <span className="name">{p.label.toLowerCase()}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function App() {
  const [page, setPage] = useState<LauncherPage>("apps");
  const [themeChoice, setThemeChoice] = useThemeChoice("paperboat.theme");
  const [snap, setSnap] = useState<LauncherStateSnapshot | null>(null);
  const [logs, setLogs] = useState<LauncherLogLine[]>([]);
  const [tasks, setTasks] = useState<LauncherTask[]>([]);
  const [modal, setModal] = useState<ModalKind>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Stations state
  const [selectedStation, setSelectedStation] = useState("scratchpad");
  const [stationFilter, setStationFilter] = useState<"all" | "builtin" | "example" | "installed">("all");
  const [stationQuery, setStationQuery] = useState("");
  const [runOpts, setRunOpts] = useState<Record<string, StationRunOpts>>({});
  const [showRunOptions, setShowRunOptions] = useState(false);
  const [newVarText, setNewVarText] = useState("");

  // Toolkits & block cards state
  const [selectedToolkit, setSelectedToolkit] = useState("control");
  const [blockQuery, setBlockQuery] = useState("");
  const [blockKindFilter, setBlockKindFilter] = useState<"all" | BlockKind>("all");
  const [tkInspectMap, setTkInspectMap] = useState<Record<string, api.InspectResult>>({});

  // Versions & feedback state
  const [appVersions, setAppVersions] = useState<Record<string, string[]>>({});
  const [appPickedVer, setAppPickedVer] = useState<Record<string, string>>({});
  const [tkVersions, setTkVersions] = useState<Record<string, string[]>>({});
  const [tkPickedVer, setTkPickedVer] = useState<Record<string, string>>({});
  const [feedbackMap, setFeedbackMap] = useState<Record<string, CardFeedback>>({});

  // Web & Quick launch state
  const [webPort] = useState(3047);
  const [quickTarget, setQuickTarget] = useState("");

  // Console state
  const [cmdText, setCmdText] = useState("");
  const [compOpen, setCompOpen] = useState(false);
  const [compIdx, setCompIdx] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  // Modal fields
  const [pstPath, setPstPath] = useState("");
  const [pstPort, setPstPort] = useState(8792);
  const [pstDir, setPstDir] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [nbName, setNbName] = useState("my-rig");
  const [nbLang, setNbLang] = useState<"cpp" | "python" | "julia">("cpp");
  const [nbDir, setNbDir] = useState("");
  const [ctkName, setCtkName] = useState("");
  const [ctkSrc, setCtkSrc] = useState("");

  const logSeqRef = useRef(0);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const refreshState = useCallback(async () => {
    try {
      const next = await api.fetchState();
      setSnap(next);
      setTasks(next.tasks);
      setErrorMsg("");
    } catch (e) {
      setErrorMsg(String((e as Error).message || e));
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const timer = setInterval(() => void refreshState(), 2500);
    return () => clearInterval(timer);
  }, [refreshState]);

  useEffect(() => {
    const unsub = api.subscribeElectron({
      onLog: (entry) => {
        logSeqRef.current = Math.max(logSeqRef.current, entry.seq);
        setLogs((prev) => [...prev, entry].slice(-800));
      },
      onTasks: (list) => {
        setTasks(list);
        void refreshState();
      },
      onOpenPst: (filePath) => {
        setPstPath(filePath);
        setPage("stations");
        setModal("pst");
      },
    });
    return unsub;
  }, [refreshState]);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
      const filePath = file?.path || file?.name || "";
      if (filePath.toLowerCase().endsWith(".pst")) {
        setPstPath(filePath);
        setPage("stations");
        setModal("pst");
      }
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    if (api.isElectron()) return;
    let live = true;
    const poll = async () => {
      try {
        const res = await api.pollLogs(logSeqRef.current);
        if (!live) return;
        if (res.seq > logSeqRef.current) {
          logSeqRef.current = res.seq;
          if (res.lines.length) setLogs((prev) => [...prev, ...res.lines].slice(-800));
        }
        setTasks(res.tasks);
      } catch {
        // ignore transient poll error
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 600);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // Sync per-card feedback from live tasks
  useEffect(() => {
    setFeedbackMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [key, fb] of Object.entries(prev)) {
        const t = tasks.find((x) => x.id === fb.taskId);
        if (!t) continue;
        const status: "busy" | "ok" | "err" =
          t.status === "running" ? "busy" : t.status === "done" ? "ok" : "err";
        const text =
          t.status === "running"
            ? t.lastLine || `${t.label}…`
            : t.status === "done"
              ? t.lastLine || `✓ ${t.label} complete`
              : t.lastLine || `${t.label} failed (exit ${t.exitCode})`;
        if (fb.status !== status || fb.text !== text) {
          next[key] = { taskId: fb.taskId, status, text };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  useEffect(() => {
    if (page === "cli") consoleEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs.length, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal((m) => (m === "palette" ? null : "palette"));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setModal("pst");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setModal("new-station");
      } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const idx = Number(e.key) - 1;
        if (idx >= 0 && idx < LAUNCHER_PAGES.length) {
          e.preventDefault();
          setPage(LAUNCHER_PAGES[idx].id);
        }
      } else if (e.key === "Escape") {
        setModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Load remote versions when viewing Apps or Toolkits
  useEffect(() => {
    if (!snap) return;
    if (page === "apps") {
      for (const a of snap.apps) {
        if (!appVersions[a.name]) {
          api.fetchVersions("app", a.name).then((r) => {
            setAppVersions((prev) => ({ ...prev, [a.name]: [...r.versions, "dev"] }));
          }).catch(() => {});
        }
      }
    } else if (page === "toolkits") {
      for (const t of snap.toolkits) {
        if (!t.builtin && !tkVersions[t.name]) {
          api.fetchVersions("toolkit", t.name).then((r) => {
            setTkVersions((prev) => ({ ...prev, [t.name]: [...r.versions, "dev"] }));
          }).catch(() => {});
        }
      }
    }
  }, [page, snap, appVersions, tkVersions]);

  // Inspect selected toolkit blocks for rich block cards
  useEffect(() => {
    if (!selectedToolkit || tkInspectMap[selectedToolkit]) return;
    let alive = true;
    api.inspectToolkit(selectedToolkit).then((d) => {
      if (!alive) return;
      setTkInspectMap((prev) => ({ ...prev, [selectedToolkit]: d }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [selectedToolkit, tkInspectMap]);

  const runCmd = useCallback(
    async (args: string[], label?: string, kind: "task" | "job" = "task", feedbackKey?: string) => {
      try {
        const res = await api.execCli(args, label, kind);
        if (feedbackKey) {
          setFeedbackMap((prev) => ({
            ...prev,
            [feedbackKey]: { taskId: res.taskId, status: "busy", text: `${label || args.join(" ")}…` },
          }));
        }
        setTimeout(() => void refreshState(), 400);
      } catch (e) {
        const msg = String((e as Error).message || e);
        setErrorMsg(msg);
        if (feedbackKey) {
          setFeedbackMap((prev) => ({
            ...prev,
            [feedbackKey]: { taskId: 0, status: "err", text: msg },
          }));
        }
      }
    },
    [refreshState],
  );

  const dismissFeedback = (key: string) => {
    setFeedbackMap((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const runningTasks = tasks.filter((t) => t.status === "running");
  const busy = runningTasks.length > 0;
  const activeTask = runningTasks[0];

  const stations = snap?.stations ?? [];
  const apps = snap?.apps ?? [];
  const toolkits = snap?.toolkits ?? [];
  const running = snap?.running ?? [];
  const statusItems = snap?.status ?? [];
  const commands = snap?.commands ?? [];
  const webRunning = running.find((r) => r.kind === "paperboat" && r.name === "paperboat");
  const installedAppsCount = 1 + apps.filter((a) => a.installed || a.checkout).length;
  const installedToolkitsCount = toolkits.filter((t) => !t.builtin && t.installed).length;

  const optsFor = useCallback(
    (b: StationInfo): StationRunOpts =>
      runOpts[b.dir] ?? { port: b.port || 8765, noBuild: false, clean: false, time: false, verbose: false, vars: [] },
    [runOpts],
  );
  const patchOpts = useCallback(
    (b: StationInfo, patch: Partial<StationRunOpts>) =>
      setRunOpts((prev) => ({ ...prev, [b.dir]: { ...optsFor(b), ...patch } })),
    [optsFor],
  );

  const filteredStations = useMemo(() => {
    const q = stationQuery.trim().toLowerCase();
    return stations.filter(
      (b) =>
        (stationFilter === "all" || b.source === stationFilter) &&
        (!q || `${b.name} ${b.description} ${b.language}`.toLowerCase().includes(q)),
    );
  }, [stations, stationFilter, stationQuery]);

  const curStation =
    stations.find((b) => b.name === selectedStation || b.dir === selectedStation) ??
    filteredStations[0] ??
    stations[0];
  const curToolkit =
    toolkits.find((t) => t.name === selectedToolkit) ??
    toolkits.find((t) => !t.builtin) ??
    toolkits[0];

  const allBlockCards: BlockCardInfo[] = useMemo(() => {
    if (!curToolkit) return [];
    return buildToolkitBlockCards(
      curToolkit.name,
      tkInspectMap[curToolkit.name],
      curToolkit.blocks,
    );
  }, [curToolkit, tkInspectMap]);

  const filteredBlockCards = useMemo(() => {
    const q = blockQuery.trim().toLowerCase();
    return allBlockCards.filter(
      (b) =>
        (blockKindFilter === "all" || b.kind === blockKindFilter) &&
        (!q || `${b.label} ${b.type} ${b.description} ${b.group}`.toLowerCase().includes(q)),
    );
  }, [allBlockCards, blockKindFilter, blockQuery]);

  const latestCheckTask = useMemo(() => {
    if (!curStation) return undefined;
    return [...tasks]
      .reverse()
      .find((t) => t.args[0] === "check" && (t.args[1] === curStation.dir || t.args[1] === curStation.name));
  }, [tasks, curStation]);

  const completion = useMemo(
    () => completeInput(cmdText, commands, stations, apps, toolkits),
    [cmdText, commands, stations, apps, toolkits],
  );

  const printConsoleHelp = useCallback(() => {
    const baseSeq = Date.now();
    setLogs((prev) => [
      ...prev,
      ...commands.map((c, i) => ({
        seq: baseSeq + i,
        timeMs: Date.now(),
        taskId: 0,
        tone: "dim" as const,
        text: `  ${c.name.padEnd(11)} ${c.summary}`,
      })),
    ]);
  }, [commands]);

  const submitConsole = () => {
    const raw = cmdText.trim();
    if (!raw) return;
    setCmdText("");
    setCompOpen(false);
    setHistory((h) => [...h, raw].slice(-200));
    setHistIdx(-1);
    const words = splitCommandWords(raw.replace(/^paperboat\s+/, ""));
    if (!words.length) return;
    if (words[0] === "clear") {
      setLogs([]);
      return;
    }
    if (words[0] === "help") {
      printConsoleHelp();
      return;
    }
    void runCmd(words, `paperboat ${words.join(" ")}`, words[0] === "run" || words[0] === "start" ? "job" : "task");
  };

  const handleChannelChange = useCallback(
    async (ch: Channel) => {
      try {
        await api.setChannel(ch);
        await refreshState();
      } catch (e) {
        setErrorMsg(String((e as Error).message || e));
      }
    },
    [refreshState],
  );

  const handleStationRun = useCallback(
    (b: StationInfo) => {
      const o = optsFor(b);
      const args = ["run", b.dir, "--port", String(o.port)];
      if (o.noBuild) args.push("--no-build");
      if (o.clean) args.push("--clean");
      if (o.time) args.push("--time");
      if (o.verbose) args.push("--verbose");
      for (const v of o.vars) args.push("--var", v);
      void runCmd(args, `run ${b.name}`, "job", `station:${b.dir}`);
    },
    [optsFor, runCmd],
  );

  const handleQuickStart = () => {
    const val = quickTarget || (stations[0] ? `station:${stations[0].dir}` : "");
    if (!val) return;
    const [kind, ...rest] = val.split(":");
    const target = rest.join(":");
    if (kind === "station") {
      const b = stations.find((x) => x.dir === target);
      if (b) handleStationRun(b);
    } else {
      void runCmd(["squero", "start", target, "--daemon"], `start ${target}`, "job", `app:${target}`);
    }
  };

  const handlePick = useCallback(async (kind: "pst" | "psf" | "dir", onPicked: (path: string) => void) => {
    try {
      const r = await api.pickFile(kind);
      if (!r.cancelled && r.path) onPicked(r.path);
    } catch (e) {
      setErrorMsg(String((e as Error).message || e));
    }
  }, []);

  const versionStr = snap?.version || "0.1.7";
  const channel = snap?.channel || "release";

  /* =========================================================================
     DYNAMIC TOP PANEL: Section-Specific Menus, Labels, Context Title & BarEnd
     ========================================================================= */
  const sharedViewCommands: MenuCommand[] = useMemo(
    () => [
      ...LAUNCHER_PAGES.map((p, i) => ({
        id: `view.page.${p.id}`,
        label: p.label,
        menu: "view" as MenuId,
        group: "pages",
        shortcut: `Alt+${i + 1}`,
        checked: page === p.id,
        run: () => setPage(p.id),
      })),
      ...(["auto", "light", "dark"] as Theme[]).map((t) => ({
        id: `view.theme.${t}`,
        label: `Theme: ${t}`,
        menu: "view" as MenuId,
        group: "theme",
        checked: themeChoice === t,
        run: () => setThemeChoice(t),
      })),
      {
        id: "view.search",
        label: "Command search…",
        menu: "view" as MenuId,
        group: "search",
        shortcut: "Ctrl+K",
        quiet: true,
        run: () => setModal("palette"),
      },
    ],
    [page, themeChoice, setThemeChoice],
  );

  const { sectionCommands, sectionMenuLabels } = useMemo(() => {
    if (page === "apps") {
      const cmds: MenuCommand[] = [
        {
          id: "apps.launch.paperboat",
          label: webRunning ? "Open Paperboat Web UI" : "Launch Paperboat Web App",
          menu: "file",
          group: "launch",
          meta: `:${webRunning?.port ?? webPort}`,
          run: () =>
            webRunning
              ? void api.openExternalUrl(webRunning.url)
              : void runCmd(["web", "start", "--port", String(webPort), "--daemon"], "launch paperboat", "job", "app:paperboat"),
        },
        ...apps.map((a) => ({
          id: `apps.launch.${a.name}`,
          label: `Launch ${appDisplayTitle(a.name)}`,
          menu: "file" as MenuId,
          group: "launch",
          meta: `:${a.port}`,
          enabled: a.installed || a.checkout,
          why: `Install ${appDisplayTitle(a.name)} first`,
          run: () => void runCmd(["squero", "start", a.name, "--daemon"], `launch ${appDisplayTitle(a.name)}`, "job", `app:${a.name}`),
        })),
        {
          id: "apps.check.updates",
          label: "Check for updates",
          menu: "file",
          group: "squero",
          run: () => void runCmd(["update", "--check", "--channel", channel], "check updates", "task", "app:paperboat"),
        },
        {
          id: "apps.update.all",
          label: "Update all installed apps",
          menu: "file",
          group: "squero",
          run: () => void runCmd(["squero", "update", "--all"], "update all apps", "task", "app:paperboat"),
        },
        {
          id: "apps.build.web",
          label: "Rebuild Paperboat web assets",
          menu: "file",
          group: "squero",
          run: () => void runCmd(["web", "build"], "build web app", "task", "app:paperboat"),
        },
        ...CHANNEL_OPTIONS.map((c) => ({
          id: `apps.channel.${c.value}`,
          label: `${c.label} — ${c.hint}`,
          menu: "model" as MenuId,
          group: "channel",
          checked: channel === c.value,
          run: () => void handleChannelChange(c.value),
        })),
        {
          id: "sessions.start.scratchpad",
          label: "Start scratchpad station",
          menu: "run",
          group: "start",
          run: () => {
            const wb = stations.find((b) => b.name === "scratchpad") ?? stations[0];
            if (wb) handleStationRun(wb);
          },
        },
        {
          id: "sessions.examples.start",
          label: "Start example stations",
          menu: "run",
          group: "start",
          run: () => void runCmd(["examples", "start"], "examples start", "job"),
        },
        {
          id: "sessions.stop.all",
          label: "Stop all running sessions",
          menu: "run",
          group: "stop",
          enabled: running.length > 0,
          why: "No sessions are currently running",
          run: () => void runCmd(["stop", "--all"], "stop all sessions"),
        },
        ...sharedViewCommands,
      ];
      return {
        sectionCommands: cmds,
        sectionMenuLabels: {
          file: "Apps",
          model: `Channel (${channel})`,
          run: running.length ? `Sessions (${running.length})` : "Sessions",
          view: "View",
        } as Partial<Record<MenuId, string>>,
        sectionProjectLabel: `apps · ${installedAppsCount} of 3 installed`,
      };
    }

    if (page === "stations") {
      const b = curStation;
      const o = b ? optsFor(b) : null;
      const liveProc = b
        ? running.find((r) => r.kind === "station" && (r.name === b.name || r.port === (o?.port ?? b.port)))
        : undefined;
      const fbKey = b ? `station:${b.dir}` : undefined;

      const cmds: MenuCommand[] = [
        {
          id: "be.open.pst",
          label: "Open .pst package…",
          menu: "file",
          group: "open",
          shortcut: "Ctrl+O",
          run: () => setModal("pst"),
        },
        {
          id: "be.open.folder",
          label: "Open station folder…",
          menu: "file",
          group: "open",
          run: () => setModal("folder"),
        },
        {
          id: "be.open.psf",
          label: "Open .psf project…",
          menu: "file",
          group: "open",
          run: () => void handlePick("psf", (p) => void runCmd(["open", p], `open ${p}`, "job")),
        },
        {
          id: "be.new",
          label: "New station project…",
          menu: "file",
          group: "create",
          shortcut: "Ctrl+N",
          run: () => setModal("new-station"),
        },
        {
          id: "be.fetch.examples",
          label: "Fetch official examples",
          menu: "file",
          group: "examples",
          run: () => void runCmd(["examples", "fetch"], "fetch examples"),
        },
        ...(b
          ? [
              {
                id: "be.open.dir",
                label: `Reveal ${b.name} in file manager`,
                menu: "file" as MenuId,
                group: "reveal",
                run: () => void api.openFolderPath(stationFolder(b)),
              },
              {
                id: "be.build",
                label: b.language === "cpp" ? `Build ${b.name}` : `Install ${b.name} dependencies`,
                menu: "model" as MenuId,
                group: "build",
                enabled: !isPrebuiltStation(b),
                why: "Prebuilt scratchpad binary — source build not needed",
                run: () =>
                  void runCmd(
                    b.language === "cpp" ? ["build", b.dir] : ["deps", "install", b.dir],
                    `build ${b.name}`,
                    "task",
                    fbKey,
                  ),
              },
              ...(b.language === "cpp"
                ? [
                    {
                      id: "be.rebuild",
                      label: `Rebuild ${b.name} (--clean)`,
                      menu: "model" as MenuId,
                      group: "build",
                      enabled: !isPrebuiltStation(b),
                      why: "Prebuilt scratchpad binary — source build not needed",
                      run: () => void runCmd(["rebuild", b.dir], `rebuild ${b.name}`, "task", fbKey),
                    },
                  ]
                : []),
              {
                id: "be.check",
                label: "Run 4-stage verification (check)",
                menu: "model" as MenuId,
                group: "verify",
                enabled: !isPrebuiltStation(b),
                why: "Verification applies to station project folders",
                run: () => void runCmd(["check", b.dir, "--json-stream"], `check ${b.name}`, "task", fbKey),
              },
              {
                id: "be.check.fast",
                label: "Run fast check (--fast)",
                menu: "model" as MenuId,
                group: "verify",
                enabled: !isPrebuiltStation(b),
                why: "Verification applies to station project folders",
                run: () => void runCmd(["check", b.dir, "--fast", "--json-stream"], `check --fast ${b.name}`, "task", fbKey),
              },
              {
                id: "be.pack",
                label: "Pack .pst archive",
                menu: "model" as MenuId,
                group: "pack",
                enabled: !isPrebuiltStation(b),
                why: "Prebuilt scratchpad is bundled with Paperboat",
                run: () => void runCmd(["pack", b.dir, "--json-stream"], `pack ${b.name}`, "task", fbKey),
              },
              {
                id: "be.run.start",
                label: `Run ${b.name}`,
                menu: "run" as MenuId,
                group: "lifecycle",
                meta: `:${o?.port ?? b.port}`,
                run: () => handleStationRun(b),
              },
              {
                id: "be.run.open",
                label: "Open in Paperboat web",
                menu: "run" as MenuId,
                group: "lifecycle",
                enabled: Boolean(liveProc),
                why: "Start the station first",
                run: () =>
                  liveProc &&
                  void api.openExternalUrl(
                    `http://localhost:${webRunning?.port ?? webPort}/?station=${encodeURIComponent(liveProc.url)}`,
                  ),
              },
              {
                id: "be.run.restart",
                label: `Restart ${b.name}`,
                menu: "run" as MenuId,
                group: "lifecycle",
                enabled: Boolean(liveProc),
                why: "Station is not running",
                run: () => void runCmd(["restart", b.name], `restart ${b.name}`, "task", fbKey),
              },
              {
                id: "be.run.stop",
                label: `Stop ${b.name}`,
                menu: "run" as MenuId,
                group: "lifecycle",
                enabled: Boolean(liveProc),
                why: "Station is not running",
                run: () => void runCmd(["stop", b.name], `stop ${b.name}`, "task", fbKey),
              },
              {
                id: "be.flag.nobuild",
                label: "Skip build (--no-build)",
                menu: "run" as MenuId,
                group: "flags",
                checked: Boolean(o?.noBuild),
                run: () => o && patchOpts(b, { noBuild: !o.noBuild }),
              },
              {
                id: "be.flag.clean",
                label: "Clean build (--clean)",
                menu: "run" as MenuId,
                group: "flags",
                checked: Boolean(o?.clean),
                run: () => o && patchOpts(b, { clean: !o.clean }),
              },
              {
                id: "be.flag.time",
                label: "Print timing (--time)",
                menu: "run" as MenuId,
                group: "flags",
                checked: Boolean(o?.time),
                run: () => o && patchOpts(b, { time: !o.time }),
              },
              {
                id: "be.flag.verbose",
                label: "Verbose output (--verbose)",
                menu: "run" as MenuId,
                group: "flags",
                checked: Boolean(o?.verbose),
                run: () => o && patchOpts(b, { verbose: !o.verbose }),
              },
            ]
          : []),
        ...sharedViewCommands,
      ];
      return {
        sectionCommands: cmds,
        sectionMenuLabels: {
          file: "Station",
          model: "Build",
          run: "Run",
          view: "View",
        } as Partial<Record<MenuId, string>>,
      };
    }

    if (page === "toolkits") {
      const t = curToolkit;
      const fbKey = t ? `toolkit:${t.name}` : undefined;
      const cmds: MenuCommand[] = [
        {
          id: "tk.install.custom",
          label: "Install from git repo or local path…",
          menu: "file",
          group: "manage",
          run: () => setModal("custom-toolkit"),
        },
        {
          id: "tk.update.all",
          label: "Update all installed toolkits",
          menu: "file",
          group: "manage",
          run: () => void runCmd(["toolkit", "update", "--all"], "update all toolkits"),
        },
        ...(t && !t.builtin
          ? [
              {
                id: "tk.cur.install_or_update",
                label: t.installed ? `Update ${t.name}` : `Install ${t.name}`,
                menu: "file" as MenuId,
                group: "current",
                run: () =>
                  void runCmd(
                    t.installed ? ["toolkit", "update", t.name] : ["toolkit", "install", t.name],
                    `${t.installed ? "update" : "install"} ${t.name}`,
                    "task",
                    fbKey,
                  ),
              },
              {
                id: "tk.cur.uninstall",
                label: `Uninstall ${t.name}`,
                menu: "file" as MenuId,
                group: "current",
                enabled: t.installed,
                why: `${t.name} is not installed`,
                run: () => void runCmd(["toolkit", "uninstall", t.name], `uninstall ${t.name}`, "task", fbKey),
              },
            ]
          : []),
        ...toolkits.map((tk) => ({
          id: `tk.select.${tk.name}`,
          label: tk.name,
          menu: "file" as MenuId,
          group: "select",
          meta: tk.builtin ? "built-in" : tk.installed ? tk.version || "installed" : "optional",
          checked: t?.name === tk.name,
          run: () => setSelectedToolkit(tk.name),
        })),
        ...BLOCK_KIND_OPTIONS.map((k) => ({
          id: `tk.kind.${k.value}`,
          label: `Show ${k.label} blocks`,
          menu: "model" as MenuId,
          group: "kind",
          checked: blockKindFilter === k.value,
          run: () => setBlockKindFilter(k.value),
        })),
        {
          id: "tk.clear.search",
          label: "Clear block search filter",
          menu: "model",
          group: "filter",
          enabled: blockQuery.trim().length > 0,
          why: "No active block filter",
          run: () => setBlockQuery(""),
        },
        ...sharedViewCommands,
      ];
      return {
        sectionCommands: cmds,
        sectionMenuLabels: {
          file: "Toolkit",
          model: "Blocks",
          view: "View",
        } as Partial<Record<MenuId, string>>,
      };
    }

    // page === "cli"
    const cmds: MenuCommand[] = [
      {
        id: "cli.list",
        label: "paperboat list",
        menu: "file",
        group: "inspect",
        meta: "running sessions",
        run: () => void runCmd(["list"], "paperboat list"),
      },
      {
        id: "cli.status",
        label: "paperboat status",
        menu: "file",
        group: "inspect",
        meta: "station build status",
        run: () => void runCmd(["status"], "paperboat status"),
      },
      {
        id: "cli.squero.list",
        label: "paperboat squero list",
        menu: "file",
        group: "inspect",
        meta: "installed squero apps",
        run: () => void runCmd(["squero", "list"], "paperboat squero list"),
      },
      {
        id: "cli.toolkit.list",
        label: "paperboat toolkit list",
        menu: "file",
        group: "inspect",
        meta: "engine toolkits",
        run: () => void runCmd(["toolkit", "list"], "paperboat toolkit list"),
      },
      {
        id: "cli.stations",
        label: "paperboat stations",
        menu: "file",
        group: "inspect",
        meta: "available stations",
        run: () => void runCmd(["stations"], "paperboat stations"),
      },
      {
        id: "console.help",
        label: "Print CLI command reference",
        menu: "edit",
        group: "output",
        run: () => printConsoleHelp(),
      },
      {
        id: "console.copy",
        label: "Copy all console output",
        menu: "edit",
        group: "output",
        enabled: logs.length > 0,
        why: "Console is empty",
        run: () => {
          const text = logs.map((l) => (l.tone === "cmd" ? `› ${l.text}` : l.text)).join("\n");
          void navigator.clipboard?.writeText(text);
        },
      },
      {
        id: "console.clear",
        label: "Clear console output",
        menu: "edit",
        group: "output",
        enabled: logs.length > 0,
        why: "Console is empty",
        run: () => setLogs([]),
      },
      {
        id: "console.stop",
        label: "Stop active CLI task",
        menu: "edit",
        group: "task",
        enabled: Boolean(activeTask),
        why: "No task is currently running",
        run: () => activeTask && void api.stopTask(activeTask.id),
      },
      ...sharedViewCommands,
    ];
    return {
      sectionCommands: cmds,
      sectionMenuLabels: {
        file: "CLI Commands",
        edit: "Console",
        view: "View",
      } as Partial<Record<MenuId, string>>,
      sectionProjectLabel: `cli · ${logs.length} lines`,
    };
  }, [
    page,
    webRunning,
    webPort,
    apps,
    channel,
    stations,
    running,
    installedAppsCount,
    curStation,
    optsFor,
    patchOpts,
    handleStationRun,
    handleChannelChange,
    handlePick,
    curToolkit,
    toolkits,
    filteredBlockCards.length,
    allBlockCards.length,
    blockKindFilter,
    blockQuery,
    logs,
    activeTask,
    printConsoleHelp,
    runCmd,
    sharedViewCommands,
  ]);

  const pageIndex = Math.max(0, LAUNCHER_PAGES.findIndex((p) => p.id === page));
  const railBadges: Partial<Record<LauncherPage, { text: string; live?: boolean }>> = {
    apps: running.length > 0 ? { text: String(running.length), live: true } : { text: `${installedAppsCount}/3` },
    stations: { text: String(stations.length) },
    toolkits: { text: String(installedToolkitsCount) },
  };

  const statusLabel = busy
    ? activeTask?.label || "working"
    : running.length > 0
      ? `v${versionStr} · ${running.length} live`
      : `v${versionStr} · ready`;

  const renderFeedback = (key: string) => {
    const fb = feedbackMap[key];
    if (!fb) return null;
    return (
      <div className={`inline-feedback ${fb.status}`} role="status">
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {fb.status === "busy" && (
            <span className="wave" aria-hidden="true">
              <i /><i /><i /><i /><i />
            </span>
          )}
          <span className="inline-feedback-text">{fb.text}</span>
        </div>
        <div style={{ display: "inline-flex", gap: 4, flex: "none" }}>
          <button type="button" className="key small" onClick={() => setPage("cli")}>Logs</button>
          {fb.status === "busy" && fb.taskId > 0 ? (
            <button type="button" className="key small" onClick={() => void api.stopTask(fb.taskId)}>Cancel</button>
          ) : (
            <button type="button" className="key small" onClick={() => dismissFeedback(key)}>Dismiss</button>
          )}
        </div>
      </div>
    );
  };

  // Section-specific contextual controls on the right side of the top bar (BarEnd)
  const sectionBarKeys = useMemo(() => {
    if (page === "apps") {
      return (
        <button
          type="button"
          className="key small"
          disabled={busy}
          onClick={() => void runCmd(["update", "--check", "--channel", channel], "check updates", "task", "app:paperboat")}
        >
          Check for updates
        </button>
      );
    }
    if (page === "stations") {
      return (
        <>
          <button type="button" className="key small run" onClick={() => setModal("pst")}>
            Open .pst…
          </button>
          <button type="button" className="key small" onClick={() => setModal("new-station")}>
            + New
          </button>
        </>
      );
    }
    if (page === "toolkits") {
      return (
        <button type="button" className="key small" onClick={() => setModal("custom-toolkit")}>
          + Install toolkit…
        </button>
      );
    }
    return (
      <>
        <button type="button" className="key small" onClick={printConsoleHelp}>
          Help
        </button>
        <button type="button" className="key small" onClick={() => setLogs([])}>
          Clear
        </button>
      </>
    );
  }, [page, busy, channel, runCmd, printConsoleHelp]);

  const sectionBarView = useMemo(() => {
    if (page === "apps") {
      return (
        <Switch
          label="Channel"
          value={channel}
          onChange={(ch) => void handleChannelChange(ch)}
          options={CHANNEL_OPTIONS}
        />
      );
    }
    if (page === "stations") {
      return (
        <Switch
          label="Source"
          value={stationFilter}
          onChange={setStationFilter}
          options={STATION_FILTER_OPTIONS}
        />
      );
    }
    if (page === "toolkits") {
      return (
        <Switch
          label="Kind"
          value={blockKindFilter}
          onChange={setBlockKindFilter}
          options={BLOCK_KIND_OPTIONS}
        />
      );
    }
    return null;
  }, [page, channel, handleChannelChange, stationFilter, blockKindFilter]);

  return (
    <div className="app mode-navigator">
      {/* Dynamic Section-Aware Top Bar using @paperboat/shared AppBar + MenuBar + BarEnd */}
      <AppBar
        brand={<Wordmark running={busy || running.length > 0} />}
        commands={sectionCommands}
        menuLabels={sectionMenuLabels}
        about={{
          title: "About Paperboat",
          shown: modal === "about",
          onOpen: () => setModal((m) => (m === "about" ? null : "about")),
        }}
      >
        <BarEnd
          keys={sectionBarKeys}
          view={sectionBarView}
          status={
            <StatusPill
              label={statusLabel}
              labels={[`v${versionStr} · ready`, `v${versionStr} · 9 live`, "checking updates…"]}
              tone={busy ? "busy" : "ok"}
              title="Click to check for updates"
              onClick={() => void runCmd(["update", "--check", "--channel", channel], "check updates", "task", "app:paperboat")}
            />
          }
          theme={themeChoice}
          onTheme={setThemeChoice}
        />
      </AppBar>

      {/* Left Rail with gliding ink brackets */}
      <LauncherRail page={page} onPage={setPage} badges={railBadges} />

      {/* Pages Column Stack — slides smoothly on --slide */}
      <div className="pages">
        <div className="page-stack">
          {/* =====================================================================
              PAGE 0: APPS & ACTIVE SESSIONS
             ===================================================================== */}
          <section
            className={`panel${page === "apps" ? " current" : ""}`}
            inert={page !== "apps"}
            aria-label="Apps"
            style={{ "--i": 0, "--at": pageIndex } as CSSProperties}
          >
            <header className="panel-head">
              <h2>Apps</h2>
              <span className="panel-info lbl">
                {installedAppsCount} of 3 installed
                {running.length > 0 ? ` · ${running.length} running` : ""}
              </span>
              <button
                type="button"
                className="key small"
                disabled={busy}
                onClick={() => void runCmd(["squero", "update", "--all"], "update all apps", "task", "app:paperboat")}
              >
                Update all
              </button>
            </header>

            <div className="panel-body">
              {errorMsg && (
                <div className="inline-feedback err">
                  <span className="inline-feedback-text">{errorMsg}</span>
                  <button type="button" className="key small" onClick={() => setErrorMsg("")}>Dismiss</button>
                </div>
              )}

              {/* 3 Application Cards: Paperboat, Squero Studio OM, Squero Studio MX */}
              <div className="apps-grid">
                {/* 1. Paperboat */}
                <article className={`app-card${webRunning ? " live" : ""}`}>
                  <div className="app-card-top">
                    <span className="app-card-title">
                      <span className={`dot${webRunning ? " live" : ""}`} />
                      Paperboat
                    </span>
                    {webRunning ? (
                      <span className="badge-pill signal">running :{webRunning.port}</span>
                    ) : (
                      <span className="badge-pill ink">v{versionStr}</span>
                    )}
                  </div>

                  <p className="app-card-desc">
                    Station, Flow, and Board scratchpad for building, running, and inspecting C++, Python, and Julia stations.
                  </p>

                  <div className="app-card-meta">
                    <span>channel <b>{channel}</b></span>
                    <span>port <b>:{webRunning?.port ?? webPort}</b></span>
                    <span>core runtime</span>
                  </div>

                  {renderFeedback("app:paperboat")}

                  <div className="app-card-foot">
                    <div className="app-card-actions">
                      {webRunning ? (
                        <>
                          <button
                            type="button"
                            className="key small run"
                            onClick={() => void api.openExternalUrl(webRunning.url)}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            className="key small"
                            onClick={() => void runCmd(["web", "stop", "--port", String(webRunning.port)], "stop paperboat", "task", "app:paperboat")}
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="key small run"
                          onClick={() => void runCmd(["web", "start", "--port", String(webPort), "--daemon"], "launch paperboat", "job", "app:paperboat")}
                        >
                          ▶ Launch
                        </button>
                      )}
                    </div>

                    <div className="app-card-actions">
                      <button
                        type="button"
                        className="key small"
                        disabled={feedbackMap["app:paperboat"]?.status === "busy"}
                        onClick={() => void runCmd(["update", "--channel", channel], `update paperboat (${channel})`, "task", "app:paperboat")}
                      >
                        {feedbackMap["app:paperboat"]?.status === "busy" ? "Updating…" : "Update"}
                      </button>
                    </div>
                  </div>
                </article>

                {/* 2 & 3. Squero Studio OM & Squero Studio MX */}
                {apps.map((app: AppInfo) => {
                  const liveApp = running.find((r) => r.name === app.name);
                  const versions = appVersions[app.name] ?? ["dev"];
                  const picked = appPickedVer[app.name] ?? app.version ?? versions[0] ?? "dev";
                  const fbKey = `app:${app.name}`;
                  const isBusy = feedbackMap[fbKey]?.status === "busy";
                  const ready = app.installed || app.checkout;
                  const verLabel = (v: string) => (v === "dev" ? "dev" : v.startsWith("v") ? v : `v${v}`);
                  // A version picked other than the installed one: Update installs that one instead.
                  const switchTo = app.installed && picked !== app.version ? picked : "";

                  return (
                    <article key={app.name} className={`app-card${liveApp ? " live" : ""}`}>
                      <div className="app-card-top">
                        <span className="app-card-title">
                          <span className={`dot${liveApp ? " live" : ""}`} />
                          {appDisplayTitle(app.name)}
                        </span>
                        {liveApp ? (
                          <span className="badge-pill signal">
                            running :{liveApp.port}
                            {app.installed && app.version ? ` · ${verLabel(app.version)}` : ""}
                          </span>
                        ) : app.installed ? (
                          <span className="badge-pill ink">{app.version ? `${verLabel(app.version)} installed` : "installed"}</span>
                        ) : app.checkout ? (
                          <span className="badge-pill ink">workspace</span>
                        ) : (
                          <span className="badge-pill">not installed</span>
                        )}
                      </div>

                      <p className="app-card-desc">{app.description}</p>

                      <div className="app-card-meta">
                        <span>port <b>:{app.port}</b></span>
                        <span>deps <b>auto</b></span>
                        <select
                          aria-label={`${appDisplayTitle(app.name)} version`}
                          value={picked}
                          onChange={(e) => setAppPickedVer((prev) => ({ ...prev, [app.name]: e.target.value }))}
                          style={{ height: 22, fontSize: 11 }}
                        >
                          {versions.map((v) => (
                            <option key={v} value={v}>
                              {verLabel(v)}
                              {app.installed && v === app.version ? " · installed" : ""}
                            </option>
                          ))}
                        </select>
                      </div>

                      {app.missingPrerequisites && (
                        <div className="inline-feedback err">
                          <span className="inline-feedback-text">Needs: {app.missingPrerequisites}</span>
                        </div>
                      )}

                      {renderFeedback(fbKey)}

                      <div className="app-card-foot">
                        <div className="app-card-actions">
                          {!ready ? (
                            <button
                              type="button"
                              className="key small run"
                              disabled={isBusy}
                              onClick={() =>
                                void runCmd(
                                  ["squero", "install", picked ? `${app.name}@${picked}` : app.name],
                                  `install ${appDisplayTitle(app.name)}`,
                                  "task",
                                  fbKey,
                                )
                              }
                            >
                              {isBusy ? "Installing…" : "Install"}
                            </button>
                          ) : liveApp ? (
                            <>
                              <button
                                type="button"
                                className="key small run"
                                onClick={() => void api.openExternalUrl(liveApp.url)}
                              >
                                Open
                              </button>
                              <button
                                type="button"
                                className="key small"
                                onClick={() => void runCmd(["squero", "stop", app.name], `stop ${appDisplayTitle(app.name)}`, "task", fbKey)}
                              >
                                Stop
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="key small run"
                              onClick={() => void runCmd(["squero", "start", app.name, "--daemon"], `launch ${appDisplayTitle(app.name)}`, "job", fbKey)}
                            >
                              ▶ Launch
                            </button>
                          )}
                        </div>

                        {ready && (
                          <div className="app-card-actions">
                            <button
                              type="button"
                              className="key small"
                              disabled={isBusy}
                              onClick={() =>
                                void runCmd(
                                  switchTo ? ["squero", "install", `${app.name}@${switchTo}`] : ["squero", "update", app.name],
                                  `${switchTo ? `install ${verLabel(switchTo)} of` : "update"} ${appDisplayTitle(app.name)}`,
                                  "task",
                                  fbKey,
                                )
                              }
                            >
                              {isBusy ? "Working…" : switchTo ? `Install ${verLabel(switchTo)}` : "Update"}
                            </button>
                            {app.installed && !liveApp && (
                              <button
                                type="button"
                                className="key small subtle-danger"
                                disabled={isBusy}
                                title={`Uninstall ${appDisplayTitle(app.name)}`}
                                onClick={() => void runCmd(["squero", "uninstall", app.name], `uninstall ${appDisplayTitle(app.name)}`, "task", fbKey)}
                              >
                                Uninstall
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Active Sessions & Quick Launch */}
              <div className="sessions-box">
                <div className="sessions-head">
                  <h3>Active Sessions</h3>
                  <span className="lbl">
                    {running.length === 0 ? "No processes running" : `${running.length} active`}
                  </span>
                  <div className="spacer" style={{ flex: 1 }} />
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <select
                      aria-label="Quick launch target"
                      value={quickTarget}
                      onChange={(e) => setQuickTarget(e.target.value)}
                      style={{ height: 24 }}
                    >
                      {stations.map((b) => (
                        <option key={b.dir} value={`station:${b.dir}`}>
                          {b.name} ({b.language} · :{b.port})
                        </option>
                      ))}
                      {apps.map((a) => (
                        <option key={a.name} value={`app:${a.name}`}>
                          {appDisplayTitle(a.name)} (:{a.port})
                        </option>
                      ))}
                    </select>
                    <button type="button" className="key small run" onClick={handleQuickStart}>
                      ▶ Start
                    </button>
                    {running.length > 0 && (
                      <button
                        type="button"
                        className="key small subtle-danger"
                        onClick={() => void runCmd(["stop", "--all"], "stop all sessions")}
                      >
                        Stop all
                      </button>
                    )}
                  </div>
                </div>

                {running.length > 0 || statusItems.some((s) => s.state !== "running") ? (
                  <div className="sessions-list">
                    {statusItems
                      .filter((s) => s.state !== "running")
                      .map((s) => (
                        <div key={`st-${s.name}-${s.port}`} className="session-row">
                          <span>
                            <span className={`dot ${s.state === "failed" ? "failed" : "building"}`} style={{ marginRight: 6 }} />
                            {s.state}
                          </span>
                          <span className="tag">station</span>
                          <b>{s.name}</b>
                          <span>:{s.port}</span>
                          <span className="lbl">{s.stage || s.error || s.url}</span>
                          <div className="session-actions">
                            <button type="button" className="key small" onClick={() => setPage("cli")}>Logs</button>
                          </div>
                        </div>
                      ))}
                    {running.map((r) => (
                      <div key={`${r.kind}-${r.port}-${r.pid}`} className="session-row">
                        <span style={{ color: "var(--signal-text)" }}>
                          <span className="dot live" style={{ marginRight: 6 }} />
                          running
                        </span>
                        <span className="tag">{r.kind}</span>
                        <b>{r.name}</b>
                        <span>:{r.port}</span>
                        <span className="lbl">{r.url}</span>
                        <div className="session-actions">
                          {r.kind === "station" ? (
                            <button
                              type="button"
                              className="key small run"
                              onClick={() =>
                                void api.openExternalUrl(
                                  `http://localhost:${webRunning?.port ?? webPort}/?station=${encodeURIComponent(r.url)}`,
                                )
                              }
                            >
                              Open in Paperboat
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="key small run"
                              onClick={() => void api.openExternalUrl(r.url)}
                            >
                              Open
                            </button>
                          )}
                          <button
                            type="button"
                            className="key small"
                            onClick={() =>
                              void runCmd(
                                r.kind === "squero"
                                  ? ["squero", "restart", r.name]
                                  : ["restart", r.kind === "paperboat" && r.name === "paperboat" ? "" : r.name].filter(Boolean),
                                `restart ${r.name}`,
                              )
                            }
                          >
                            Restart
                          </button>
                          <button
                            type="button"
                            className="key small subtle-danger"
                            onClick={() =>
                              void runCmd(
                                r.kind === "squero"
                                  ? ["squero", "stop", r.name]
                                  : ["stop", r.kind === "paperboat" && r.name === "paperboat" ? "" : r.name].filter(Boolean),
                                `stop ${r.name}`,
                              )
                            }
                          >
                            Stop
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: "var(--size-xs)" }}>
                    Launch an app above, or pick any station on the right to start a live session.
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* =====================================================================
              PAGE 1: STATIONS SCRATCHPAD
             ===================================================================== */}
          <section
            className={`panel${page === "stations" ? " current" : ""}`}
            inert={page !== "stations"}
            aria-label="Stations"
            style={{ "--i": 1, "--at": pageIndex } as CSSProperties}
          >
            <header className="panel-head">
              <h2>Stations</h2>
              <span className="panel-info lbl">{filteredStations.length} of {stations.length} shown</span>
            </header>

            <div className="panel-body">
              <div className="scratchpad">
                {/* Left Sidebar: Filterable Station List */}
                <aside className="wb-sidebar" aria-label="Station list">
                  <div className="well wb-search">
                    <span className="lbl">/</span>
                    <input
                      type="text"
                      placeholder="Filter stations…"
                      value={stationQuery}
                      onChange={(e) => setStationQuery(e.target.value)}
                    />
                  </div>

                  <div className="wb-list">
                    {filteredStations.map((b) => {
                      const live = running.some(
                        (r) => r.kind === "station" && (r.name === b.name || r.port === b.port),
                      );
                      const active = curStation?.dir === b.dir;
                      return (
                        <button
                          key={b.dir}
                          type="button"
                          className={`wb-item${active ? " current" : ""}`}
                          onClick={() => setSelectedStation(b.dir)}
                        >
                          <div className="wb-item-top">
                            <span className={`dot${live ? " live" : ""}`} />
                            <span className="wb-item-name">{b.name}</span>
                            <span className="tag" style={{ marginLeft: "auto" }}>
                              {b.language} · :{b.port}
                            </span>
                          </div>
                          <div className="wb-item-desc">{b.description || b.dir}</div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="wb-sidebar-foot">
                    <button type="button" className="key small" onClick={() => setModal("folder")}>
                      Open folder…
                    </button>
                    <button
                      type="button"
                      className="key small"
                      onClick={() => void handlePick("psf", (p) => void runCmd(["open", p], `open ${p}`, "job"))}
                    >
                      Open .psf…
                    </button>
                    <button
                      type="button"
                      className="key small"
                      onClick={() => void runCmd(["examples", "fetch"], "fetch examples")}
                    >
                      Fetch examples
                    </button>
                  </div>
                </aside>

                {/* Right Main Inspector: Unified Instrument Sheet */}
                {curStation && (
                  <div className="wb-main">
                    {(() => {
                      const o = optsFor(curStation);
                      const liveProc = running.find(
                        (r) => r.kind === "station" && (r.name === curStation.name || r.port === o.port),
                      );
                      const fbKey = `station:${curStation.dir}`;
                      return (
                        <>
                          <div className="sheet-card">
                            {/* Top Band: Identity */}
                            <div className="sheet-band">
                              <div className="sheet-title-row">
                                <span className={`dot${liveProc ? " live" : ""}`} />
                                <h3 className="sheet-title">{curStation.name}</h3>
                                <span className="badge-pill ink">{curStation.language}</span>
                                <span className="badge-pill">{curStation.source}</span>
                                <div style={{ flex: 1 }} />
                                <button
                                  type="button"
                                  className="key small"
                                  onClick={() => void api.openFolderPath(stationFolder(curStation))}
                                >
                                  Open folder
                                </button>
                                {curStation.source === "installed" && (
                                  <button
                                    type="button"
                                    className="key small subtle-danger"
                                    onClick={() =>
                                      void api
                                        .removeStationDir(curStation.dir)
                                        .then(() => refreshState())
                                        .catch((e) => setErrorMsg(String((e as Error).message || e)))
                                    }
                                  >
                                    Uninstall
                                  </button>
                                )}
                              </div>
                              <p className="sheet-desc">
                                {curStation.description || "Paperboat station project."}
                              </p>
                              <div className="tag">{curStation.dir}</div>
                            </div>

                            {/* Second Band: Unified Run Bar */}
                            <div className="sheet-band sunken">
                              <div className="be-run-bar">
                                {liveProc ? (
                                  <>
                                    <button
                                      type="button"
                                      className="key run"
                                      onClick={() =>
                                        void api.openExternalUrl(
                                          `http://localhost:${webRunning?.port ?? webPort}/?station=${encodeURIComponent(liveProc.url)}`,
                                        )
                                      }
                                    >
                                      Open in Paperboat
                                    </button>
                                    <button
                                      type="button"
                                      className="key small"
                                      onClick={() => void runCmd(["restart", curStation.name], `restart ${curStation.name}`, "task", fbKey)}
                                    >
                                      Restart
                                    </button>
                                    <button
                                      type="button"
                                      className="key small subtle-danger"
                                      onClick={() => void runCmd(["stop", curStation.name], `stop ${curStation.name}`, "task", fbKey)}
                                    >
                                      Stop
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="key run"
                                    onClick={() => handleStationRun(curStation)}
                                  >
                                    ▶ Run
                                  </button>
                                )}

                                <div className="run-options">
                                  <span>port</span>
                                  <input
                                    type="number"
                                    aria-label="Station port"
                                    value={o.port}
                                    onChange={(e) => patchOpts(curStation, { port: Number(e.target.value) || 8765 })}
                                    style={{ width: "8ch" }}
                                  />
                                </div>

                                <button
                                  type="button"
                                  className={`key small${showRunOptions ? " run" : ""}`}
                                  aria-expanded={showRunOptions}
                                  onClick={() => setShowRunOptions((v) => !v)}
                                >
                                  Options {o.vars.length > 0 ? `(${o.vars.length})` : ""} ▾
                                </button>

                                <span className="tag" style={{ marginLeft: "auto" }}>
                                  {liveProc ? `live at ${liveProc.url}` : `paperboat run ${curStation.name}`}
                                </span>
                              </div>

                              {showRunOptions && (
                                <div className="be-run-drawer">
                                  {!isPrebuiltStation(curStation) && (
                                    <>
                                      <label className={`flag-toggle${o.noBuild ? " on" : ""}`}>
                                        <input
                                          type="checkbox"
                                          checked={o.noBuild}
                                          onChange={(e) => patchOpts(curStation, { noBuild: e.target.checked })}
                                        />
                                        --no-build
                                      </label>
                                      <label className={`flag-toggle${o.clean ? " on" : ""}`}>
                                        <input
                                          type="checkbox"
                                          checked={o.clean}
                                          onChange={(e) => patchOpts(curStation, { clean: e.target.checked })}
                                        />
                                        --clean
                                      </label>
                                    </>
                                  )}
                                  <label className={`flag-toggle${o.time ? " on" : ""}`}>
                                    <input
                                      type="checkbox"
                                      checked={o.time}
                                      onChange={(e) => patchOpts(curStation, { time: e.target.checked })}
                                    />
                                    --time
                                  </label>
                                  <label className={`flag-toggle${o.verbose ? " on" : ""}`}>
                                    <input
                                      type="checkbox"
                                      checked={o.verbose}
                                      onChange={(e) => patchOpts(curStation, { verbose: e.target.checked })}
                                    />
                                    --verbose
                                  </label>

                                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
                                    <span className="lbl">--var</span>
                                    {o.vars.map((v, i) => (
                                      <span key={v} className="var-chip">
                                        {v}
                                        <button
                                          type="button"
                                          style={{ border: 0, background: "none", padding: 0, cursor: "pointer" }}
                                          onClick={() => patchOpts(curStation, { vars: o.vars.filter((_, k) => k !== i) })}
                                        >
                                          ×
                                        </button>
                                      </span>
                                    ))}
                                    <input
                                      type="text"
                                      className="well"
                                      value={newVarText}
                                      placeholder="key=value + Enter"
                                      style={{ height: 24, width: 140, padding: "0 8px" }}
                                      onChange={(e) => setNewVarText(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && newVarText.includes("=")) {
                                          patchOpts(curStation, { vars: [...o.vars, newVarText.trim()] });
                                          setNewVarText("");
                                        }
                                      }}
                                    />
                                  </div>
                                </div>
                              )}

                              {renderFeedback(fbKey)}
                            </div>
                          </div>

                          {/* Structured 2-Column Build/Package & Verification Grid */}
                          {isPrebuiltStation(curStation) ? (
                            <div className="workflow-box">
                              <div className="workflow-head">
                                <h3>Bundled Scratchpad</h3>
                                <span className="tag">Prebuilt binary</span>
                              </div>
                              <p className="sheet-desc">
                                Built-in standard toolkits host (Flow &amp; Board) plus installed toolkit plugins.
                                Starts automatically when you launch Paperboat, or run it standalone above.
                              </p>
                            </div>
                          ) : (
                          <div className="be-workflow-grid">
                            <div className="workflow-box">
                              <div className="workflow-head">
                                <h3>Build &amp; Package</h3>
                                <span className="tag">{curStation.language === "cpp" ? "CMake + C++20" : curStation.language}</span>
                              </div>
                              <p className="sheet-desc">
                                Compile the station or bundle it into a single portable <code>.pst</code> package.
                              </p>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
                                {curStation.language === "cpp" ? (
                                  <>
                                    <button
                                      type="button"
                                      className="key small run"
                                      onClick={() => void runCmd(["build", curStation.dir], `build ${curStation.name}`, "task", fbKey)}
                                    >
                                      Build
                                    </button>
                                    <button
                                      type="button"
                                      className="key small"
                                      onClick={() => void runCmd(["rebuild", curStation.dir], `rebuild ${curStation.name}`, "task", fbKey)}
                                    >
                                      Rebuild (--clean)
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="key small run"
                                    onClick={() => void runCmd(["deps", "install", curStation.dir], `deps install ${curStation.name}`, "task", fbKey)}
                                  >
                                    Install dependencies
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="key small"
                                  onClick={() => void runCmd(["pack", curStation.dir, "--json-stream"], `pack ${curStation.name}`, "task", fbKey)}
                                >
                                  Pack .pst
                                </button>
                              </div>
                            </div>

                            <div className="workflow-box">
                              <div className="workflow-head">
                                <h3>Verification (paperboat check)</h3>
                                <div style={{ display: "flex", gap: 6 }}>
                                  <button
                                    type="button"
                                    className="key small run"
                                    onClick={() => void runCmd(["check", curStation.dir, "--json-stream"], `check ${curStation.name}`, "task", fbKey)}
                                  >
                                    Run check
                                  </button>
                                  <button
                                    type="button"
                                    className="key small"
                                    onClick={() => void runCmd(["check", curStation.dir, "--fast", "--json-stream"], `check --fast ${curStation.name}`, "task", fbKey)}
                                  >
                                    Fast
                                  </button>
                                </div>
                              </div>

                              <div className="stepper">
                                {(["manifest", "catalog", "smoke", "golden"] as const).map((stepName) => {
                                  const done = [...(latestCheckTask?.events ?? [])]
                                    .reverse()
                                    .find((ev) => ev.event === "step" && ev.name === stepName);
                                  const started = latestCheckTask?.events.some(
                                    (ev) => ev.event === "step-start" && ev.name === stepName,
                                  );
                                  const cls = done
                                    ? done.ok || done.skipped
                                      ? "ok"
                                      : "fail"
                                    : started
                                      ? "running"
                                      : "";
                                  return (
                                    <div key={stepName} className={`step-box ${cls}`}>
                                      <div className="step-head">
                                        <span>
                                          {done ? (done.skipped ? "–" : done.ok ? "✓" : "✗") : started ? "…" : "·"}{" "}
                                          {stepName}
                                        </span>
                                        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                                          {done?.duration ? `${done.duration.toFixed(1)}s` : ""}
                                        </span>
                                      </div>
                                      <div className="step-msg">
                                        {done?.message || (started ? "running…" : "ready")}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* =====================================================================
              PAGE 2: TOOLKITS & BLOCK CARDS BROWSER
             ===================================================================== */}
          <section
            className={`panel${page === "toolkits" ? " current" : ""}`}
            inert={page !== "toolkits"}
            aria-label="Toolkits"
            style={{ "--i": 2, "--at": pageIndex } as CSSProperties}
          >
            <header className="panel-head">
              <h2>Toolkits</h2>
              <span className="panel-info lbl">
                {installedToolkitsCount} optional installed · {toolkits.length} in catalog
              </span>
              <button
                type="button"
                className="key small"
                onClick={() => void runCmd(["toolkit", "update", "--all"], "update all toolkits")}
              >
                Update all
              </button>
            </header>

            <div className="panel-body">
              <div className="scratchpad">
                {/* Left Sidebar: Toolkit List */}
                <aside className="wb-sidebar" aria-label="Toolkit list">
                  <div className="wb-list">
                    {toolkits.map((t: ToolkitInfo) => (
                      <button
                        key={t.name}
                        type="button"
                        className={`wb-item${curToolkit?.name === t.name ? " current" : ""}`}
                        onClick={() => setSelectedToolkit(t.name)}
                      >
                        <div className="wb-item-top">
                          <span className={`dot${t.installed ? " live" : ""}`} />
                          <span className="wb-item-name">{t.name}</span>
                          <span className="tag" style={{ marginLeft: "auto" }}>
                            {t.builtin ? "built-in" : t.installed ? t.version || "installed" : "optional"}
                          </span>
                        </div>
                        <div className="wb-item-desc">{t.description}</div>
                      </button>
                    ))}
                  </div>
                </aside>

                {/* Right Main Inspector: Toolkit Summary + Block Cards Grid */}
                {curToolkit && (
                  <div className="wb-main">
                    {(() => {
                      const fbKey = `toolkit:${curToolkit.name}`;
                      const isBusy = feedbackMap[fbKey]?.status === "busy";
                      const pickedVer =
                        tkPickedVer[curToolkit.name] ?? (tkVersions[curToolkit.name]?.[0] || "dev");

                      return (
                        <>
                          <div className="sheet-card" style={{ flex: "none" }}>
                            <div className="sheet-band">
                              <div className="sheet-title-row">
                                <span className={`dot${curToolkit.installed ? " live" : ""}`} />
                                <h3 className="sheet-title">{curToolkit.name}</h3>
                                <span className={`badge-pill${curToolkit.installed ? " ink" : ""}`}>
                                  {curToolkit.builtin
                                    ? "built-in"
                                    : curToolkit.installed
                                      ? `installed ${curToolkit.version || ""}`.trim()
                                      : "not installed"}
                                </span>
                                {curToolkit.repo && <span className="tag">{curToolkit.repo}</span>}
                                <div style={{ flex: 1 }} />

                                {!curToolkit.builtin && (
                                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                    <select
                                      aria-label={`${curToolkit.name} version`}
                                      value={pickedVer}
                                      onChange={(e) =>
                                        setTkPickedVer((prev) => ({ ...prev, [curToolkit.name]: e.target.value }))
                                      }
                                      style={{ height: 24 }}
                                    >
                                      {(tkVersions[curToolkit.name] ?? ["dev"]).map((v) => (
                                        <option key={v} value={v}>
                                          {v === "dev" ? "dev" : v.startsWith("v") ? v : `v${v}`}
                                        </option>
                                      ))}
                                    </select>
                                    {!curToolkit.installed ? (
                                      <button
                                        type="button"
                                        className="key small run"
                                        disabled={isBusy}
                                        onClick={() =>
                                          void runCmd(
                                            ["toolkit", "install", curToolkit.name, "--version", pickedVer],
                                            `install ${curToolkit.name}`,
                                            "task",
                                            fbKey,
                                          )
                                        }
                                      >
                                        {isBusy ? "Installing…" : "Install"}
                                      </button>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          className="key small"
                                          disabled={isBusy}
                                          onClick={() =>
                                            void runCmd(
                                              ["toolkit", "update", curToolkit.name],
                                              `update ${curToolkit.name}`,
                                              "task",
                                              fbKey,
                                            )
                                          }
                                        >
                                          {isBusy ? "Updating…" : "Update"}
                                        </button>
                                        <button
                                          type="button"
                                          className="key small subtle-danger"
                                          disabled={isBusy}
                                          onClick={() =>
                                            void runCmd(
                                              ["toolkit", "uninstall", curToolkit.name],
                                              `uninstall ${curToolkit.name}`,
                                              "task",
                                              fbKey,
                                            )
                                          }
                                        >
                                          Uninstall
                                        </button>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                              <p className="sheet-desc">{curToolkit.description}</p>
                              {renderFeedback(fbKey)}
                            </div>
                          </div>

                          {/* BLOCK CARDS BROWSER (Point #2: cards with explanation of each block) */}
                          <div className="blocks-section">
                            <div className="blocks-toolbar">
                              <h3>Blocks ({filteredBlockCards.length})</h3>
                              <div className="well wb-search" style={{ flex: "0 1 260px", marginLeft: "auto" }}>
                                <span className="lbl">/</span>
                                <input
                                  type="text"
                                  placeholder="Filter blocks…"
                                  value={blockQuery}
                                  onChange={(e) => setBlockQuery(e.target.value)}
                                />
                              </div>
                            </div>

                            <div className="block-cards-grid">
                              {filteredBlockCards.map((b) => (
                                <article key={b.type} className="block-card">
                                  <div className="block-card-head">
                                    <b>{b.label}</b>
                                    <span className="block-card-kind">{b.kind}</span>
                                  </div>
                                  <code className="block-card-type">{b.type}</code>
                                  <p className="block-card-desc">{b.description}</p>
                                </article>
                              ))}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* =====================================================================
              PAGE 3: INTERACTIVE PAPERBOAT CLI
             ===================================================================== */}
          <section
            className={`panel${page === "cli" ? " current" : ""}`}
            inert={page !== "cli"}
            aria-label="Paperboat CLI"
            style={{ "--i": 3, "--at": pageIndex } as CSSProperties}
          >
            <header className="panel-head">
              <h2>Paperboat CLI</h2>
              <span className="panel-info lbl">
                Tab completes · → accepts suggestion · ↑↓ history
              </span>
            </header>

            <div className="panel-body">
              <div className="console-wrap">
                <div className="screen console-screen">
                  {logs.map((l) => (
                    <div key={`${l.seq}-${l.timeMs}`} className={l.tone}>
                      {l.tone === "cmd" ? `› ${l.text}` : l.text}
                    </div>
                  ))}
                  <div ref={consoleEndRef} />
                </div>

                <div className="prompt-bar">
                  {compOpen && completion.candidates.length > 0 && (
                    <div className="completion-pop">
                      {completion.candidates.map((c, i) => (
                        <div
                          key={c.value}
                          className={`comp-row${i === compIdx ? " on" : ""}`}
                          onClick={() => {
                            const parts = cmdText.split(" ");
                            parts[parts.length - 1] = c.value;
                            setCmdText(parts.join(" ") + " ");
                            setCompOpen(false);
                          }}
                        >
                          <span>{c.value}</span>
                          <span className="det">{c.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <span className="prompt-sig">paperboat›</span>
                  <div className="prompt-input-wrap">
                    <span className="prompt-ghost">{completion.ghost}</span>
                    <input
                      className="prompt-input"
                      type="text"
                      value={cmdText}
                      placeholder="Type any paperboat command (start, squero list, check, toolkit list, help)…"
                      onChange={(e) => {
                        setCmdText(e.target.value);
                        setCompIdx(0);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Tab") {
                          e.preventDefault();
                          if (!compOpen) {
                            setCompOpen(true);
                            setCompIdx(0);
                          } else if (completion.candidates[compIdx]) {
                            const parts = cmdText.split(" ");
                            parts[parts.length - 1] = completion.candidates[compIdx].value;
                            setCmdText(parts.join(" ") + " ");
                            setCompOpen(false);
                          }
                        } else if (
                          e.key === "ArrowRight" &&
                          e.currentTarget.selectionStart === cmdText.length &&
                          completion.ghost
                        ) {
                          e.preventDefault();
                          setCmdText(completion.ghost);
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          if (compOpen && completion.candidates.length) {
                            setCompIdx((i) => (i - 1 + completion.candidates.length) % completion.candidates.length);
                          } else if (history.length) {
                            const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
                            setHistIdx(next);
                            setCmdText(history[next]);
                          }
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          if (compOpen && completion.candidates.length) {
                            setCompIdx((i) => (i + 1) % completion.candidates.length);
                          } else if (histIdx >= 0) {
                            const next = histIdx + 1;
                            setHistIdx(next >= history.length ? -1 : next);
                            setCmdText(next < history.length ? history[next] : "");
                          }
                        } else if (e.key === "Escape") {
                          setCompOpen(false);
                        } else if (e.key === "Enter") {
                          submitConsole();
                        }
                      }}
                    />
                  </div>
                  <button type="button" className="key small run" onClick={submitConsole}>
                    Run
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Native CommandSearch (Ctrl+K) from @paperboat/shared */}
      {modal === "palette" && (
        <CommandSearch commands={sectionCommands} onClose={() => setModal(null)} />
      )}

      {/* Other Modals */}
      {modal && modal !== "palette" && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          {modal === "about" ? (
            <section className="console-window about-window" role="dialog" aria-label="About Paperboat">
              <header className="console-head">
                <h2>About Paperboat</h2>
                <span className="lbl">paperboat/0</span>
                <button type="button" className="key small" onClick={() => setModal(null)}>
                  Close
                </button>
              </header>
              <div className="about-body">
                <div className="about-mark">
                  <Logo height={112} running />
                  <span className="about-name">paperboat</span>
                </div>
                <div className="about-info">
                  <dl className="about-facts">
                    <dt>Version</dt>
                    <dd className="mono">{versionStr}</dd>
                    <dt>Channel</dt>
                    <dd className="mono">{channel}</dd>
                    <dt>Apps</dt>
                    <dd className="mono">{installedAppsCount} / 3 installed</dd>
                    <dt>Toolkits</dt>
                    <dd className="mono">{installedToolkitsCount} optional installed</dd>
                    <dt>License</dt>
                    <dd>GPL-3.0-only</dd>
                  </dl>
                  <section className="about-section">
                    <h3>Optional Toolkits</h3>
                    <ul className="about-list">
                      {toolkits
                        .filter((t) => !t.builtin && t.installed)
                        .map((t) => (
                          <li key={t.name}>
                            <span>{t.name}</span>
                            <span className="lbl">{t.version || "installed"}</span>
                          </li>
                        ))}
                    </ul>
                  </section>
                </div>
              </div>
            </section>
          ) : (
            <div className="modal-dialog" role="dialog">
              {modal === "pst" && (
                <>
                  <header className="modal-head">
                    <h3>Open Station (.pst)</h3>
                    <span className="sp" />
                    <button type="button" className="modal-close" onClick={() => setModal(null)}>×</button>
                  </header>
                  <div className="modal-body-pad">
                    <p className="sheet-desc">
                      Run a packaged <code>.pst</code> station directly or install it into your local stations store.
                    </p>
                    <div className="field-row">
                      <span className="field-label">Package (.pst)</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <div className="well well-field" style={{ flex: 1 }}>
                          <input
                            value={pstPath}
                            onChange={(e) => setPstPath(e.target.value)}
                            placeholder="/path/to/station.pst"
                          />
                        </div>
                        <button type="button" className="key small" onClick={() => void handlePick("pst", setPstPath)}>
                          Browse…
                        </button>
                      </div>
                    </div>
                    <div className="field-row">
                      <span className="field-label">Port</span>
                      <div className="well well-field">
                        <input
                          type="number"
                          value={pstPort}
                          onChange={(e) => setPstPort(Number(e.target.value) || 8792)}
                        />
                      </div>
                    </div>
                    <div className="field-row">
                      <span className="field-label">Install dir</span>
                      <div className="well well-field">
                        <input
                          value={pstDir}
                          onChange={(e) => setPstDir(e.target.value)}
                          placeholder="default (~/.local/share/paperboat/stations/)"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="key small" onClick={() => setModal(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="key small"
                      disabled={!pstPath.trim()}
                      onClick={() => {
                        const p = pstPath.trim();
                        const args = ["unpack", p, "--json-stream"];
                        if (pstDir.trim()) args.push("--dir", pstDir.trim());
                        setModal(null);
                        void runCmd(args, `unpack ${pstDisplayName(p)}`);
                      }}
                    >
                      Install to stations
                    </button>
                    <button
                      type="button"
                      className="key small run"
                      disabled={!pstPath.trim()}
                      onClick={() => {
                        const p = pstPath.trim();
                        setModal(null);
                        void runCmd(["run", p, "--port", String(pstPort)], `run ${pstDisplayName(p)}`, "job");
                      }}
                    >
                      ▶ Run .pst
                    </button>
                  </div>
                </>
              )}

              {modal === "folder" && (
                <>
                  <header className="modal-head">
                    <h3>Open Station Folder</h3>
                    <span className="sp" />
                    <button type="button" className="modal-close" onClick={() => setModal(null)}>×</button>
                  </header>
                  <div className="modal-body-pad">
                    <div className="field-row">
                      <span className="field-label">Folder path</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <div className="well well-field" style={{ flex: 1 }}>
                          <input
                            value={folderPath}
                            onChange={(e) => setFolderPath(e.target.value)}
                            placeholder="/path/to/station"
                          />
                        </div>
                        <button type="button" className="key small" onClick={() => void handlePick("dir", setFolderPath)}>
                          Browse…
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="key small" onClick={() => setModal(null)}>Cancel</button>
                    <button
                      type="button"
                      className="key small run"
                      disabled={!folderPath.trim()}
                      onClick={() => {
                        const p = folderPath.trim();
                        setModal(null);
                        void runCmd(["run", p], `run ${p}`, "job");
                      }}
                    >
                      ▶ Run folder
                    </button>
                  </div>
                </>
              )}

              {modal === "new-station" && (
                <>
                  <header className="modal-head">
                    <h3>New Station</h3>
                    <span className="sp" />
                    <button type="button" className="modal-close" onClick={() => setModal(null)}>×</button>
                  </header>
                  <div className="modal-body-pad">
                    <div className="field-row">
                      <span className="field-label">Name</span>
                      <div className="well well-field">
                        <input value={nbName} onChange={(e) => setNbName(e.target.value)} />
                      </div>
                    </div>
                    <div className="field-row">
                      <span className="field-label">Language</span>
                      <Switch
                        label=""
                        value={nbLang}
                        onChange={setNbLang}
                        options={[
                          { value: "cpp", label: "c++" },
                          { value: "python", label: "python" },
                          { value: "julia", label: "julia" },
                        ]}
                      />
                    </div>
                    <div className="field-row">
                      <span className="field-label">Directory</span>
                      <div className="well well-field">
                        <input
                          value={nbDir}
                          onChange={(e) => setNbDir(e.target.value)}
                          placeholder="optional (--dir)"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="key small" onClick={() => setModal(null)}>Cancel</button>
                    <button
                      type="button"
                      className="key small run"
                      disabled={!nbName.trim()}
                      onClick={() => {
                        const args = ["new", nbName.trim(), `--${nbLang}`];
                        if (nbDir.trim()) args.push("--dir", nbDir.trim());
                        setModal(null);
                        void runCmd(args, `new ${nbName.trim()}`);
                      }}
                    >
                      Create station
                    </button>
                  </div>
                </>
              )}

              {modal === "custom-toolkit" && (
                <>
                  <header className="modal-head">
                    <h3>Install Toolkit</h3>
                    <span className="sp" />
                    <button type="button" className="modal-close" onClick={() => setModal(null)}>×</button>
                  </header>
                  <div className="modal-body-pad">
                    <div className="field-row">
                      <span className="field-label">Toolkit name</span>
                      <div className="well well-field">
                        <input
                          value={ctkName}
                          onChange={(e) => setCtkName(e.target.value)}
                          placeholder="e.g. control"
                        />
                      </div>
                    </div>
                    <div className="field-row">
                      <span className="field-label">Repo or Path</span>
                      <div className="well well-field">
                        <input
                          value={ctkSrc}
                          onChange={(e) => setCtkSrc(e.target.value)}
                          placeholder="https://github.com/… or /path/to/toolkit"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="key small" onClick={() => setModal(null)}>Cancel</button>
                    <button
                      type="button"
                      className="key small run"
                      disabled={!ctkName.trim() || !ctkSrc.trim()}
                      onClick={() => {
                        const src = ctkSrc.trim();
                        const flag = src.includes("://") || src.endsWith(".git") ? "--repo" : "--path";
                        const args = ["toolkit", "install", ctkName.trim(), flag, src];
                        setModal(null);
                        void runCmd(args, `install ${ctkName.trim()}`);
                      }}
                    >
                      Install toolkit
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
