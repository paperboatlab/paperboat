// Apps: the registry's apps as cards in their own accent, and the sessions running now.
// Open runs `app open <app> <folder> --no-open` and shows the app's page in a window of its own.

import {useRef, useState} from 'react';
import {APPS, AppMark, Dialog, Key, Menu, Pill, Tag, type MenuEntry} from '@paperboatlab/ui';
import type {App, Client, Session} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import type {Act, Show} from './act.ts';
import {bridge} from './bridge.ts';

const mark = (app: string) => ((APPS as readonly string[]).includes(app) ? (app as (typeof APPS)[number]) : 'paperboat');
const home = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, '~');
const since = (t: number) => {
  const m = Math.floor((Date.now() / 1000 - t) / 60);
  return m < 1 ? 'just now' : m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`;
};

export function Apps({client, act, show}: {client: Client; act: Act; show: Show}) {
  const {apps, sessions, jobs} = useStore(client, s => s);
  const [logs, setLogs] = useState<{id: string; text: string} | null>(null);
  const working = (app: string) => jobs.find(j => j.state === 'running' && j.line.split(' ').includes(app));
  const installed = apps.filter(a => a.installed).length;

  async function open(a: App) {
    const s = sessions.find(x => x.app === a.name);
    if (s) return bridge().openWindow(s.url, a.label);
    const folder = await bridge().pickFolder(`Open ${a.label} on a folder`);
    if (!folder) return;
    const job = await client.run(`app open ${a.name} "${folder}" --no-open`);
    if (job.state === 'failed') return show({title: `${a.label} did not start`, detail: job.error, state: 'failed'});
    const started = job.result as Session;
    bridge().openWindow(started.url, a.label);
  }
  async function from(a: App) {
    const folder = await bridge().pickFolder(`A checkout of ${a.label}`);
    if (folder) await act(`app install ${a.name} --from "${folder}"`, `Installing ${a.label} from ${home(folder)}`);
  }
  async function showLogs(id: string) {
    const job = await client.run(`session logs ${id}`);
    if (job.state === 'done') setLogs(job.result as {id: string; text: string});
    else show({title: 'No logs', detail: job.error, state: 'failed'});
  }

  return (
    <section className="panel page" aria-label="Apps">
      <div className="phead"><b>Apps</b><span className="count">{installed} installed · {apps.length - installed} available</span></div>
      <div className="scroll"><div className="dbody">
        <div className="agrid">
          {apps.map(a => (
            <AppCard key={a.name} a={a} session={sessions.find(s => s.app === a.name)} job={working(a.name)?.output.at(-1) ?? (working(a.name) ? 'working' : undefined)}
              onInstall={() => void act(`app install ${a.name}`, `Installing ${a.label}`)} onFrom={() => void from(a)} onOpen={() => void open(a)}
              onStop={() => void act(`app stop ${a.name}`, `Stopping ${a.label}`)} onUpdate={() => void act(`app update ${a.name}`, `Updating ${a.label}`)}
              onUninstall={() => void act(`app uninstall ${a.name}`, `Removing ${a.label}`)} />
          ))}
        </div>
        <div className="card">
          <div className="chead"><b>Active sessions</b><span className="label">apps running now</span>
            <span className="bend">{sessions.length > 0 && <Key size="sm" kind="quiet" onClick={() => void act('session stop --all', 'Stopping every session')}>Stop all</Key>}</span></div>
          {sessions.length === 0 ? <div className="none">Nothing is running. Open an app to start it on a folder.</div> : (
            <table className="t">
              <thead><tr><th>Session</th><th>Folder</th><th>Address</th><th>State</th><th></th></tr></thead>
              <tbody>{sessions.map(s => (
                <tr key={s.id}>
                  <td><div className="owner"><AppMark app={mark(s.app)} size={20} idle /><span><b>{s.id}</b><small>{since(s.started)}</small></span></div></td>
                  <td className="v">{home(s.project)}</td><td className="v">{s.url}</td>
                  <td><span className={`app-${s.app}`}><Pill state="live" label="running" /></span></td>
                  <td><div className="acts">
                    <Key size="sm" onClick={() => bridge().openWindow(s.url, s.app)}>Open</Key>
                    <Key size="sm" kind="quiet" round icon="debug-restart" label="Restart" onClick={() => void act(`session restart ${s.id}`, `Restarting ${s.id}`)} />
                    <Key size="sm" kind="quiet" round icon="output" label="Logs" onClick={() => void showLogs(s.id)} />
                    <Key size="sm" kind="quiet" round icon="debug-stop" label="Stop" onClick={() => void act(`session stop ${s.id}`, `Stopping ${s.id}`)} />
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div></div>
      {logs && (
        <Dialog title={`Logs · ${logs.id}`} tags={['the last 200 lines']} wide onClose={() => setLogs(null)}
          actions={<><Key kind="quiet" onClick={() => void showLogs(logs.id)}>Refresh</Key><Key onClick={() => setLogs(null)}>Close</Key></>}>
          <pre className="screen tall">{logs.text || 'No output yet.'}</pre>
        </Dialog>
      )}
    </section>
  );
}

function AppCard({a, session, job, onInstall, onFrom, onOpen, onStop, onUpdate, onUninstall}: {
  a: App; session?: Session; job?: string;
  onInstall: () => void; onFrom: () => void; onOpen: () => void; onStop: () => void; onUpdate: () => void; onUninstall: () => void;
}) {
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  const linked = Boolean(a.installed?.from);
  const items: MenuEntry[] = [{id: 'from', label: linked ? 'Link another checkout…' : 'Install from a folder…', icon: 'folder-opened', run: onFrom}];
  if (a.installed) items.push('-', {id: 'rm', label: `Uninstall ${a.label} (your projects stay)`, icon: 'trash', run: onUninstall});
  return (
    <article className={`acard app-${a.name}`}>
      <div className="ahead">
        <AppMark app={mark(a.name)} size={56} idle={!session} label={a.label} />
        {job ? <Pill state="working" label={job} /> : session ? <Pill state="live" label={`running · :${session.port}`} /> : <Pill state={a.installed ? 'idle' : 'plain'} label={a.installed ? 'installed' : 'available'} />}
      </div>
      <div><b className="an">{a.label}</b><p>{a.description}</p></div>
      <dl className="af">
        <dt>Version</dt><dd>{a.installed ? <span className="v">{linked ? 'your checkout' : a.installed.version}</span> : <span className="muted">from the newest release</span>}</dd>
        <dt>Runtimes</dt><dd>{a.runtimes.map(r => <Tag key={r}>{r.replace('@', ' ')}</Tag>)}</dd>
      </dl>
      <div className="afoot">
        {a.installed ? (
          <>
            <Key size="sm" kind={session ? undefined : 'primary'} onClick={onOpen}>Open</Key>
            {session && <Key size="sm" kind="quiet" onClick={onStop}>Stop</Key>}
            {!linked && <Key size="sm" onClick={onUpdate}>Update</Key>}
          </>
        ) : (
          <Key size="sm" kind="primary" busy={Boolean(job)} onClick={onInstall}>Install</Key>
        )}
        <span className="grow" />
        <span ref={moreRef}><Key size="sm" kind="quiet" round icon="kebab-vertical" label="More" aria-expanded={more} onClick={() => setMore(m => !m)} /></span>
        {more && <Menu label={`${a.label}: more`} items={items} triggerRef={moreRef} onClose={() => setMore(false)} />}
      </div>
    </article>
  );
}
