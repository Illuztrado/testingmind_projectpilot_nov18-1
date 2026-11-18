# Focused ProjectPilot scope — changes

This version narrows ProjectPilot to three capabilities:

1. Objective → approved project brief and phased deliverables.
2. Deliverables → approved backlog of epics, stories and tasks.
3. Saved backlog → approved draft sprint proposal.

## User interface

- The project summary displays saved phased deliverables.
- The Backlog tab displays persisted epics, stories and tasks with filters and expandable details.
- The Sprint plan tab displays saved draft proposals, selected items, capacity, and recomputed warnings.
- The agent panel displays the exact proposed tool input and approve/reject actions for pending writes.
- `ui-preview.html` and `sprint-preview.html` are static sample-data previews; the interactive app is available through `npm run dev`.

## Data safety

- `createProject`, `createBacklogItems`, and `draftSprintPlan` are the only server-side write tools.
- All three use `needsApproval: true`.
- The SQL inserts are inside each tool's `execute` handler. The SDK pauses execution until an approval response is received.
- `listProjects`, `listBacklog`, and `getWorkspaceBoard` are read-only.
- No update or delete tools are exposed in this version.
- The `projects` table has a lightweight migration that adds a JSON `deliverables` column to an earlier workspace schema.

## Validation performed in the authoring environment

- 8 unit/static policy tests passed.
- TypeScript/TSX syntax transpile checks passed for `src/server.ts`, `src/app.tsx`, and `src/project-utils.ts`.
- The 10-slide PowerPoint was converted to PDF successfully for visual inspection.
- A full dependency-backed `npm run check` and `npm run build` were not completed because dependency installation did not finish in the authoring environment. Run them locally before the workshop or deployment.

## Reliability and workspace interaction patch (November 2026)

- Added a turn-end chat error callback; the board refresh processor now runs on completed tool-part updates and again as a terminal-turn fallback, but processes only successfully completed writes.
- Guard concurrent board reads with a request sequence so an older response cannot overwrite the currently selected project's latest state.
- Display the AI SDK tool-part `errorText` field and expose a compact diagnostic section instead of looking for an error in the regular tool output payload.
- Accept `null` for optional date, backlog estimate, criteria, priority, dependency, scope and stakeholder fields; normalize those values before persistence.
- Disable additional chat submissions while a request is submitted or streaming.
- Add backlog search and priority/status filters, plus a direct "View in backlog" action from each saved sprint item.
- Preserve the focused scope: no update/delete data tools were added; saved writes remain approval-gated.

- Final validation of the November patch: 18 automated tests passed on November 18, 2026. A dependency-backed build remains to be run locally because npm installation timed out in the authoring environment.


## Approval continuation and read-after-write fix (November 18, 2026)

- Strengthen the system prompt so a user request to create/save a backlog or sprint requires an actual `createBacklogItems` / `draftSprintPlan` tool call. Text-only proposals no longer substitute for the UI approval card. Missing inputs still trigger clarification instead of a write call.
- Attach the selected workspace project's ID, name, and objective to typed prompts, not only shortcut prompts, so approval-gated writes target the project visible in the project picker.
- Explicitly enable `autoContinueAfterToolResult` in `useAgentChat`. Clicking **Approve & save** now sends the approval back through the Cloudflare AI Chat protocol and resumes the paused server-side tool execution; approval is not treated as a completed write by itself.
- Read the tool approval ID directly from the AI SDK UI message part and render a visible **Approval received / Saving approved changes…** state while the continuation is running.
- Refresh the saved workspace only when an approved write tool reaches `output-available` / normalized `complete` and its result includes `persisted: true`, confirming the server-side `execute()` handler returned a saved result. The refresh reads the actual SQLite-backed board through `getWorkspaceBoard()`.
- Run the same completion processor from the live messages effect and `onTurnEnd` terminal callback. This catches final message updates batched by React; a set of processed tool-call IDs prevents duplicate refreshes.
- After backlog creation, switch to the Backlog tab. After sprint planning, switch to Sprint Plan and select the newly persisted sprint. Refresh targets the project ID carried by the approved tool call, not a stale project selection.
- Treat a missing project as a tool execution error rather than a successful tool result containing an `{ error }` object. This prevents a false-positive UI refresh after a failed write.
- Added regression checks for automatic approval continuation and the write-completion/read-after-write behavior.
