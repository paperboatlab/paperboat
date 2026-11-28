// Paperboat's own updates in the Launcher (pb#94, pb#61, pb#63). Check for updates (and Settings' "Check and ask")
// shows the check in words; Update now, the only consent, runs `update --install --yes` (the CLI downloads, checks
// the SHA-256 and installs behind the system's password prompt) with its progress in the same toast; then the
// restart prompt. A restart that ends running work (paperboatd's instances, the apps' windows) says what first.
import {useCallback, useEffect, useRef, useState} from 'react';
import {Dialog, Key, readStored, writeStored} from '@paperboatlab/ui';
import type {Client} from '@paperboat/client/browser';
import {useStore} from '@paperboat/client/react';
import type {Show} from './act.ts';
import {bridge} from './bridge.ts';
import {CHECK_EVERY_MS, checkWords, endsWords, progressWords, restartNeeds, running, type AutoUpdate, type Check, type Installed, type Needs} from './update.ts';

const INSTALL = 'update --install --yes';
const LATER = 'paperboat.launcher.updates.later';  // the version "Later" put off: "Check and ask" doesn't ask again
const isString = (v: unknown): v is string => typeof v === 'string';

interface Ask {version: string; needs: Needs}

export function useUpdates({client, show, launcher, auto, onAbout}: {client: Client; show: Show; launcher: string; auto: AutoUpdate; onAbout: () => void}) {
  const {instances, sessions} = useStore(client, s => s);
  const note = useRef<number | undefined>(undefined);
  const offered = useRef('');  // the version whose restart was offered, so focus doesn't offer it again
  const [ask, setAsk] = useState<Ask | null>(null);
  const [waiting, setWaiting] = useState<Ask | null>(null);

  // what the restart ends: paperboatd's running instances, and the apps' windows when the Launcher restarts
  const ends = (needs: Needs) => [
    ...(needs.daemon ? endsWords(client.getState().instances, client.getState().sessions) : []),
    ...(needs.launcher ? client.getState().sessions.map(s => `the ${s.app} window on ${s.project}`) : []),
  ];

  const restartNow = useCallback(async ({version, needs}: Ask) => {
    setAsk(null);
    setWaiting(null);
    if (needs.daemon) {
      note.current = show({id: note.current, title: `Restarting paperboatd ${version}`, state: 'working'});
      await client.run('daemon stop');
    }
    if (needs.launcher) return bridge().relaunch();
    await client.refresh({runtimes: true});  // starts the new paperboatd
    onAbout();
    note.current = show({id: note.current, title: `paperboatd ${version} runs`, state: 'done'});
  }, [client, show, onAbout]);

  const restart = useCallback((a: Ask) => (ends(a.needs).length ? setAsk(a) : void restartNow(a)), [restartNow]);

  const offerRestart = useCallback((a: Ask) => {
    offered.current = a.version;
    if (!a.needs.launcher && !a.needs.daemon) return void (note.current = show({id: note.current, title: `Paperboat ${a.version} is installed`, state: 'done'}));
    note.current = show({id: note.current, title: `Paperboat ${a.version} is installed`, detail: a.needs.launcher ? 'restart to use it' : 'restart paperboatd to use it',
      state: 'done', actions: [{label: 'Restart', primary: true, run: () => restart(a)}]});
  }, [show, restart]);

  // installed but not running (the terminal's `paperboat update --install`, dnf upgrade): the CLI on disk is newer
  const noticeInstalled = useCallback(async () => {
    const j = await client.run('about');
    if (j.state !== 'done') return;
    const about = j.result as {paperboat: string; daemon: {version: string} | null};
    const needs = restartNeeds(about.paperboat, launcher, about.daemon?.version);
    if ((needs.launcher || needs.daemon) && offered.current !== about.paperboat) offerRestart({version: about.paperboat, needs});
  }, [client, launcher, offerRestart]);

  const install = useCallback(async (c: Check) => {
    const version = c.newest!.version, title = `Updating Paperboat to ${version}`;
    // a new toast: the one whose Update now was pressed is on its way out
    const id = (note.current = show({title, detail: 'Downloading', state: 'working'}));
    let said = '';
    const stop = client.subscribe(() => {
      const job = client.getState().jobs.findLast(x => x.line === INSTALL && x.state === 'running');
      const words = job?.output.map(progressWords).filter(Boolean).at(-1);
      if (words && words !== said) show({id, title, detail: (said = words), state: 'working'});
    });
    const job = await client.run(INSTALL);
    stop();
    if (job.state === 'failed') {
      // a refused or dismissed password prompt changed nothing: a warning, not a failure
      if (job.extra?.cancelled) return void show({id, title: 'Paperboat was not updated', detail: `nothing changed: you still have ${c.current}`, state: 'warning'});
      return void show({id, title: 'The update failed', detail: job.error, state: 'failed'});
    }
    const r = job.result as Installed;
    if (!r.installed) return void show({id, ...checkWords(r), state: 'done'});
    onAbout();
    offerRestart({version: r.installed, needs: restartNeeds(r.installed, launcher, r.daemon?.version)});
  }, [client, show, launcher, onAbout, offerRestart]);

  /** `manual`: Check for updates (always says); else "Check and ask" (says only of a version not put off). */
  const check = useCallback(async (manual: boolean) => {
    const id = manual ? (note.current = show({title: 'Checking for updates', state: 'working'})) : undefined;
    const job = await client.run('update --check');
    if (job.state === 'failed') return void (manual && show({id, title: 'Could not check for updates', detail: job.error, state: 'failed'}));
    const c = job.result as Check, words = checkWords(c);
    if (!c.update || !c.newest) {
      if (manual) show({id, ...words, state: 'done'});
      return void noticeInstalled();
    }
    const newest = c.newest;
    if (!manual && readStored(LATER, isString) === newest.version) return;
    const later = {label: 'Later', run: () => writeStored(LATER, newest.version)};
    note.current = show({id, ...words, state: 'done', actions: c.installable
      ? [{label: 'Update now', primary: true, run: () => void install(c)}, later]
      // a build from source, or no package of ours: the release's page has the packages
      : [{label: 'Open release', primary: true, run: () => void window.open(newest.url)}, later]});
  }, [client, show, install, noticeInstalled]);

  // "Check and ask": shortly after start, then every six hours
  useEffect(() => {
    if (auto !== 'ask') return;
    const first = setTimeout(() => void check(false), 10_000), every = setInterval(() => void check(false), CHECK_EVERY_MS);
    return () => (clearTimeout(first), clearInterval(every));
  }, [auto, check]);
  // back to the window: was Paperboat installed meanwhile? (at most once a minute)
  useEffect(() => {
    let at = 0;
    const onFocus = () => Date.now() - at > 60_000 && ((at = Date.now()), void noticeInstalled());
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [noticeInstalled]);
  // "When none run": the restart waits for the last of what it would end
  useEffect(() => {
    if (waiting && !ends(waiting.needs).length) void restartNow(waiting);
  }, [waiting, instances, sessions, restartNow]);

  const dialog = ask && (
    <Dialog title={`Restart for Paperboat ${ask.version}`} onClose={() => setAsk(null)}
      actions={<>
        <Key kind="danger" onClick={() => void restartNow(ask)}>Restart now</Key>
        <Key onClick={() => {
          setWaiting(ask);
          setAsk(null);
          note.current = show({id: note.current, title: `Paperboat ${ask.version} restarts when nothing runs`, detail: `${running(instances)} running now`, state: 'working'});
        }}>When none run</Key>
        <Key shortcut="Esc" onClick={() => setAsk(null)}>Cancel</Key>
      </>}>
      <p>{ask.needs.daemon && 'paperboatd still runs the version before, and restarting it ends its runtimes. '}Restarting now ends:</p>
      <ul className="restart-ends">{ends(ask.needs).map(w => <li key={w}>{w}</li>)}</ul>
    </Dialog>
  );
  return {check, dialog};
}
