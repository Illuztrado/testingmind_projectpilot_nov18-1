// Shared status values used by backlog items and sprint validation.
export type WorkStatus = "backlog" | "ready" | "in_progress" | "blocked" | "done";

// The sprint evaluator only needs these fields; keeping the input small makes
// the function easy to test without Cloudflare, SQLite, or an LLM.
export interface SprintCandidate {
  id: string;
  title: string;
  estimatePoints: number | null;
  status: WorkStatus;
  dependencies: string[];
}

export interface SprintDependencyWarning {
  workItemId: string;
  dependencyId: string;
  dependencyStatus: string;
}

/**
 * Deterministic sprint arithmetic. The agent may recommend a selection, but
 * capacity, unestimated work, missing IDs, and dependency warnings are computed
 * by code instead of being left to the LLM to guess.
 */
export function evaluateSprintSelection(
  candidates: SprintCandidate[],
  requestedIds: string[],
  capacityPoints: number,
  allItems: SprintCandidate[]
) {
  // Index candidates by ID so requested sprint selections can be resolved quickly.
  const byId = new Map(candidates.map((item) => [item.id, item]));
  // Resolve only IDs that actually belong to this project's backlog. Unknown IDs
  // are returned separately so the UI can flag stale or invalid selections.
  const requestedItems = requestedIds.map((id) => byId.get(id)).filter((item): item is SprintCandidate => Boolean(item));
  const unknownIds = requestedIds.filter((id) => !byId.has(id));
  // Completed items should not consume capacity in a new sprint proposal.
  const completedWorkItemIds = requestedItems.filter((item) => item.status === "done").map((item) => item.id);
  const selected = requestedItems.filter((item) => item.status !== "done");
  const selectedIds = new Set(selected.map((item) => item.id));
  // Sum known estimates. Unestimated items contribute zero here but are reported
  // below, so the user is warned rather than being given a misleading total.
  const plannedPoints = selected.reduce((sum, item) => sum + (item.estimatePoints ?? 0), 0);
  const unestimatedWorkItemIds = selected.filter((item) => item.estimatePoints === null).map((item) => item.id);
  const dependencyWarnings: SprintDependencyWarning[] = [];

  // A dependency is acceptable only if it is already done or included in this
  // same sprint. Missing dependencies and unfinished dependencies are warnings.
  for (const item of selected) {
    for (const dependencyId of item.dependencies) {
      const dependency = allItems.find((candidate) => candidate.id === dependencyId);
      if (!dependency || (dependency.status !== "done" && !selectedIds.has(dependencyId))) {
        dependencyWarnings.push({
          workItemId: item.id,
          dependencyId,
          dependencyStatus: dependency?.status ?? "not found"
        });
      }
    }
  }

  // Return raw findings instead of making a go/no-go decision. The sprint remains
  // a draft and a human decides whether the warnings are acceptable.
  return {
    selected,
    selectedCount: selected.length,
    completedWorkItemIds,
    plannedPoints,
    capacityPoints,
    remainingCapacity: capacityPoints - plannedPoints,
    overCapacity: plannedPoints > capacityPoints,
    overBy: Math.max(0, plannedPoints - capacityPoints),
    unestimatedWorkItemIds,
    dependencyWarnings,
    unknownWorkItemIds: unknownIds
  };
}

