// Toolkits: the platform's registry of them (toolkits.toml). Installing one is the command of the app
// that builds them (Simplicial's `toolkit install`), offered once that app is installed. The detail reads
// the toolkit's repository (`toolkit info`, cached by the CLI): version, licence, blocks and README.

import {useEffect, useMemo, useState} from 'react';
import {Icon, Key, Pill, Spinner, Tag, sanitizeHtml} from '@paperboatlab/ui';
import type {Client} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import type {Act} from './act.ts';

interface Toolkit {
  name: string;
  kind: string;
  repo: string;
  description: string;
  installed: boolean;
}

interface Info {
  version: string;
  licence: string;
  url: string;
  release: {version: string; url: string} | null;
  blocks: string[];
  readme: string;
  readme_url: string;
  channel: string;
  fetched: number;
  stale: boolean;
}

type Remote = {state: 'loading'} | {state: 'done'; info: Info} | {state: 'failed'; error: string};

/** GitHub's rendered README, made to sit in the page: links resolved against the file on GitHub, the heading anchors gone, inert. */
function readmeHtml(html: string, base: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('a.anchor, svg.octicon').forEach(e => e.remove());
  doc.querySelectorAll('[href]').forEach(e => e.setAttribute('href', new URL(e.getAttribute('href')!, base).href));
  doc.querySelectorAll('[src]').forEach(e => e.setAttribute('src', new URL(e.getAttribute('src')!, base.replace('/blob/', '/raw/')).href));
  return sanitizeHtml(doc.body.innerHTML);
}

export function Toolkits({client, act}: {client: Client; act: Act}) {
  const commands = useStore(client, s => s.commands);
  const [list, setList] = useState<Toolkit[]>([]);
  const [pick, setPick] = useState('');
  useEffect(() => void client.run('toolkit list').then(j => j.state === 'done' && setList(j.result as Toolkit[])), [client]);
  const install = commands.find(c => c.name === 'toolkit install');
  const t = list.find(x => x.name === pick) ?? list[0];
  const [remote, setRemote] = useState<Record<string, Remote>>({});
  const read = (name: string, refresh = false) => {
    setRemote(r => ({...r, [name]: {state: 'loading'}}));
    void client.run(`toolkit info ${name}${refresh ? ' --refresh' : ''}`).then(j =>
      setRemote(r => ({...r, [name]: j.state === 'done' ? {state: 'done', info: j.result as Info} : {state: 'failed', error: j.error ?? 'failed'}})));
  };
  useEffect(() => void (t && !remote[t.name] && read(t.name)), [t?.name]);
  const r = t ? remote[t.name] : undefined, info = r?.state === 'done' ? r.info : undefined;
  const readme = useMemo(() => (info ? readmeHtml(info.readme, info.readme_url) : ''), [info]);
  return (
    <div className="main">
      <section className="panel" aria-label="Toolkits">
        <div className="phead"><span className="count">{list.filter(x => x.installed).length} of {list.length} installed</span></div>
        <div className="scroll"><div className="klist">
          {list.map(x => (
            <div key={x.name} className={`kr${x === t ? ' on' : ''}${x.installed ? '' : ' avail'}`} role="button" tabIndex={0} onClick={() => setPick(x.name)}>
              <span className="lang"><Icon name="extensions" /></span>
              <span><b>{x.name}</b><small>{x.kind}</small></span>
              <Pill state={x.installed ? 'idle' : 'plain'} label={x.installed ? 'installed' : 'available'} />
            </div>
          ))}
        </div></div>
      </section>
      <div className="bay">{t && (
        <section className="panel" aria-label={t.name}>
          <div className="dhead">
            <span className="lang big"><Icon name="extensions" size={22} /></span>
            <div><div className="dname">{t.name}{info?.version && <small>{info.version}</small>}</div>
              <div className="dmeta"><Tag>{t.repo.replace(/^https:\/\//, '').replace(/\.git$/, '')}</Tag>{info?.licence && <Tag>{info.licence}</Tag>}<Tag>{t.kind}</Tag>
                {info && <Tag title={info.release?.url}>{info.release ? `newest on ${info.channel}: ${info.release.version}` : `no release on ${info.channel}`}</Tag>}</div></div>
            <span className="bend">
              <Key icon="github" onClick={() => window.open(info?.url ?? t.repo.replace(/\.git$/, ''), '_blank')}>Repository</Key>
              {install && !t.installed && <Key kind="primary" onClick={() => void act(`toolkit install ${t.name}`, `Installing ${t.name}`)}>Install</Key>}
            </span>
          </div>
          <div className="scroll"><div className="dbody">
            <div className="card"><div className="chead"><b>About</b></div><p className="pad">{t.description}</p>
              {!install && <div className="cfoot">Toolkits are built by the app that uses them: install Simplicial to install toolkits.</div>}</div>
            {(!r || r.state === 'loading') && <div className="card"><p className="empty-state"><span><Spinner /> reading {t.name} from its repository</span></p></div>}
            {r?.state === 'failed' && (
              <div className="card"><div className="chead"><b>From the repository</b><span className="bend"><Key size="sm" onClick={() => read(t.name, true)}>Try again</Key></span></div>
                <p className="pad bad">{r.error}</p></div>
            )}
            {info && <>
              <div className="card"><div className="chead"><b>Blocks</b><span className="label">{info.blocks.length}</span></div>
                <div className="tk-blocks">{info.blocks.map(b => <code key={b}>{b}</code>)}</div>
                {info.stale && <div className="cfoot">Offline: what the repository said on {new Date(info.fetched * 1000).toLocaleDateString()}
                  <span className="bend"><Key size="sm" onClick={() => read(t.name, true)}>Try again</Key></span></div>}</div>
              <div className="card"><div className="chead"><b>README</b></div>
                <div className="tk-readme" dangerouslySetInnerHTML={{__html: readme}} /></div>
            </>}
          </div></div>
        </section>
      )}</div>
    </div>
  );
}
