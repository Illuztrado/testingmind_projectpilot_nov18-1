# Troubleshooting

## TypeScript check

```bash
# Regenerate worker-configuration.d.ts from wrangler.jsonc.
npm run types

# Run the TypeScript compiler after the declarations are generated.
npm run check
```

`npm run types` regenerates `worker-configuration.d.ts`; do not rename an existing non-generated `env.d.ts` to this target. `tsconfig.json` should include the generated worker configuration.

## UI does not show updated backlog or sprint

- Confirm the agent response says the approved write completed.
- Click **Refresh** in the workspace toolbar.
- Confirm that the same browser workspace is being used; the workspace ID is kept in local storage.
- Check the Worker logs for SQLite or tool errors.

## Approval card does not appear

- A text-only backlog or sprint proposal is not an approval request. The system prompt now explicitly tells the agent to call `createBacklogItems` or `draftSprintPlan` when the user asks to save a completed proposal. Check the transcript for an actual tool call, not just assistant prose.
- Confirm the tool is still marked `needsApproval: true` in `src/server.ts`.
- Confirm the relevant tool's database `INSERT` is inside its `execute` function.
- Confirm `src/app.tsx` recognizes `approval-requested` / normalized `waiting-approval` and sends `addToolApprovalResponse` with the approval ID.
- Do not remove the approval gate to work around the issue.

## A rejected action still appears to have written data

Stop using the workspace and inspect Worker logs and SQLite state before continuing. The expected behavior is that rejected calls do not enter the tool's `execute` function. Treat any contrary behavior as a critical defect.

## Model or Workers AI errors

Check Wrangler authentication, the AI binding in `wrangler.jsonc`, current Workers AI availability and free quota. Do not add a payment method, upgrade, start a paid trial or use a paid-only model to work around a limit.

## Common workflow issue

The sprint tool requires saved backlog item IDs and an explicit capacity. Have the agent call `listBacklog` first. If estimates or dependencies are missing, it must flag them rather than invent facts.

## Backlog or sprint does not appear after approval

1. Wait for the approved tool call to finish. The workspace refreshes when the tool reaches its successful result state; `onTurnEnd` provides a fallback when the final streamed state update is batched by React.
2. Use **↻ Refresh** beside the project picker to request the saved board again.
3. Confirm the correct project is selected. Each browser workspace has its own Durable Object name and SQLite records.
4. If the tool card shows an error, expand **Show diagnostic details**. The visible error comes from the AI SDK `errorText` field; also inspect the Cloudflare Worker logs for the corresponding request.
5. For model-generated optional dates or estimates, leave the value blank or use `null`; the server normalizes either form.

## Using the planning views

- In **Backlog**, click a work item's title to expand its description, acceptance criteria, and dependencies. Search by title, description, or ID and filter by type, priority, or status.
- In **Sprint plan**, use the saved-proposal selector to switch sprint drafts. Choose **View in backlog** on a sprint item to find its exact source item by ID in the Backlog tab.
- The focused version remains create-only: it does not edit existing work items or delete projects/sprints. All three create operations still require explicit approval.


## What should happen after approving backlog or sprint creation?

1. The tool card first displays **ACTION REVIEW REQUIRED** with the complete proposed data. No rows are written at this point.
2. Click **Approve & save**. The card should change to **APPROVAL RECEIVED / Saving approved changes…** while the approval response resumes the server-side tool.
3. When the tool reports **output-available** / normalized **complete** and returns `persisted: true`, the app calls `getWorkspaceBoard()` and reloads the saved SQLite records. A terminal-turn fallback checks the same final transcript, and a tool-call ID guard prevents duplicate refreshes.
4. Backlog creation opens the **Backlog** tab and shows the saved items. Sprint creation opens **Sprint Plan** and selects the newly saved sprint.
5. If the card instead shows **Tool error**, open **Show diagnostic details** and inspect the Cloudflare Worker logs. A tool error is not treated as a successful save, and the board is not refreshed as if data had been written.

The app does not refresh on `approval-requested` or `approval-responded`: these states indicate a pending/accepted decision, not proof that the database operation completed.
