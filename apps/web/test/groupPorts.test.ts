import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "@xyflow/react";
import { keepPorts, withPort, type Expose } from "../src/groupPorts.ts";

// src → [ inner ] → dst, inner in a subsystem
const node = (id: string, parentId?: string, data: object = {}): Node => ({ id, type: parentId === undefined && id === "sub" ? "frame" : "block", position: { x: 0, y: 0 }, ...(parentId ? { parentId } : {}), data });
const nodes = [node("src"), node("dst"), node("sub", undefined, { kind: "subsystem" }), node("inner", "sub")];
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}-${target}`, source, sourceHandle, target, targetHandle });
const exposeOf = (ns: Node[]) => (ns.find((n) => n.id === "sub")!.data as { expose?: Expose[] }).expose;

test("a wire removed across a subsystem's edge leaves its port; one inside or outside doesn't", () => {
  const kept = keepPorts(nodes, [wire("src", "y", "inner", "u"), wire("inner", "y", "dst", "u")]);
  assert.deepEqual(exposeOf(kept), [{ side: "in", to: ["inner", "u"] }, { side: "out", to: ["inner", "y"] }]);
  assert.equal(keepPorts(kept, [wire("src", "y", "inner", "u")]), kept, "already kept: unchanged");
  assert.equal(keepPorts(nodes, [wire("src", "y", "dst", "u")]), nodes, "outside only");
  const frame = nodes.map((n) => (n.id === "sub" ? { ...n, data: { kind: "visual" } } : n));
  assert.equal(keepPorts(frame, [wire("src", "y", "inner", "u")]), frame, "a frame has no ports of its own");
});

test("a port renamed, named back, removed; naming a wired port exposes it", () => {
  const named = withPort([{ side: "in", to: ["inner", "u"] }], "in", [["inner", "u"]], "ref");
  assert.deepEqual(named, [{ side: "in", to: ["inner", "u"], name: "ref" }]);
  assert.deepEqual(withPort(named, "in", [["inner", "u"]], ""), [{ side: "in", to: ["inner", "u"] }]);
  assert.deepEqual(withPort(named, "in", [["inner", "u"]], null), []);
  assert.deepEqual(withPort(named, "out", [["inner", "u"]], null), named, "the other side is another port");
  assert.deepEqual(withPort([], "out", [["inner", "y"]], "y2"), [{ side: "out", to: ["inner", "y"], name: "y2" }]);
});
