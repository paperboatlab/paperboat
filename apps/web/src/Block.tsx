import { useReactFlow, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { captionValue, CompactBlock, Glyph } from "./Compact";
import { signOf } from "./ports";
import { fits } from "./bindings";
import { iconValid, rotateIcon } from "@paperboat/shared";
import { usePortLayout } from "./portLayout";
import { PageIcon } from "./Shell";
import { ParamRow } from "./ParamFields";
import { ConnectorsContext, IconWires, OnBlocks, RunStates } from "./flowContexts";
import { hasStepPorts, inForm, type BlockNode, type Wire } from "./flowModel";
import { makeRoom, type Rect } from "./flowLayout";
import { draggedVariable, VAR_DRAG } from "./Variables";
import { VarsContext } from "./VarsContext";
import { runWord } from "./engine";
import { isPortType } from "./portBlocks";
import { PortPill } from "./PortPill";
import type { ParamValue } from "./protocol";

/** A card's head: what it sits above its port body, so a plate's ports line up with the card's. */
const HEAD = 28;
const nodeEl = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);

/**
 * Generic node: everything it shows comes from the backend's BlockDef. A block with a plate
 * (`view.compact` or an icon) draws as the plate; double-click floats its card over it to inspect
 * and edit, and the card's unfold key puts the card on the canvas instead (`unfolded`, saved),
 * making room for it. Other blocks are always their card. One card, the same three ways.
 */
export function Block(props: NodeProps<BlockNode>) {
  return isPortType(props.data.def.type) ? <PortPill {...props} /> : <BlockFace {...props} />;
}

