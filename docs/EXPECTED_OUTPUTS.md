# Expected Outputs and Acceptance Checks

## Objective → project brief

- The agent asks about material missing information instead of inventing it.
- It proposes a project name, objective, scope and phased deliverables.
- An approval card displays the exact `createProject` arguments.
- Before approval, the project count in the project picker does not change.
- After approval, a project ID is returned and the project summary appears.
- After rejection, no project row is created.

## Deliverables → backlog

- The agent proposes epics, stories and implementation tasks.
- Items have actionable descriptions; acceptance criteria are present where appropriate.
- Priority is a recommendation. Story-point estimates are labeled as suggestions.
- Owners and due dates are not fabricated.
- An approval card displays all proposed items and fields.
- Before approval, the Backlog count does not change.
- After approval, items appear in the Backlog table with type, priority, status and estimate.
- After rejection, no work-item rows are created.

## Backlog → sprint proposal

- The agent reads saved backlog items before selecting them.
- It asks for explicit team capacity if not supplied.
- It proposes a sprint goal, dates if provided, selected saved item IDs and planned story points.
- The server computes capacity and dependency warnings deterministically.
- An approval card displays the exact proposed sprint fields and selected item IDs.
- Before approval, the saved sprint count does not change.
- After approval, the Sprint plan view shows a saved `draft` proposal, selected work items, planned/capacity points, and any recomputed capacity/dependency warnings.
- After rejection, no sprint row is created.
- Saving a draft sprint does not update work-item statuses.

## Human approval checks

1. Trigger `createProject`; verify execution waits at `approval-requested`.
2. Reject; verify no new project is visible after refresh.
3. Trigger `createProject` again and approve; verify the project appears.
4. Trigger `createBacklogItems`; reject and verify no items were inserted.
5. Repeat and approve; verify the backlog view updates.
6. Trigger `draftSprintPlan`; verify the exact capacity and selected item IDs appear in the approval card.
7. Reject and verify no sprint appears.
8. Repeat and approve; verify the sprint appears with status `draft`.

## Regression

```bash
# Type-check the source against the generated Cloudflare Worker types.
npm run check

# Run unit tests for approval rules and sprint calculations.
npm test

# Confirm the Vite/Cloudflare production bundle can be generated.
npm run build
```
