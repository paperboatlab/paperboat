// `paperboat` on a terminal: the C++ CLI execs `node share/paperboat/cli/main.js` with PAPERBOAT_BIN set.

import {render} from 'ink';
import {cliTransport, createClient} from '@paperboat/client';
import {App, type About} from './App.tsx';
import {useGlyphs} from './theme.ts';

const client = createClient(cliTransport());
const [about] = await Promise.all([
  cliTransport()
    .call(['about'])
    .then(a => a as About)
    .catch(() => null),
  client.refresh(),
]);
render(<App client={client} about={about} cwd={process.cwd()} glyphs={useGlyphs()} />, {exitOnCtrlC: false});
