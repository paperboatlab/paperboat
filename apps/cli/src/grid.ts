// Lines as segments on a character grid, as the mockup draws them: pad, cut with "…", boxes.

export interface Seg {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
}
export type Line = Seg[];

import {C} from './theme.ts';

export const seg = (text: string, color?: string, bold?: boolean): Seg => ({text, color, bold});
export const width = (l: Line) => l.reduce((n, s) => n + [...s.text].length, 0);
export const plain = (l: Line) => l.map(s => s.text).join('');

/** Pad to w, or cut and end in "…". */
export function fit(l: Line, w: number, bg?: string): Line {
  const out: Line = [];
  let n = 0;
  const over = width(l) > w;
  for (const s of l) {
    if (n >= w) break;
    let t = [...s.text].slice(0, w - n).join('');
    const len = [...t].length;
    if (over && n + len === w && t.trim()) t = [...t].slice(0, -1).join('') + '…';
    out.push({...s, text: t, bg: bg ?? s.bg});
    n += len;
  }
  if (n < w) out.push({text: ' '.repeat(w - n), bg});
  return out;
}

/** A column: the text padded or cut to w. */
export const col = (t: string, w: number, color?: string, bold?: boolean): Seg[] => fit([seg(String(t), color, bold)], w);

/** A box w wide: a title, a note on the right, the rows inside. */
export function box(title: string, right: string, rows: Line[], w: number): Line[] {
  const head: Line = title ? [seg('┌ ', C.ln), seg(title, C.fg, true), seg(' ')] : [seg('┌', C.ln)];
  const tail: Line = right ? [seg(` ${right} `, C.mu), seg('┐', C.ln)] : [seg('┐', C.ln)];
  return [
    [...head, seg('─'.repeat(Math.max(1, w - width(head) - width(tail))), C.ln), ...tail],
    ...rows.map(r => [seg('│ ', C.ln), ...fit(r, w - 4), seg(' │', C.ln)]),
    [seg('└' + '─'.repeat(w - 2) + '┘', C.ln)],
  ];
}

/** Rows of cells as a table: each column as wide as its widest cell (up to its cap). */
export function table(rows: Line[][], caps: number[]): Line[] {
  const w = caps.map((cap, i) => Math.min(cap, Math.max(0, ...rows.map(r => (r[i] ? width(r[i]) : 0)))));
  return rows.map(r => r.flatMap((cell, i) => (i < r.length - 1 ? [...fit(cell, w[i]), seg('  ')] : cell)));
}
