import { NodeResizer, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";
import type { BlockDef, GraphGroup, PortDef } from "./protocol";
import type { PortSides } from "./ports";
import { usePortLayout } from "./portLayout";
import { PortHandle } from "./wireSnap";

import { NumberField } from "./NumberField";
import { isPort, portName, type Expose } from "./groupPorts";
export { descendants, keepPorts, portName, withPort, type Expose } from "./groupPorts";
/**
 * Groups on the Flow page (#68). Three kinds:
 * - **subsystem**: a block you enter and leave, like a Simulink subsystem. Outside it is one
 *   block whose ports are the wires crossing its edge; double-click opens its own level,
 *   where the wires from outside come in through **In** and leave through **Out** ports.
 * - **story**: the same, and one step of a Step flow (ports in → next). When a path arrives,
 *   its blocks run once per clock step for `seconds` (0: once); then the path moves on, and
 *   what the story computed stays on its outputs for the next story to read.
 * - **visual** (a frame): a dashed box that tidies the canvas; its blocks run as if ungrouped.
 *   Collapsed, it shows as one block, as a subsystem does from outside.
 * Subsystems nest (a group's `parentId` is the group it is in). Backends see a flat graph.
 */
export type GroupData = {
  kind: "visual" | "subsystem" | "story";
  label: string;
  /** A frame drawn as one block (subsystems and stories always are, from outside). */
  collapsed: boolean;
  seconds: number;
  /** A story's blocks start afresh each time a path arrives. */
  reset: boolean;
  /** A story's outputs to clear when its path leaves. */
  release?: [string, string][];
  /** A frame's size when open. */
  size: { w: number; h: number };
  /** Ports shown as a block's even with no wire yet: an input or output inside it. */
  expose?: Expose[];
  /** Where the user put its ports (as a block's `ports`). */
  sides?: PortSides;
  /** Filled for display: the ports it shows as a block (`node::port` ids). */
  ports?: { inputs: PortDef[]; outputs: PortDef[] };
};
export type GroupNode = Node<GroupData, "frame">;


/** The step ports a story has, as a block definition. */
export const STORY_DEF: BlockDef = {
  type: "story",
  label: "Story",
  kind: "function",
  inputs: [{ id: "in", type: "step" }],
  outputs: [{ id: "next", type: "step" }],
  params: [],
};

/** A group's handle for a port inside it: `node::port`. */
export const SEP = "::";
export const portHandle = (node: string, port: string) => `${node}${SEP}${port}`;
export const splitHandle = (handle: string): [string, string] | null => {
  const i = handle.indexOf(SEP);
  return i < 0 ? null : [handle.slice(0, i), handle.slice(i + SEP.length)];
};

export const isFrame = (n: Node): n is GroupNode => n.type === "frame";
/** A group that is a level of its own: a subsystem or a story. */
export const isLevel = (n: Node | undefined): n is GroupNode => !!n && isFrame(n) && n.data.kind !== "visual";

/** Actions a group offers, provided by the Flow editor. */
export const GroupActions = createContext<{
  update: (id: string, change: Partial<GroupData>) => void;
  ungroup: (id: string) => void;
  /** Open a subsystem or story: show its level. */
  enter: (id: string) => void;
  /** What is happening inside a group: its most urgent block's state. */
  stateOf: (id: string) => "failed" | "running" | undefined;
  /** Analyse a subsystem (pb#370); absent when no toolkit offers an analysis. */
  analyse?: (id: string) => void;
  /** Rename a group's port (its ports inside at `ends`; "" puts the default name back), or remove it (null) with its wires across the edge. */
  port: (group: string, side: Expose["side"], ends: [string, string][], name: string | null) => void;
}>({ update: () => {}, ungroup: () => {}, enter: () => {}, stateOf: () => undefined, port: () => {} });

const HEAD = 34;

export function GroupBox(props: NodeProps<GroupNode>) {
  return props.data.kind === "visual" ? <Frame {...props} /> : <Subsystem {...props} />;
}

/** A frame: a dashed box round its blocks, or one block when collapsed. */
function Frame({ id, data, selected }: NodeProps<GroupNode>) {
  const { update, ungroup } = useContext(GroupActions);
  const ports = data.ports ?? { inputs: [], outputs: [] };
  return (
    <div className={`frame frame-visual${data.collapsed ? " collapsed" : ""}`}>
      {!data.collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={180}
          minHeight={100}
          onResizeEnd={(_, p) => update(id, { size: { w: p.width, h: p.height } })}
        />
      )}
      <div className="frame-head" style={{ height: HEAD }}>
        <button className="frame-toggle nodrag" title={data.collapsed ? "Open" : "Collapse"} onClick={() => update(id, { collapsed: !data.collapsed })}>
          {data.collapsed ? "▸" : "▾"}
        </button>
        <span className="frame-kind kind-visual">frame</span>
        <input className="frame-label nodrag" value={data.label} onChange={(e) => update(id, { label: e.target.value })} />
        <button className="remove nodrag" title="Remove the frame (keeps the blocks)" onClick={() => ungroup(id)}>
          ⊟
        </button>
      </div>
      {data.collapsed && (
        <div className="frame-ports">
          {ports.inputs.map((p) => (
            <div key={p.id} className={`port in port-${p.type}`}>
              <PortHandle type="target" position={Position.Left} id={p.id} />
              {p.id.replace(SEP, ".")}
            </div>
          ))}
          {ports.outputs.map((p) => (
            <div key={p.id} className={`port out port-${p.type}`}>
              {p.id.replace(SEP, ".")}
              <PortHandle type="source" position={Position.Right} id={p.id} />
            </div>
          ))}
          {ports.inputs.length + ports.outputs.length === 0 && <div className="muted frame-empty">no wires cross it</div>}
        </div>
      )}
    </div>
  );
}

