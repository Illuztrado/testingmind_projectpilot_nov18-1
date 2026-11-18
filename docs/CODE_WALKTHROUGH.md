# ProjectPilot Code Walkthrough (Beginner Edition)

This guide follows the main code path from a user's request to a saved project-planning record. The matching source files also contain inline comments; use this document as a guided reading order.

## 1. Start with the overall request flow

1. The React page in `src/app.tsx` sends the user's message through `useAgentChat()`.
2. Cloudflare routes the request to a named `ChatAgent` instance in `src/server.ts`.
3. `onChatMessage()` calls `streamText()` with the system prompt, conversation history, model, and tool definitions.
4. The model can answer normally or request one of the server-defined tools.
5. Read tools execute immediately. A write tool pauses because it declares `needsApproval: true`.
6. The UI renders the exact proposed tool input and lets the user approve or reject it.
7. Only after approval does the tool's `execute` handler run its SQL `INSERT`.
8. The UI reloads `getWorkspaceBoard()` and shows the saved result in the Backlog or Sprint view.

## 2. The system prompt: what role may the agent play?

File: `src/server.ts`

```ts
// This is the agent's operating policy. It narrows the LLM to three jobs and
// instructs it to request approval before persisting project data.
const systemPrompt = `You are ProjectPilot, a focused AI software project planning agent.

YOUR ONLY THREE SKILLS
1. Turn a project objective into phased deliverables.
2. Decompose deliverables into a prioritized backlog.
3. Propose a sprint using saved backlog items and explicit team capacity.

Never persist a project, backlog item, or sprint until the user approves it.
`;
```

The prompt guides the LLM's behavior, but a prompt is not a security boundary on its own. The actual write protection is implemented by the tool definitions and their `needsApproval: true` setting.

## 3. The agent class and persistence

File: `src/server.ts`

```ts
// AIChatAgent supplies the chat lifecycle and persisted conversation history.
// ProjectPilot adds its own structured project data in SQLite.
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 80; // Keep at most 80 messages in managed chat history.
  private readonly aiBinding: Ai; // Type of the Workers AI binding from Env.

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);          // Initialize the base AIChatAgent runtime.
    this.aiBinding = env.AI;  // Keep the Workers AI binding for model inference.
  }
}
```

There are two kinds of persistence:

- **Conversation persistence:** messages managed by `AIChatAgent`.
- **Application persistence:** project, backlog and sprint rows written to the Durable Object's SQLite database.

`ensureSchema()` creates the `projects`, `work_items` and `sprints` tables if they do not exist. It also adds the `deliverables` column to older project tables when needed.

## 4. How the LLM gets tools

File: `src/server.ts`, inside `onChatMessage()`

```ts
// streamText connects the chosen model to instructions, recent chat history,
// and the tools listed below. It can perform several tool/model steps per turn.
const result = streamText({
  model: ai("@cf/meta/llama-4-scout-17b-16e-instruct"),
  system: systemPrompt,
  messages: pruneMessages({
    messages: await convertToModelMessages(this.messages),
    toolCalls: "before-last-2-messages"
  }),
  tools: {
    // Tool definitions go here.
  },
  stopWhen: stepCountIs(8)
});
```

- `model` selects the LLM served by Workers AI.
- `system` gives it ProjectPilot's role and boundaries.
- `messages` supplies recent conversation context in the format expected by the model.
- `tools` lists functions the model may request.
- `stopWhen` limits the number of steps so a single turn cannot loop forever.

The model does not run SQL itself. It asks for a tool call; the TypeScript server validates and executes the function.

## 5. Read tool versus write tool

A read tool can run without modifying records. This is a shortened example of the pattern used by `listProjects`:

```ts
// READ TOOL: this returns existing projects. It does not write to SQLite,
// so the user does not need to approve it.
listProjects: tool({
  description: "Read projects saved in this workspace.",
  inputSchema: z.object({}),
  execute: async () => {
    return this.sql<ProjectRow>`SELECT * FROM projects`;
  }
})
```

A write tool must pause for approval. This shortened example mirrors the structure used by `createProject` in `src/server.ts`:

```ts
createProject: tool({
  // Validate the model's proposed fields before showing them for approval.
  inputSchema: z.object({
    name: z.string().min(2).max(120),
    objective: z.string().min(10).max(1000)
    // The real project schema also includes deliverables, scope and dates.
  }),

  // The SDK creates an approval request and waits for the human decision.
  needsApproval: true,

  // This handler is reached only after approval is granted.
  execute: async ({ name, objective }) => {
    const id = newId("PRJ");

    // The database INSERT is deliberately inside execute, after the approval gate.
    this.sql`INSERT INTO projects (id, name, objective) VALUES (${id}, ${name}, ${objective})`;

    // Return a result so the model and UI can report what was saved.
    return { id, name, objective, persisted: true };
  }
})
```

