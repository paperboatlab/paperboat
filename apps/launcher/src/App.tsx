// The Launcher (agent-docs/rebrand/apps/launcher): the bar, the rail (Apps, Stations when an app adds
// them, Toolkits, Runtimes, Console), the pages, Ctrl+K over the whole registry. A view of
// @paperboat/client: every key runs a command line, the CLI's own words.

import {useEffect, useMemo, useState} from 'react';
import {AppMark, Key, Pill, Rail, Search, Segmented, ThemePicker, Toasts, chordMatches, readStored, useTheme, useToasts, writeStored, type RailItem, type SearchItem, type Theme} from '@paperboatlab/ui';
import type {Client} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import {makeAct} from './act.ts';
import {Apps} from './Apps.tsx';
import {Console} from './Console.tsx';
import {Runtimes} from './Runtimes.tsx';
import {Toolkits} from './Toolkits.tsx';

type Page = 'apps' | 'stations' | 'toolkits' | 'runtimes' | 'console';
const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark' || v === 'system';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export function App({client}: {client: Client}) {
  const state = useStore(client, s => s);
  const [theme, setTheme] = useState<Theme>(() => readStored('paperboat.theme', isTheme) ?? 'system');
  useTheme(theme);
  const [wide, setWide] = useState(() => readStored('paperboat.launcher.rail.wide', isBool) ?? false);
  const [page, setPage] = useState<Page>('apps');
  const [search, setSearch] = useState(false);
  const [line, setLine] = useState<string | null>(null);  // a command for the Console to fill in
  const [about, setAbout] = useState<{paperboat: string; channel: string} | null>(null);
  const {toasts, show, dismiss} = useToasts();
  const act = useMemo(() => makeAct(client, show), [client, show]);
  useEffect(() => writeStored('paperboat.theme', theme), [theme]);
  useEffect(() => writeStored('paperboat.launcher.rail.wide', wide), [wide]);

  useEffect(() => {
    void client.refresh({runtimes: true});
    const stop = client.watch();
    const t = setInterval(() => void client.refresh(), 5000);  // sessions end on their own
    return () => (stop(), clearInterval(t));
  }, [client]);
  const loadAbout = () => void client.run('about').then(j => j.state === 'done' && setAbout(j.result as {paperboat: string; channel: string}));
  useEffect(loadAbout, [client]);

  const stations = state.commands.some(c => c.group === 'Stations');
  const base: RailItem[] = [
    {id: 'apps', label: 'Apps', icon: 'a-apps', count: state.sessions.length ? 'live' : undefined},
    ...(stations ? [{id: 'stations', label: 'Stations', icon: 'a-stations'} as RailItem] : []),
    {id: 'toolkits', label: 'Toolkits', icon: 'a-toolkits'},
    {id: 'runtimes', label: 'Runtimes', icon: 'a-runtimes', count: state.instances.length || undefined},
    {id: 'console', label: 'Console', icon: 'a-console'},
  ];
  const pages = base.map((p, i) => ({...p, keys: `Alt+${i + 1}`}));

  // Ctrl+K: every command of the registry. One with nothing to fill in runs; else the Console gets it.
  const items: SearchItem[] = useMemo(
    () => [
      ...pages.map(p => ({id: `go:${p.id}`, label: `Go to ${p.label}`, group: 'Pages', shortcut: p.keys, icon: p.icon, run: () => setPage(p.id as Page)})),
      ...state.commands
        .filter(c => !c.tui)
        .map(
          (c): SearchItem => ({
            id: c.id,
            label: c.name + (c.args ? ` ${c.args}` : ''),
            detail: c.desc,
            group: c.group,
            run: () => {
              if (/</.test(c.args)) {
                setLine(c.name + ' ');
                setPage('console');
              } else void act(c.name, c.desc);
            },
          }),
        ),
    ],
    [state.commands, pages.length, act],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (chordMatches({key: 'k', ctrl: true}, e)) {
        e.preventDefault();
        setSearch(s => !s);
      } else if (e.altKey && /^[1-5]$/.test(e.key) && pages[+e.key - 1]) {
        e.preventDefault();
        setPage(pages[+e.key - 1].id as Page);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [pages]);

  const running = state.instances.filter(l => l.state === 'running' || l.state === 'starting').length;
  return (
    <div className="win">
      <header className="bar">
        <AppMark app="paperboat" size={26} idle label="Paperboat" />
        <span className="wm">Paperboat</span>
        <span className="wt">Launcher</span>
        <span className="bend">
          {page === 'apps' && (
            <>
              <Segmented label="Update channel" value={(about?.channel ?? 'release') as 'release' | 'beta' | 'dev'}
                options={[{value: 'release', label: 'release'}, {value: 'beta', label: 'beta'}, {value: 'dev', label: 'dev'}]}
                onChange={ch => void act(`channel ${ch}`, `Channel ${ch}`, {quiet: true}).then(loadAbout)} />
              {about && <span className="tag">paperboat {about.paperboat}</span>}
              <Key icon="cloud-download" onClick={() => void act('update --check', 'Check for updates')}>Check for updates</Key>
            </>
          )}
          {page === 'runtimes' && <Pill state={running ? 'live' : 'idle'} label={running ? `${running} running` : 'nothing running'} />}
          <ThemePicker theme={theme} onChange={setTheme} />
        </span>
      </header>

      <Rail label="Launcher pages" pages={pages} page={page} onPage={p => setPage(p as Page)} wide={wide} onWide={setWide}
        foot={[{id: 'search', label: 'Commands', icon: 'search', keys: 'Ctrl+K'}]} onFoot={() => setSearch(true)} />

      <main className="pages">
        {page === 'apps' && <Apps client={client} act={act} show={show} />}
        {page === 'stations' && <Console client={client} line={line} onLine={setLine} only="Stations" />}
        {page === 'toolkits' && <Toolkits client={client} act={act} />}
        {page === 'runtimes' && <Runtimes client={client} act={act} />}
        {page === 'console' && <Console client={client} line={line} onLine={setLine} />}
      </main>

      {search && <Search items={items} scopes={['All', 'Pages', ...new Set(state.commands.filter(c => !c.tui).map(c => c.group))]} placeholder="Run a command or go to a page" onClose={() => setSearch(false)} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
