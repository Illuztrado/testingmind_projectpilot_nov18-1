# ProjectPilot — AI Software Project Planning Agent

A focused, beginner-friendly workshop project for Testingmind. ProjectPilot has three skills only:

1. Turn a project objective into a short project brief and phased deliverables.
2. Break deliverables into a prioritized backlog of epics, user stories, and implementation tasks.
3. Propose a sprint from saved backlog items using the team's explicit capacity.

The interface includes dedicated **Backlog** and **Sprint plan** views. The agent can read workspace data without approval, but every tool that writes project data pauses for human approval before its `execute` function runs.

**Stack:** TypeScript · React · Cloudflare Agents SDK · Cloudflare Workers AI · Vercel AI SDK · Zod · Durable Objects SQLite

**Model:** Meta Llama 4 Scout through the Cloudflare Workers AI `AI` binding. No separate OpenAI, Anthropic, or Gemini API key is configured.

> **Safety boundary:** The app only creates project records, backlog items, and draft sprint proposals in its own SQLite workspace. It does not update or delete existing project records, connect to Jira/Linear/GitHub, assign tasks, send messages, or commit a sprint. Use fictional workshop data only; workspace IDs are not authentication.

## What participants will build

Participants give ProjectPilot a software project objective. The agent clarifies missing inputs, proposes deliverables, and can then:

- Save a project brief and phased deliverables after approval. Deliverables are stored with the project and displayed above the planning views.
- Generate epics, stories, tasks, acceptance criteria, priorities, suggested estimates, and dependencies.
- Show the proposed backlog in a dedicated table view after approval.
- Inspect saved backlog items, select sprint candidates against a stated capacity, and flag over-capacity, unestimated work, and dependency gaps.
- Save a sprint as a draft only after approval and show it in a dedicated Sprint plan view.

## Human-in-the-loop policy

The only server-side write tools are:

- `createProject`
- `createBacklogItems`
- `draftSprintPlan`

Every one of these tools declares `needsApproval: true`. The AI SDK emits an approval request and does not call the tool's `execute` function until the user approves. Rejecting an action prevents the corresponding database write. The UI shows the exact proposed payload and provides **Approve & save** and **Reject** actions. The client recognizes both the raw `approval-requested` state and Cloudflare's normalized `waiting-approval` state.

Read-only tools (`listProjects`, `listBacklog`) and the read-only UI RPC (`getWorkspaceBoard`) do not need approval. If you add any future operation that inserts, updates, or deletes persistent data, it must be approval-gated before merging.

No update or delete tools are exposed in this focused workshop version. There is no hidden autonomous mutation path.

## Prerequisites

- Node.js **22.12+** and npm
- Git and a code editor (VS Code recommended)
- A Cloudflare account on the Free plan for remote Workers AI access and deployment
- Basic JavaScript/TypeScript familiarity

No paid LLM provider key, local model download, Docker, or GPU is required. Keep the Cloudflare account on its Free plan. Check current plan limits before the workshop; do not add a payment method, start a paid trial, or upgrade.

## Quick start

```bash
# Install the project dependencies declared in package.json.
npm install

# Generate Cloudflare environment types, then run the TypeScript checker.
npm run check

# Run the local unit tests (no LLM request is made by these tests).
npm test

# Sign in so the local app can use the remote Workers AI binding.
npx wrangler login

# Start the Vite development server.
npm run dev
```

Open <http://localhost:5173>.

The Workers AI binding is configured with `remote: true`, so local development still requires Wrangler authentication and calls Cloudflare's remote Workers AI service.

## Deploy

```bash
# Build the frontend bundle, then upload the Worker and assets to Cloudflare.
npm run deploy
```

The Wrangler Worker name is `testingmind-projectpilot`. Wrangler prints the resulting `workers.dev` URL. This deployment uses its own Durable Object namespace; it does not overwrite the earlier QA Buddy Worker.

## Try the three workflows

### 1. Objective → project brief and deliverables

```text
I want to build a customer self-service portal where customers can view their policies and submit service requests. Target delivery is 10 weeks. Help me clarify anything missing, then propose a project brief and phased deliverables. Show me the exact project details and wait for approval before saving.
```

Expected: ProjectPilot clarifies the brief and proposes project metadata. An approval card appears before `createProject` writes the project. Approving creates the project and displays its workspace ID.

### 2. Deliverables → backlog

```text
For this project, break the objective into epics, user stories, and implementation tasks. Include acceptance criteria, MoSCoW priority, suggested story points, and dependencies. Do not invent owners or due dates. Show the complete backlog proposal and wait for my approval before saving it.
```

Expected: `createBacklogItems` pauses for approval. Rejecting writes nothing. Approving saves the proposed work items and the Backlog view refreshes.

### 3. Backlog → sprint proposal

```text
Inspect the saved backlog and propose a two-week sprint with a capacity of 24 story points. Select sensible items, explain the sprint goal, and flag any missing estimates or dependencies. Show the complete proposal and wait for approval before saving it.
```

