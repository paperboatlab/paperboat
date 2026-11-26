// Stations: the station projects Simplicial can run (its commands.toml adds the Stations group), from
// `station list`: built-in, examples, installed. Every key is one of its commands (run, check, build, pack).

import {useCallback, useEffect, useState} from 'react';
import {Dialog, Key, Pill, Segmented, Tag} from '@paperboatlab/ui';
import type {Client} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import type {Act} from './act.ts';
import {bridge} from './bridge.ts';

/** `station list --json` */
interface Station {name: string; description: string; dir: string; language: string; port: number; source: 'builtin' | 'example' | 'installed'}
type Lang = 'cpp' | 'python' | 'julia';

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
const home = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, '~');
const SHORT: Record<string, string> = {cpp: 'c++', python: 'py', julia: 'jl'};
const LANG: Record<string, string> = {cpp: 'C++', python: 'Python', julia: 'Julia'};
const GROUPS: [Station['source'], string][] = [['builtin', 'Built-in'], ['example', 'Examples'], ['installed', 'Installed']];

export function Stations({client, act}: {client: Client; act: Act}) {
  const {sessions, jobs} = useStore(client, s => s);
  const [list, setList] = useState<Station[] | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState('');
  const [ask, setAsk] = useState<'new' | 'uninstall' | null>(null);
  const load = useCallback(() => void client.run('station list').then(j => j.state === 'done' ? (setList(j.result as Station[]), setError('')) : setError(j.error ?? 'failed')), [client]);
  useEffect(load, [load]);
  const run = (line: string, title: string) => act(line, title).then(j => (load(), j));
  // live: Simplicial open on its folder, or a `run` from here still serving it
  const session = (x: Station) => sessions.find(s => s.project === x.dir);
  const serving = (x: Station) => jobs.some(j => j.state === 'running' && j.line === `run ${x.name}`);
  const st = list?.find(x => x.name === pick) ?? list?.[0];

  async function pack(x: Station) {
    const folder = await bridge().pickFolder(`Where to write ${x.name}.pst`);
    if (folder) void act(`pack ${x.name} --out ${q(`${folder}/${x.name}.pst`)}`, `Packing ${x.name}`);
  }
  async function create(name: string, lang: Lang) {
    const folder = await bridge().pickFolder(`Where to make ${name}`);
    if (!folder) return;
    const dir = `${folder}/${name}`;
    const j = await run(`new ${q(name)} --${lang} --dir ${q(dir)}`, `Making ${name}`);
    if (j.state === 'done') bridge().reveal(dir);
  }

  return (
    <div className="main">
      <section className="panel" aria-label="Stations">
        <div className="phead"><span className="count">{list ? `${list.length} stations` : ''}</span></div>
        <div className="list-keys">
          <Key size="sm" icon="add" onClick={() => setAsk('new')}>New station…</Key>
          <Key size="sm" icon="cloud-download" onClick={() => void run('station examples', 'Fetching the examples')}>Fetch examples</Key>
        </div>
        <div className="scroll"><div className="klist st-list">
          {error && <p className="empty-note bad">{error}</p>}
          {GROUPS.map(([source, label]) => {
            const rows = list?.filter(x => x.source === source) ?? [];
            return rows.length > 0 && (
              <div key={source} role="group" aria-label={label}>
                <div className="label kgroup">{label}</div>
                {rows.map(x => (
                  <div key={x.name} className={`kr${x === st ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => setPick(x.name)} onKeyDown={e => e.key === 'Enter' && setPick(x.name)}>
                    <span className="lang">{SHORT[x.language] ?? x.language}</span>
                    <span><b>{x.name}</b><small>{x.description}</small></span>
                    {session(x) || serving(x) ? <span className="app-simplicial"><Pill state="live" label="live" /></span> : <span />}
                  </div>
                ))}
              </div>
            );
          })}
        </div></div>
      </section>
      <div className="bay">{st && (
        <section className="panel" aria-label={st.name}>
          <div className="dhead st-head">
            <span className="lang big">{SHORT[st.language] ?? st.language}</span>
            <div><div className="dname">{st.name}</div>
              <div className="dmeta"><Tag>{LANG[st.language] ?? st.language}</Tag><Tag>{GROUPS.find(g => g[0] === st.source)?.[1]}</Tag><Tag>ws://127.0.0.1:{st.port}</Tag>
                {(session(st) || serving(st)) && <span className="app-simplicial"><Pill state="live" label="running" /></span>}</div></div>
            <span className="bend">
              <Key onClick={() => void act(`check ${st.name}`, `Checking ${st.name}`)}>Check</Key>
              {st.language === 'cpp' && <Key onClick={() => void act(`build ${st.name}`, `Building ${st.name}`)}>Build</Key>}
              <Key icon="file-zip" onClick={() => void pack(st)}>Pack…</Key>
              {session(st)
                ? <Key kind="primary" icon="link-external" onClick={() => bridge().openWindow(session(st)!.url, 'Simplicial')}>Open in Simplicial</Key>
                : <Key kind="primary" icon="play" busy={serving(st)} disabled={serving(st)} onClick={() => void act(`run ${st.name}`, `Running ${st.name}`)}>{serving(st) ? 'Running' : 'Run'}</Key>}
            </span>
          </div>
          <div className="scroll"><div className="dbody">
            <div className="card"><div className="chead"><b>About</b></div><p className="pad">{st.description}</p></div>
            <div className="card">
              <div className="chead"><b>Where it is</b><span className="bend"><Key size="sm" kind="quiet" icon="folder-opened" onClick={() => bridge().reveal(st.dir)}>Reveal folder</Key></span></div>
              <dl className="facts2"><dt>Folder</dt><dd title={st.dir}>{home(st.dir)}</dd></dl>
              {st.source === 'installed' && <div className="cfoot"><span className="grow">installed in your stations folder</span><Key size="sm" kind="danger" onClick={() => setAsk('uninstall')}>Uninstall…</Key></div>}
            </div>
          </div></div>
        </section>
      )}</div>
      {ask === 'new' && <NewStation onClose={() => setAsk(null)} onCreate={(n, l) => void create(n, l)} />}
      {ask === 'uninstall' && st && (
        <Dialog title={`Uninstall ${st.name}?`} onClose={() => setAsk(null)}
          actions={<><Key kind="danger" onClick={() => (setAsk(null), void run(`station uninstall ${st.name}`, `Removing ${st.name}`))}>Uninstall</Key><Key shortcut="Esc" onClick={() => setAsk(null)}>Cancel</Key></>}>
          <p>Its folder {home(st.dir)} is removed from your stations.</p>
        </Dialog>
      )}
    </div>
  );
}

function NewStation({onClose, onCreate}: {onClose: () => void; onCreate: (name: string, lang: Lang) => void}) {
  const [name, setName] = useState('');
  const [lang, setLang] = useState<Lang>('cpp');
  const ok = () => name.trim() && (onClose(), onCreate(name.trim(), lang));
  return (
    <Dialog title="New station" onClose={onClose}
      actions={<><Key kind="primary" disabled={!name.trim()} onClick={ok}>Create…</Key><Key shortcut="Esc" onClick={onClose}>Cancel</Key></>}>
      <p>A station that passes check, in a folder you pick next.</p>
      <label className="well"><input autoFocus aria-label="Name" placeholder="my-station" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && ok()} /></label>
      <Segmented label="Language" value={lang} onChange={setLang} options={[{value: 'cpp', label: 'C++'}, {value: 'python', label: 'Python'}, {value: 'julia', label: 'Julia'}]} />
    </Dialog>
  );
}
