// Runtimes: only what paperboatd serves (docs/control.md). The catalog and the backends at the left; the
// chosen runtime's instances (stats, logs, interrupt), a folder's packages, its image, the events.

import {useCallback, useEffect, useRef, useState} from 'react';
import {AppMark, APPS, Icon, Key, Menu, Pill, RuntimeMark, Spinner, Tabs, Tag, type MenuEntry} from '@paperboatlab/ui';
import {PackagePanel, type InstalledPackage, type RegistryItem} from '@paperboatlab/ui/packages';
import type {Client, Lease, Runtime} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import type {Act} from './act.ts';
import {bridge} from './bridge.ts';

type View = 'running' | 'packages' | 'image' | 'events';
const ownerApp = (owner: string) => owner.split(':')[0];
const mb = (b: number) => (b < 0 ? '–' : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const home = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, '~');
const ready = (r: Runtime) => Object.values(r.backends ?? {}).some(b => b.usable && b.ready);
const usable = (r: Runtime) => Object.values(r.backends ?? {}).some(b => b.usable);
const alive = (l: Lease) => l.state !== 'exited' && l.state !== 'failed';

export function Runtimes({client, act}: {client: Client; act: Act}) {
  const {runtimes, instances, events, errors} = useStore(client, s => s);
  const list = runtimes?.runtimes ?? [];
  const [pick, setPick] = useState<string>('');
  const [view, setView] = useState<View>('running');
  const rt = list.find(r => r.name === pick) ?? list[0];
  const leases = rt ? instances.filter(l => l.runtime.startsWith(rt.name + '@')) : [];

  if (!runtimes)
    return <div className="bay"><section className="panel page" aria-label="Runtimes">
      <div className="empty-state">{errors.runtimes ? <span className="bad">{errors.runtimes}</span> : <span><Spinner /> asking paperboatd</span>}</div></section></div>;

  return (
    <div className="main">
      <section className="panel" aria-label="Runtimes">
        <div className="phead"><b>Catalog</b><span className="count">{list.length}</span></div>
        <div className="scroll"><div className="klist">
          {list.map(r => {
            const n = instances.filter(l => l.runtime.startsWith(r.name + '@') && alive(l)).length;
            return (
              <div key={r.name} className={`kr${r === rt ? ' on' : ''}`} onClick={() => setPick(r.name)} role="button" tabIndex={0}>
                <span className="lang"><RuntimeMark lang={r.name} /></span>
                <span><b>{r.name}</b><small>{r.version} · {ready(r) ? 'ready' : usable(r) ? 'not pulled' : 'no backend'}</small></span>
                {n ? <Pill state="live" label={`${n} running`} /> : !ready(r) && usable(r) ? <Key size="sm" onClick={e => (e.stopPropagation(), void act(`runtime pull ${r.name}`, `Pulling ${r.name}`))}>Pull</Key> : <span />}
              </div>
            );
          })}
        </div></div>
        <div className="backends">
          <div className="label">Where runtimes run</div>
          {runtimes.backends.map(b => (
            <div className="be" key={b.name}><Icon name={b.available ? 'check' : 'circle-slash'} className={b.available ? '' : 'no'} />
              <span>{b.name}</span><small>{b.available ? [b.detail, b.rootless && 'rootless', b.selinux && 'SELinux'].filter(Boolean).join(' · ') : 'not installed'}</small></div>
          ))}
        </div>
      </section>

      <div className="bay">{rt && (
        <section className="panel" aria-label={`${rt.name} ${rt.version}`}>
          <div className="dhead">
            <span className="lang big"><RuntimeMark lang={rt.name} /></span>
            <div><div className="dname">{rt.name}<small>{rt.version}</small></div>
              <div className="dmeta"><Tag>{rt.modes.join(' · ')}</Tag>{image(rt).digest && <Tag>pinned {image(rt).digest.slice(0, 15)}…{image(rt).digest.slice(-4)}</Tag>}
                <Tag>{image(rt).signer ? 'signed' : 'unsigned upstream image'}</Tag></div></div>
            <span className="bend">{usable(rt) && <Key onClick={() => void act(`runtime pull ${rt.name}`, `Pulling ${rt.name}`)}>{ready(rt) ? 'Pull again' : 'Pull'}</Key>}</span>
          </div>
          <Tabs label="Runtime" value={view} onChange={setView}
            tabs={[{value: 'running', label: 'Running', count: leases.filter(alive).length}, {value: 'packages', label: 'Packages'}, {value: 'image', label: 'Image'}, {value: 'events', label: 'Events'}]} />
          <div className="scroll"><div className="dbody">
            {view === 'running' && <Running client={client} act={act} leases={leases} />}
            {view === 'packages' && <Packages client={client} act={act} rt={rt} />}
            {view === 'image' && <Image act={act} rt={rt} />}
            {view === 'events' && <Events events={events} />}
          </div></div>
        </section>
      )}</div>
    </div>
  );
}

