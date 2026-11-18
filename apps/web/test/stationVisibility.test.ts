import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendVisibilityKey,
  readStationChoices,
  resolveStationVisible,
  STATION_STORAGE_KEY,
  writeStationChoice,
} from "../src/stationVisibility.ts";

function mockStorage(initial: Record<string, string> = {}) {
  const box = new Map<string, string>(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => void box.set(k, v),
    removeItem: (k: string) => void box.delete(k),
  } as Storage;
  return box;
}

test("resolveStationVisible follows hello.station.visible in auto mode and honors explicit overrides", () => {
  assert.equal(resolveStationVisible("auto", undefined), true);
  assert.equal(resolveStationVisible("auto", true), true);
  assert.equal(resolveStationVisible("auto", false), false);
  assert.equal(resolveStationVisible("shown", false), true);
  assert.equal(resolveStationVisible("hidden", true), false);
});

test("choices are scoped per backend and do not leak between workbench and domain backends", () => {
  mockStorage();
  const workbench = backendVisibilityKey("ws://localhost:8765", "workbench");
  const cartPole = backendVisibilityKey("ws://localhost:8766", "cart-pole");

  // User shows Station on cart-pole (or hides it); workbench stays on auto (hidden)
  writeStationChoice(cartPole, "hidden");
  let choices = readStationChoices();
  assert.equal(resolveStationVisible(choices[workbench] ?? "auto", false), false);
  assert.equal(resolveStationVisible(choices[cartPole] ?? "auto", true), false);

  // User shows Station on workbench once; cart-pole stays independent, and switching back to auto clears override
  writeStationChoice(workbench, "shown");
  writeStationChoice(cartPole, "auto");
  choices = readStationChoices();
  assert.equal(resolveStationVisible(choices[workbench] ?? "auto", false), true);
  assert.equal(resolveStationVisible(choices[cartPole] ?? "auto", true), true);

  writeStationChoice(workbench, "auto");
  choices = readStationChoices();
  assert.equal(resolveStationVisible(choices[workbench] ?? "auto", false), false);
});

test("legacy global paperboat.station values migrate cleanly to auto", () => {
  for (const legacy of ["shown", "hidden", "auto", JSON.stringify("shown")]) {
    const box = mockStorage({ [STATION_STORAGE_KEY]: legacy });
    assert.deepEqual(readStationChoices(), {});
    assert.equal(box.has(STATION_STORAGE_KEY), false);
  }
});
