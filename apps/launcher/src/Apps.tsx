// Apps: the registry's apps as cards in their own accent, and the sessions running now.
// Open runs `app open <app> --start --no-open` and shows the app's page in a window of its own.

import {useEffect, useRef, useState} from 'react';
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
  const [channel, setChannel] = useState('');
  useEffect(() => void client.run('channel').then(j => j.state === 'done' && setChannel((j.result as {channel: string}).channel)), [client]);
  const [logs, setLogs] = useState<{id: string; text: string} | null>(null);
  const working = (app: string) => jobs.find(j => j.state === 'running' && j.line.split(' ').includes(app));
  const installed = apps.filter(a => a.installed).length, absent = apps.filter(a => !a.installed && a.available === false).length;

  async function open(a: App) {
    const s = sessions.find(x => x.app === a.name);
    if (s) return bridge().openWindow(s.url, a.label);
    // as a double click on its icon does: the app on its Start page, which asks for the folder or file
    const id = show({title: `Starting ${a.label}`, state: 'working'});
    const job = await client.run(`app open ${a.name} --start --no-open`);
    if (job.state === 'failed') return show({id, title: `${a.label} did not start`, detail: job.error, state: 'failed'});
    const started = job.result as Session;
    show({id, title: `${a.label} started`, detail: started.url, state: 'done'});
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
    <div className="bay"><section className="panel page" aria-label="Apps">
      <div className="phead"><span className="count">{installed} installed · {apps.length - installed - absent} available{absent ? ` · ${absent} not on ${channel}` : ''}</span></div>
      <div className="scroll"><div className="dbody">
        <div className="agrid">
          {apps.map(a => (
            <AppCard key={a.name} a={a} channel={channel} session={sessions.find(s => s.app === a.name)} job={working(a.name)?.output.at(-1) ?? (working(a.name) ? 'working' : undefined)}
              onInstall={() => void act(`app install ${a.name}`, `Installing ${a.label}`)} onFrom={() => void from(a)} onOpen={() => void open(a)}
              onStop={() => void act(`app stop ${a.name}`, `Stopping ${a.label}`)} onUpdate={() => void act(`app update ${a.name}`, `Updating ${a.label}`)}
              onUninstall={() => void act(`app uninstall ${a.name}`, `Removing ${a.label}`)} />
          ))}
        </div>
        <div className="card">
          <div className="chead"><b>Active sessions</b><span className="label">apps running now</span>
            <span className="bend">{sessions.length > 0 && <Key size="sm" kind="quiet" onClick={() => void act('session stop --all', 'Stopping every session')}>Stop all</Key>}</span></div>
          {sessions.length === 0 ? <div className="empty-note">Nothing is running. Open an app to start it.</div> : (
            <table className="t">
              <thead><tr><th>Session</th><th>Folder</th><th>Address</th><th>State</th><th></th></tr></thead>
              <tbody>{sessions.map(s => (
                <tr key={s.id}>
                  <td><div className="owner"><AppMark app={mark(s.app)} size={20} idle /><span><b>{s.id}</b><small>{since(s.started)}</small></span></div></td>
                  <td className="mono">{home(s.project)}</td><td className="mono">{s.url}</td>
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
    </section></div>
  );
}

function AppCard({a, channel, session, job, onInstall, onFrom, onOpen, onStop, onUpdate, onUninstall}: {
  a: App; channel: string; session?: Session; job?: string;
  onInstall: () => void; onFrom: () => void; onOpen: () => void; onStop: () => void; onUpdate: () => void; onUninstall: () => void;
}) {
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  const linked = Boolean(a.installed?.from);
  const absent = !a.installed && a.available === false;  // no release on this channel yet: greyed, a checkout still installs
  const items: MenuEntry[] = [{id: 'from', label: linked ? 'Link another checkout…' : 'Install from a folder…', icon: 'folder-opened', run: onFrom}];
  if (a.installed) items.push('-', {id: 'rm', label: `Uninstall ${a.label} (your projects stay)`, icon: 'trash', run: onUninstall});
  return (
    <article className={`acard app-${a.name}${absent ? ' absent' : ''}`}>
      <div className="ahead">
        <AppMark app={mark(a.name)} size={56} idle={!session} label={a.label} />
        {job ? <Pill state="working" label={job} /> : session ? <Pill state="live" label={`running · :${session.port}`} /> : <Pill state={a.installed ? 'idle' : 'plain'} label={a.installed ? 'installed' : absent ? `not on ${channel || 'this channel'}` : 'available'} />}
      </div>
      <div><b className="an">{a.label}</b><p>{a.description}</p></div>
      <dl className="af">
        <dt>Version</dt><dd>{a.installed ? <span className="mono">{linked ? 'your checkout' : a.installed.version}</span> : absent ? <span className="muted">none on {channel || 'this channel'} yet</span> : <span className="muted">{a.available ? <span className="mono">{a.available}</span> : 'from the newest release'}</span>}</dd>
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
          <Key size="sm" kind="primary" busy={Boolean(job)} disabled={absent} title={absent ? `${a.label} has no release on the ${channel} channel yet` : undefined} onClick={onInstall}>Install</Key>
        )}
        <span className="grow" />
        <span ref={moreRef}><Key size="sm" kind="quiet" round icon="kebab-vertical" label="More" aria-expanded={more} onClick={() => setMore(m => !m)} /></span>
        {more && <Menu label={`${a.label}: more`} items={items} triggerRef={moreRef} onClose={() => setMore(false)} />}
      </div>
    </article>
  );
}