/** A subsystem or story from outside: one block, its ports movable like a block's. */
function Subsystem({ id, data, selected }: NodeProps<GroupNode>) {
  const { update, ungroup, enter, stateOf, analyse } = useContext(GroupActions);
  const story = data.kind === "story";
  const inputs = [...(story ? STORY_DEF.inputs : []), ...(data.ports?.inputs ?? [])];
  const outputs = [...(story ? STORY_DEF.outputs : []), ...(data.ports?.outputs ?? [])];
  const ports = usePortLayout({
    id,
    def: { inputs, outputs },
    sides: data.sides,
    save: (sides) => update(id, { sides }),
    name: (p) => {
      const to = splitHandle(p.id);
      return (to && portName(data.expose, inputs.includes(p) ? "in" : "out", to)) || p.id.replace(SEP, ".");
    },
  });
  const state = stateOf(id);
  const tag = state ?? (story ? "story" : "subsystem");
  const classes = ["block", "subsystem", story && "step", selected && "selected", state === "running" && "active", state === "failed" && "failed"];
  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      title="Double-click to open"
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("input, button, .port")) return;
        e.stopPropagation();
        enter(id);
      }}
    >
      {ports.top}
      <div className="block-title">
        <span className="block-name">{data.label}</span>
        <span className={`block-tag tag-${tag}`}>{tag}</span>
        <button className="fold nodrag" title="Open: show what is inside (double-click)" onClick={() => enter(id)}>
          open
        </button>
        {analyse && !story && (
          <button className="fold nodrag" title="Analyse it outside the flow: its In ports are the inputs, its Out ports the outputs" onClick={() => analyse(id)}>
            analyse
          </button>
        )}
        <button className="remove nodrag" title="Ungroup: put its blocks back here" onClick={() => ungroup(id)}>
          ⊟
        </button>
      </div>
      {ports.rows}
      {inputs.length + outputs.length === 0 && <div className="muted frame-empty">no wires cross it</div>}
      {story && (
        <>
          <label className="param" title="How long the story runs when a path arrives (0: once)">
            <span>
              seconds<span className="unit"> s</span>
            </span>
            <NumberField className="nodrag num" value={data.seconds} valid={(v) => v >= 0} onChange={(seconds) => update(id, { seconds })} />
          </label>
          <label className="param" title="Start its blocks afresh each time a path arrives (a story in a loop starts over)">
            <span>fresh</span>
            <input className="nodrag" type="checkbox" checked={data.reset} onChange={(e) => update(id, { reset: e.target.checked })} />
          </label>
        </>
      )}
      {ports.bottom}
    </div>
  );
}

/**
 * Where the wires from outside a level come in (In) and leave (Out), at its edges: one per block
 * outside (`label`, `from`), or for a port of the group with no wire yet (`unwired`). `group` is
 * the level, `inner` its ports inside this one stands for, `name` theirs if the user named them.
 */
