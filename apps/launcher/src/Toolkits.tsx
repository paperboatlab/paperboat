// Toolkits: the platform's registry of them (toolkits.toml). Installing one is the command of the app
// that builds them (Simplicial's `toolkit install`), offered once that app is installed.

import {useEffect, useState} from 'react';
import {Icon, Key, Pill, Tag} from '@paperboatlab/ui';
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

export function Toolkits({client, act}: {client: Client; act: Act}) {
  const commands = useStore(client, s => s.commands);
  const [list, setList] = useState<Toolkit[]>([]);
  const [pick, setPick] = useState('');
  useEffect(() => void client.run('toolkit list').then(j => j.state === 'done' && setList(j.result as Toolkit[])), [client]);
  const install = commands.find(c => c.name === 'toolkit install');
  const t = list.find(x => x.name === pick) ?? list[0];
  return (
    <div className="main">
      <section className="panel" aria-label="Toolkits">
        <div className="phead"><b>Toolkits</b><span className="count">{list.filter(x => x.installed).length} of {list.length} installed</span></div>
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
      {t && (
        <section className="panel" aria-label={t.name}>
          <div className="dhead">
            <span className="lang big"><Icon name="extensions" size={22} /></span>
            <div><div className="dname">{t.name}</div>
              <div className="dmeta"><Tag>{t.repo.replace(/^https:\/\//, '')}</Tag><Tag>{t.kind}</Tag></div></div>
            <span className="bend">{install && !t.installed && <Key kind="primary" onClick={() => void act(`toolkit install ${t.name}`, `Installing ${t.name}`)}>Install</Key>}</span>
          </div>
          <div className="scroll"><div className="dbody">
            <div className="card"><div className="chead"><b>About</b></div><p className="pad">{t.description}</p>
              {!install && <div className="cfoot">Toolkits are built by the app that uses them: install Simplicial to install toolkits.</div>}</div>
          </div></div>
        </section>
      )}
    </div>
  );
}
