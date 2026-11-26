// The Console: the registry as a command line, the same completion and words as the terminal UI.
// `only` narrows it to one group (the Stations page, from the app that adds them).

import {useEffect, useRef, useState} from 'react';
import {Key, Spinner} from '@paperboatlab/ui';
import {complete, findCommand, ghost as ghostOf, remember, splitWords, type Client, type Sources} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';

export function Console({client, line, onLine, only}: {client: Client; line: string | null; onLine: (l: string | null) => void; only?: string}) {
  const state = useStore(client, s => s);
  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [pick, setPick] = useState(0);
  const [shown, setShown] = useState<number[]>([]);  // job ids in this console
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (line !== null) (setText(line), onLine(null));
    input.current?.focus();
  }, [line, onLine]);
  useEffect(() => {
    end.current?.scrollIntoView({block: 'end'});  // it returns a Promise in Chromium 14x: not an effect's clean-up
  }, [shown.length, state.jobs]);

  const commands = only ? state.commands.filter(c => c.group === only) : state.commands.filter(c => !c.tui);
  const sources: Sources = {
    commands,
    args: {
      app: state.apps.map(a => ({value: a.name, detail: a.installed ? 'installed' : 'available'})),
      session: state.sessions.map(s => ({value: s.id, detail: s.url})),
      runtime: (state.runtimes?.runtimes ?? []).map(r => ({value: r.name, detail: r.version})),
      instance: state.instances.map(l => ({value: l.id, detail: `${l.runtime} ${l.state}`})),
      kernel: state.instances.filter(l => l.mode === 'session').map(l => ({value: l.id, detail: l.runtime})),
    },
  };
  const {candidates, from} = text ? complete(text, sources) : {candidates: [], from: 0};
  const menu = candidates.slice(0, 8);
  const at = Math.min(pick, Math.max(0, menu.length - 1));
  const fill = (v: string) => {
    const c = commands.find(x => x.name === v);
    return text.slice(0, from) + v + (c && !c.args ? '' : ' ');
  };
  const top = menu[at] && fill(menu[at].value);
  const ghost = top?.startsWith(text) ? top.slice(text.length).trimEnd() : ghostOf(text, history, sources);

  async function run(l: string) {
    const t = l.trim();
    if (!t) return;
    setHistory(h => remember(h, t));
    setHi(-1);
    setText('');
    if (t === 'clear') return setShown([]);
    const p = client.run(t, {text: true});
    const id = client.getState().jobs.at(-1)?.id;
    if (id) setShown(s => [...s, id]);
    await p;
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const f = top;
      const cmd = findCommand(commands, splitWords(text));
      if (f && f.trim() !== text.trim() && !cmd) return setText(f);
      return void run(text);
    }
    if ((e.key === 'Tab' || (e.key === 'ArrowRight' && input.current?.selectionStart === text.length)) && (top || ghost)) {
      e.preventDefault();
      return setText(top ?? text + ghost);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.length > 1 && text) return setPick((at + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
      const n = e.key === 'ArrowUp' ? Math.min(history.length - 1, hi + 1) : Math.max(-1, hi - 1);
      setHi(n);
      return setText(n < 0 ? '' : history[history.length - 1 - n]);
    }
    if (e.key === 'Escape') setText('');
  }

  const jobs = state.jobs.filter(j => shown.includes(j.id));
  return (
    <div className="bay"><section className="panel page console" aria-label={only ?? 'Console'}>
      <div className="phead"><span className="count">the same as paperboat &lt;command&gt; in a shell</span></div>
      <div className="scroll screen transcript">
        {jobs.length === 0 && (
          <div className="d">{only ? commands.map(c => `${c.name} ${c.args}`.trim()).join('\n') || `No app adds ${only.toLowerCase()} yet.` : 'Type a command: app list, runtime ps, help…  Tab completes, ↑ history.'}</div>
        )}
        {jobs.map(j => (
          <div key={j.id} className="entry">
            <div className="cmd">› {j.line}</div>
            {j.state === 'running' ? <div className="d"><Spinner size={12} /> {j.output.at(-1) ?? 'working…'}</div>
              : j.state === 'failed' ? <div className="bad">✗ {j.error}{j.app ? `\n  app install ${j.app} adds it` : ''}</div>
              : <div>{String(j.result ?? '').replace(/\n$/, '') || '✓ done'}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="console-prompt">
        <span className="caret">›</span>
        <label className="well">
          <input ref={input} value={text} spellCheck={false} aria-label="Command" onChange={e => (setText(e.target.value), setPick(0))} onKeyDown={onKey} />
          <span className="ghost" aria-hidden><span>{text}</span>{ghost}</span>
        </label>
        <Key size="sm" kind="primary" onClick={() => void run(text)} disabled={!text.trim()}>Run</Key>
        {text && menu.length > 0 && (
          <ul className="menu complete" role="listbox">
            {menu.map((c, i) => (
              <li key={c.value} role="option" aria-selected={i === at} className="menu-item" onMouseDown={e => (e.preventDefault(), setText(fill(c.value)), input.current?.focus())}>
                <b>{c.value}</b><span className="muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section></div>
  );
}