export type BoundaryData = { dir: "in" | "out"; label: string; type: string; handle: string; group: string; inner: [string, string][]; name?: string; unwired?: boolean };
export type BoundaryNode = Node<BoundaryData, "boundary">;

/** An In or Out port of the open level: double-click its name to rename the group's port, × to remove it. */
export function Boundary({ data }: NodeProps<BoundaryNode>) {
  const { port } = useContext(GroupActions);
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  const into = data.dir === "in";
  const shown = data.name ?? data.label;
  return (
    <div
      className={`boundary boundary-${data.dir} port-${data.type}${data.unwired ? " unwired" : ""}`}
      title={data.unwired ? "A port of the group with no wire yet" : into ? `Comes in from ${data.label}, outside` : `Goes out to ${data.label}, outside`}
    >
      {!into && !data.unwired && <PortHandle type="target" position={Position.Left} id={data.handle} />}
      <span className="boundary-tag">{into ? "In" : "Out"}</span>
      {editing ? (
        <input
          className="boundary-name nodrag"
          autoFocus
          defaultValue={data.name ?? ""}
          placeholder={data.label}
          aria-label="Port name"
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") (cancel.current = true), e.currentTarget.blur();
          }}
          onBlur={(e) => {
            setEditing(false);
            if (!cancel.current) port(data.group, data.dir, data.inner, e.currentTarget.value.trim());
            cancel.current = false;
          }}
        />
      ) : (
        <span className="boundary-name" title="Double-click to rename the port" onDoubleClick={() => setEditing(true)}>
          {shown}
        </span>
      )}
      <button className="boundary-x nodrag" title="Remove the port, and its wires across the edge" aria-label={`Remove port ${shown}`} onClick={() => port(data.group, data.dir, data.inner, null)}>
        ×
      </button>
      {into && !data.unwired && <PortHandle type="source" position={Position.Right} id={data.handle} />}
    </div>
  );
}

type AnyNode = Node & { data: unknown };
type ById = Map<string, AnyNode>;
const byIdOf = (nodes: AnyNode[]): ById => new Map(nodes.map((n) => [n.id, n]));

/** Where a node is on the canvas, through every group it is in. */
export function absolute(n: Node, nodes: Node[] | ById): { x: number; y: number } {
  const byId = nodes instanceof Map ? nodes : byIdOf(nodes as AnyNode[]);
  let { x, y } = n.position;
  for (let p = n.parentId ? byId.get(n.parentId) : undefined, guard = 0; p && guard < 64; p = p.parentId ? byId.get(p.parentId) : undefined, guard++) {
    x += p.position.x;
    y += p.position.y;
  }
  return { x, y };
}

/** The subsystem or story a node is directly in (frames don't count), or null: the top level. */
export function levelOf(id: string, nodes: AnyNode[] | ById): string | null {
  const byId = nodes instanceof Map ? nodes : byIdOf(nodes);
  for (let p = byId.get(id)?.parentId, guard = 0; p && guard < 64; p = byId.get(p)?.parentId, guard++) if (isLevel(byId.get(p))) return p;
  return null;
}

/** The levels from the top down to `level` (itself included). */
export function levelPath(level: string | null, nodes: AnyNode[]): GroupNode[] {
  const byId = byIdOf(nodes);
  const out: GroupNode[] = [];
  for (let l = level, guard = 0; l && guard < 64; l = levelOf(l, byId), guard++) {
    const n = byId.get(l);
    if (isLevel(n)) out.unshift(n);
  }
  return out;
}

/**
 * What React Flow is shown at `level` (null: the top). Only that level's blocks and groups
 * show; a subsystem or story in it, or a collapsed frame, is one block whose ports are the
 * wires crossing its edge (`node::port`). Inside a level, a wire from outside comes in
 * through an In port at the left, and one going out leaves through an Out port at the
 * right. The editor's state keeps the real, flat wires.
 */
