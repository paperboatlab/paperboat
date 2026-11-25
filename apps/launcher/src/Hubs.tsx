// Hubs (paperboat#16; agent-docs/rebrand/apps/hub/launcher.html): the hubs this machine knows, shown once
// Malachite is installed (its commands.toml adds the Hubs group). Every control is one `paperboat hub …`
// command. The Launcher lists and sets up hubs; it never picks one for an app (each app picks its own).

import {useCallback, useEffect, useState} from 'react';
import {Dialog, Icon, Key, Pill, Tabs, Tag} from '@paperboatlab/ui';
import {HubMark, HubSettings, type Hub as KitHub} from '@paperboatlab/ui/hub';
import type {Client, Session} from '@paperboat/client/browser';
import type {Act, Show} from './act.ts';
import {bridge} from './bridge.ts';

/** `hub list --json` */
interface HubInfo {id: string; path: string; shown: string; place: 'local' | 'google-drive'; name: string; missing?: boolean}
/** `hub show --json` */
interface Shown extends HubInfo {author: string; created: string; keep: '90d' | '1y' | 'always'; ignore: string; schema: number; holds: {notes: number; runs: number; models: number; files: number; bytes: number}}
/** `hub history --json` */
interface Version {id: string; time: string; author: string; what: string}
type Ask = {title: string; note?: string; label?: string; value?: string; ok: string; danger?: boolean; run: (v: string) => void};

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
const size = (b: number) => (b < 1e6 ? `${Math.round(b / 1e3)} kB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(1)} GB`);
const when = (t: string) => t.slice(0, 16).replace('T', ' ');
const kit = (h: HubInfo): KitHub => ({id: h.id, name: h.name, place: h.place, path: h.shown, missing: h.missing});
const KEEP = {'90d': '90 days', '1y': '1 year', always: 'always'};

