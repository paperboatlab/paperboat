// `paperboat` on a terminal: the C++ CLI execs `node share/paperboat/cli/main.js` with PAPERBOAT_BIN set.

import {render} from 'ink';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {cliTransport, createClient} from '@paperboat/client';
import {App, type About} from './App.tsx';
import {useGlyphs} from './theme.ts';

const KEEP = 1000;
const client = createClient(cliTransport());
const [about] = await Promise.all([
  cliTransport()
    .call(['about'])
    .then(a => a as About)
    .catch(() => null),
  client.refresh(),
]);

// History between runs: <home>/history, one line each, the newest KEEP (trimmed when it doubles).
const file = about?.home ? join(about.home, 'history') : null;
let history: string[] = [];
try {
  history = file ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  if (file && history.length > 2 * KEEP) writeFileSync(file, (history = history.slice(-KEEP)).join('\n') + '\n');
} catch {}
const keep = (line: string) => {
  try {
    mkdirSync(about!.home!, {recursive: true});
    appendFileSync(file!, line + '\n');
  } catch {}
};

render(<App client={client} about={about} cwd={process.cwd()} glyphs={useGlyphs()} history={history.slice(-KEEP)} onHistory={file ? keep : undefined} />, {exitOnCtrlC: false});