export function display<N extends AnyNode, E extends Edge>(
  nodes: N[],
  edges: E[],
  portType: (node: string, port: string, side: "inputs" | "outputs") => string,
  level: string | null = null,
): { nodes: N[]; edges: E[] } {
  const byId = byIdOf(nodes);
  const closed = (n: AnyNode | undefined) => !!n && isFrame(n) && (n.data.kind !== "visual" || n.data.collapsed);
  // Where `id` is at this level: "out" (not inside it), "here" (shown), or the closed group showing it.
  const place = (id: string): "out" | "here" | string => {
    if (id === level) return "out";
    let shownAs: string | null = null;
    for (let p = byId.get(id)?.parentId, guard = 0; guard < 64; p = byId.get(p!)?.parentId, guard++) {
      if (p === level || (!p && level === null)) return shownAs ?? "here";
      if (!p) return "out";
      if (closed(byId.get(p))) shownAs = p;
    }
    return "out";
  };
  const placeOf = new Map(nodes.map((n) => [n.id, place(n.id)]));
  const at = (id: string) => placeOf.get(id) ?? "out";

  const ports = new Map<string, { inputs: Map<string, PortDef>; outputs: Map<string, PortDef> }>();
  const portsOf = (g: string) => ports.get(g) ?? ports.set(g, { inputs: new Map(), outputs: new Map() }).get(g)!;
  const bounds = new Map<string, BoundaryData>();
  // Ports the user exposed come first, in their order, wired or not.
  for (const g of nodes) {
    if (!isFrame(g) || !closed(g) || at(g.id) !== "here") continue;
    for (const x of g.data.expose ?? []) {
      if (at(x.to[0]) !== g.id) continue; // the block is gone, or in a group of its own
      const id = portHandle(x.to[0], x.to[1]);
      const side = x.side === "in" ? "inputs" : "outputs";
      portsOf(g.id)[side].set(id, { id, type: portType(x.to[0], x.to[1], side) });
    }
  }
  const levelExpose = level ? (byId.get(level) as GroupNode | undefined)?.data.expose : undefined;
  const bound = (key: string, data: Omit<BoundaryData, "group" | "inner" | "name">, inner: [string, string]) => {
    const had = bounds.get(key)?.inner ?? [];
    const ends = had.some((x) => x[0] === inner[0] && x[1] === inner[1]) ? had : [...had, inner];
    const name = ends.map((to) => portName(levelExpose, data.dir, to)).find(Boolean);
    bounds.set(key, { ...data, group: level ?? "", inner: ends, ...(name ? { name } : {}) });
  };
  const shownEdges = edges.flatMap((e) => {
    const sp = at(e.source);
    const tp = at(e.target);
    if (sp === "out" && tp === "out") return [];
    if (e.source === level || e.target === level) return []; // a story's own step wires are outside it
    if (sp !== "here" && sp !== "out" && sp === tp) return []; // inside one closed group
    const sh = e.sourceHandle ?? "";
    const th = e.targetHandle ?? "";
    let shown = e;
    if (sp === "out") {
      const handle = portHandle(e.source, sh);
      bound(`in:${handle}`, { dir: "in", label: `${e.source}.${sh}`, type: portType(e.source, sh, "outputs"), handle }, [e.target, th]);
      shown = { ...shown, source: `in:${handle}`, sourceHandle: handle };
    } else if (sp !== "here") {
      const id = portHandle(e.source, sh);
      portsOf(sp).outputs.set(id, { id, type: portType(e.source, sh, "outputs") });
      shown = { ...shown, source: sp, sourceHandle: id };
    }
    if (tp === "out") {
      const handle = portHandle(e.target, th);
      bound(`out:${handle}`, { dir: "out", label: `${e.target}.${th}`, type: portType(e.target, th, "inputs"), handle }, [e.source, sh]);
      shown = { ...shown, target: `out:${handle}`, targetHandle: handle };
    } else if (tp !== "here") {
      const id = portHandle(e.target, th);
      portsOf(tp).inputs.set(id, { id, type: portType(e.target, th, "inputs") });
      shown = { ...shown, target: tp, targetHandle: id };
    }
    return [shown];
  });

  const shownNodes = nodes.map((n) => {
    if (at(n.id) !== "here") return n.hidden ? n : { ...n, hidden: true };
    const plain = n.hidden ? { ...n, hidden: false } : n;
    if (!isFrame(n)) return plain;
    const d = n.data;
    if (d.kind === "visual" && !d.collapsed) return { ...plain, width: d.size.w, height: d.size.h, zIndex: -1 };
    const p = ports.get(n.id);
    return {
      ...plain,
      width: undefined,
      height: undefined,
      zIndex: d.kind === "visual" ? -1 : 0,
      data: { ...d, ports: { inputs: [...(p?.inputs.values() ?? [])], outputs: [...(p?.outputs.values() ?? [])] } },
    };
  });

  // The level's own ports with no wire across its edge yet: an In or Out with nothing outside.
  for (const x of levelExpose ?? []) {
    if (at(x.to[0]) === "out" || [...bounds.values()].some((b) => b.dir === x.side && b.inner.some((to) => isPort(x, x.side, to)))) continue;
    const handle = portHandle(x.to[0], x.to[1]);
    const type = portType(x.to[0], x.to[1], x.side === "in" ? "inputs" : "outputs");
    bounds.set(`${x.side}-unwired:${handle}`, { dir: x.side, label: `${x.to[0]}.${x.to[1]}`, type, handle, group: level!, inner: [x.to], ...(x.name ? { name: x.name } : {}), unwired: true });
  }

  // In ports down the left of what the level shows, Out ports down its right.
  const boundary: AnyNode[] = [];
  if (bounds.size > 0) {
    const here = nodes.filter((n) => at(n.id) === "here");
    const xs = here.map((n) => absolute(n, byId).x);
    const ys = here.map((n) => absolute(n, byId).y);
    const right = here.map((n, i) => xs[i] + (n.measured?.width ?? BLOCK_W));
    const left = xs.length ? Math.min(...xs) : 0;
    const top = ys.length ? Math.min(...ys) : 0;
    const end = right.length ? Math.max(...right) : 300;
    let ins = 0;
    let outs = 0;
    for (const [id, data] of bounds) {
      const into = data.dir === "in";
      const row = into ? ins++ : outs++;
      const node: AnyNode = {
        id,
        type: "boundary",
        position: { x: into ? left - 90 - boundaryWidth(data) : end + 90, y: top + row * 52 },
        // Sized here: it is only shown, never in the editor's state, so React Flow can't
        // keep a measured size for it (and doesn't show a node it has no size for).
        width: boundaryWidth(data),
        height: 28,
        data,
        draggable: false,
        selectable: false,
        deletable: false,
        connectable: true,
      };
      // The same object while nothing about it changes: React Flow keeps a node's measured
      // handles only while it is given the same node.
      const key = JSON.stringify([node.position, data]);
      const had = boundaryCache.get(id);
      if (had?.key === key) boundary.push(had.node);
      else {
        boundaryCache.set(id, { key, node });
        boundary.push(node);
      }
    }
  }
  return { nodes: [...shownNodes, ...(boundary as N[])], edges: shownEdges };
}