export function Hubs({client, act, show}: {client: Client; act: Act; show: Show}) {
  const [list, setList] = useState<HubInfo[] | null>(null);
  const [pick, setPick] = useState('');
  const [tab, setTab] = useState<'overview' | 'history' | 'settings'>('overview');
  const [shown, setShown] = useState<Shown | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [only, setOnly] = useState('');
  const [cli, setCli] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [rev, setRev] = useState(0);

  const load = useCallback(() => client.run('hub list').then(j => j.state === 'done' && setList(j.result as HubInfo[])), [client]);
  useEffect(() => void load(), [load, rev]);
  const h = list?.find(x => x.id === pick) ?? list?.[0];
  useEffect(() => {
    setShown(null);
    if (!h || h.missing) return;
    void client.run(`hub show ${h.id}`).then(j => j.state === 'done' && setShown(j.result as Shown));
  }, [client, h?.id, h?.missing, rev]);
  useEffect(() => {
    setVersions(null);
    if (!h || h.missing) return;
    void client.run(`hub history ${h.id}${only ? ` ${q(only)}` : ''}`).then(j => setVersions(j.state === 'done' ? (j.result as Version[]) : []));
  }, [client, h?.id, h?.missing, only, rev]);

  const run = async (line: string, title: string) => {
    const j = await act(line, title);
    setRev(r => r + 1);
    return j;
  };
  async function newHub() {
    setAsk({title: 'New hub', label: 'Name', ok: 'Create', note: 'It goes in ~/Documents/paperboat. Each app picks its own hub from its bar.',
      run: n => void run(`hub new ${q(n)}`, `Making ${n}`)});
  }
  async function addHub() {
    const folder = await bridge().pickFolder('A hub folder that is already there');
    if (folder) void run(`hub add ${q(folder)}`, 'Adding a hub');
  }
  async function move(x: HubInfo) {
    const parent = await bridge().pickFolder(x.missing ? `Where is ${x.name} now?` : `Move ${x.name} into…`);
    if (!parent) return;
    void run(`hub move ${x.id} ${q(x.missing ? parent : `${parent}/${x.path.split('/').pop()}`)}`, x.missing ? `Finding ${x.name}` : `Moving ${x.name}`);
  }
  async function openInMalachite(x: HubInfo) {
    const id = show({title: `Opening ${x.name} in Malachite`, detail: x.shown, state: 'working'});
    const j = await client.run(`app open malachite ${q(x.path)} --no-open`);
    if (j.state === 'failed') return show({id, title: `Malachite did not start`, detail: j.error, state: 'failed'});
    show({id, title: `${x.name} is open in Malachite`, state: 'done'});
    bridge().openWindow((j.result as Session).url, 'Malachite');
  }

  return (
    <div className="main">
      <section className="panel" aria-label="Hubs">
        <div className="phead"><b>Hubs</b><span className="count">{list ? `${list.length} known` : ''}</span></div>
        <div className="hub-keys">
          <Key size="sm" kind="primary" icon="add" onClick={newHub}>New hub…</Key>
          <Key size="sm" icon="folder-opened" onClick={addHub}>Add a hub folder…</Key>
        </div>
        <div className="scroll"><div className="klist hub-list">
          {list?.length === 0 && <p className="pad muted">No hubs yet. Make one, or add a folder that is one.</p>}
          {list?.map(x => (
            <div key={x.id} className={`kr${x === h ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => setPick(x.id)} onKeyDown={e => e.key === 'Enter' && setPick(x.id)}>
              <span className="lang">{x.place === 'local' ? <HubMark size={18} /> : <Icon name="cloud" size={18} />}</span>
              <span><b>{x.name}</b><small>{x.place === 'local' ? 'Local' : 'Google Drive'} · {x.shown}</small></span>
              {x.missing ? <Pill state="failed" label="can't find the folder" /> : <span />}
            </div>
          ))}
        </div></div>
      </section>
      {h && (
        <section className="panel" aria-label={h.name}>
          <div className="dhead hub-head">
            <span className="lang big">{h.place === 'local' ? <HubMark size={24} /> : <Icon name="cloud" size={24} />}</span>
            <div><div className="dname">{h.name}</div>
              <div className="dmeta"><Tag>{h.place === 'local' ? 'this computer' : 'Google Drive'}</Tag><Tag>{h.shown}</Tag>{shown && <Tag>hub format {shown.schema}</Tag>}</div></div>
            <span className="bend"><Key icon="link-external" disabled={h.missing} onClick={() => void openInMalachite(h)}>Open in Malachite</Key></span>
          </div>
          <div className="hub-tabs">
            <Tabs label="Hub" value={tab} onChange={setTab} tabs={[{value: 'overview', label: 'Overview'}, {value: 'history', label: 'History', count: versions?.length || undefined}, {value: 'settings', label: 'Settings'}]} />
            <Key size="sm" kind="quiet" icon="a-console" onClick={() => setCli(c => !c)} aria-pressed={cli} title="Show the command behind each control">Commands</Key>
          </div>
          <div className="scroll"><div className="dbody">
            {h.missing && (
              <div className="card"><div className="chead"><b className="bad">Can't find the folder</b></div>
                <p className="pad">{h.shown} was moved or deleted. Point the hub at where it is now, or take it off the list.</p>
                <div className="cfoot"><Key size="sm" onClick={() => void move(h)}>Find it…</Key><Key size="sm" onClick={() => setAsk({title: `Take ${h.name} off the list?`, ok: 'Remove from the list', danger: true, run: () => void run(`hub remove ${h.id}`, `Removing ${h.name}`)})}>Remove from the list</Key>{cli && <code>paperboat hub move {h.id} &lt;folder&gt;</code>}</div></div>
            )}
            {tab === 'overview' && shown && (<>
              <div className="card hub-stats">
                {[[shown.holds.notes, 'notes'], [shown.holds.runs, 'runs'], [shown.holds.models, 'models'], [shown.holds.files, 'files'], [size(shown.holds.bytes), 'on disk']].map(([n, l]) => <div key={l}><b>{n}</b><small>{l}</small></div>)}
              </div>
              <div className="card"><div className="chead"><b>Where it lives</b>{cli && <code className="hub-cmd">paperboat hub show {shown.name}</code>}</div>
                <dl className="facts2"><dt>Folder</dt><dd>{shown.shown}</dd><dt>History</dt><dd>{versions ? `${versions.length} versions` : '…'} · kept {KEEP[shown.keep]}</dd>
                  <dt>Made</dt><dd>{shown.created.slice(0, 10)} by {shown.author}</dd></dl></div>
            </>)}
            {tab === 'history' && !h.missing && (
              <div className="card">
                <div className="chead"><b>Versions</b><span className="label">saved automatically · kept {shown ? KEEP[shown.keep] : ''}</span>
                  <span className="bend"><label className="well" style={{minWidth: 240}}><input placeholder="Only this file or folder…" value={only} onChange={e => setOnly(e.target.value)} aria-label="Only this file or folder" /></label></span></div>
                {versions?.length === 0 && <p className="pad muted">No versions{only ? ` of ${only}` : ''} yet: saved changes become versions.</p>}
                {versions?.map((v, i) => (
                  <div key={v.id} className="hub-ver"><time>{when(v.time)}</time><span>{v.what}<small>{v.author}</small></span>
                    {i > 0 && <Key size="sm" onClick={() => setAsk({title: `Restore ${only || `all of ${h.name}`} as it was ${when(v.time)}?`, note: 'The current version stays in the history; you can come back to it.', ok: 'Restore',
                      run: () => void run(`hub restore ${h.id} ${v.id}${only ? ` ${q(only)}` : ''}`, `Restoring ${only || h.name}`)})}>Restore…</Key>}</div>
                ))}
                {cli && <div className="cfoot"><code>paperboat hub history {h.name}{only ? ` ${only}` : ''}</code></div>}
              </div>
            )}
            {tab === 'settings' && shown && (
              <HubSettings hub={kit(h)} values={{author: shown.author, keep: shown.keep, ignore: shown.ignore}} commands={cli}
                onSet={(k, v) => void run(`hub config ${h.id} ${k} ${q(String(v))}`, `${h.name}: ${k}`)}
                onRename={() => setAsk({title: 'Rename the hub', label: 'Name', value: h.name, ok: 'Rename', note: 'The folder keeps its name; apps show this one.', run: n => void run(`hub rename ${h.id} ${q(n)}`, `Renaming ${h.name}`)})}
                onMove={() => void move(h)}
                onRemove={() => setAsk({title: `Take ${h.name} off the list?`, note: 'Paperboat forgets it; the folder and its files stay. Opening it again adds it back.', ok: 'Remove from the list', danger: true, run: () => void run(`hub remove ${h.id}`, `Removing ${h.name}`)})} />
            )}
          </div></div>
        </section>
      )}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}

function AskDialog({ask, onClose}: {ask: Ask; onClose: () => void}) {
  const [v, setV] = useState(ask.value ?? '');
  const ok = () => { if (ask.label && !v.trim()) return; onClose(); ask.run(v.trim()); };
  return (
    <Dialog title={ask.title} onClose={onClose}
      actions={<><Key kind={ask.danger ? 'danger' : 'primary'} disabled={!!ask.label && !v.trim()} onClick={ok}>{ask.ok}</Key><Key shortcut="Esc" onClick={onClose}>Cancel</Key></>}>
      {ask.note && <p>{ask.note}</p>}
      {ask.label && <label className="well"><input autoFocus aria-label={ask.label} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && ok()} /></label>}
    </Dialog>
  );
}
