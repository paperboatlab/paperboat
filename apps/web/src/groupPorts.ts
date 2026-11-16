// A subsystem's or story's ports (groups.tsx draws them): the ports inside it that it shows as
// a block's, their names, and that a port stays when its last wire across the edge goes.

import type { Edge, Node } from "@xyflow/react";

/** A port a group shows as a block's: an input (`in`) or output (`out`) of a block inside it, and its name. */
export type Expose = { side: "in" | "out"; to: [string, string]; name?: string };
export const isPort = (x: Expose, side: Expose["side"], to: readonly [string, string]) => x.side === side && x.to[0] === to[0] && x.to[1] === to[1];
/** The name the user gave a group's port, if any. */
export const portName = (expose: Expose[] | undefined, side: Expose["side"], to: readonly [string, string]) => expose?.find((x) => isPort(x, side, to))?.name;
type GroupPorts = { kind: string; expose?: Expose[] };

/** Every block and group inside group `id`, at any depth. */
export function descendants(id: string, nodes: Node[]): string[] {
  const kids = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
  const out: string[] = [];
  const walk = (p: string) => (kids.get(p) ?? []).forEach((c) => (out.push(c), walk(c)));
  walk(id);
  return out;
}

/**
 * A group keeps its ports when their wires go: each wire removed that crossed a subsystem's or
 * story's edge leaves the port it went through exposed, unwired, ready for the next wire.
 */
export function keepPorts<N extends Node>(nodes: N[], removed: Edge[]): N[] {
  let changed = false;
  const out = nodes.map((g) => {
    if (g.type !== "frame" || (g.data as GroupPorts).kind === "visual" || removed.length === 0) return g;
    const had = (g.data as GroupPorts).expose ?? [];
    const inside = new Set(descendants(g.id, nodes));
    const expose = [...had];
    for (const w of removed) {
      if (inside.has(w.source) === inside.has(w.target)) continue;
      const x: Expose = inside.has(w.target) ? { side: "in", to: [w.target, w.targetHandle ?? ""] } : { side: "out", to: [w.source, w.sourceHandle ?? ""] };
      if (!expose.some((e) => isPort(e, x.side, x.to))) expose.push(x);
    }
    if (expose.length === had.length) return g;
    changed = true;
    return { ...g, data: { ...g.data, expose } };
  });
  return changed ? out : nodes;
}

/** A group's ports with those at `ends` renamed (`name`; "" the default name), or removed (null). */
export function withPort(expose: Expose[], side: Expose["side"], ends: [string, string][], name: string | null): Expose[] {
  const hit = (x: Expose) => ends.some((to) => isPort(x, side, to));
  if (name === null) return expose.filter((x) => !hit(x));
  const named = (x: Expose): Expose => (name ? { side: x.side, to: x.to, name } : { side: x.side, to: x.to });
  return [...expose.map((x) => (hit(x) ? named(x) : x)), ...ends.filter((to) => !expose.some((x) => isPort(x, side, to))).map((to) => named({ side, to }))];
}
