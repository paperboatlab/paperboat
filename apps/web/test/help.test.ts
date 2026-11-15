import test from "node:test";
import assert from "node:assert/strict";
import type { BlockDef } from "@paperboat/shared";
import { blockPage, paperboatHelp } from "../src/help.ts";

const gain: BlockDef = {
  type: "gain", label: "Gain", kind: "function", group: "math", description: "Multiplies the input by k.",
  inputs: [{ id: "u", type: "signal", unit: "m" }], outputs: [{ id: "y", type: "signal" }],
  params: [{ id: "k", type: "number", default: 2, unit: "1/s" }, { id: "mode", type: "enum", default: "a", options: ["a", "b"] }],
};
const linked: BlockDef = { type: "body", label: "Body", kind: "probe", inputs: [], outputs: [], params: [], linked: true };

test("a block's page says what it does, its ports and its params", () => {
  const text = blockPage(gain).text ?? "";
  assert.match(text, /Multiplies the input by k/);
  assert.match(text, /`u` \[m\]/);
  assert.match(text, /`k` number, default 2 1\/s/);
  assert.match(text, /one of a, b/);
});

test("help finds blocks by label, type or description; station-linked blocks stay out", async () => {
  const help = paperboatHelp(() => [gain, linked]);
  const ids = async (q: string) => (await help.items(q)).map((i) => i.id);
  assert.ok((await ids("gain")).includes("block:gain"));
  assert.ok((await ids("multiplies")).includes("block:gain"));
  assert.ok(!(await ids("")).includes("block:body"));
  assert.equal((await help.page("block:gain"))?.title, "Gain");
});