Expected: ProjectPilot reads the backlog, proposes selected work items, and `draftSprintPlan` pauses for approval. Approving saves a **draft** sprint; the Sprint plan view refreshes. A draft is not a team commitment.

## UI

- **Project brief:** displays the approved objective and phased deliverables (phase, title, and verifiable outcome).
- **Backlog:** filter epics, stories and tasks; inspect acceptance criteria; view priority, status and suggested points.
- **Sprint plan:** choose a saved proposal; view its goal, dates, selected items, planned points, capacity and remaining capacity.
- **Agent panel:** send objectives and instructions; inspect tool proposals; approve or reject writes.

## Architecture

```text
React planning workspace
  |-- Backlog view
  |-- Sprint plan view
  |-- Agent chat + approval cards
  |       |
  |       | WebSocket chat / callable read RPC
  v       v
Cloudflare AIChatAgent (Durable Object)
  |-- Llama 4 Scout through Workers AI
  |-- Vercel AI SDK bounded tool loop
  |-- Read tools: listProjects, listBacklog
  |-- Write tools: createProject, createBacklogItems, draftSprintPlan
  |       | needsApproval: true on every write tool
  v       v
Durable Object SQLite
  |-- projects
  |-- work_items
  |-- sprints
```

- **Model:** interprets objectives, proposes deliverables/backlog/sprint selections, and decides which tool to call.
- **Agent runtime:** Cloudflare Agents SDK / Durable Objects provides durable identity, WebSockets, lifecycle, and SQLite storage.
- **Harness:** `streamText()` with `stopWhen: stepCountIs(8)` runs a bounded multi-step tool interaction.
- **Tools:** TypeScript functions validate inputs with Zod and perform database writes only after human approval.
- **UI data:** `getWorkspaceBoard()` is a read-only `@callable()` method exposed to the React client via `agent.call()`.

## Persistence

Conversation messages are persisted automatically by `AIChatAgent`. Project data is stored separately in SQLite tables created by `ensureSchema()` in `src/server.ts`:

- `projects` — project brief, objective, phased deliverables (phase, title, outcome), scope, stakeholders, dates and lifecycle state.
- `work_items` — backlog epics, stories and tasks; includes descriptions, acceptance criteria, priority, status, optional estimate, and dependencies.
- `sprints` — sprint goal, capacity, planned points, selected work-item IDs, dates, and draft status.

The UI fetches the selected project's saved records through the read-only `getWorkspaceBoard()` RPC. It refreshes after the agent finishes a turn, including after an approval is granted or rejected.

## Learn the code

See [`docs/CODE_WALKTHROUGH.md`](docs/CODE_WALKTHROUGH.md) for an annotated, beginner-friendly explanation of the agent flow, SQLite persistence, tool calling, human approval, and the Backlog/Sprint UI. The source files also include inline comments at the main teaching points.

## Repository map

```text
src/
  app.tsx               Focused planning UI: backlog, sprint plan, agent panel, approval cards
  client.tsx            React entry point
  server.ts             AIChatAgent, focused prompt, read/write tools, SQLite, approval gates
  project-utils.ts      Deterministic sprint capacity and dependency checks
  styles.css            Planning dashboard and responsive UI

tests/
  approval-policy.test.ts Tests for human approval and allowed database writes
  project-utils.test.ts  Unit tests for deterministic sprint calculations

docs/
  PROJECT_MANAGER_SKILLS.md  The three in-scope skills and non-goals
  AGENT_TOOLS.md             Read/write tool contracts and approval requirements
  PARTICIPANT_LAB.md         Hands-on exercises
  INSTRUCTOR_GUIDE.md        60-minute facilitation guide
  EXPECTED_OUTPUTS.md        Acceptance checks and expected UI results
  CODE_WALKTHROUGH.md        Annotated beginner guide to the main source code
  TROUBLESHOOTING.md         Setup and debugging help
```

## UI previews

The ZIP includes `ui-preview.html` (Backlog view) and `sprint-preview.html` (Sprint Plan view). These are static sample-data previews; the interactive application is available through `npm run dev`.

## Checks and tests

```bash
# Regenerate Worker types and check the TypeScript code.
npm run check

# Execute the automated unit and approval-policy tests.
npm test

# Create a production build locally without deploying it.
npm run build
```

`npm run check` first regenerates `worker-configuration.d.ts` using Wrangler, then runs TypeScript. The unit tests do not call an LLM and do not require Cloudflare credentials.

## Known limitations

- No authentication or user/tenant authorization. Browser workspace IDs are not proof of identity. Use fictional data only.
- No Jira, Linear, GitHub, Slack, email, calendar, CI/CD, source-control, or external system integration.
- No delete or update actions are available in this scoped version. To add such tools, require approval before every write.
- Sprint proposals are saved as drafts. They do not change backlog item states or commit team capacity.
- Estimates and proposed deliverables are AI recommendations. The team must review scope, estimates, dates, dependencies and capacity.

## License

MIT. See [`LICENSE`](LICENSE).
