// What the wait screen says while the station at the app's URL is still coming up: the CLI's start
// status (pb#332, `paperboat status --json`, served as /__paperboat/status), read every second until
// the station says hello. Without a status (no host, nothing starting there) the socket's own state.

import { useEffect, useState } from "react";

/** One station in `paperboat status --json`. */
export type StationStatus = {
  name: string;
  state: "building" | "starting" | "failed" | "running";
  stage?: "prepare" | "configure" | "compile" | "waiting";
  port: number;
  elapsed?: number;
  error?: string;
};

const STAGE: Record<string, string> = { prepare: "preparing", configure: "configuring", compile: "compiling" };

/** The wait screen's words for the station on `url`'s port, or null when the status says nothing of it. */
export function startWords(list: readonly StationStatus[], url: string): { words: string; failed: boolean; elapsed?: number } | null {
  let port = 0;
  try {
    port = Number(new URL(url).port);
  } catch {
    return null;
  }
  const b = list.find((one) => one.port === port && one.state !== "running");
  if (!b) return null;
  if (b.state === "failed") return { words: `${b.name} failed to start: ${b.error ?? "see paperboat logs"}`, failed: true };
  const words = b.state === "building" ? `${STAGE[b.stage ?? ""] ?? "building"} ${b.name}` : `starting ${b.name}`;
  return { words, failed: false, elapsed: b.elapsed };
}

/** The start status of every station, read every second while `on`; empty when the host has none. */
export function useStationStatus(on: boolean): StationStatus[] {
  const [list, setList] = useState<StationStatus[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () =>
      fetch("/__paperboat/status")
        .then((r) => (r.ok ? r.json() : { stations: [] }))
        .then((doc: { stations?: StationStatus[] }) => live && setList(doc.stations ?? []))
        .catch(() => live && setList([]));
    read();
    const t = setInterval(read, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [on]);
  return on ? list : [];
}