const boundaryCache = new Map<string, { key: string; node: AnyNode }>();
const BLOCK_W = 190;
const BLOCK_H = 130;
/**
 * An In or Out port's width: its tag and its name in the head's small type, measured. Counting
 * characters under-estimates mono text, and `Out` needs more room than `In` (both clipped).
 */
let textMeasure: CanvasRenderingContext2D | null | undefined;
const boundaryWidth = (d: BoundaryData) => {
  const tag = d.dir === "in" ? "In" : "Out";
  if (textMeasure === undefined) {
    textMeasure =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  }
  const label = d.name ?? d.label;
  if (!textMeasure) return Math.round((d.dir === "in" ? 66 : 74) + 7.5 * label.length);
  const tokens = getComputedStyle(document.documentElement);
  const mono = tokens.getPropertyValue("--font-mono").trim() || "monospace";
  const sans = tokens.getPropertyValue("--font-sans").trim() || "sans-serif";
  textMeasure.font = `400 12px ${mono}`;
  const name = textMeasure.measureText(label).width;
  textMeasure.font = `600 12px ${sans}`;
  return Math.ceil(name + textMeasure.measureText(tag).width + 64); // padding 10 + 10, two gaps, the × key, the border, slack
};

/**
 * A group round `children`, which become its children. They all have the same parent (or
 * none) and their positions are in its space; the group goes in that parent too.
 */
