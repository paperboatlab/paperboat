// The terminal UI, command-first: the mark and a welcome panel, a transcript (finished output goes to
// the terminal's scrollback through <Static>), the prompt with registry completion, and a status line.
// It owns no logic: every command is @paperboat/client's run(line), i.e. the CLI's own words.

import {Box, Static, useApp, useInput, useWindowSize, type Key} from 'ink';
import {readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {useEffect, useReducer, useRef, useState} from 'react';
import {complete, edit, findCommand, ghost as ghostOf, remember, searchHistory, splitWords, type Choice, type Client, type Job, type Line as InputLine, type Sources, type State} from '@paperboat/client';
import {useStore} from '@paperboat/client/react';
import {box, fit, seg, type Line} from './grid.ts';
import {Lines} from './Lines.tsx';
import {markLines} from './mark.ts';
import {accent, C, FRAME_MS, spinner} from './theme.ts';
import {jobLines, JSON_VIEWS, help} from './views.ts';

export interface About {
  paperboat: string;
  channel: string;
  daemon: {version: string; runtimes: number} | null;
  home?: string;
}

interface Entry {
  key: number;
  lines: Line[];
}

const tilde = (p: string) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p);

export function banner(about: About | null, cwd: string, w: number): Line[] {
  const text: Line[] = [
    [seg('Paperboat', C.fg, true), seg(` ${about?.paperboat ?? ''}`)],
    [seg(`${about?.channel ?? 'release'} channel · ${tilde(cwd)}`, C.mu)],
    [seg(about?.daemon ? `paperboatd ${about.daemon.version} · ${about.daemon.runtimes} runtimes` : 'paperboatd starts when needed', C.mu)],
    [],
    [seg('/ for commands · Tab completes · ↑ history · ? keys', C.mu)],
  ];
  const rows = markLines().map((m, i) => [seg('  '), ...m, seg('    '), ...(text[i] ?? [])]);
  return box('', '', [[], ...rows, []], Math.min(76, w));
}

const KEYS: Line[] = [
  ['/', 'the commands (the registry)'],
  ['Tab  →', 'take the suggestion'],
  ['↑ ↓', 'choose in the menu; history on an empty menu'],
  ['Ctrl+R', 'search the history (again: older; Enter runs, Tab edits)'],
  ['Enter', 'run (or fill in the chosen command)'],
  ['Esc', 'clear the line; stop following events'],
  ['Ctrl+A E U K W', 'start, end, cut before, cut after, cut a word'],
  ['Ctrl+L', 'clear the transcript'],
  ['Ctrl+C twice', 'quit'],
].map(([k, d]) => [seg(k.padEnd(18), C.fg, true), seg(d, C.mu)]);

/** Values for each argument the usages name. */
function sources(s: State, cwd: string): Sources {
  const args: Record<string, Choice[]> = {
    app: s.apps.map(a => ({value: a.name, detail: a.sessions ? 'running' : a.installed ? 'installed' : 'available'})),
    session: s.sessions.map(x => ({value: x.id, detail: x.url})),
    runtime: (s.runtimes?.runtimes ?? []).map(r => ({value: r.name, detail: r.version})),
  };
  args.instance = args.kernel = args.lease = s.instances.map(l => ({value: l.id, detail: `${l.runtime} ${l.state}`}));
  const listDir = (dir: string): Choice[] => {
    try {
      const at = resolve(cwd, dir.replace(/^~(?=\/|$)/, homedir()));
      return readdirSync(at, {withFileTypes: true})
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => ({value: d.name + '/', detail: ''}));
    } catch {
      return [];
    }
  };
  return {commands: s.commands, args, listDir};
}