function BlockFace({ id, data, selected }: NodeProps<BlockNode>) {
  const { updateNodeData, setNodes, getNode } = useReactFlow<BlockNode, Wire>();
  const states = useContext(RunStates);
  const vars = useContext(VarsContext);
  const active = states.active.has(id);
  const progress = states.progress[id];
  const { params, missing, commented, commentMode, comment, unfolded } = data;
  const def = inForm(data.def, params);
  const failed = states.failed.has(id);
  const word = runWord(states, id);
  const connectors = useContext(ConnectorsContext);
  const iconWires = useContext(IconWires);
  const on = useContext(OnBlocks).has(id);
  const [noteOpen, setNoteOpen] = useState(false);
  // Ports that follow a param come and go: have the canvas measure the handles again.
  const updateInternals = useUpdateNodeInternals();
  const portKey = [...def.inputs, ...def.outputs].map((p) => p.id).join(",");
  useEffect(() => updateInternals(id), [portKey, id, updateInternals, data.rotation, data.mirror, data.ports, unfolded]);
  const hasPlate = (!!def.view?.compact || iconValid(def.view?.icon)) && !missing && !hasStepPorts(def);
  const plate = hasPlate && !unfolded;
  const ports = usePortLayout({
    id,
    def,
    sides: data.ports,
    save: (ports) => updateNodeData(id, { ports }),
    disabled: missing,
    sign: (p, dir) => (dir === "in" ? signOf(def, params, def.inputs.indexOf(p)) : ""),
    handles: !plate, // a floating card's ports are the plate's dots under it
  });
  const setParam = (param: string, v: ParamValue) => updateNodeData(id, { params: { ...params, [param]: v } });

  // Unfold on the canvas: the card's port body takes the plate's place (its head above), then
  // what it grew over moves aside. Fold: the plate back where the card's body was.
  const moved = useRef<Rect | "fold" | null>(null);
  const move = (dx: number, dy: number, change: Partial<BlockNode["data"]> = {}) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy }, data: { ...n.data, ...change } } : n)));
  const toggleUnfold = () => {
    const node = getNode(id);
    if (!node) return;
    if (unfolded) {
      moved.current = "fold";
      move(0, HEAD, { unfolded: undefined });
      return;
    }
    const p = nodeEl(id)?.querySelector<HTMLElement>(".plate");
    const was = { x: node.position.x + (p?.offsetLeft ?? 0), y: node.position.y + (p?.offsetTop ?? 0), w: p?.offsetWidth ?? 64, h: p?.offsetHeight ?? 56 };
    moved.current = was;
    move(was.x - node.position.x, was.y - node.position.y - HEAD, { unfolded: true });
  };
  useLayoutEffect(() => {
    const was = moved.current;
    moved.current = null;
    const el = nodeEl(id);
    if (!was || !el) return;
    if (was === "fold") {
      const off = el.querySelector<HTMLElement>(".plate")?.offsetLeft ?? 0; // a caption wider than the plate centres it
      if (off) move(-off, 0);
    } else setNodes((ns) => makeRoom(ns, id, was, { x: was.x, y: was.y - HEAD, w: el.offsetWidth, h: el.offsetHeight }) as BlockNode[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unfolded]);

  // A variable dragged from the sheet onto the plate: bound to the one param it fits, or the
  // card opens so the user picks among the params it fits.
  const fitting = (e: DragEvent) => {
    const v = e.dataTransfer.types.includes(VAR_DRAG) ? vars?.list.find((x) => x.name === draggedVariable()) : undefined;
    return v && !vars?.locked ? def.params.filter((p) => fits(v, p)) : [];
  };

  const step = hasStepPorts(def);
  const mode = commentMode ?? "out";
  const classes = [
    "block",
    `kind-${def.kind}`,
    step && "step",
    selected && !plate && "selected",
    active && "active",
    def.linked && "linked",
    missing && "missing",
    failed && "failed",
    commented && "commented",
    commented && mode === "through" && "comment-through",
  ];
  // The head's tag says what is happening to the block, else what it is: words, not colours.
  const tag = commented
    ? mode === "through"
      ? "// bypass"
      : "// commented"
    : missing
      ? "missing"
      : word
        ? word
        : def.linked
          ? "linked"
          : step
            ? "step"
            : def.kind === "function"
              ? "fn"
              : def.kind;
  const card = (
    <div
      className={classes.filter(Boolean).join(" ")}
      title={missing ? `This backend has no "${def.type}" block: its params and wires are kept. Replace or delete it.` : undefined}
    >
      {ports.top}
      <div className="block-title">
        <span className="block-name" title={def.linked ? `Linked to station object ${id}: set its properties, or remove it, on the Station` : undefined}>
          {missing ? def.type : def.label}
          {def.linked && <span className="linked-tag"> <PageIcon page="station" className="link-mark" />{id}</span>}
        </span>
        {/* A glyph, shown on hover or selection; an ink one means a note is there. Not a second tag. */}
        <button
          type="button"
          className={`block-note-btn nodrag ${comment ? "has-note" : ""}`}
          title={comment ? `Note: ${comment}` : "Add note"}
          aria-label={comment ? `Edit note: ${comment}` : "Add note"}
          onClick={() => setNoteOpen((o) => !o)}
        >
          ✎
        </button>
        <span className={`block-tag tag-${tag}`}>{tag}</span>
        {hasPlate && (
          <button className="fold nodrag" title={unfolded ? "Fold back to a plate" : "Unfold on the canvas; what it covers moves aside"} onClick={toggleUnfold}>
            {unfolded ? "fold" : "unfold"}
          </button>
        )}
      </div>
      {noteOpen && (
        <div className="block-note-well nodrag nowheel nopan">
          <textarea
            className="block-note-input"
            placeholder="Notes or formulas..."
            value={comment ?? ""}
            onChange={(e) => updateNodeData(id, { comment: e.target.value })}
          />
        </div>
      )}
      {active && progress !== undefined && progress < 1 && (
        <div className="block-progress" title={`${Math.round(progress * 100)} %`}>
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="port-rows">
        {def.view?.glyph && !def.view.icon && <Glyph name={captionValue(def.view.glyph, params)} />}
        {ports.rows}
      </div>
      {def.params.length > 0 && (
        <div className="block-params">
          {def.params.map((p) => (
            <ParamRow key={p.id} def={p} value={params[p.id]} disabled={missing} set={(v) => setParam(p.id, v)} />
          ))}
        </div>
      )}
      {ports.bottom}
    </div>
  );
  if (!plate) return card;
  const placedIcon = (data.rotation || data.mirror) && def.view?.icon ? rotateIcon(def.view.icon, { rotation: data.rotation, mirror: data.mirror }) : def.view?.icon;
  return (
    <CompactBlock
      id={id}
      def={placedIcon ? { ...def, view: { ...def.view, icon: placedIcon } } : def}
      sides={data.ports}
      params={params}
      selected={!!selected}
      commented={commented}
      word={word}
      progress={progress}
      card={card}
      dropTake={(e) => (fitting(e).length === 1 ? "take" : fitting(e).length > 1 ? "open" : null)}
      onTake={(e) => {
        const [p] = fitting(e);
        if (p) setParam(p.id, { var: draggedVariable()! });
      }}
      connectors={connectors}
      wires={iconWires.count.get(id)}
      live={on}
    />
  );
}
