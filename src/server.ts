import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import { createAI } from "agents/models/ai-sdk";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { evaluateSprintSelection } from "./project-utils";
import { createScopedLogger, type LogLevel } from "./logger";

// SYSTEM PROMPT = the agent's operating instructions.
// This text tells the LLM which jobs it may do, which tools it can use, and
// which decisions must remain with the human project owner. It guides the model;
// the server-side tool definitions below enforce the actual data-write boundary.
const systemPrompt = `You are ProjectPilot, a focused AI software project planning agent.

YOUR ONLY THREE SKILLS
1. Turn a project objective into a clear project brief and phased deliverables.
2. Decompose those deliverables into a prioritized backlog of epics, user stories, and implementation tasks.
3. Propose a sprint from saved backlog items using the team's explicit capacity and sprint dates.

WORKFLOW
- If no project is specified, call listProjects. If none exist, ask for the project name and objective, then propose a concise project brief and deliverable breakdown.
- NEVER persist a project, backlog item, or sprint until the user sees and explicitly approves the relevant tool call in the app's approval card.
- The tools createProject, createBacklogItems, and draftSprintPlan all require human approval (needsApproval: true). Never ask the user to bypass or work around that approval. If approval is rejected, do not retry that write or make a similar write with altered inputs unless the user explicitly makes a new request.
- Use listBacklog to ground sprint selection in saved work. If capacity is missing, ask for it. Never invent team capacity, owners, commitments, story point estimates as agreed facts, or dates.
- When creating a project, include only 1-2 phased deliverables. Each deliverable must have a phase, a concise title, and a verifiable outcome. Persist these deliverables with the project so they remain visible in the workspace.
- For backlog decomposition, trace epics, stories and tasks back to the saved deliverables. Create actionable, independently verifiable work items. Include acceptance criteria where useful. Set AI-suggested story points as estimates and clearly label them as suggestions.
- **Limit backlog output to only one  Epic (with its child stories/tasks). Limit stories to only 1 per epic. Limit tasks to 1 per story.** This keeps the approval card focused and reviewable.
- A sprint is only a proposal and is saved as status 'draft'. It is not a team commitment or a baseline. Flag over-capacity selections, unestimated items, and unfinished or missing dependencies.
- **Limit sprint proposals to exactly one sprint.** Do not propose multiple sprints in a single call.
- Read tools may run without approval. Every tool that adds, changes, or deletes persisted project data must require explicit human approval before execution. Do not claim that a write happened until the tool completes successfully.
- Do not offer or imply capabilities outside these three skills. You do not assign work, update external systems, send messages, execute code, or delete records.

REQUIRED WRITE-TOOL INVOCATION — CRITICAL
- A proposal written only in chat text does NOT create an approval card and does NOT save data. You MUST invoke the matching approval-gated write tool (createProject, createBacklogItems, or draftSprintPlan) after the proposal is ready. If you only write the proposal in chat text without calling the tool, the user sees text but nothing is saved — this is a FAILURE.
- For a new project, once the project name, objective, scope, and phased deliverables are sufficiently clear, call createProject with the complete proposed project record.
- For backlog creation, once the project is identified and the backlog proposal is ready, call createBacklogItems exactly once with the selected project ID and the complete proposed item array. Do NOT stop after merely writing the backlog in chat text — you MUST call the tool.
- For sprint planning, first use listBacklog to obtain saved item IDs and ask for team capacity and sprint dates if missing. Once the sprint proposal is ready, call draftSprintPlan exactly once with the saved project ID, saved work-item IDs, capacity, and dates.
- These write-tool calls intentionally produce the application's **ACTION REVIEW REQUIRED** approval card. The user's **Approve & save** click is the only approval that allows the server-side execute handler to run. Do not substitute a plain-text yes/no question for the approval card, and do not claim the write happened before the tool returns persisted: true.
- ⚠️ NEVER claim a backlog/project/sprint exists or was created unless you have VERIFIED it through the appropriate read tool (listProjects, listBacklog) or the write tool has returned persisted: true. Do NOT hallucinate or assume data exists.
- If required inputs are missing, ask the user for them and do not invoke the write tool yet. If the user asks only to brainstorm or review without saving, do not invoke a write tool. If a user rejects a tool call, do not retry it unless the user explicitly makes a new request.

STYLE
Be a calm, practical project manager. Separate confirmed inputs from assumptions and recommendations. Show deliverables, backlog items, and sprint selections in readable tables or concise lists. End with the next decision needed from the project owner.

OUTPUT DISCIPLINE
- Do NOT repeat the tool input payload (arrays, objects, IDs, etc.) in your chat response. The approval card already displays the exact proposed data for the user to review. Repeating it wastes tokens and clutters the conversation.
- After invoking a write tool (createProject, createBacklogItems, draftSprintPlan), briefly confirm what action was proposed (e.g., "Proposed backlog with 1 epic and 3 stories — awaiting your approval") without restating the full payload.
- Keep responses focused on summary, rationale, and next steps — not raw data duplication.
- ⚠️ NEVER output JSON arrays, markdown tables, or structured payloads that mirror the tool input. The approval card IS the review surface. If you output the payload in chat, you are duplicating work and confusing the user.
- ⚠️ SILENT TOOL INVOCATION: Do NOT narrate tool calls in chat text (e.g., "I will now call createBacklogItems..." or "To create the backlog, I will invoke..."). Just invoke the tool. The approval card appears automatically. Any text before/after the tool call that describes the payload is redundant.
- ⚠️ MANDATORY TOOL EXECUTION: When the workflow requires a write tool (createProject, createBacklogItems, draftSprintPlan), you MUST call the tool function. Saying "I will call..." or "Next step is to call..." is NOT calling the tool. The tool is ONLY called when the function invocation appears in your response. If you do not see a tool call in your output, you have NOT called it.
- ⚠️ APPROVAL TRANSPARENCY: When a write tool requires approval, explicitly state "This requires your approval" or similar. Do NOT say "created", "saved", or "done" until the tool returns persisted: true after user approval. The approval card is the ONLY mechanism for saving data.`;

