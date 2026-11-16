// What the wait screen says while the backend at the app's URL is still coming up: the CLI's start
// status (pb#332, `paperboat status --json`, served as /__paperboat/status), read every second until
// the backend says hello. Without a status (no host, nothing starting there) the socket's own state.

import { useEffect, useState } from "react";

/** One backend in `paperboat status --json`. */
export type BackendStatus = {
  name: string;
  state: "building" | "starting" | "failed" | "running";
  stage?: "prepare" | "configure" | "compile" | "waiting";
  port: number;
  elapsed?: number;
  error?: string;
};

const STAGE: Record<string, string> = { prepare: "preparing", configure: "configuring", compile: "compiling" };

/** The wait screen's words for the backend on `url`'s port, or null when the status says nothing of it. */
export function startWords(list: readonly BackendStatus[], url: string): { words: string; failed: boolean; elapsed?: number } | null {
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

/** The start status of every backend, read every second while `on`; empty when the host has none. */
export function useBackendStatus(on: boolean): BackendStatus[] {
  const [list, setList] = useState<BackendStatus[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () =>
      fetch("/__paperboat/status")
        .then((r) => (r.ok ? r.json() : { backends: [] }))
        .then((doc: { backends?: BackendStatus[] }) => live && setList(doc.backends ?? []))
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
