// Per-backend Station page visibility (#407): each backend starts from its own
// `hello.station.visible` default ("auto"), and a manual View toggle applies only to that
// backend rather than leaking across every backend in the browser.

import { useCallback, useState } from "react";
import { readStored, writeStored } from "./storage.ts";

export type StationChoice = "auto" | "shown" | "hidden";
export const STATION_STORAGE_KEY = "paperboat.station";

const isChoice = (v: unknown): v is StationChoice => v === "auto" || v === "shown" || v === "hidden";

function isChoiceMap(v: unknown): v is Record<string, StationChoice> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(isChoice);
}

/** Stable key identifying a backend connection (endpoint URL + reported engine name). */
export function backendVisibilityKey(url: string, engine?: string): string {
  return engine ? `${url}#${engine}` : url;
}

/** Resolve whether the Station page is shown from the backend's choice and hello.station.visible. */
export function resolveStationVisible(choice: StationChoice, helloVisible?: boolean): boolean {
  return choice === "auto" ? helloVisible !== false : choice === "shown";
}

/** Read per-backend station choices, dropping any legacy global string value to auto. */
export function readStationChoices(): Record<string, StationChoice> {
  try {
    const raw = localStorage.getItem(STATION_STORAGE_KEY);
    if (raw === "auto" || raw === "shown" || raw === "hidden") {
      localStorage.removeItem(STATION_STORAGE_KEY);
      return {};
    }
  } catch {
    return {};
  }
  const map = readStored(STATION_STORAGE_KEY, isChoiceMap);
  if (!map) {
    // Legacy JSON string ("shown"/"hidden") or corrupt entry: reset to auto so it never leaks.
    writeStored(STATION_STORAGE_KEY, undefined);
    return {};
  }
  return map;
}

/** Update one backend's choice in storage ("auto" clears the override back to backend default). */
export function writeStationChoice(key: string, choice: StationChoice, current = readStationChoices()): Record<string, StationChoice> {
  const next = { ...current };
  if (choice === "auto") delete next[key];
  else next[key] = choice;
  writeStored(STATION_STORAGE_KEY, Object.keys(next).length ? next : undefined);
  return next;
}

/** Per-backend Station page visibility choice ("auto" follows hello.station.visible). */
export function useStationVisibility(url: string, engine?: string): [StationChoice, (c: StationChoice) => void] {
  const key = backendVisibilityKey(url, engine);
  const [choices, setChoices] = useState<Record<string, StationChoice>>(() => readStationChoices());
  const choice = choices[key] ?? "auto";
  const setChoice = useCallback(
    (next: StationChoice) => {
      setChoices((prev) => writeStationChoice(key, next, prev));
    },
    [key],
  );
  return [choice, setChoice];
}
