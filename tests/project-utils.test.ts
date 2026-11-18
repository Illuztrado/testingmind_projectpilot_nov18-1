import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSprintSelection } from "../src/project-utils.ts";

// Small, deterministic sample backlog used by the tests below. No LLM or database
// is needed because sprint capacity/dependency rules are ordinary TypeScript logic.
const backlog = [
  { id: "WI-1", title: "Login form", estimatePoints: 5, status: "ready" as const, dependencies: [] },
  { id: "WI-2", title: "Session refresh", estimatePoints: 8, status: "backlog" as const, dependencies: ["WI-1"] },
  { id: "WI-3", title: "Audit logging", estimatePoints: null, status: "backlog" as const, dependencies: ["WI-999"] }
];

// If 13 points are selected for a 10-point sprint, the evaluator must flag 3 points over.
test("sprint selection calculates capacity and identifies overcommitment", () => {
  const result = evaluateSprintSelection(backlog, ["WI-1", "WI-2"], 10, backlog);
  assert.equal(result.plannedPoints, 13);
  assert.equal(result.overCapacity, true);
  assert.equal(result.overBy, 3);
});

test("sprint selection flags unestimated items, missing IDs, and unfinished dependencies", () => {
  const result = evaluateSprintSelection(backlog, ["WI-3", "WI-missing"], 20, backlog);
  assert.deepEqual(result.unestimatedWorkItemIds, ["WI-3"]);
  assert.deepEqual(result.unknownWorkItemIds, ["WI-missing"]);
  assert.deepEqual(result.dependencyWarnings, [
    { workItemId: "WI-3", dependencyId: "WI-999", dependencyStatus: "not found" }
  ]);
});

test("completed work is excluded from sprint selection", () => {
  const candidates = [
    { id: "WI-DONE", title: "Completed story", estimatePoints: 5, status: "done" as const, dependencies: [] },
    { id: "WI-NEXT", title: "Next story", estimatePoints: 3, status: "ready" as const, dependencies: ["WI-DONE"] }
  ];
  const result = evaluateSprintSelection(candidates, ["WI-DONE", "WI-NEXT"], 5, candidates);
  assert.equal(result.plannedPoints, 3);
  assert.deepEqual(result.completedWorkItemIds, ["WI-DONE"]);
  assert.deepEqual(result.selected.map((item) => item.id), ["WI-NEXT"]);
  assert.deepEqual(result.dependencyWarnings, []);
});
