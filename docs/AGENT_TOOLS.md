# ProjectPilot Agent Tools

All inputs are validated with Zod. The LLM cannot access SQLite directly. The server executes the defined functions.

| Tool / method | Purpose | Reads or writes | Human approval |
|---|---|---|---|
| `listProjects` | Identify existing projects | Read | Not required |
| `listBacklog` | Read saved backlog items for sprint selection | Read | Not required |
| `getWorkspaceBoard` | Load projects, selected project, backlog and sprint plans into the UI | Read-only `@callable()` RPC | Not required |
| `createProject` | Save the reviewed project brief | Add project row | **Required before execute** |
| `createBacklogItems` | Save the reviewed epics, stories and tasks | Add work-item rows | **Required before execute** |
| `draftSprintPlan` | Save the reviewed sprint proposal as a draft | Add sprint row | **Required before execute** |

## Approval contract

Every exposed write tool declares `needsApproval: true`. The AI SDK must emit an approval request before the tool's `execute` function can run. The client displays the exact tool input in an approval card. The user can:

- **Approve & save:** return an approval response; the AI SDK may then execute the tool.
- **Reject:** return a denial response; the write function must not execute.

The UI recognizes the raw `approval-requested` part state and the Cloudflare helper's normalized `waiting-approval` state. It displays the exact input payload before the user responds. The server prompt explicitly prohibits retrying a rejected write unless the user makes a new request.

**Important:** If a future contributor adds any tool that inserts, updates, or deletes persisted data, it must declare `needsApproval: true` and be added to the manual approval test matrix. Do not add an unreviewed mutation path.

## Data storage

- `projects` — project brief, objective, phased deliverables, scope and target date.
- `work_items` — epics, stories and tasks with descriptions, acceptance criteria, priority, estimate, status and dependencies.
- `sprints` — draft sprint goal, capacity, planned points, selected work-item IDs and dates.

`getWorkspaceBoard()` returns a serializable read-only snapshot for the deliverables, backlog and sprint UI. It also recomputes the saved sprint's capacity and dependency warnings from the current backlog, rather than trusting cached AI output. Conversation history remains managed separately by `AIChatAgent`.

## No mutation tools beyond the three

This focused version intentionally exposes no update or delete tools. The agent cannot directly change a saved backlog item or delete a project/sprint. If that functionality is introduced later, each update/delete operation must first present a concrete diff or deletion summary and then await human approval before persistence.
