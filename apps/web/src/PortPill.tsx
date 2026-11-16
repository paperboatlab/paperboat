import { Position, useReactFlow, useStore, type NodeProps } from "@xyflow/react";
import { useRef, useState } from "react";
import { PortHandle } from "./wireSnap";
import { OUTER, PORT_IN, portBlocksOf } from "./portBlocks";
import type { BlockNode, Wire } from "./flowModel";

/**
 * An In or Out block, drawn as the pill a subsystem's port is inside it: `In 2`, its number among
 * its group's Ins top to bottom (the port it is on the group's block), then its name if it has
 * one. Double-click the pill to name it; Enter keeps, Escape cancels, empty goes back to `In 2`.
 */
export function PortPill({ id, data, selected }: NodeProps<BlockNode>) {
  const { updateNodeData } = useReactFlow<BlockNode, Wire>();
  const into = data.def.type === PORT_IN;
  const name = String(data.params.name ?? "").trim();
  // Its number among the In (or Out) blocks beside it: re-read only when that number changes.
  const index = useStore((s) => {
    const me = s.nodeLookup.get(id);
    const kin = [...s.nodeLookup.values()].filter((n) => n.parentId === me?.parentId && (n.data as BlockNode["data"]).def?.type === data.def.type);
    return portBlocksOf(kin).find((p) => p.node.id === id)?.index ?? 1;
  });
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  const tag = `${into ? "In" : "Out"} ${index}`;
  return (
    <div
      className={`port-pill ${into ? "in" : "out"}${selected ? " selected" : ""}`}
      title={`${into ? "Input" : "Output"} ${index} of the group${name ? `: ${name}` : ""}. Double-click to name it`}
      onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))}
    >
      {/* The port facing outside the group is the group's own: there, not drawn here. */}
      <PortHandle type={into ? "target" : "source"} position={into ? Position.Left : Position.Right} id={OUTER} />
      {!into && <PortHandle type="target" position={Position.Left} id="u" />}
      <span className="port-pill-tag">{tag}</span>
      {editing ? (
        <input
          className="port-pill-name nodrag"
          autoFocus
          defaultValue={name}
          placeholder="name"
          aria-label={`Name of ${tag}`}
          size={Math.max(4, name.length)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") (cancel.current = true), e.currentTarget.blur();
          }}
          onBlur={(e) => {
            setEditing(false);
            if (!cancel.current) updateNodeData(id, { params: { ...data.params, name: e.currentTarget.value.trim() } });
            cancel.current = false;
          }}
        />
      ) : (
        name && <span className="port-pill-name">{name}</span>
      )}
      {into && <PortHandle type="source" position={Position.Right} id="y" />}
    </div>
  );
}
