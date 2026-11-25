// The Paperboat sailboat on a 14 × 10 pixel grid, two pixels a cell in half blocks: the big sail
// lightest, the small sail and hull darker.

import {C} from './theme.ts';
import type {Line} from './grid.ts';

const MARK = [
  '.......S......',
  '......SS......',
  '.....SSSh.....',
  '....SSSShh....',
  '...SSSSShhh...',
  '..SSSSSShhhh..',
  '..............',
  'hhhhhhhhhhhhhh',
  '.hhhhhhhhhhhh.',
  '..hhhhhhhhhh..',
];
const tone = (p: string) => (p === 'S' ? C.sail : p === 'h' ? C.shade : undefined);

export function markLines(): Line[] {
  const out: Line[] = [];
  for (let y = 0; y < MARK.length; y += 2) {
    const l: Line = [];
    for (let x = 0; x < 14; x++) {
      const t = tone(MARK[y][x]);
      const b = tone(MARK[y + 1][x]);
      if (t && b) l.push({text: '▀', color: t, bg: b});
      else if (t) l.push({text: '▀', color: t});
      else if (b) l.push({text: '▄', color: b});
      else l.push({text: ' '});
    }
    out.push(l);
  }
  return out;
}
