// Toolkits: the platform's registry of them (toolkits.toml). Installing one is the command of the app
// that builds them (Simplicial's `toolkit install`), offered once that app is installed. The detail reads
// the toolkit's repository (`toolkit info`, cached by the CLI): version, licence, blocks and README.

import {useEffect, useState} from 'react';
import {Key, Spinner, Tag} from '@paperboatlab/ui';
import {repoPage, ToolkitBlocks, ToolkitCard, ToolkitHead, ToolkitList, ToolkitReadme} from '@paperboatlab/ui/toolkits';
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
  return (
    <div className="main">
      <section className="panel" aria-label="Toolkits">
        <div className="phead"><span className="count">{list.filter(x => x.installed).length} of {list.length} installed</span></div>
        <div className="scroll"><ToolkitList toolkits={list} selected={t?.name} onSelect={x => setPick(x.name)} /></div>
      </section>
      <div className="bay">{t && (
        <section className="panel" aria-label={t.name}>
          <ToolkitHead toolkit={{...t, version: info?.version, licence: info?.licence}}
            tags={info && <Tag title={info.release?.url}>{info.release ? `newest on ${info.channel}: ${info.release.version}` : `no release on ${info.channel}`}</Tag>}
            actions={<>
              <Key icon="github" onClick={() => window.open(info?.url ?? repoPage(t.repo), '_blank')}>Repository</Key>
              {install && !t.installed && <Key kind="primary" onClick={() => void act(`toolkit install ${t.name}`, `Installing ${t.name}`)}>Install</Key>}
            </>} />
          <div className="scroll"><div className="dbody">
            <ToolkitCard title="About" text={t.description}
              foot={!install && 'Toolkits are built by the app that uses them: install Simplicial to install toolkits.'} />
            {(!r || r.state === 'loading') && <div className="tk-card"><p className="empty-state"><span><Spinner /> reading {t.name} from its repository</span></p></div>}
            {r?.state === 'failed' && <ToolkitCard title="From the repository" text={r.error} failed actions={<Key size="sm" onClick={() => read(t.name, true)}>Try again</Key>} />}
            {info && <>
              <ToolkitCard title="Blocks" count={info.blocks.length}
                foot={info.stale && <>Offline: what the repository said on {new Date(info.fetched * 1000).toLocaleDateString()}
                  <span className="tk-end"><Key size="sm" onClick={() => read(t.name, true)}>Try again</Key></span></>}>
                <ToolkitBlocks blocks={info.blocks} />
              </ToolkitCard>
              <ToolkitCard title="README"><ToolkitReadme html={info.readme} base={info.readme_url} /></ToolkitCard>
            </>}
          </div></div>
        </section>
      )}</div>
    </div>
  );
}
