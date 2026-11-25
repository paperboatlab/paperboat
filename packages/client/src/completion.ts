// Completion, the grey suggestion, history and line editing: pure functions over the registry.
// Cherry-picked from paperboat-legacy apps/cli/src/model.ts; commands are now several words
// (`app install`) and argument values come from what each command's usage names (`<app>`).

import type {Command} from './types.ts';

export interface Candidate {
  value: string;
  detail: string;
  /** Matched character positions in `value`, for highlighting. */
  match: number[];
}

export interface Choice {
  value: string;
  detail: string;
}

/** Values by argument name (`app` → the apps and their state); `folder` by `listDir`. */
export interface Sources {
  commands: Command[];
  args: Record<string, Choice[]>;
  /** Entries of a folder, names only, folders ending in `/`. */
  listDir?: (dir: string) => Choice[];
}

/** Score `query` against `text`: prefix beats substring beats subsequence; null when absent. */
export function fuzzy(query: string, text: string): {score: number; match: number[]} | null {
  if (!query) return {score: 0, match: []};
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return {score: at === 0 ? 100 - text.length / 100 : 50, match: [...q].map((_, k) => at + k)};
  const match: number[] = [];
  for (let i = 0, j = 0; i < t.length && j < q.length; i++)
    if (t[i] === q[j]) {
      match.push(i);
      j++;
    }
  return match.length === q.length ? {score: 10 - match[match.length - 1] / 100, match} : null;
}

/** Split a command line into words; quotes group. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = '';
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) words.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (cur || has) words.push(cur);
  return words;
}

/** The command the words start with (longest name or alias, as the CLI parses) and how many words it took. */
export function findCommand(commands: Command[], words: string[]): {cmd: Command; used: number} | null {
  let best: {cmd: Command; used: number} | null = null;
  for (const cmd of commands)
    for (const name of [cmd.name, ...cmd.alias]) {
      const n = name.split(' ');
      if (n.length <= words.length && n.length > (best?.used ?? 0) && n.every((w, i) => w === words[i])) best = {cmd, used: n.length};
    }
  return best;
}

/** A usage's positional argument names and flags: `<app> [<folder>] [--no-open]` → app, folder; --no-open. */
export function usage(args: string): {positional: string[]; flags: string[]} {
  const positional: string[] = [];
  const flags: string[] = [];
  const tokens = args.split('|')[0].split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^\[|\]$/g, '');
    if (t.startsWith('--')) {
      flags.push(t);
      if (tokens[i + 1]?.startsWith('<')) i++;  // the flag's value
    } else {
      const m = /^<([\w-]+)>/.exec(t);
      if (m) positional.push(m[1]);
    }
  }
  for (const m of args.matchAll(/--[\w-]+/g)) if (!flags.includes(m[0])) flags.push(m[0]);
  return {positional, flags};
}

const rank = (pool: Choice[], word: string): Candidate[] =>
  pool
    .map(p => ({p, m: fuzzy(word, p.value)}))
    .flatMap(({p, m}) => (m ? [{...p, score: m.score, match: m.match}] : []))
    .sort((a, b) => b.score - a.score)
    .map(({value, detail, match}) => ({value, detail, match}));

/** Completions at the line's end: `from` is where the replaced text starts. */
export function complete(line: string, sources: Sources): {candidates: Candidate[]; from: number; word: string} {
  const words = splitWords(line);
  const open = line === '' || /\s$/.test(line);  // the cursor starts a new word
  const done = open ? words : words.slice(0, -1);
  const word = open ? '' : words[words.length - 1];
  const from = line.length - word.length;
  const found = findCommand(sources.commands, done);
  if (!found) {
    // still naming the command: match the whole line against every name
    const pool = sources.commands.flatMap(c => [
      {value: c.name, detail: c.desc},
      ...c.alias.map(a => ({value: a, detail: `same as ${c.name}`})),
    ]);
    const typed = line.trimStart();
    return {candidates: rank(pool, typed), from: line.length - typed.length, word: typed};
  }
  const {positional, flags} = usage(found.cmd.args);
  if (word.startsWith('-')) return {candidates: rank([...flags, '--json'].map(f => ({value: f, detail: ''})), word), from, word};
  const index = done.slice(found.used).filter(w => !w.startsWith('-')).length;
  const kind = positional[index];
  if (!kind) return {candidates: [], from, word};
  if (kind === 'folder' && sources.listDir) {
    const cut = word.lastIndexOf('/') + 1;
    const dir = word.slice(0, cut);
    const rest = word.slice(cut);
    return {
      candidates: sources
        .listDir(dir || '.')
        .filter(p => p.value.toLowerCase().startsWith(rest.toLowerCase()))
        .sort((a, b) => a.value.localeCompare(b.value))
        .map(p => ({value: dir + p.value, detail: p.detail, match: [...rest].map((_, k) => dir.length + k)})),
      from,
      word,
    };
  }
  return {candidates: rank(sources.args[kind] ?? [], word), from, word};
}

/** The grey suggestion: the newest history line that extends the input, else the top completion's rest. */
export function ghost(input: string, history: string[], sources: Sources): string {
  if (!input) return '';
  for (let i = history.length - 1; i >= 0; i--)
    if (history[i].startsWith(input) && history[i].length > input.length) return history[i].slice(input.length);
  const {candidates, word} = complete(input, sources);
  const top = candidates[0];
  return word && top && top.value.startsWith(word) ? top.value.slice(word.length) : '';
}

/** History lines containing `query`, newest first, without repeats. */
export function searchHistory(history: string[], query: string): string[] {
  return [...new Set([...history].reverse())].filter(h => h.includes(query));
}

/** Append a line to history: skip blanks and an immediate repeat, keep the newest `max`. */
export function remember(history: string[], line: string, max = 1000): string[] {
  const l = line.trim();
  if (!l || history[history.length - 1] === l) return history;
  return [...history, l].slice(-max);
}

export interface Line {
  text: string;
  cursor: number;
}

export interface EditKey {
  input: string;
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
  left?: boolean;
  right?: boolean;
  home?: boolean;
  end?: boolean;
}

/** One editing key on the input line; null when the key isn't an edit. */
export function edit(line: Line, key: EditKey): Line | null {
  const {text, cursor} = line;
  if (key.ctrl) {
    switch (key.input) {
      case 'a':
        return {text, cursor: 0};
      case 'e':
        return {text, cursor: text.length};
      case 'u':
        return {text: text.slice(cursor), cursor: 0};
      case 'k':
        return {text: text.slice(0, cursor), cursor};
      case 'w': {
        const start = text.slice(0, cursor).replace(/\S+\s*$/, '').length;
        return {text: text.slice(0, start) + text.slice(cursor), cursor: start};
      }
      default:
        return null;
    }
  }
  // Terminals send DEL for Backspace; Ink reports it as delete.
  if (key.backspace || key.delete) return cursor ? {text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1} : line;
  if (key.left) return {text, cursor: Math.max(0, cursor - 1)};
  if (key.right) return {text, cursor: Math.min(text.length, cursor + 1)};
  if (key.home) return {text, cursor: 0};
  if (key.end) return {text, cursor: text.length};
  // Typed or pasted text; a paste's newlines and tabs become spaces, other controls go.
  const typed = key.input.replace(/[\t\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  return typed ? {text: text.slice(0, cursor) + typed + text.slice(cursor), cursor: cursor + typed.length} : null;
}
