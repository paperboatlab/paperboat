// Runtimes: only what paperboatd serves (docs/control.md). The catalog and the backends at the left; the
// chosen runtime's instances (stats, logs, interrupt), a project's packages, its image, the events.

import {useEffect, useState} from 'react';
import {AppMark, APPS, Icon, Key, Pill, Spinner, Tabs, Tag} from '@paperboatlab/ui';
import type {Client, Lease, Runtime} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import type {Act} from './act.ts';
import {bridge} from './bridge.ts';

type View = 'running' | 'packages' | 'image' | 'events';
const short: Record<string, string> = {julia: 'jl', python: 'py', omc: 'mo'};
const lang = (name: string) => short[name] ?? name.slice(0, 2);
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
    return <section className="panel page"><div className="phead"><b>Runtimes</b></div>
      <div className="empty">{errors.runtimes ? <span className="bad">{errors.runtimes}</span> : <><Spinner /> asking paperboatd</>}</div></section>;

  return (
    <div className="main">
      <section className="panel" aria-label="Runtimes">
        <div className="phead"><b>Runtimes</b><span className="count">{list.length} in the catalog</span></div>
        <div className="scroll"><div className="klist">
          {list.map(r => {
            const n = instances.filter(l => l.runtime.startsWith(r.name + '@') && alive(l)).length;
            return (
              <div key={r.name} className={`kr${r === rt ? ' on' : ''}`} onClick={() => setPick(r.name)} role="button" tabIndex={0}>
                <span className="lang">{lang(r.name)}</span>
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

      {rt && (
        <section className="panel" aria-label={`${rt.name} ${rt.version}`}>
          <div className="dhead">
            <span className="lang big">{lang(rt.name)}</span>
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
      )}
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
        {live.length === 0 ? <div className="none">None running. An app starts one when it needs it.</div> : (
          <table className="t">
            <thead><tr><th>Held by</th><th>Mode</th><th>State</th><th>CPU</th><th>Memory</th><th>Processes</th><th>Isolation</th><th></th></tr></thead>
            <tbody>{live.map(l => {
              const st = stats[l.id];
              const app = ownerApp(l.owner);
              return (
                <tr key={l.id} className={logs?.id === l.id ? 'sel' : ''}>
                  <td><div className="owner">{(APPS as readonly string[]).includes(app) && <AppMark app={app as (typeof APPS)[number]} size={20} idle />}
                    <span><b>{app || l.owner}</b><small>{home(l.project || '') || l.id} · {Math.floor((l.uptime_s ?? 0) / 60)} m</small></span></div></td>
                  <td className="v">{l.mode === 'session' ? 'kernel' : l.mode}</td>
                  <td><span className={`app-${app}`}><Pill state={l.state === 'running' ? 'live' : l.state === 'starting' ? 'working' : 'idle'} label={l.state} /></span></td>
                  <td className="v">{st ? (st.cpu_percent < 0 ? '–' : `${Math.round(st.cpu_percent)} %`) : '…'}</td>
                  <td className="v">{st ? mb(st.memory_bytes) : '…'}</td><td className="v">{st ? (st.pids < 0 ? '–' : st.pids) : '…'}</td>
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

function Packages({client, act, rt}: {client: Client; act: Act; rt: Runtime}) {
  const [project, setProject] = useState<string | null>(null);
  const [pkgs, setPkgs] = useState<{name: string; version: string}[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const load = (dir: string) => {
    setPkgs(null);
    setError('');
    void client.run(`package list ${rt.name} --project "${dir}"`).then(j =>
      j.state === 'done' ? setPkgs((j.result as {packages: {name: string; version: string}[]}).packages ?? []) : setError(j.error ?? 'failed'));
  };
  const choose = async () => {
    const dir = await bridge().pickFolder('A project folder');
    if (dir) (setProject(dir), load(dir));
  };
  const change = async (op: 'add' | 'remove', pkg: string) => {
    if (!project || !pkg) return;
    const what = `${op === 'add' ? 'Adding' : 'Removing'} ${pkg}`;
    setBusy(what);
    await act(`package ${op} ${rt.name} ${pkg} --project "${project}"`, what);
    setBusy('');
    setName('');
    load(project);
  };
  return (
    <div className="card">
      <div className="chead"><span className="label">Project</span>
        <button className="well sm pick" onClick={() => void choose()}>{project ? home(project) : 'Choose a folder…'}</button>
        <span className="label">its own package volume</span></div>
      {project && (
        <form className="find" onSubmit={e => (e.preventDefault(), void change('add', name.trim()))}>
          <input className="well" placeholder="Package name, or name@version" value={name} onChange={e => setName(e.target.value)} />
          <Key kind="primary" type="submit" disabled={!name.trim() || Boolean(busy)}>Add</Key>
        </form>
      )}
      {busy && <div className="op"><Spinner /><span><span className="what">{busy}</span><small>in a short-lived runtime with network</small></span></div>}
      {!project ? <div className="none">Choose a project to see its packages.</div> : error ? <div className="none bad">{error}</div> : !pkgs ? <div className="none"><Spinner /> reading the packages</div> : (
        <table className="t">
          <thead><tr><th>Package</th><th>Version</th><th></th></tr></thead>
          <tbody>{pkgs.map(p => (
            <tr key={p.name}><td className="v"><b>{p.name}</b></td><td className="v">{p.version}</td>
              <td><div className="acts"><Key size="sm" kind="quiet" round icon="trash" label={`Remove ${p.name}`} onClick={() => void change('remove', p.name)} /></div></td></tr>
          ))}</tbody>
        </table>
      )}
      {pkgs && <div className="cfoot">{pkgs.length} packages · a running kernel loads new ones after a restart</div>}
    </div>
  );
}

function Image({act, rt}: {act: Act; rt: Runtime}) {
  const img = image(rt);
  const limits = (rt.limits ?? {}) as {memory?: string; cpus?: number | string; pids?: number};
  const backends = Object.entries(rt.backends ?? {}).map(([n, b]) => `${n} ${b.ready ? 'ready' : b.usable ? 'usable' : 'no'}`).join(' · ');
  return (
    <>
      <div className="split">
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
      {events.length === 0 ? <div className="none">No events yet.</div> : [...events].reverse().map((e, i) => {
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
