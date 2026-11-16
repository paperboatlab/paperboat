// The selection dialog (#54): over the blocks and groups picked on the Flow canvas, what can be
// done to them all at once.

import { NodeToolbar, Position } from "@xyflow/react";
import { useState, type CSSProperties } from "react";
import type { GroupData, GroupNode } from "./groups";
import { isBlock, type BlockNode, type FlowNode, type Wire } from "./flowModel";

type Props = {
  pickedNodes: FlowNode[];
  pickedBlocks: BlockNode[];
  pickedWires: Wire[];
  pickedFrames: GroupNode[];
  /** Something is picked, and nothing is being dragged. */
  isVisible: boolean;
  /** Room for the dialog above the selection, else it goes below. */
  roomAbove: boolean;
  allCommented: boolean;
  /** Linked blocks among the picked: they aren't deleted. */
  kept: number;
  canGroup: boolean;
  canFrame: boolean;
  canStory: boolean;
  toggleComment: (mode: "out" | "through") => void;
  removePicked: () => void;
  group: (kind: GroupData["kind"]) => void;
  ungroup: (id: string) => void;
  /** Analyse the picked blocks and groups (pb#370); absent when no toolkit offers an analysis. */
  analyse?: () => void;
};

export function SelectionDialog({ pickedNodes, pickedBlocks, pickedWires, pickedFrames, isVisible, roomAbove, allCommented, kept, canGroup, canFrame, canStory, toggleComment, removePicked, group, ungroup, analyse }: Props) {
  /** The group unfolded by hover or focus: its actions slide out in brackets, the rest of the bar dims. */
  const [open, setOpen] = useState<string | null>(null);
  const counted = (n: number, one: string) => (n ? [`${n} ${one}${n === 1 ? "" : "s"}`] : []);
  const summary = [
    ...counted(pickedNodes.filter(isBlock).length, "block"),
    ...counted(pickedFrames.length, "group"),
    ...counted(pickedWires.length, "wire"),
  ].join(" · ");
  return (
    <NodeToolbar
      nodeId={pickedNodes.map((n) => n.id)}
      isVisible={isVisible}
      position={roomAbove ? Position.Top : Position.Bottom}
      offset={14}
      className={`selection-dialog nodrag nopan nowheel${open ? " hud-on" : ""}`}
    >
      <span className="lbl">{summary}</span>
      <div className="hud" onPointerLeave={() => setOpen(null)}>
        <HudGroup
          id="comment"
          label={allCommented ? "Uncomment" : "Comment"}
          open={open}
          setOpen={setOpen}
          items={[
            { label: allCommented ? "Uncomment" : "Comment out", keys: "Ctrl+/", title: "Leave the blocks out of the run", disabled: pickedBlocks.length === 0, run: () => toggleComment("out") },
            { label: "Bypass", keys: "Ctrl+Shift+Y", title: "Pass each block's input straight to its output", disabled: pickedBlocks.length === 0, run: () => toggleComment("through") },
          ]}
        />
        <HudGroup
          id="group"
          label="Group"
          open={open}
          setOpen={setOpen}
          items={[
            { label: "Subsystem", title: canGroup ? "One block here, its insides on their own level (double-click it to open)" : "Pick blocks or groups in the same place (not some in a frame)", disabled: !canGroup, run: () => group("subsystem") },
            ...(canStory ? [{ label: "Story", title: "One step of a Step flow", run: () => group("story") }] : []),
            { label: "Frame", title: "A frame round them: tidy, they stay on this level and run as before", disabled: !canFrame, run: () => group("visual") },
            ...(pickedFrames.length ? [{ label: "Ungroup", title: "Put the selected groups' blocks back on this level", run: () => pickedFrames.forEach((f) => ungroup(f.id)) }] : []),
          ]}
        />
        {analyse && (
          <button
            className="key small hud-key"
            disabled={pickedBlocks.length + pickedFrames.length === 0}
            title="Analyse the selection outside the flow: its inputs fed from outside, its outputs read outside"
            onClick={analyse}
            onPointerEnter={() => setOpen(null)}
          >
            Analyse
          </button>
        )}
        <button
          className="key small icon-key hud-delete"
          disabled={kept === pickedNodes.length && pickedWires.length === 0}
          title="Delete the selection (Delete)"
          aria-label="Delete the selection"
          onClick={removePicked}
          onPointerEnter={() => setOpen(null)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4" /></svg>
        </button>
      </div>
      {kept > 0 && (
        <span className="lbl kept" title="Linked blocks come from the backend's own graph">
          {kept} linked {kept === 1 ? "block stays" : "blocks stay"}
        </span>
      )}
    </NodeToolbar>
  );
}

type HudItem = { label: string; keys?: string; title: string; disabled?: boolean; run: () => void };

/**
 * One group of the selection bar: its name, and its actions folded away until it is hovered or
 * focused. Then they slide out one after another inside corner brackets, each with its keys. A
 * click on the name pins it open (touch), Escape folds it.
 */
function HudGroup({ id, label, items, open, setOpen }: { id: string; label: string; items: HudItem[]; open: string | null; setOpen: (id: string | null) => void }) {
  const on = open === id;
  return (
    <div
      className={`hud-group${on ? " on" : ""}`}
      onPointerEnter={() => setOpen(id)}
      onFocus={() => setOpen(id)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(null); }}
      onKeyDown={(e) => { if (e.key === "Escape" && on) { e.stopPropagation(); setOpen(null); } }}
    >
      <button className="hud-head" aria-expanded={on} onClick={() => setOpen(on ? null : id)}>
        {label}
      </button>
      <span className="hud-items" role="group" aria-label={label} inert={!on}>
        {items.map((item, i) => (
          <button key={item.label} className="hud-item" style={{ "--i": i } as CSSProperties} disabled={item.disabled} title={item.title} onClick={item.run}>
            {item.label}
            {item.keys && <kbd>{item.keys}</kbd>}
          </button>
        ))}
      </span>
    </div>
  );
}