The snippet is illustrative and shortened; use the complete schema and INSERT in `src/server.ts`. The key rule is structural: keep every database mutation inside the approval-gated `execute` function. Do not write to the database before the approval response arrives.

## 6. How the approval card works in React

File: `src/app.tsx`

```tsx
// The UI detects that a tool is waiting for a decision, then shows the user
// the exact input that the model wants to send to the server-side tool.
if (toolState === "waiting-approval") {
  const approval = getToolApproval(part);
  if (!approval) return null; // A missing approval payload cannot be acted on.

  return (
    <div className="approval-card">
      <pre>{pretty(getToolInput(part))}</pre>
      <button
        onClick={() => addToolApprovalResponse({ id: approval.id, approved: true })}
      >
        Approve & save
      </button>
      <button
        onClick={() => addToolApprovalResponse({ id: approval.id, approved: false })}
      >
        Reject
      </button>
    </div>
  );
}
```

The browser does not execute SQL. It sends an approval decision to the AI SDK. The server-side tool is resumed only if approval is granted.

## 7. How the Backlog and Sprint UI receives data

The React page calls the read-only `getWorkspaceBoard()` method. This is a simplified excerpt of the fetch used in `useEffect()`:

```tsx
// Read the selected project and its saved backlog/sprint records from the agent.
const board = await agent.call("getWorkspaceBoard", [selectedProjectId]);
setBoard(board as WorkspaceBoard);
```

The Backlog tab renders `board.backlog`. The Sprint tab renders `board.sprints`. Filters, totals and selected sprint display are derived from this read-only snapshot; they do not change persisted records.

## 8. Why sprint checks use ordinary TypeScript

File: `src/project-utils.ts`

```ts
// The LLM suggests which backlog IDs belong in the sprint. This function
// independently calculates totals and flags capacity/dependency problems.
const plannedPoints = selected.reduce(
  (sum, item) => sum + (item.estimatePoints ?? 0),
  0
);
const overCapacity = plannedPoints > capacityPoints;
```

Use deterministic application code for arithmetic and integrity checks. The model can explain the findings, but it should not be trusted to calculate or certify capacity by itself.

## 9. Important files to read in order

| Order | File | What to learn |
|---|---|---|
| 1 | `src/app.tsx` | React state, Backlog/Sprint views, chat and approval UI |
| 2 | `src/server.ts` | Agent prompt, model call, tools, SQLite and approval gates |
| 3 | `src/project-utils.ts` | Deterministic sprint capacity and dependency checks |
| 4 | `tests/approval-policy.test.ts` | Tests protecting the human-approval rules |
| 5 | `tests/project-utils.test.ts` | Tests for sprint calculations |
| 6 | `wrangler.jsonc` | Workers AI binding and Durable Object registration |

## 10. How the app starts and how Cloudflare knows what to deploy

`src/client.tsx` is the browser entry point. It finds the `#root` element in `index.html` and mounts the React `App` component there. `vite.config.ts` registers the React, Agents SDK and Cloudflare plugins so the same project can run locally and be bundled for Workers.

`wrangler.jsonc` is the Cloudflare deployment configuration:

```jsonc
{
  // The name is used for the Worker deployment and its workers.dev hostname.
  "name": "testingmind-projectpilot",
  // This is the server-side entry point Cloudflare deploys.
  "main": "src/server.ts",
  // Bind Workers AI so server code can access it through env.AI.
  "ai": { "binding": "AI", "remote": true },
  // Bind the ChatAgent class as a SQLite-backed Durable Object.
  "durable_objects": {
    "bindings": [{ "name": "ChatAgent", "class_name": "ChatAgent" }]
  }
}
```

The actual file also contains compatibility settings, static asset handling, and the Durable Object migration declaration. The example above highlights the three settings most useful to understand first.

## 11. Try this learning exercise

1. Search for `needsApproval: true` in `src/server.ts`.
2. Find the matching approval UI in `src/app.tsx`.
3. Trace one `createBacklogItems` request from the agent's tool call to the approval card and then to the SQL `INSERT`.
4. Reject the approval and confirm no new backlog rows appear.
5. Repeat and approve; refresh the workspace and confirm the rows appear.

**Safety note:** this workshop app uses browser-generated workspace IDs for demo separation, not authentication. Use fictional data only; do not deploy it as a multi-tenant production project tracker without adding verified authentication and authorization.
