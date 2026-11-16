import assert from "node:assert/strict";
import { test } from "node:test";
import { startWords, type BackendStatus } from "../src/backendStart.ts";

const url = "ws://localhost:8791";
const at = (b: Partial<BackendStatus>): BackendStatus[] => [{ name: "cart-pole", state: "building", port: 8791, ...b }];

test("the wait screen says what the backend on the app's port is doing", () => {
  assert.deepEqual(startWords(at({ stage: "compile", elapsed: 42.1 }), url), { words: "compiling cart-pole", failed: false, elapsed: 42.1 });
  assert.equal(startWords(at({ stage: "configure" }), url)?.words, "configuring cart-pole");
  assert.equal(startWords(at({ state: "starting", stage: "waiting" }), url)?.words, "starting cart-pole");
  assert.deepEqual(startWords(at({ state: "failed", error: "build failed: main.cpp:18: error: x" }), url), {
    words: "cart-pole failed to start: build failed: main.cpp:18: error: x",
    failed: true,
  });
  assert.equal(startWords(at({ state: "running" }), url), null, "running: the socket says the rest");
  assert.equal(startWords(at({ port: 8765 }), url), null, "another port");
  assert.equal(startWords(at({}), "not a url"), null);
});
