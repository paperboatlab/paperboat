import test from "node:test";
import assert from "node:assert/strict";
import { docsHelp, type BlockDef, type DocSite } from "@paperboat/shared";
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

const site: DocSite = {
  site: "toolkits/math", title: "math", url: "https://x.test/toolkits/math/",
  items: [{ id: "index", title: "math", page: "math", url: "https://x.test/toolkits/math/index.html", summary: "Pointwise arithmetic.", html: "<p>Pointwise arithmetic.</p>" }],
  blocks: { gain: "<p>Use a negative k to invert.</p>" },
};
const docs = docsHelp(Promise.resolve([site]));

test("help finds blocks by label, type or description; station-linked blocks stay out", async () => {
  const help = paperboatHelp(() => [gain, linked], docs);
  const ids = async (q: string) => (await help.items(q)).map((i) => i.id);
  assert.ok((await ids("gain")).includes("block:gain"));
  assert.ok((await ids("multiplies")).includes("block:gain"));
  assert.ok(!(await ids("")).includes("block:body"));
  assert.equal((await help.page("block:gain"))?.title, "Gain");
});

test("a block's page carries its toolkit's prose; the docs are searched with the blocks", async () => {
  const help = paperboatHelp(() => [gain], docs);
  assert.match((await help.page("block:gain"))?.html ?? "", /Use a negative k to invert/);
  assert.deepEqual((await help.items("")).map((i) => i.title), ["math", "Gain"]);
  assert.deepEqual((await help.items("arithmetic")).map((i) => i.title), ["math"]);
  assert.equal((await help.page("doc:toolkits/math:index"))?.title, "math");
});