// Zod schemas validate tool arguments before a tool's execute function runs.
// Keeping validation on the server is important: model-generated arguments are
// suggestions, not trusted application data.
const projectIdSchema = z.string().min(1).max(80).describe("ID of a project in this workspace");
// Models may express an omitted optional date as null or as an empty string.
const dateSchema = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).nullable().optional();
function normalizeOptionalDate(value?: string | null): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// These interfaces describe the shape of rows read from SQLite.
// Database columns use snake_case; the UI-facing objects returned by
// getWorkspaceBoard() are converted to camelCase for React.
interface ProjectRow {
  id: string;
  name: string;
  objective: string;
  scope_in: string;
  scope_out: string;
  deliverables: string;
  stakeholders: string;
  status: string;
  start_date: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkItemRow {
  id: string;
  project_id: string;
  type: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  priority: string;
  status: string;
  estimate_points: number | null;
  owner: string | null;
  due_date: string | null;
  dependencies: string;
  created_at: string;
  updated_at: string;
}


// Prefixes make IDs easier to recognize in logs and workshop demonstrations.
// The UUID portion keeps each project, work item, and sprint ID unique.
function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Some structured fields are stored as JSON strings in SQLite (for example,
// deliverables and acceptance criteria). If old or malformed data is found,
// return a safe fallback instead of crashing the workspace view.
function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ChatAgent is the server-side agent instance. AIChatAgent supplies the chat
// lifecycle and persisted conversation history; this class adds ProjectPilot's
// project-planning tools and its own structured SQLite tables.
export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 80;
  private readonly aiBinding: Ai;
  private schemaReady = false;
  private readonly log = createScopedLogger({ workspace: "ChatAgent" });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.aiBinding = env.AI;
    this.log.info("ChatAgent initialized", { durableObjectId: ctx.id.toString() });
  }

