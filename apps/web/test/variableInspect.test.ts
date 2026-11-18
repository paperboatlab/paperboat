import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectVariable } from "../src/variableInspect.ts";
import type { Variable } from "../src/protocol.ts";

test("inspectVariable turns MX scalars, vectors, and matrices into grid values with shape tags", () => {
  const scalar: Variable = { name: "x_opt", type: "number", value: 0.999999, source: "mx" };
  assert.deepEqual(inspectVariable(scalar), { value: 0.999999, tags: ["number", "1 × 1"] });

  const mat: Variable = { name: "A", type: "matrix", value: "1 -1 0; 2 3 4", source: "mx" };
  assert.deepEqual(inspectVariable(mat), { value: [[1, -1, 0], [2, 3, 4]], tags: ["matrix", "2 × 3"] });

  const jsonMat: Variable = { name: "X", type: "matrix", value: "[[1,2],[3,4],[5,6]]", source: "mx" };
  assert.deepEqual(inspectVariable(jsonMat), { value: [[1, 2], [3, 4], [5, 6]], tags: ["matrix", "3 × 2"] });
});

test("inspectVariable keeps functions, text, and oversized notes as wrapped full text", () => {
  const fn: Variable = { name: "fun", type: "function" as Variable["type"], value: "(x1, x2) -> x1^2 + x2^2", source: "mx" };
  assert.deepEqual(inspectVariable(fn), { value: "(x1, x2) -> x1^2 + x2^2", tags: ["function"] });

  const big: Variable = { name: "dist2", type: "matrix", source: "mx", note: "150 × 150 Matrix{Float64}: too large to share live" };
  assert.deepEqual(inspectVariable(big), { value: "150 × 150 Matrix{Float64}: too large to share live", tags: ["matrix"] });
});
