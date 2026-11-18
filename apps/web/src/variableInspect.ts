import type { ValueGridValue } from "@paperboat/shared";
import { parseMatrixCells } from "./bindings.ts";
import type { Variable } from "./protocol";

export type InspectedVariable = {
  value: ValueGridValue | string;
  tags: string[];
};

const isNumRow = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number");

/** Format a live MX variable for the shared ValueTable modal (grid for scalars/arrays, wrapped text otherwise). */
export function inspectVariable(v: Variable): InspectedVariable {
  if (v.value === undefined) {
    return { value: v.note ?? "–", tags: [v.type] };
  }
  if (typeof v.value === "number") {
    return { value: v.value, tags: [v.type, "1 × 1"] };
  }
  if (typeof v.value === "boolean") {
    return { value: v.value ? "on" : "off", tags: [v.type] };
  }
  if (Array.isArray(v.value)) {
    const arr = v.value as unknown[];
    if (isNumRow(arr)) {
      return { value: arr, tags: [v.type, `${arr.length} × 1`] };
    }
    if (arr.length > 0 && arr.every(isNumRow)) {
      const cols = (arr[0] as number[]).length;
      if (arr.every((r) => (r as number[]).length === cols)) {
        return { value: arr as number[][], tags: [v.type, `${arr.length} × ${cols}`] };
      }
    }
    return { value: JSON.stringify(arr), tags: [v.type] };
  }
  if (typeof v.value === "string") {
    const trimmed = v.value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isNumRow(parsed) && parsed.length > 0) {
          return { value: parsed, tags: [v.type, `${parsed.length} × 1`] };
        }
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isNumRow)) {
          const cols = (parsed[0] as number[]).length;
          if (cols > 0 && parsed.every((r) => (r as number[]).length === cols)) {
            return { value: parsed as number[][], tags: [v.type, `${parsed.length} × ${cols}`] };
          }
        }
      } catch {
        // Fall through to MATLAB-style matrix syntax check
      }
    }
    const matrix = parseMatrixCells(v.value);
    if (!("error" in matrix) && matrix.rows > 0 && matrix.cols > 0) {
      return { value: matrix.cells, tags: [v.type, `${matrix.rows} × ${matrix.cols}`] };
    }
    return { value: v.value, tags: [v.type] };
  }
  return { value: String(v.value), tags: [v.type] };
}