export function frameAround<N extends AnyNode>(
  id: string,
  kind: GroupData["kind"],
  children: N[],
  options: { label?: string; collapsed?: boolean; seconds?: number; reset?: boolean; release?: [string, string][]; pos?: [number, number]; sides?: PortSides; expose?: Expose[]; inFrame?: boolean } = {},
): { frame: GroupNode; children: N[] } {
  const xs = children.map((n) => n.position.x);
  const ys = children.map((n) => n.position.y);
  const right = Math.max(...children.map((n) => n.position.x + (n.measured?.width ?? BLOCK_W)));
  const bottom = Math.max(...children.map((n) => n.position.y + (n.measured?.height ?? BLOCK_H)));
  const pad = 24;
  const x = options.pos?.[0] ?? Math.min(...xs) - pad;
  const y = options.pos?.[1] ?? Math.min(...ys) - pad - HEAD;
  const size = { w: Math.max(200, right - x + pad), h: Math.max(120, bottom - y + pad) };
  const parentId = children[0]?.parentId;
  const frame: GroupNode = {
    id,
    type: "frame",
    position: { x, y },
    deletable: false,
    zIndex: kind === "visual" ? -1 : 0,
    ...(parentId ? { parentId, ...(options.inFrame ? { extent: "parent" as const } : {}) } : {}),
    data: {
      kind,
      label: options.label ?? (kind === "story" ? "Story" : kind === "subsystem" ? "Subsystem" : "Frame"),
      collapsed: options.collapsed ?? false,
      seconds: options.seconds ?? (kind === "story" ? 1 : 0),
      reset: options.reset ?? false,
      ...(options.release ? { release: options.release } : {}),
      size,
      ...(options.sides ? { sides: options.sides } : {}),
      ...(options.expose?.length ? { expose: options.expose } : {}),
    },
  };
  return {
    frame,
    children: children.map((n) => ({
      ...n,
      parentId: id,
      extent: kind === "visual" ? ("parent" as const) : undefined,
      selected: false,
      position: { x: n.position.x - x, y: n.position.y - y },
    })),
  };
}

/** The group's contents back where the group was (one level up), where they are now; the group gone. */
export function withoutFrame<N extends AnyNode>(nodes: N[], id: string): N[] {
  const frame = nodes.find((n) => n.id === id);
  if (!frame) return nodes;
  const up = frame.parentId;
  const upIsFrame = !!up && nodes.some((n) => n.id === up && isFrame(n) && n.data.kind === "visual");
  return nodes
    .filter((n) => n.id !== id)
    .map((n) =>
      n.parentId === id
        ? {
            ...n,
            parentId: up,
            extent: upIsFrame ? ("parent" as const) : undefined,
            hidden: false,
            position: { x: frame.position.x + n.position.x, y: frame.position.y + n.position.y },
          }
        : n,
    );
}

/** Parents before their children, as React Flow wants; otherwise in the order given. */
export function ordered<N extends AnyNode>(nodes: N[]): N[] {
  const byId = byIdOf(nodes);
  const depth = (n: AnyNode) => {
    let d = 0;
    for (let p = n.parentId, guard = 0; p && guard < 64; p = byId.get(p)?.parentId, guard++) d++;
    return d;
  };
  return nodes.map((n, i) => ({ n, i, d: depth(n) })).sort((a, b) => a.d - b.d || a.i - b.i).map((e) => e.n);
}

/** The protocol's groups for these nodes. `pos` is where the group is on the whole canvas. */
export function toGroups(nodes: AnyNode[]): GraphGroup[] {
  const byId = byIdOf(nodes);
  return nodes.filter(isFrame).map((g) => {
    const at = absolute(g, byId);
    return {
      id: g.id,
      kind: g.data.kind,
      label: g.data.label,
      nodes: nodes.filter((n) => n.parentId === g.id && !isFrame(n)).map((n) => n.id),
      ...(g.parentId ? { parent: g.parentId } : {}),
      ...(g.data.kind === "visual" ? { collapsed: g.data.collapsed } : {}),
      pos: [Math.round(at.x), Math.round(at.y)],
      ...(g.data.kind === "story" ? { params: { seconds: g.data.seconds, reset: g.data.reset } } : {}),
      ...(g.data.kind === "story" && g.data.release ? { release: g.data.release } : {}),
      ...(g.data.sides ? { ports: g.data.sides } : {}),
      ...(g.data.kind !== "visual" && g.data.expose?.some((x) => byId.has(x.to[0])) ? { expose: g.data.expose.filter((x) => byId.has(x.to[0])) } : {}),
    };
  });
}