export function App({client, about, cwd, glyphs, history = [], onHistory}: {
  client: Client;
  about: About | null;
  cwd: string;
  glyphs: boolean;
  /** The lines kept from earlier runs, oldest first; `onHistory` gets each new one to keep. */
  history?: string[];
  onHistory?: (line: string) => void;
}) {
  const {exit} = useApp();
  const {columns} = useWindowSize();
  const w = Math.max(40, Math.min(columns || 80, 120));
  const state = useStore(client, s => s);
  // The prompt lives in a ref: keys can come faster than renders, and each must see the last one's line.
  const ui = useRef({line: {text: '', cursor: 0} as InputLine, menu: 0, history, hi: -1, search: null as null | {query: string; n: number; before: InputLine}});
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const set = (patch: Partial<typeof ui.current>) => {
    Object.assign(ui.current, patch);
    rerender();
  };
  const setLine = (line: InputLine) => set({line});
  const setMenu = (menu: number) => set({menu});
  const [done, setDone] = useState<Entry[]>(() => [{key: 0, lines: [...banner(about, cwd, w), []]}]);
  const [running, setRunning] = useState<{key: number; line: string; job?: number}[]>([]);
  const [events, setEvents] = useState<(() => void) | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [frame, setFrame] = useState(0);
  const [generation, setGeneration] = useState(0);
  const keys = useRef(1);

  const busy = running.length > 0 || events !== null;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setFrame(f => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, [busy]);

  // The menu and the grey suggestion for the prompt as it is now.
  const derive = () => {
    const {line, menu, history} = ui.current;
    const src = sources(client.getState(), cwd);
    const text = line.text;
    const slash = text.startsWith('/');
    const body = slash ? text.slice(1) : text;
    const {candidates, from} = slash ? complete(body, src) : {candidates: [], from: 0};
    const shown = candidates.slice(0, 8);
    const pick = Math.min(menu, Math.max(0, shown.length - 1));
    const fill = (v: string) => {
      const c = src.commands.find(x => x.name === v || x.alias.includes(v));
      return '/' + body.slice(0, from) + v + (v.endsWith('/') || (c && !c.args) ? '' : ' ');
    };
    const top = shown[pick] && fill(shown[pick].value);
    const ghost = line.cursor !== text.length ? '' : top && top.startsWith(text) ? top.slice(text.length).trimEnd() : ghostOf(text, history, src);
    return {line, text, src, shown, pick, fill, ghost};
  };

  const add = (lines: Line[]) => setDone(d => [...d, {key: keys.current++, lines}]);

  async function exec(input: string) {
    const t = input.trim().replace(/^\//, '');
    if (!t) return;
    const h = remember(ui.current.history, '/' + t);
    if (h !== ui.current.history) onHistory?.('/' + t);
    set({history: h, hi: -1});
    const head: Line = [seg('› ', C.mu), seg('/' + t, C.fg, true)];
    const cmd = findCommand(client.getState().commands, splitWords(t))?.cmd;
    if (cmd?.id === 'paperboat.quit') return exit();
    if (cmd?.id === 'paperboat.clear') {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setDone([]);
      setGeneration(g => g + 1);
      return;
    }
    if (cmd?.id === 'paperboat.help') return add([head, ...indent(help(client.getState().commands, w - 2)), []]);
    if (cmd?.id === 'runtime.events') {
      add([head]);
      events?.();
      setEvents(() => client.watch());
      return;
    }
    const key = keys.current++;
    setRunning(r => [...r, {key, line: t}]);
    const text = !cmd || !(cmd.id in JSON_VIEWS);
    if (cmd?.id === 'runtime.list' && !client.getState().runtimes) await client.refresh({runtimes: true});
    const job = await client.run(t, {text});
    setRunning(r => r.filter(x => x.key !== key));
    setDone(d => [...d, {key, lines: [head, ...indent(jobLines(job, client.getState(), w - 2)), []]}]);
  }

  // A paste (or keys faster than the terminal reads) comes as one chunk: Enter inside it runs the line.
  useInput((input, key) => {
    if (input.length < 2 || !/[\r\n]/.test(input)) return onKey(input, key);
    for (const part of input.split(/(\r\n|\r|\n)/))
      if (/^[\r\n]+$/.test(part)) onKey('', {...key, return: true});
      else if (part) onKey(part, key);
  });

  function onKey(input: string, key: Key) {
    const {line, text, src, shown, pick, fill, ghost} = derive();
    const {history, hi} = ui.current;
    if (key.ctrl && input === 'c') {
      if (quitting || !text) return exit();
      setLine({text: '', cursor: 0});
      setQuitting(true);
      setTimeout(() => setQuitting(false), 2000);
      return;
    }
    setQuitting(false);
    if (ui.current.search) return searchKey(input, key);
    if (key.ctrl && input === 'r') return set({search: {query: '', n: 0, before: line}});
    if (key.return) {
      const c = shown[pick];
      const f = c && fill(c.value);
      if (f && f.trim() !== text.trim()) {
        const cmd = src.commands.find(x => x.name === c.value);
        if (cmd && !cmd.args) void exec(f);
        else setLine({text: f, cursor: f.length});
        if (cmd && !cmd.args) setLine({text: '', cursor: 0});
      } else {
        void exec(text);
        setLine({text: '', cursor: 0});
      }
      setMenu(0);
      return;
    }
    if (key.tab || (key.rightArrow && line.cursor === text.length && (shown.length || ghost))) {
      const f = shown[pick] ? fill(shown[pick].value) : text + ghost;
      setLine({text: f, cursor: f.length});
      setMenu(0);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (shown.length > 1 && text) return setMenu((pick + (key.downArrow ? 1 : shown.length - 1)) % shown.length);
      const n = key.upArrow ? Math.min(history.length - 1, hi + 1) : Math.max(-1, hi - 1);
      const h = n < 0 ? '' : history[history.length - 1 - n];
      return set({hi: n, line: {text: h, cursor: h.length}});
    }
    if (key.escape) {
      if (events) {
        events();
        setEvents(null);
        add(indent(eventLines(client.getState(), w - 2)));
      }
      return setLine({text: '', cursor: 0});
    }
    if (key.ctrl && input === 'l') {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setDone([]);
      setGeneration(g => g + 1);
      return;
    }
    if (input === '?' && !text) return add([...indent(box('Keys', '', KEYS, w - 2)), []]);
    const next = edit(line, {input, ctrl: key.ctrl, backspace: key.backspace, delete: key.delete, left: key.leftArrow, right: key.rightArrow, home: key.home, end: key.end});
    if (next) {
      setLine(next);
      setMenu(0);
    }
  }

  // Ctrl+R: the newest history line containing the query; Ctrl+R again goes older.
  const found = () => {
    const s = ui.current.search!;
    const all = searchHistory(ui.current.history, s.query);
    return all[Math.min(s.n, all.length - 1)] ?? '';
  };
  function searchKey(input: string, key: Key) {
    const s = ui.current.search!;
    const hit = found();
    if (key.ctrl && input === 'r') return set({search: {...s, n: Math.min(s.n + 1, searchHistory(ui.current.history, s.query).length - 1)}});
    if (key.escape || (key.ctrl && input === 'g')) return set({search: null, line: s.before});
    if (key.return) {
      set({search: null, line: {text: '', cursor: 0}});
      return void exec(hit);
    }
    if (key.backspace || key.delete) return set({search: {...s, query: s.query.slice(0, -1), n: 0}});
    if (input && !key.ctrl && !key.meta && !key.tab) return set({search: {...s, query: s.query + input, n: 0}});
    // Tab, an arrow or any other key: take the line to edit it.
    set({search: null, line: {text: hit || s.before.text, cursor: (hit || s.before.text).length}});
  }

  const {line, text, src, shown, pick, ghost} = derive();
  const live: Line[] = [
    ...running.flatMap(r => {
      const job = client.getState().jobs.findLast((j: Job) => j.line === r.line && j.state === 'running');
      const out = job?.output.at(-1);
      return [[seg('› ', C.mu), seg('/' + r.line, C.fg, true)], [seg('  '), seg(spinner(frame, glyphs) + ' ', C.p), seg(out ?? 'working…', C.mu)]];
    }),
    ...(events ? [...indent(eventLines(state, w - 2, 'following · esc stops')), []] : []),
  ];
  const before = text.slice(0, line.cursor);
  const at = text[line.cursor] ?? ghost[0] ?? ' ';
  const after = line.cursor < text.length ? text.slice(line.cursor + 1) : ghost.slice(1);
  const search = ui.current.search;
  const hit = search ? found() : '';
  const prompt = search
    ? box('', '', [[seg('search ', C.mu), seg(search.query, C.fg, true), {text: ' ', color: C.screen, bg: C.fg}, seg(hit ? '  ' + hit : '  no match', hit ? C.fg : C.mu)]], w)
    : box('', '', [[seg('› ', C.p), seg(before), {text: at, color: C.screen, bg: C.fg}, seg(after, line.cursor < text.length ? C.fg : C.mu)]], w);
  const menuLines: Line[] = shown.map((c, i) => {
    const sel = i === pick ? C.selbg : undefined;
    const cmd = src.commands.find(x => x.name === c.value);
    const label = [...c.value].map((ch, k) => ({text: ch, color: C.fg, bold: c.match.includes(k), bg: sel}));
    const args = cmd?.args ? [{text: ' ' + cmd.args, color: C.mu, bg: sel}] : [];
    const lw = c.value.length + (cmd?.args ? cmd.args.length + 1 : 0);
    return fit([{text: '  ', bg: sel}, ...label, ...args, {text: ' '.repeat(Math.max(2, 40 - lw)), bg: sel}, {text: c.detail, color: C.mu, bg: sel}], w, sel);
  });
  const nSessions = state.sessions.length;
  const status: Line = [
    seg(' '),
    seg(nSessions ? `${nSessions} running` : 'nothing running', nSessions ? accent(state.sessions[0].app) : C.mu),
    seg(` · ${about?.channel ?? 'release'} ${about?.paperboat ?? ''} · ${tilde(cwd)}`, C.mu),
    seg('   '),
    seg(search ? 'ctrl-r older · enter runs · tab edits · esc cancels' : quitting ? 'ctrl-c again quits' : '? keys · ctrl-c twice quits', quitting || search ? C.fg : C.ln),
  ];

  return (
    <Box flexDirection="column">
      <Static key={generation} items={done}>
        {e => <Lines key={e.key} lines={e.lines} />}
      </Static>
      <Lines lines={live} />
      <Lines lines={prompt} />
      <Lines lines={menuLines.length && !search ? menuLines : [status]} />
    </Box>
  );
}

const indent = (lines: Line[]): Line[] => lines.map(l => [seg('  '), ...l]);

function eventLines(s: State, w: number, right = ''): Line[] {
  const last = s.events.slice(-10);
  return box('runtime events', right, last.length ? last.map(e => [seg(e.event.padEnd(18), C.fg), seg(JSON.stringify({...e, event: undefined}), C.mu)]) : [[seg('waiting for events…', C.mu)]], w);
}

