# ProjectPilot reliability and workspace interaction fixes

This patch is applied to the focused annotated ProjectPilot project and keeps it as the reference implementation.

## Chat and tool-call reliability

- The chat composer and workflow shortcuts are disabled while a turn is submitted/streaming or a write tool is waiting for approval. This prevents a second prompt from being appended while the previous assistant tool call is unresolved.
- Tool error cards read the AI SDK `errorText` field first, then other error/message fields, rather than trying to read a failed call as a normal tool output.
- Error cards expose the proposed input and key error state in an expandable diagnostic section.
- Tool schemas accept `null` or blank strings for optional dates, and `null` for optional scope, stakeholders, criteria, priorities, estimates, and dependencies, then normalize those values before writes.
- Database write failures are logged by the Worker and returned with the failing operation's context.

## Workspace refresh and interaction

- The `useAgentChat` hook explicitly sets `autoContinueAfterToolResult: true`, so approval responses are sent to the Durable Object and approved server-side tools resume without requiring another user prompt.
- The board refresh is triggered only after the write tool reaches `output-available` / normalized `complete` and returns `persisted: true`, never at the earlier approval-request or approval-response state.
- The same completion processor runs from both the live message-state effect and `useAgentChat`'s `onTurnEnd` callback. This covers the case where React batches the final tool-result update with the end-of-turn event.
- A shared tool-call ID set makes the completion processor idempotent, so one approved write causes one read-after-write refresh even when both synchronization paths observe it.
- The approval card sends the SDK approval ID through `addToolApprovalResponse({ id, approved: true })`; it shows **APPROVAL RECEIVED / Saving approved changes…** while the server continuation is running. Rejecting the action does not trigger a write or a success refresh.
- The system prompt now explicitly requires `createBacklogItems` or `draftSprintPlan` tool invocation for a user-requested save. A text-only proposal is no longer treated as an approval workflow; the model must create the approval card through the gated tool.
- Typed prompts now include the currently selected project ID, name, and objective, so the server-side write tool receives the same project the user sees selected in the workspace.
- A workspace refresh now also requires the write tool's explicit `persisted: true` result, not just a completed-looking tool state.
- Refresh requests are sequenced so an older in-flight response cannot overwrite a newer project selection.
- After backlog creation, the Backlog tab is selected. After sprint creation, the Sprint Plan tab is selected and the newly created sprint is chosen.
- Backlog now supports search by title, description, or ID; type, priority, and status filters; expandable item details; and a clear-filters state.
- Sprint view supports switching between saved sprint drafts and navigating from a sprint item directly to its exact backlog record by ID.
- A manual workspace refresh remains available in the project toolbar.

## Scope and safety preserved

- This remains the focused, create-only ProjectPilot version.
- The only write tools remain `createProject`, `createBacklogItems`, and `draftSprintPlan`.
- Every write still requires explicit human approval before its SQLite insert executes.
- No update or delete tools were added. Backlog and sprint screens provide navigation, inspection, filtering and selection of saved views; they do not silently mutate project records.

## Validation

- `node --experimental-strip-types --test tests/*.test.ts`: 18 tests passed.
- TypeScript transpile/syntax checks passed for `src/app.tsx`, `src/server.ts`, `src/project-utils.ts`, and `tests/approval-policy.test.ts`.
- A full `npm run check`, `npm run build`, and browser runtime test were not completed because `npm install --no-audit --no-fund` timed out in the authoring environment before dependencies were installed. Run the full checks locally before deployment.


## Approval-to-UI synchronization correction (November 18, 2026)

The previous patch refreshed too early / did not explicitly enable the approval continuation behavior. This correction addresses the complete lifecycle:

1. The UI calls `addToolApprovalResponse()` with the approval ID from the tool part.
2. `useAgentChat` has `autoContinueAfterToolResult: true`, so the approval response is sent to the Durable Object and the paused AI SDK run resumes.
3. The approved server-side tool executes its SQLite insert and returns its saved result.
4. The UI observes that the write tool part reached `output-available` and only then calls `getWorkspaceBoard()`.
5. Backlog creation opens the Backlog tab; sprint creation opens Sprint Plan and selects the newly saved sprint.

A pending approval or an approval response is not considered proof that a write succeeded. The refresh requires both a completed tool state and `persisted: true` in its result.