  // Create the application's data tables the first time this Durable Object
  // needs them. `projects`, `work_items`, and `sprints` are application records;
  // chat messages are persisted separately by AIChatAgent.
  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.log.debug("Creating database schema if not exists");
    this.sql`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        scope_in TEXT NOT NULL,
        scope_out TEXT NOT NULL,
        deliverables TEXT NOT NULL DEFAULT '[]',
        stakeholders TEXT NOT NULL,
        status TEXT NOT NULL,
        start_date TEXT,
        target_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        estimate_points INTEGER,
        owner TEXT,
        due_date TEXT,
        dependencies TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS sprints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        capacity_points INTEGER NOT NULL,
        planned_points INTEGER NOT NULL,
        work_item_ids TEXT NOT NULL,
        status TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      )
    `;
    // Lightweight schema migration: older workshop databases may not have the
    // deliverables column. Add it only when it is missing, preserving old rows.
    const projectColumns = this.sql<{ name: string }>`PRAGMA table_info(projects)`;
    if (!projectColumns.some((column) => column.name === "deliverables")) {
      this.log.info("Running schema migration: adding deliverables column to projects");
      this.sql`ALTER TABLE projects ADD COLUMN deliverables TEXT NOT NULL DEFAULT '[]'`;
    }
    this.sql`CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id)`;
    this.schemaReady = true;
    this.log.info("Database schema ready");
  }

  // Small query helpers keep SQL in one place and make the tools easier to read.
  // These methods only read data; they do not change the database.
  private getProject(projectId: string): ProjectRow | undefined {
    this.ensureSchema();
    return this.sql<ProjectRow>`SELECT * FROM projects WHERE id = ${projectId}`[0];
  }

  private getWorkItems(projectId: string): WorkItemRow[] {
    this.ensureSchema();
    return this.sql<WorkItemRow>`
      SELECT * FROM work_items WHERE project_id = ${projectId}
      ORDER BY CASE priority WHEN 'must' THEN 1 WHEN 'should' THEN 2 WHEN 'could' THEN 3 ELSE 4 END, created_at DESC
    `;
  }

  private projectNotFound(projectId: string): { error: string } | null {
    return this.getProject(projectId) ? null : { error: `Project ${projectId} was not found in this workspace. Call listProjects to see available projects.` };
  }

  // @callable exposes this read-only application-data method to the React client
  // through agent.call(). It assembles one view model containing the project, backlog,
  // and saved sprint proposals so the UI does not need direct database access.
  @callable()
  async getWorkspaceBoard(projectId?: string) {
    this.ensureSchema();
    const boardLog = this.log.withToolLogging("getWorkspaceBoard", async () => {
      const projectRows = this.sql<ProjectRow>`SELECT * FROM projects ORDER BY updated_at DESC LIMIT 30`;
      const selectedId = projectId && projectRows.some((project) => project.id === projectId)
        ? projectId
        : projectRows[0]?.id ?? null;
      const selectedProject = selectedId ? this.getProject(selectedId) : undefined;

      if (!selectedProject) {
        this.log.debug("No project selected, returning empty board");
        return { projects: projectRows.map((project) => ({
          id: project.id, name: project.name, objective: project.objective,
          deliverables: parseJson<Array<{ phase: string; title: string; outcome: string }>>(project.deliverables, []),
          status: project.status, targetDate: project.target_date
        })), selectedProjectId: null, project: null, backlog: [], sprints: [] };
      }

      // Convert database rows into UI-friendly objects. JSON text columns are
      // parsed back into arrays so React can render criteria and dependencies.
      const backlog = this.getWorkItems(selectedProject.id).map((item) => ({
        id: item.id, type: item.type, title: item.title, description: item.description,
        acceptanceCriteria: parseJson<string[]>(item.acceptance_criteria, []),
        priority: item.priority, status: item.status, estimatePoints: item.estimate_points,
        owner: item.owner, dueDate: item.due_date,
        dependencies: parseJson<string[]>(item.dependencies, [])
      }));
      const sprintRows = this.sql<{
        id: string; project_id: string; name: string; goal: string; capacity_points: number;
        planned_points: number; work_item_ids: string; status: string;
        start_date: string | null; end_date: string | null; created_at: string;
      }>`SELECT * FROM sprints WHERE project_id = ${selectedProject.id} ORDER BY created_at DESC LIMIT 20`;
      const itemById = new Map(backlog.map((item) => [item.id, item]));
      const sprintCandidates = backlog.map((item) => ({
        id: item.id, title: item.title, estimatePoints: item.estimatePoints,
        status: item.status as "backlog" | "ready" | "in_progress" | "blocked" | "done",
        dependencies: item.dependencies
      }));
      // Recalculate sprint warnings from the current backlog instead of blindly
      // trusting the values originally proposed by the LLM. Capacity and dependency
      // checks are deterministic application logic, not model-generated claims.
      const sprints = sprintRows.map((sprint) => {
        const ids = parseJson<string[]>(sprint.work_item_ids, []);
        const evaluation = evaluateSprintSelection(sprintCandidates, ids, sprint.capacity_points, sprintCandidates);
        return {
          id: sprint.id, name: sprint.name, goal: sprint.goal, status: sprint.status,
          capacityPoints: sprint.capacity_points, plannedPoints: sprint.planned_points,
          remainingCapacity: sprint.capacity_points - sprint.planned_points,
          overCapacity: evaluation.overCapacity, overBy: evaluation.overBy,
          unestimatedWorkItemIds: evaluation.unestimatedWorkItemIds,
          dependencyWarnings: evaluation.dependencyWarnings,
          unknownWorkItemIds: evaluation.unknownWorkItemIds,
          completedWorkItemIds: evaluation.completedWorkItemIds,
          startDate: sprint.start_date, endDate: sprint.end_date, createdAt: sprint.created_at,
          items: ids.map((id) => itemById.get(id)).filter((item) => item !== undefined)
        };
      });

      this.log.debug("Workspace board loaded", { projectId: selectedProject.id, backlogCount: backlog.length, sprintCount: sprints.length });
      return {
        projects: projectRows.map((project) => ({
          id: project.id, name: project.name, objective: project.objective,
          status: project.status, targetDate: project.target_date
        })),
        selectedProjectId: selectedProject.id,
        project: {
          id: selectedProject.id, name: selectedProject.name, objective: selectedProject.objective,
          status: selectedProject.status, targetDate: selectedProject.target_date,
          scopeIn: parseJson<string[]>(selectedProject.scope_in, []),
          scopeOut: parseJson<string[]>(selectedProject.scope_out, []),
          deliverables: parseJson<Array<{ phase: string; title: string; outcome: string }>>(selectedProject.deliverables, [])
        },
        backlog,
        sprints
      };
    }, { projectId });
    return boardLog;
  }

  // This method is called when a user sends a chat message. It configures the
  // model, supplies recent conversation context, registers the available tools,
  // and streams the assistant/tool interaction back to the browser.
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    this.ensureSchema();
    const ai = createAI({ binding: this.aiBinding });
    const workspaceId = this.ctx.id.toString();

    this.log.info("Chat message received", { workspaceId });

    // streamText is the agent harness for this request: it sends the prompt to
    // the model, manages tool-call steps, and streams the response to the UI.
    const result = streamText({
      model: ai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      system: systemPrompt,
      // Allow longer responses for detailed backlog/sprint generation
      // Note: maxTokens is passed via providerOptions for Workers AI
      providerOptions: {
        workersai: {
          max_tokens: 16384,
        },
      },
      // Convert stored chat messages into the model's message format. Pruning
      // reduces the context sent to the LLM; it does not delete persisted history.
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      // Tools are the controlled interface between the LLM and application data.
      // Read tools can run directly. Every tool that writes a record is marked
      // needsApproval: true, so the SDK pauses for a human response first.
      tools: {
        createProject: tool({
          // The schema is the contract for the project data the model may propose.
          // min/max constraints prevent empty or excessively long user-facing fields.
          description: "Create and persist a new software project after the user approves the exact project name, objective, scope, deliverables, and dates shown in the approval card. Do not list the payload in the chat response; the approval card already shows the proposed sprint.",
          inputSchema: z.object({
            name: z.string().min(2).max(120),
            objective: z.string().min(10).max(1000),
            deliverables: z.array(z.object({
              phase: z.string().min(2).max(80),
              title: z.string().min(3).max(160),
              outcome: z.string().min(5).max(400)
            })).min(1).max(12),
            // Some models emit null for optional fields rather than omitting them.
            // Accept both representations, then normalize them before persistence.
            scopeIn: z.array(z.string().min(2).max(240)).max(15).nullable().optional(),
            scopeOut: z.array(z.string().min(2).max(240)).max(15).nullable().optional(),
            stakeholders: z.array(z.object({ name: z.string().min(1).max(100), role: z.string().min(1).max(100) })).max(20).nullable().optional(),
            startDate: dateSchema,
            targetDate: dateSchema
          }),
          // Approval is configured via needsApproval: true on the tool (deprecated but avoids secret issues).
          // Keep the SQL INSERT inside execute.
          needsApproval: true,
          execute: async ({ name, objective, deliverables, scopeIn, scopeOut, stakeholders, startDate, targetDate }) => {
            const now = new Date().toISOString();
            const id = newId("PRJ");
            const normalizedScopeIn = scopeIn ?? [];
            const normalizedScopeOut = scopeOut ?? [];
            const normalizedStakeholders = stakeholders ?? [];
            const normalizedStartDate = normalizeOptionalDate(startDate);
            const normalizedTargetDate = normalizeOptionalDate(targetDate);
            try {
              this.sql`
                INSERT INTO projects (id, name, objective, scope_in, scope_out, deliverables, stakeholders, status, start_date, target_date, created_at, updated_at)
                VALUES (${id}, ${name}, ${objective}, ${JSON.stringify(normalizedScopeIn)}, ${JSON.stringify(normalizedScopeOut)}, ${JSON.stringify(deliverables)}, ${JSON.stringify(normalizedStakeholders)}, 'planning', ${normalizedStartDate}, ${normalizedTargetDate}, ${now}, ${now})
              `;
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              console.error("[ProjectPilot] createProject INSERT failed", { error: err.message, stack: err.stack, projectId: id });
              throw new Error(`Project creation failed: ${err.message}`);
            }
            console.log("[ProjectPilot] createProject approval completed", { projectId: id, name });
            return { id, name, objective, deliverables, status: "planning", startDate: normalizedStartDate, targetDate: normalizedTargetDate, scopeIn: normalizedScopeIn, scopeOut: normalizedScopeOut, stakeholders: normalizedStakeholders, persisted: true };
          }
        }),

        // READ TOOL: listing projects has no side effect, so approval is not needed.
        // Its results help the model identify the project the user is referring to.
        listProjects: tool({
          description: "Read projects saved in this workspace. Use when the user refers to an existing project without providing its ID.",
          inputSchema: z.object({}),
          execute: async () => {
            this.ensureSchema();
            return this.sql<ProjectRow>`SELECT * FROM projects ORDER BY updated_at DESC LIMIT 30`.map((project) => ({
              id: project.id, name: project.name, objective: project.objective,
              deliverables: parseJson<Array<{ phase: string; title: string; outcome: string }>>(project.deliverables, []),
              status: project.status, targetDate: project.target_date
            }));
          }
        }),

        // WRITE TOOL: this adds one or more backlog rows. The complete list of
        // proposed items is shown in the approval card before any INSERT executes.
        createBacklogItems: tool({
          // Each array entry becomes one backlog row after the whole proposed batch
          // is approved. IDs and timestamps are assigned by the server, not the LLM.
          description: "Create and persist a proposed backlog (1 epic + its stories/tasks) for a project after the user approves the proposed epics, stories, and tasks. Limit: 1 epic + its stories/tasks per call. Limit: 2 stories per epic. Each story may have 0-2 tasks. Include acceptance criteria where useful. Set AI-suggested story points as estimates and clearly label them as suggestions. Do not list the payload in the chat response; the approval card already shows the proposed sprint.",
          inputSchema: z.object({
            projectId: projectIdSchema,
            items: z.array(z.object({
              type: z.enum(["epic", "story", "task"]),
              title: z.string().min(3).max(160),
              description: z.string().min(5).max(1000),
              acceptanceCriteria: z.array(z.string().min(3).max(300)).max(12).nullable().optional(),
              priority: z.enum(["must", "should", "could", "wont"]).nullable().optional(),
              estimatePoints: z.number().int().min(1).max(100).nullable().optional(),
              dependencies: z.array(z.string().min(1).max(100)).max(10).nullable().optional()
            })).min(1).max(25)
          }),
          // Nothing is inserted before approval. After approval, validate the
          // project exists, then persist the approved backlog items as a batch.
          // Approval is configured via needsApproval: true on the tool (deprecated but avoids secret issues).
          needsApproval: true,
          execute: async ({ projectId, items }) => {
            return this.log.withToolLogging("createBacklogItems", async () => {
              const missing = this.projectNotFound(projectId);
              if (missing) throw new Error(missing.error);
              const now = new Date().toISOString();
              const saved = items.map((item) => {
                const id = newId("WI");
                const acceptanceCriteria = item.acceptanceCriteria ?? [];
                const priority = item.priority ?? "should";
                const dependencies = item.dependencies ?? [];
                const estimatePoints = item.estimatePoints ?? null;
                try {
                  this.sql`
                    INSERT INTO work_items (id, project_id, type, title, description, acceptance_criteria, priority, status, estimate_points, owner, due_date, dependencies, created_at, updated_at)
                    VALUES (${id}, ${projectId}, ${item.type}, ${item.title}, ${item.description}, ${JSON.stringify(acceptanceCriteria)}, ${priority}, 'backlog', ${estimatePoints}, NULL, NULL, ${JSON.stringify(dependencies)}, ${now}, ${now})
                  `;
                } catch (error) {
                  this.log.error("createBacklogItems INSERT failed", error instanceof Error ? error : new Error(String(error)), { projectId, workItemId: id, title: item.title });
                  throw new Error(`Backlog item save failed for '${item.title}': ${error instanceof Error ? error.message : String(error)}`);
                }
                return { id, type: item.type, title: item.title, priority, status: "backlog", estimatePoints };
              });
              this.log.approval({ toolName: "createBacklogItems", action: "completed", projectId, message: `Created ${saved.length} backlog items` });
              return { projectId, createdCount: saved.length, items: saved, persisted: true };
            }, { input: { projectId, items } });
          }
        }),

        // READ TOOL: sprint planning must be based on saved backlog records,
        // rather than on work items the model merely remembers or invents.
        listBacklog: tool({
          description: "Read all saved backlog items for a project, including priority, status, estimate, acceptance criteria, and dependencies.",
          inputSchema: z.object({ projectId: projectIdSchema, status: z.enum(["backlog", "ready", "in_progress", "blocked", "done"]).optional() }),
          execute: async ({ projectId, status }) => {
            const missing = this.projectNotFound(projectId);
            if (missing) return missing;
            return this.getWorkItems(projectId).filter((item) => !status || item.status === status).map((item) => ({
              id: item.id, type: item.type, title: item.title, description: item.description,
              acceptanceCriteria: parseJson<string[]>(item.acceptance_criteria, []),
              priority: item.priority, status: item.status, estimatePoints: item.estimate_points,
              dependencies: parseJson<string[]>(item.dependencies, [])
            }));
          }
        }),

        // WRITE TOOL: saves a sprint proposal as a draft. It does not commit
        // capacity or change the status of any backlog item.
        draftSprintPlan: tool({
          // The model supplies selected IDs; the server looks them up again and
          // recomputes points, capacity and dependency warnings before persisting.
          description: "Create and persist a proposed sprint (DRAFT) for a projectusing selected saved backlog IDs and the user's explicit team capacity after the user approves the proposed sprint draft. Flag over-capacity, unestimated work, and unfinished or missing dependencies. Never claim a draft is committed. Limit: exactly 1 sprint per call. Do not list the payload in the chat response; the approval card already shows the proposed sprint.",
          inputSchema: z.object({
            projectId: projectIdSchema,
            name: z.string().min(2).max(100),
            goal: z.string().min(5).max(500),
            capacityPoints: z.number().int().min(1).max(500),
            workItemIds: z.array(z.string().min(1).max(100)).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, "Work item IDs must be unique"),
            startDate: dateSchema,
            endDate: dateSchema
          }),
          // The user must approve the exact sprint name, goal, capacity, selected
          // work-item IDs, and dates before this handler writes the sprint row.
          // Approval is configured via needsApproval: true on the tool (deprecated but avoids secret issues).
          needsApproval: true,
          execute: async ({ projectId, name, goal, capacityPoints, workItemIds, startDate, endDate }) => {
            return this.log.withToolLogging("draftSprintPlan", async () => {
              const missing = this.projectNotFound(projectId);
              if (missing) throw new Error(missing.error);
              const all = this.getWorkItems(projectId);
              const candidates = all.map((item) => ({
                id: item.id, title: item.title, estimatePoints: item.estimate_points,
                status: item.status as "backlog" | "ready" | "in_progress" | "blocked" | "done",
                dependencies: parseJson<string[]>(item.dependencies, [])
              }));
              const evaluation = evaluateSprintSelection(candidates, workItemIds, capacityPoints, candidates);
              const normalizedStartDate = normalizeOptionalDate(startDate);
              const normalizedEndDate = normalizeOptionalDate(endDate);
              const id = newId("SP");
              try {
                this.sql`
                  INSERT INTO sprints (id, project_id, name, goal, capacity_points, planned_points, work_item_ids, status, start_date, end_date, created_at)
                  VALUES (${id}, ${projectId}, ${name}, ${goal}, ${capacityPoints}, ${evaluation.plannedPoints}, ${JSON.stringify(evaluation.selected.map((item) => item.id))}, 'draft', ${normalizedStartDate}, ${normalizedEndDate}, ${new Date().toISOString()})
                `;
              } catch (error) {
                this.log.error("draftSprintPlan INSERT failed", error instanceof Error ? error : new Error(String(error)), { projectId, sprintId: id });
                throw new Error(`Sprint plan save failed: ${error instanceof Error ? error.message : String(error)}`);
              }
              this.log.approval({ toolName: "draftSprintPlan", action: "completed", projectId, message: `Sprint ${name} created as draft` });
              return {
                id, projectId, name, goal, status: "draft", capacityPoints,
                plannedPoints: evaluation.plannedPoints, remainingCapacity: evaluation.remainingCapacity,
                overCapacity: evaluation.overCapacity, overBy: evaluation.overBy,
                selectedItems: evaluation.selected.map((item) => ({ id: item.id, title: item.title, estimatePoints: item.estimatePoints, status: item.status })),
                completedItemsExcluded: evaluation.completedWorkItemIds,
                unestimatedWorkItemIds: evaluation.unestimatedWorkItemIds,
                dependencyWarnings: evaluation.dependencyWarnings,
                unknownWorkItemIds: evaluation.unknownWorkItemIds,
                startDate: normalizedStartDate, endDate: normalizedEndDate, persisted: true
              };
            }, { input: { projectId, name, goal, capacityPoints, workItemIds, startDate, endDate } });
          }
        })
      },
      // Bound the agent loop so one request cannot make unlimited model/tool steps.
      // The model can still perform multiple tool calls, up to this eight-step cap.
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// Worker entry point: route incoming HTTP/WebSocket requests to the correct
// named Durable Object agent. Unmatched routes receive a simple 404 response.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  }
};