// The Launcher (agent-docs/rebrand/apps/launcher): the bar, the rail (Apps, Stations when an app adds
// them, Toolkits, Runtimes, Hubs when Malachite adds them, Console), the pages, Ctrl+K over the whole registry. A view of
// @paperboat/client: every key runs a command line, the CLI's own words.

import {useEffect, useMemo, useRef, useState} from 'react';
import {About, AppMark, Key, Notifications, Pill, Rail, Search, Segmented, SettingRow, Settings, SettingsSection, ShortcutList, ThemeSetting, Toasts, WindowKeys, chordMatches, readStored, useTheme, useToasts, writeStored, type Command, type RailItem, type Credit, type SearchItem, type Theme} from '@paperboatlab/ui';
import type {Client} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import {makeAct} from './act.ts';
import {Apps} from './Apps.tsx';
import {Console} from './Console.tsx';
import {Hubs} from './Hubs.tsx';
import {Runtimes} from './Runtimes.tsx';
import {Toolkits} from './Toolkits.tsx';
import pkg from '../package.json' with {type: 'json'};

// what the Launcher ships beyond the kit (About lists the kit's after these)
const OWN: Credit[] = [
  ['Electron', 'the window', 'MIT', 'https://www.electronjs.org'],
  ['Chromium', 'the page, inside Electron', 'BSD-3-Clause', 'https://www.chromium.org'],
  ['Node.js', 'running the CLI, inside Electron', 'MIT', 'https://nodejs.org'],
];

// the Launcher's keys, for Settings › Shortcuts (it has no menu bar, so no command registry)
const KEYS = (pages: {label: string; keys?: string}[]): Command[] => [
  {id: 'search', label: 'Commands', menu: 'launcher', group: 'k', shortcut: 'Ctrl K', run: () => {}},
  {id: 'settings', label: 'Settings', menu: 'launcher', group: 'k', shortcut: 'Ctrl ,', run: () => {}},
  ...pages.map(p => ({id: `go:${p.label}`, label: p.label, menu: 'pages', group: 'p', shortcut: p.keys?.replace('+', ' '), run: () => {}})),
];