const image = (rt: Runtime) => (rt.image ?? {}) as {ref?: string; digest: string; signer?: string};

function Running({client, act, leases}: {client: Client; act: Act; leases: Lease[]}) {
  const [stats, setStats] = useState<Record<string, {cpu_percent: number; memory_bytes: number; pids: number}>>({});
  const [logs, setLogs] = useState<{id: string; text: string} | null>(null);
  const live = leases.filter(alive);
  const ids = live.map(l => l.id).join(' ');
  useEffect(() => {
    if (!ids) return;
    const poll = () =>
      ids.split(' ').forEach(id => void client.run(`runtime stats ${id}`).then(j => j.state === 'done' && setStats(s => ({...s, [id]: (j.result as {stats: typeof s[string]}).stats}))));
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [ids, client]);
  const showLogs = (id: string) => void client.run(`runtime logs ${id}`).then(j => j.state === 'done' && setLogs({id, text: (j.result as {text: string}).text}));

  return (
    <>
      <div className="card">
        <div className="chead"><b>Running now</b><span className="label">instances of this runtime</span></div>
        {live.length === 0 ? <div className="empty-note">None running. An app starts one when it needs it.</div> : (
          <table className="t">
            <thead><tr><th>Held by</th><th>Mode</th><th>State</th><th>CPU</th><th>Memory</th><th>Processes</th><th>Isolation</th><th></th></tr></thead>
            <tbody>{live.map(l => {
              const st = stats[l.id];
              const app = ownerApp(l.owner);
              return (
                <tr key={l.id} className={logs?.id === l.id ? 'sel' : ''}>
                  <td><div className="owner">{(APPS as readonly string[]).includes(app) && <AppMark app={app as (typeof APPS)[number]} size={20} idle />}
                    <span><b>{app || l.owner}</b><small>{home(l.project || '') || l.id} · {Math.floor((l.uptime_s ?? 0) / 60)} m</small></span></div></td>
                  <td className="mono">{l.mode === 'session' ? 'kernel' : l.mode}</td>
                  <td><span className={`app-${app}`}><Pill state={l.state === 'running' ? 'live' : l.state === 'starting' ? 'working' : 'idle'} label={l.state} /></span></td>
                  <td className="mono">{st ? (st.cpu_percent < 0 ? '–' : `${Math.round(st.cpu_percent)} %`) : '…'}</td>
                  <td className="mono">{st ? mb(st.memory_bytes) : '…'}</td><td className="mono">{st ? (st.pids < 0 ? '–' : st.pids) : '…'}</td>
                  <td>{(l.weakened as string[] | undefined)?.length ? <Tag ask title="Approved by you">{'+ ' + (l.weakened as string[]).join(', ')}</Tag> : <Tag>{l.backend === 'native' ? 'native' : 'sandboxed'}</Tag>}</td>
                  <td><div className="acts">
                    {l.mode === 'session' && <Key size="sm" round icon="debug-pause" label="Interrupt the kernel (SIGINT)" onClick={() => void act(`runtime interrupt ${l.id}`, `Interrupting ${l.id}`)} />}
                    <Key size="sm" kind="quiet" round icon="output" label="Logs" onClick={() => showLogs(l.id)} />
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {logs && (
        <div className="card">
          <div className="chead"><b>Logs</b><span className="label">{logs.id} · the last 200 lines</span>
            <span className="bend"><Key size="sm" kind="quiet" onClick={() => showLogs(logs.id)}>Refresh</Key><Key size="sm" kind="quiet" onClick={() => setLogs(null)}>Close</Key></span></div>
          <div className="pad"><pre className="screen">{logs.text || 'No output yet.'}</pre></div>
        </div>
      )}
    </>
  );
}

// The kit's PackagePanel: environment = `package list`, add = `package add`, remove = `package remove`; an add
// downloads and precompiles (minutes, at times): `act`'s toast turns into its end, so the view can change meanwhile.
// Julia's registry is General through the CLI (`package search|info julia`, cached a day; Julix sends its users
// here); the others add by name. A shelf to start from before a search.
const REGISTRY: Record<string, {title: string; source?: string; search?: boolean; shelf: RegistryItem[]}> = {
  python: {title: 'PyPI', source: 'pypi.org', shelf: []},
  omc: {title: 'OpenModelica index', shelf: []},
  julia: {title: 'General', source: 'github.com/JuliaRegistries', search: true, shelf: [
    {name: 'Plots', note: 'plots through backends (shown as images)'}, {name: 'CairoMakie', note: 'Makie, drawn with Cairo (shown as images)'},
    {name: 'DataFrames', note: 'tables'}, {name: 'CSV', note: 'read and write CSV'}, {name: 'Optim', note: 'optimisation'},
    {name: 'DifferentialEquations', note: 'ODEs, SDEs, DAEs'}, {name: 'ControlSystems', note: 'LTI systems, Bode, step'},
  ]},
};
/** `package info julia <name> --json` */
interface Info {name: string; uuid: string; url: string; latest: string; versions: string[]; version_count: number; description: string; stars: number | null; topics: string[]}
type Folder = {dir: string; label: string; meta?: string};
const NONE = {title: 'registry', shelf: [] as RegistryItem[], source: undefined, search: false};

// Packages are per folder (each its own package volume): the hubs (Malachite's `hub list`, absent without it), the
// folders of running sessions and instances, those that have packages already; or any other.
function useFolders(client: Client, runtime: string, rev: number) {
  const {sessions, instances, commands} = useStore(client, s => s);
  const malachite = commands.some(c => c.id === 'hub.list');
  const [hubs, setHubs] = useState<Folder[]>([]);
  const [had, setHad] = useState<Folder[]>([]);
  useEffect(() => {
    if (malachite) void client.run('hub list').then(j => j.state === 'done' &&
      setHubs((j.result as {name: string; path: string; missing?: boolean}[]).filter(h => !h.missing).map(h => ({dir: h.path, label: h.name, meta: home(h.path)}))));
    void client.run(`package folders ${runtime}`).then(j => j.state === 'done' && setHad((j.result as {project: string}[]).map(v => ({dir: v.project, label: home(v.project)}))));
  }, [client, runtime, rev, malachite]);
  const running = [...sessions.map(s => [s.app, s.project]), ...instances.filter(alive).map(l => [ownerApp(l.owner), l.project ?? ''])].filter(([, d]) => d);
  const julix = running.find(([app]) => app === 'julix')?.[1];
  const seen = new Set<string>();
  const once = (fs: Folder[]) => fs.filter(f => !seen.has(f.dir) && seen.add(f.dir));
  const groups: [string, Folder[]][] = [['Hubs', once(hubs)], ['Running', once(running.map(([app, dir]) => ({dir, label: home(dir), meta: app})))], ['With packages', once(had)]];
  return {groups, julix, name: (dir: string) => hubs.find(h => h.dir === dir)?.label ?? home(dir)};
}

function Packages({client, act, rt}: {client: Client; act: Act; rt: Runtime}) {
  const [project, setProject] = useState<string | null>(null);
  const [pkgs, setPkgs] = useState<InstalledPackage[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [output, setOutput] = useState('');
  const [menu, setMenu] = useState(false);
  const [offline, setOffline] = useState('');
  const [rev, setRev] = useState(0);
  const pickRef = useRef<HTMLSpanElement>(null);
  const folders = useFolders(client, rt.name, rev);
  const reg = REGISTRY[rt.name] ?? NONE;
  const load = (dir: string) => {
    setPkgs(null);
    setError('');
    void client.run(`package list ${rt.name} --project "${dir}"`).then(j =>
      j.state === 'done' ? setPkgs((j.result as {packages: InstalledPackage[]}).packages ?? []) : setError(j.error ?? 'failed'));
  };
  const open = (dir: string) => (setProject(dir), setOutput(''), load(dir));
  // a running Julix session's folder to begin with
  useEffect(() => void (!project && folders.julix && open(folders.julix)), [folders.julix]);
  const choose = async () => {
    const dir = await bridge().pickFolder('A folder for packages');
    if (dir) open(dir);
  };
  const change = async (op: 'add' | 'remove', pkg: string) => {
    if (!project) return;
    const what = `${op === 'add' ? 'adding' : 'removing'} ${pkg}`;
    setBusy(what);
    const job = await act(`package ${op} ${rt.name} ${pkg} --project "${project}"`, `${op === 'add' ? 'Adding' : 'Removing'} ${pkg}`);
    setOutput([...job.output, String(job.result ?? job.error ?? '')].join('\n').trim());
    setBusy('');
    load(project);
    setRev(r => r + 1);  // a first add makes the folder's volume
  };
  // General's names (a name@version adds as typed); the others: the typed name, then the shelf's matches. Kept
  // across renders: the panel searches again when it changes, and a search's job re-renders this.
  const search = useCallback(async (q: string) => {
    const typed = (q: string, note = `paperboat package add ${rt.name} ${q}`) => ({name: q, latest: q.split('@')[1] ?? 'newest', note});
    if (reg.search && /^[\w.+-]+$/.test(q)) {
      const j = await client.run(`package search ${rt.name} ${q}`);
      if (j.state === 'done') {
        const r = j.result as {total: number; results: {name: string}[]; stale: boolean};
        setOffline(r.stale ? 'offline: the last copy of General' : '');
        return {results: r.results, total: r.total};
      }
      setOffline((j.error ?? 'offline').split(' (')[0]);
      return {results: [typed(q, 'offline: this adds it by name')], total: 1};
    }
    const results = [typed(q), ...reg.shelf.filter(i => i.name !== q && `${i.name} ${i.note}`.toLowerCase().includes(q.toLowerCase()))];
    return {results, total: results.length};
  }, [client, rt.name, reg]);
  const detail = async (name: string) => {
    const j = await client.run(`package info ${rt.name} ${name}`);
    if (j.state !== 'done') throw new Error(j.error ?? 'failed');
    const p = j.result as Info;
    return {name: p.name, latest: p.latest, description: p.description, repo: p.url, versions: p.versions, id: p.uuid,
      facts: [p.stars !== null ? `${p.stars} stars` : '', `${p.version_count} versions`, p.topics.length ? `topics: ${p.topics.join(', ')}` : ''].filter(Boolean)};
  };
  const items: MenuEntry[] = folders.groups.flatMap(([group, fs]): MenuEntry[] => fs.length
    ? [{group}, ...fs.map(f => ({id: f.dir, label: f.label, meta: f.meta, checked: f.dir === project, run: () => open(f.dir)}))] : []);
  items.push(...(items.length ? ['-' as const] : []), {id: 'other', label: 'Other folder…', icon: 'folder-opened', run: () => void choose()});
  return (
    <div className="card">
      <div className="chead"><span className="label">Folder</span>
        <span className="folder" ref={pickRef}>
          <button className="well sm pick" aria-expanded={menu} onClick={() => setMenu(m => !m)}>{project ? folders.name(project) : 'Choose a folder…'}<Icon name="chevron-down" /></button>
          {menu && <Menu label="Folders" items={items} triggerRef={pickRef} onClose={() => setMenu(false)} />}
        </span>
        <span className="label">the folder you open in Julix, or a hub; each has its own packages</span></div>
      {!project ? <p className="empty-note">Choose a folder to see its packages.</p> : (
        <PackagePanel runtime={null} busy={busy} error={error} output={output} loading={error ? undefined : 'reading the packages'}
          environment={pkgs && {title: 'environment', path: home(project), tags: ['an add reaches the network, for that step only'], packages: pkgs, empty: 'No packages in this folder yet. Add one from the registry.',
            actions: [{label: 'Reload', run: () => load(project)}], remove: name => void change('remove', name)}}
          registry={{title: reg.title, source: offline || reg.source, items: reg.shelf, search, detail: reg.search ? detail : undefined, add: name => void change('add', name),
            itemsLabel: reg.search ? 'to start with; or search General, or type name@version' : 'type a name, or name@version'}} />
      )}
      {pkgs && <div className="cfoot">a running kernel loads new ones after a restart</div>}
    </div>
  );
}

function Image({act, rt}: {act: Act; rt: Runtime}) {
  const img = image(rt);
  const limits = (rt.limits ?? {}) as {memory?: string; cpus?: number | string; pids?: number};
  const backends = Object.entries(rt.backends ?? {}).map(([n, b]) => `${n} ${b.ready ? 'ready' : b.usable ? 'usable' : 'no'}`).join(' · ');
  return (
    <>
      <div className="pair">
        <div className="card"><div className="chead"><b>Image</b></div>
          <dl className="facts2">
            <dt>Reference</dt><dd>{img.ref ?? '–'}</dd><dt>Runs</dt><dd title={img.digest}>{img.digest || 'unpinned'}</dd>
            <dt>Signature</dt><dd>{img.signer ? `signed by ${img.signer}` : 'unsigned (upstream image, pinned by digest)'}</dd>
            <dt>Protocol</dt><dd>{String(rt.protocol ?? '')}</dd><dt>Modes</dt><dd>{rt.modes.join(' · ')}</dd>
            <dt>Limits</dt><dd>{[limits.memory, limits.cpus && `${limits.cpus} CPUs`, limits.pids && `${limits.pids} processes`].filter(Boolean).join(' · ') || '–'}</dd>
            <dt>Backends</dt><dd>{backends}</dd>
          </dl></div>
        <div className="card"><div className="chead"><b>Isolation</b><span className="label">what every runtime gets</span></div>
          <div className="checks">
            {[['No network', '--network=none'], ['Read-only system, scratch in memory', '--read-only'], ['No capabilities, no new privileges', '--cap-drop=all'],
              ['Runs as you, not root', 'rootless'], ['Project read-only; packages in their own volume', '/work/project:ro']].map(([t, c]) => (
              <div key={c}><Icon name="check" />{t}<code>{c}</code></div>))}
            <div className="muted"><Icon name="shield" />More only when an app asks and you approve<code>network · devices · gpu</code></div>
          </div></div>
      </div>
      <div className="card"><div className="chead"><b>Package volumes</b><span className="label">of projects that no longer exist</span>
        <span className="bend"><Key size="sm" onClick={() => void act('runtime prune', 'Removing unused package volumes')}>Remove unused</Key></span></div></div>
    </>
  );
}

const EVENT: Record<string, [string, 'play' | 'debug-stop' | 'cloud-download' | 'error' | 'trash' | 'shield' | 'check']> = {
  'runtime.started': ['Started', 'play'], 'runtime.stopped': ['Stopped', 'debug-stop'], 'runtime.exited': ['Ended', 'debug-stop'],
  'runtime.failed': ['Failed to start', 'error'], 'runtime.pulling': ['Pulling', 'cloud-download'], 'runtime.pulled': ['Pulled', 'cloud-download'],
  'runtime.pull_failed': ['Pull failed', 'error'], 'runtime.reaped': ['Cleaned up', 'trash'], 'policy.weakened': ['Allowed', 'shield'],
  'runtime.verified': ['Verified', 'check'], 'runtime.unverified': ['Not verified', 'shield'], 'lease.acquired': ['Acquired', 'play'], 'lease.released': ['Released', 'debug-stop'],
};

function Events({events}: {events: {event: string; [k: string]: unknown}[]}) {
  return (
    <div className="card"><div className="chead"><b>Events</b><span className="label">since the Launcher opened</span></div>
      {events.length === 0 ? <div className="empty-note">No events yet.</div> : [...events].reverse().map((e, i) => {
        const [word, icon] = EVENT[e.event] ?? [e.event, 'check'];
        const bad = e.event.includes('fail') || (e.event === 'runtime.exited' && Number(e.exit_code) !== 0);
        return (
          <div key={i} className={`ev${bad ? ' bad' : ''}`}>
            <Icon name={icon} />
            <span><b>{word}{e.event === 'runtime.exited' ? ` with ${String(e.exit_code)}` : ''}</b> {String(e.runtime ?? '')} <small>{String(e.owner ?? e.what ?? e.reason ?? e.error ?? '')}</small></span>
            <small>{String(e.lease ?? e.backend ?? '')}</small>
          </div>
        );
      })}
    </div>
  );
}
