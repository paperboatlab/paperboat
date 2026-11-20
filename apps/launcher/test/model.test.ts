import assert from "node:assert/strict";
import test from "node:test";
import { appDisplayTitle, buildToolkitBlockCards, completeInput, pstDisplayName, splitCommandWords } from "../src/model.ts";

test("splitCommandWords preserves quoted arguments", () => {
  assert.deepEqual(splitCommandWords('run "my station/dir" --port 8766'), ["run", "my station/dir", "--port", "8766"]);
  assert.deepEqual(splitCommandWords("unpack 'pendulum-0.1.0.pst'"), ["unpack", "pendulum-0.1.0.pst"]);
});

test("pstDisplayName extracts station name from .pst filename", () => {
  assert.equal(pstDisplayName("/tmp/pendulum-control-0.2.0.pst"), "pendulum-control");
  assert.equal(pstDisplayName("C:\\Users\\demo\\cart-pole.pst"), "cart-pole");
});

test("appDisplayTitle formats Squero Studio names cleanly", () => {
  assert.equal(appDisplayTitle("squero-studio-om"), "Squero Studio OM");
  assert.equal(appDisplayTitle("squero-studio-mx"), "Squero Studio MX");
});

test("completeInput completes commands, stations, and flags", () => {
  const commands = [
    { name: "run", summary: "Run a station", aliases: [], subcommands: [], flags: ["--port", "--no-build"], arg: "station" },
    { name: "squero", summary: "Manage Squero apps", aliases: [], subcommands: ["list", "install", "uninstall"], flags: ["--all"], arg: "" },
  ];
  const stations = [{ name: "02-cart-pole", language: "cpp", port: 8766, dir: "/x", description: "", source: "example" }];
  const c1 = completeInput("ru", commands, stations, [], []);
  assert.equal(c1.ghost, "run");
  const c2 = completeInput("run 02", commands, stations, [], []);
  assert.equal(c2.candidates[0]?.value, "02-cart-pole");
  const c3 = completeInput("run --p", commands, stations, [], []);
  assert.equal(c3.ghost, "run --port");
});

test("buildToolkitBlockCards builds rich block cards with descriptions and fallback notes", () => {
  const fromInspect = buildToolkitBlockCards("control", {
    flow_blocks: [{ type: "control/pid", label: "PID", description: "Drives an error to zero." }],
    station_blocks: [{ type: "control/arm", label: "Arm", description: "Planar link." }],
    board_instruments: [{ type: "board/scope", label: "Scope", description: "Multi-channel scope." }],
  });
  assert.equal(fromInspect.length, 3);
  assert.deepEqual(fromInspect[0], {
    type: "control/pid",
    label: "PID",
    kind: "flow",
    group: "control",
    description: "Drives an error to zero.",
  });
  assert.equal(fromInspect[1]?.kind, "station");
  assert.equal(fromInspect[2]?.kind, "board");

  const fallback = buildToolkitBlockCards("control", null, ["pid", "lqr"]);
  assert.equal(fallback.length, 2);
  assert.equal(fallback[0]?.label, "PID");
  assert.ok(fallback[0]!.description.includes("Proportional-integral-derivative"));
});