type Page = 'apps' | 'stations' | 'toolkits' | 'runtimes' | 'hubs' | 'console';
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
  const [about, setAbout] = useState<{paperboat: string; channel: string; daemon: {version: string} | null} | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settings, setSettings] = useState<string | null>(null);  // the page Settings is open on
  const notes = useToasts();
  const {toasts, show, dismiss} = notes;
  const act = useMemo(() => makeAct(client, show), [client, show]);
  useEffect(() => writeStored('paperboat.theme', theme), [theme]);
  useEffect(() => writeStored('paperboat.launcher.rail.wide', wide), [wide]);

  useEffect(() => {
    void client.refresh({runtimes: true});
    const stop = client.watch();
    const t = setInterval(() => void client.refresh(), 5000);  // sessions end on their own
    return () => (stop(), clearInterval(t));
  }, [client]);
  // paperboatd: a failure when it stops answering, the same toast turns done when it answers again
  const daemon = state.errors.runtimes ?? state.errors.instances;
  const daemonNote = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (daemon) daemonNote.current = show({id: daemonNote.current, title: 'paperboatd does not answer', detail: daemon, state: 'failed'});
    else if (daemonNote.current !== undefined) {
      show({id: daemonNote.current, title: 'paperboatd answers again', state: 'done'});
      daemonNote.current = undefined;
    }
  }, [daemon, show]);
  const loadAbout = () => void client.run('about').then(j => j.state === 'done' && setAbout(j.result as typeof about));
  useEffect(loadAbout, [client]);

  const stations = state.commands.some(c => c.group === 'Stations');
  const hubs = state.commands.some(c => c.group === 'Hubs');   // no Malachite, no hub
  const base: RailItem[] = [
    {id: 'apps', label: 'Apps', icon: 'a-apps', count: state.sessions.length ? 'live' : undefined},
    ...(stations ? [{id: 'stations', label: 'Stations', icon: 'a-stations'} as RailItem] : []),
    {id: 'toolkits', label: 'Toolkits', icon: 'a-toolkits'},
    {id: 'runtimes', label: 'Runtimes', icon: 'a-runtimes', count: state.instances.length || undefined},
    ...(hubs ? [{id: 'hubs', label: 'Hubs', icon: 'mark-malachite'} as RailItem] : []),
    {id: 'console', label: 'Console', icon: 'a-console'},
  ];
  const pages = base.map((p, i) => ({...p, keys: `Alt+${i + 1}`}));
  const checkUpdates = () => void act('update --check', 'Check for updates');
  const openAbout = () => (loadAbout(), setAboutOpen(true));

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
      {id: 'about', label: 'About Paperboat', group: 'Paperboat', icon: 'info', run: openAbout},
    ],
    [state.commands, pages.length, act],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (chordMatches({key: 'k', ctrl: true}, e)) {
        e.preventDefault();
        setSearch(s => !s);
      } else if (chordMatches({key: ',', ctrl: true}, e)) {
        e.preventDefault();
        setSettings('general');
      } else if (e.altKey && /^[1-6]$/.test(e.key) && pages[+e.key - 1]) {
        e.preventDefault();
        setPage(pages[+e.key - 1].id as Page);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [pages]);

  const running = state.instances.filter(l => l.state === 'running' || l.state === 'starting').length;
  return (
    <div className="win frame">
      <header className="bar">
        <span className="lk"><AppMark app="paperboat" size={26} idle label="Paperboat" /><span className="wm">Paperboat</span></span>
        <span className="wt">Launcher</span>
        <span className="bend">
          {page === 'apps' && (
            <>
              {about && <span className="tag">paperboat {about.paperboat} · {about.channel}</span>}
              <Key icon="cloud-download" onClick={checkUpdates}>Check for updates</Key>
            </>
          )}
          {page === 'runtimes' && <Pill state={running ? 'live' : 'idle'} label={running ? `${running} running` : 'nothing running'} />}
          <Notifications {...notes} />
          <WindowKeys />
        </span>
      </header>

      <Rail label="Launcher pages" pages={pages} page={page} onPage={p => setPage(p as Page)} wide={wide} onWide={setWide}
        foot={[{id: 'search', label: 'Commands', icon: 'search', keys: 'Ctrl+K'}, {id: 'settings', label: 'Settings', icon: 'a-settings', keys: 'Ctrl+,'}, {id: 'about', label: 'About', icon: 'info'}]}
        onFoot={id => (id === 'about' ? openAbout() : id === 'settings' ? setSettings('general') : setSearch(true))} />

      <main className="pages">
        {page === 'apps' && <Apps client={client} act={act} show={show} />}
        {page === 'stations' && <Console client={client} line={line} onLine={setLine} only="Stations" />}
        {page === 'toolkits' && <Toolkits client={client} act={act} />}
        {page === 'runtimes' && <Runtimes client={client} act={act} />}
        {page === 'hubs' && hubs && <Hubs client={client} act={act} show={show} />}
        {page === 'console' && <Console client={client} line={line} onLine={setLine} />}
      </main>

      {search && <Search items={items} scopes={['All', 'Pages', ...new Set(state.commands.filter(c => !c.tui).map(c => c.group))]} placeholder="Run a command or go to a page" onClose={() => setSearch(false)} />}
      {aboutOpen && (
        <About app="paperboat" role="Apps, runtimes and every command, on your computer" version={about?.paperboat ?? '…'}
          info={about ? `Launcher ${pkg.version} · CLI ${about.paperboat} · paperboatd ${about.daemon?.version ?? 'not running'}` : `Launcher ${pkg.version}`}
          repo="paperboatlab/paperboat" credits={OWN} onCheckUpdates={checkUpdates} onClose={() => setAboutOpen(false)} />
      )}
      {settings && (
        <Settings app="Launcher" page={settings} onClose={() => setSettings(null)} pages={[
          {id: 'general', label: 'General', icon: 'settings-gear', body: <ThemeSetting theme={theme} onTheme={setTheme} />},
          {id: 'launcher', label: 'Launcher', icon: 'mark-paperboat', body: (
            <SettingsSection title="Updates">
              <SettingRow label="Update channel" hint="Release: tested versions. Beta: the next version early. Dev: every change on main">
                <Segmented label="Update channel" value={(about?.channel ?? 'release') as 'release' | 'beta' | 'dev'}
                  options={[{value: 'release', label: 'Release'}, {value: 'beta', label: 'Beta'}, {value: 'dev', label: 'Dev'}]}
                  onChange={ch => void act(`channel ${ch}`, `Channel ${ch}`, {quiet: true}).then(loadAbout)} />
              </SettingRow>
              <SettingRow label="Version" hint={about ? `paperboat ${about.paperboat} · paperboatd ${about.daemon?.version ?? 'not running'}` : undefined}>
                <Key size="sm" icon="cloud-download" onClick={checkUpdates}>Check for updates</Key>
              </SettingRow>
            </SettingsSection>
          )},
          {id: 'shortcuts', label: 'Shortcuts', icon: 'keys', body: <ShortcutList commands={KEYS(pages)} menus={[{id: 'launcher', label: 'Launcher'}, {id: 'pages', label: 'Pages'}]} />},
        ]} />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
