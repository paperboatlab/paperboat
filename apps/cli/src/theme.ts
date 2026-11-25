// The terminal's palette: the screen roles, the dark-theme accents and the mark's greys from
// @paperboatlab/ui tokens.css, nothing else (agent-docs/rebrand/apps/cli). Red only for failed.

import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const C = {
  fg: '#f2f2ee', // --text-on-screen
  screen: '#050505', // --surface-screen: the cursor's text
  mu: '#8a8a84', // --text-on-screen-muted
  ln: '#6b6b66', // --night-500: box lines
  selbg: '#2a2a2a', // --night-50: the chosen row's band
  p: '#c9c9ce', // --slate-300: Paperboat
  bad: '#ff5c4d', // --red-dark
  sail: '#f2f2ee', // the mark: big sail
  shade: '#9d9d97', // --grey-500: small sail and hull
};

/** An app's accent (dark theme); the platform's for anything else. */
const ACCENT: Record<string, string> = {simplicial: '#f3b78b', articula: '#abc6ed', julix: '#cdbbf6', malachite: '#99d0ba'};
export const accent = (app?: string) => (app && ACCENT[app]) || C.p;

// The spinner: the blintz turn as Paperboat Glyphs U+E000–E007, 120 ms a frame, one cell drawn two
// wide over the space after it. Where the font can't show, ■ ◩ ◪ ◆ ◈ turns instead.
export const FRAME_MS = 120;
const GLYPHS = [0, 1, 2, 3, 4, 5, 5, 6, 7].map(k => String.fromCharCode(0xe000 + k));
const FALLBACK = ['■', '◩', '◪', '◆', '◈'];

/** Glyphs only where the terminal maps a fallback font and the font is installed; PAPERBOAT_GLYPHS=0|1 decides. */
export function useGlyphs(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PAPERBOAT_GLYPHS) return env.PAPERBOAT_GLYPHS !== '0';
  const term = env.KITTY_WINDOW_ID || env.WT_SESSION || /^(WezTerm|ghostty)$/i.test(env.TERM_PROGRAM ?? '');
  const dirs = [join(homedir(), '.local/share/fonts'), join(homedir(), 'Library/Fonts'), '/usr/share/fonts/paperboat', '/usr/local/share/fonts'];
  return Boolean(term) && dirs.some(d => existsSync(join(d, 'paperboat-glyphs.ttf')));
}

export const spinner = (frame: number, glyphs: boolean) =>
  glyphs ? GLYPHS[frame % GLYPHS.length] : FALLBACK[Math.floor(frame / 3) % FALLBACK.length];
