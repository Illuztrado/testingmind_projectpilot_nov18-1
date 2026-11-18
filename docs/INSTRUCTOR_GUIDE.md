# Instructor Guide — ProjectPilot

## Workshop outcome

Participants build and deploy an AI project-planning agent with only three skills: objective-to-deliverables, backlog generation and sprint proposal. The app displays a Backlog table and Sprint plan view. Every operation that writes project data requires approval.

## Before the session

- Confirm Node.js 22.12+ and Git are available.
- Verify Cloudflare account signup and Workers AI Free allowance using a fresh participant account. Do not ask participants for a card, paid trial or upgrade.
- Run `npm install`, `npm run check`, `npm test`, `npm run build`, and `npm run dev` on the instructor machine.
- Test reject and approve flows for all three write tools.
- Keep a pre-deployed instructor demo available in case a participant hits free-tier or network limits.
- Use fictional project information only. Workspace IDs are not authentication.

## 60-minute flow

| Time | Activity | Instructor emphasis |
|---|---|---|
| 0–8 min | What makes this an agent? | Model, runtime, harness, tools, tool loop |
| 8–18 min | Objective to project brief | Clarifying questions, scope, deliverables; approve or reject `createProject` |
| 18–33 min | Backlog generation | Epics/stories/tasks, acceptance criteria, priorities and suggested points; inspect Backlog UI; approve or reject `createBacklogItems` |
| 33–48 min | Sprint proposal | Capacity, item selection, warnings; inspect Sprint plan UI; approve or reject `draftSprintPlan` |
| 48–55 min | Architecture and guardrails | Read-only vs write tools, Zod validation, SQLite, approval gating |
| 55–60 min | Debrief | What should remain a human decision? |

## Teaching sequence

1. Open `src/app.tsx` and show the Backlog and Sprint plan tabs.
2. Open `src/server.ts` and show the system prompt defining exactly three skills.
3. Identify read tools (`listProjects`, `listBacklog`) and explain why they can run automatically.
4. Compare the write tools and point out `needsApproval: true` on each.
5. Show the UI approval card's `approval-requested` state check and `addToolApprovalResponse` calls.
6. Show `getWorkspaceBoard()` as a read-only `@callable()` RPC used by the interface.
7. Show `evaluateSprintSelection()` to explain deterministic capacity and dependency checks.

## Human approval demonstration

Ask the agent to create a project and reject the first proposal. Refresh the board and verify no project was written. Repeat and approve. Do the same for backlog creation and sprint proposal. The three actions are independent approval gates; approval of one does not approve the next.

## Key explanation

The LLM proposes what to do and which tool to call. TypeScript tool functions own the database logic. `needsApproval: true` ensures each write tool cannot execute before the human response. The UI shows the exact pending arguments. This is not a decorative confirmation: the tool's database `INSERT` is inside `execute`, and `execute` is held until approval.

## Scope boundaries

The app does not connect to Jira, Linear, GitHub, Slack, calendars, CI/CD or production systems. It does not update or delete existing records, assign tasks, send messages, execute tests or commit the sprint. The Sprint plan is a draft only.
