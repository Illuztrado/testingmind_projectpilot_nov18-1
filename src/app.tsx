import { useEffect, useMemo, useRef, useState } from "react";
import { getToolName, isToolUIPart } from "ai";
import { useAgent } from "agents/react";
import {
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolPartState,
  useAgentChat
} from "@cloudflare/ai-chat/react";

// Frontend view models mirror the safe, serializable data returned by the server.
// They are not database entities; the server remains the source of truth.
// The types below describe the shape of data the server sends to the screen.
// They help TypeScript catch mismatches between the backend and React components.
type Project = {
  id: string;
  name: string;
  objective: string;
  status: string;
  targetDate: string | null;
  deliverables?: Array<{ phase: string; title: string; outcome: string }>;
};

type BacklogItem = {
  id: string;
  type: "epic" | "story" | "task";
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: "must" | "should" | "could" | "wont";
  status: "backlog" | "ready" | "in_progress" | "blocked" | "done";
  estimatePoints: number | null;
  owner: string | null;
  dueDate: string | null;
  dependencies: string[];
};

type Sprint = {
  id: string;
  name: string;
  goal: string;
  status: string;
  capacityPoints: number;
  plannedPoints: number;
  remainingCapacity: number;
  overCapacity: boolean;
  overBy: number;
  unestimatedWorkItemIds: string[];
  dependencyWarnings: Array<{ workItemId: string; dependencyId: string; dependencyStatus: string }>;
  unknownWorkItemIds: string[];
  completedWorkItemIds: string[];
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  items: BacklogItem[];
};

type WorkspaceBoard = {
  projects: Project[];
  selectedProjectId: string | null;
  project: (Project & { scopeIn: string[]; scopeOut: string[]; deliverables: Array<{ phase: string; title: string; outcome: string }> }) | null;
  backlog: BacklogItem[];
  sprints: Sprint[];
};

// Initial UI state shown before the first workspace read completes.
const emptyBoard: WorkspaceBoard = {
  projects: [], selectedProjectId: null, project: null, backlog: [], sprints: []
};

// These buttons send guided instructions to the agent. They do not perform
// writes themselves; the agent may propose a write tool, which still needs approval.
const starterPrompts = [
  {
    label: "Start a project",
    description: "Turn an objective into a project brief and deliverables.",
    prompt: "I want to start a software project. Help me clarify the project name, objective, target date, and scope. Then propose a concise project brief and phased deliverables. Invoke the approval-gated createProject action so I can review the exact project details and approve or reject saving them."
  },
  {
    label: "Create a backlog",
    description: "Break the objective into epics, stories and tasks.",
    prompt: "For the selected project, decompose the objective and deliverables into a prioritized backlog of epics, user stories, and implementation tasks. Include concise descriptions, acceptance criteria, dependencies, MoSCoW priority, and suggested story points. Then invoke the approval-gated createBacklogItems action with the complete proposed backlog so I can review and approve or reject the save."
  },
  {
    label: "Propose a sprint",
    description: "Select backlog items against team capacity.",
    prompt: "Inspect the selected project's saved backlog and propose a two-week sprint. Ask me for team capacity in story points if it is not already provided. Explain your recommended selection and flag missing estimates or dependencies. Then invoke the approval-gated draftSprintPlan action with the saved work-item IDs so I can review and approve or reject saving the sprint as a draft."
  }
];

// Give this browser a stable agent-instance name so its workspace is separated
// from other browser workspaces. This ID is stored locally for convenience only;
// it is NOT authentication and must not be treated as proof of user identity.
function getWorkspaceId(): string {
  if (typeof window === "undefined") return `workshop-${crypto.randomUUID()}`;
  try {
    const key = "testingmind-projectpilot-workspace-v1";
    const saved = window.localStorage.getItem(key);
    if (saved) return saved;
    const created = window.crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return window.crypto.randomUUID();
  }
}

// Convert tool arguments/results into readable JSON for the approval and result cards.
function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
}

// AI SDK tool failures are stored on `errorText`, not in the normal output payload.
// Reading that field prevents the old generic "No error detail" message.
function getToolErrorMessage(part: unknown): string {
  if (!part || typeof part !== "object") return "The tool failed without returning a readable error.";
  const record = part as Record<string, unknown>;
  if (typeof record.errorText === "string" && record.errorText.trim()) return record.errorText;
  if (typeof record.errorMessage === "string" && record.errorMessage.trim()) return record.errorMessage;
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  if (record.error && typeof record.error === "object") {
    const nestedError = record.error as Record<string, unknown>;
    const nestedMessage = nestedError.message ?? nestedError.errorMessage ?? nestedError.cause;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) return nestedMessage;
    if (nestedMessage instanceof Error && nestedMessage.message.trim()) return nestedMessage.message;
  }
  return "The tool failed without returning a readable error. Open the diagnostic details and check the Worker logs.";
}

function formatDate(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

// Translate internal tool names into labels that make sense to a project owner.
function actionLabel(toolName: string): string {
  const labels: Record<string, string> = {
    createProject: "Create project workspace",
    createBacklogItems: "Add items to backlog",
    draftSprintPlan: "Save draft sprint plan"
  };
  return labels[toolName] ?? `Approve ${toolName}`;
}

// Main React screen: loads the saved workspace, renders Backlog and Sprint tabs,
// and hosts the chat panel where the agent proposes actions for approval.
export default function App() {
  // `useState` initializes the workspace ID once for this mounted browser app.
  const [workspaceId] = useState(() => getWorkspaceId());
  // Connect this UI to its named Cloudflare Durable Object agent instance.
  // The name isolates demo workspaces, but the app still needs real auth for production.
  const agent = useAgent({ agent: "ChatAgent", name: `workspace-${workspaceId}` });
  const [input, setInput] = useState("");
  const [board, setBoard] = useState<WorkspaceBoard>(emptyBoard);
  const [boardError, setBoardError] = useState("");
  const [chatError, setChatError] = useState("");
  const [boardLoading, setBoardLoading] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<"backlog" | "sprint">("backlog");
  const [backlogFilter, setBacklogFilter] = useState<"all" | "epic" | "story" | "task">("all");
  const [backlogSearch, setBacklogSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"all" | "must" | "should" | "could" | "wont">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "backlog" | "ready" | "in_progress" | "blocked" | "done">("all");
  const [selectedSprintId, setSelectedSprintId] = useState<string | undefined>();
  // Ignore stale board responses when refreshes overlap (for example, a user
  // switches projects while a post-approval refresh is still in flight).
  const boardRequestSequence = useRef(0);
  // A refresh can resolve the selected project and update its ID. Suppress the
  // project-selection effect for that programmatic change because this refresh
  // already loaded the board (and may carry a preferred newly-created sprint).
  const skipSelectionRefreshRef = useRef<{ pending: boolean; projectId?: string }>({ pending: false });

  // Load the project board through the read-only callable RPC. This is
  // called after the initial load, project changes, and successful approved writes.
  async function refreshBoard(
    projectId: string | undefined = selectedProjectId,
    preferredSprintId?: string
  ) {
    const requestId = ++boardRequestSequence.current;
    setBoardLoading(true);
    setBoardError("");
    try {
      const result = await agent.call("getWorkspaceBoard", projectId ? [projectId] : []);
      if (requestId !== boardRequestSequence.current) return;
      const next = result as WorkspaceBoard;
      setBoard(next);
      // When a write targets a specific project, keep the board focused on it
      // even if another project was selected before the approval completed.
      const resolvedProjectId = projectId && next.projects.some((project) => project.id === projectId)
        ? projectId
        : next.selectedProjectId ?? undefined;
      if (resolvedProjectId !== selectedProjectId) {
        skipSelectionRefreshRef.current = { pending: true, projectId: resolvedProjectId };
        setSelectedProjectId(resolvedProjectId);
      }
      setSelectedSprintId((current) => {
        if (preferredSprintId && next.sprints.some((sprint) => sprint.id === preferredSprintId)) {
          return preferredSprintId;
        }
        return current && next.sprints.some((sprint) => sprint.id === current)
          ? current
          : next.sprints[0]?.id;
      });
    } catch (error: unknown) {
      if (requestId === boardRequestSequence.current) {
        setBoardError(error instanceof Error ? error.message : "Unable to load the project workspace.");
      }
    } finally {
      if (requestId === boardRequestSequence.current) setBoardLoading(false);
    }
  }

  // Keep the latest transcript available to the terminal-turn callback. The
  // SDK can finish the resumed approval continuation before React's next effect
  // has run, so both synchronization paths inspect this same live snapshot.
  const latestMessagesRef = useRef<unknown[]>([]);
  const refreshedWriteToolCalls = useRef(new Set<string>());

  // Process a write only after its tool part is complete. An approval request
  // or approval response is not evidence that the database write succeeded.
  function processCompletedWriteMessages(sourceMessages: unknown[]) {
    for (const message of sourceMessages) {
      if (!message || typeof message !== "object") continue;
      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) continue;

      for (const candidate of parts) {
        const part = candidate as Parameters<typeof isToolUIPart>[0];
        if (!isToolUIPart(part)) continue;
        const normalizedState = getToolPartState(part);
        const rawState = "state" in part ? part.state : undefined;
        if (rawState !== "output-available" && normalizedState !== "complete") continue;

        const toolName = getToolName(part);
        if (!["createProject", "createBacklogItems", "draftSprintPlan"].includes(toolName)) continue;

        const toolCallId = getToolCallId(part);
        if (refreshedWriteToolCalls.current.has(toolCallId)) continue;
        refreshedWriteToolCalls.current.add(toolCallId);

        const input = getToolInput(part) as { projectId?: string } | undefined;
        const output = getToolOutput(part) as { id?: string; projectId?: string; persisted?: boolean } | undefined;
        // A completed tool part is not enough on its own: require the explicit
        // persistence acknowledgement returned after the SQLite INSERT succeeds.
        if (output?.persisted !== true) continue;
        const targetProjectId = input?.projectId ?? output.projectId ?? output.id ?? selectedProjectId;
        const preferredSprintId = toolName === "draftSprintPlan" ? output?.id : undefined;

        if (toolName === "createBacklogItems") {
          setActiveTab("backlog");
          setBacklogFilter("all");
          setBacklogSearch("");
          setPriorityFilter("all");
          setStatusFilter("all");
        } else if (toolName === "draftSprintPlan") {
          setActiveTab("sprint");
        }

        // The tool output is emitted only after its approval-gated execute()
        // handler has successfully inserted the records into SQLite.
        void refreshBoard(targetProjectId, preferredSprintId);
      }
    }
  }

  // useAgentChat manages the approval protocol and the resumed server turn.
  // Its terminal callback provides a second synchronization point: after the
  // approval continuation has ended, inspect the final transcript for writes.
  const { messages, sendMessage, addToolApprovalResponse, status } = useAgentChat({
    agent,
    autoContinueAfterToolResult: true,
    onTurnEnd: ({ outcome, error }) => {
      if (outcome === "error") {
        setChatError(error ?? "The agent request failed. Check the Worker logs for details.");
      } else {
        setChatError("");
        if (outcome === "completed") processCompletedWriteMessages(latestMessagesRef.current);
      }
    }
  });
  latestMessagesRef.current = messages;

  // The transcript effect handles streamed tool-state updates as soon as they
  // reach the client. The terminal callback above is a fallback for the exact
  // case where React batches the last tool update with the end-of-turn event.
  useEffect(() => {
    processCompletedWriteMessages(messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Fetch once when the screen opens and whenever the user changes projects.
  useEffect(() => {
    const skip = skipSelectionRefreshRef.current;
    if (skip.pending) {
      skipSelectionRefreshRef.current = { pending: false };
      if (skip.projectId === selectedProjectId) return;
    }
    void refreshBoard(selectedProjectId);
    // User-driven project changes load their board; refresh-driven selection
    // changes skip the duplicate read because the same response already loaded it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  // An approval-requested tool call is still an unfinished model operation.
  // Sending another prompt before approving/rejecting it can leave an unresolved
  // tool call in the transcript and trigger AI SDK "missing tool result" errors.
  const hasPendingApproval = messages.some((message) => message.parts.some((part) => {
    if (!isToolUIPart(part)) return false;
    return ("state" in part && (part.state === "approval-requested" || part.state === "approval-responded")) || getToolPartState(part) === "waiting-approval";
  }));
  const isChatBusy = status === "submitted" || status === "streaming" || hasPendingApproval;

  // Derived UI values are memoized so they are recalculated only when their inputs change.
  const selectedSprint = useMemo(
    () => board.sprints.find((sprint) => sprint.id === selectedSprintId) ?? board.sprints[0],
    [board.sprints, selectedSprintId]
  );

  // Filtering is presentation-only: it changes which rows are visible, not the
  // saved backlog in SQLite.
  const filteredBacklog = useMemo(() => {
    const query = backlogSearch.trim().toLowerCase();
    return board.backlog.filter((item) => {
      const matchesType = backlogFilter === "all" || item.type === backlogFilter;
      const matchesPriority = priorityFilter === "all" || item.priority === priorityFilter;
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesSearch = !query || [item.id, item.title, item.description].some((value) => value.toLowerCase().includes(query));
      return matchesType && matchesPriority && matchesStatus && matchesSearch;
    });
  }, [board.backlog, backlogFilter, backlogSearch, priorityFilter, statusFilter]);

  // Dashboard totals are calculated from the current saved board snapshot.
  const totalEstimate = board.backlog.reduce((sum, item) => sum + (item.estimatePoints ?? 0), 0);
  const mustHaveCount = board.backlog.filter((item) => item.priority === "must").length;

  // Send a user message to the agent. Ignore blank messages and prevent overlapping
  // submissions while the current response/tool sequence is still streaming.
  function submit(text = input) {
    const trimmed = text.trim();
    if (!trimmed || isChatBusy) return;
    setChatError("");
    // The selected project lives in the workspace UI, not automatically in the
    // model's conversation context. Attach it to typed prompts as well as starter
    // prompts so the approved write targets the project visible in the picker.
    const alreadyHasSelectedProject = Boolean(board.project && trimmed.includes(board.project.id));
    const projectContext = board.project && !alreadyHasSelectedProject
      ? `\n\nCurrent selected workspace project (use this project for backlog/sprint requests unless I explicitly specify another; if I ask to create a new project, create it separately):\nProject ID: ${board.project.id}\nProject name: ${board.project.name}\nObjective: ${board.project.objective}`
      : "";
    sendMessage({ text: `${trimmed}${projectContext}` });
    setInput("");
  }

  // Starter prompts use the same submit path as typed messages, including the
  // selected project's current workspace context.
  function usePrompt(prompt: string) {
    submit(prompt);
  }

  return (
    <main className="shell app-shell">
      <header className="topbar">
        <div className="brand-mark">PP</div>
        <div className="brand-copy">
          <p className="eyebrow">TESTINGMIND · HANDS-ON AI AGENT LAB</p>
          <h1>ProjectPilot</h1>
        </div>
        <div className="header-security"><span className="security-dot" /> HUMAN APPROVAL ON ALL WRITES</div>
      </header>

      <section className="page-intro">
        <div>
          <p className="eyebrow accent">OBJECTIVE → DELIVERABLES → BACKLOG → SPRINT</p>
          <h2>Turn a project goal into a sprint-ready plan.</h2>
          <p className="intro-copy">ProjectPilot translates a software project objective into deliverables, builds a prioritized backlog, and proposes a sprint based on team capacity. Every saved change pauses for your approval.</p>
        </div>
        <div className="model-pill"><span /> Llama 4 Scout · Workers AI</div>
      </section>

      {/* The toolbar switches the active project and lets the user refresh saved data. */}
      <section className="project-toolbar">
        <div className="project-picker-wrap">
          <label htmlFor="project-picker">WORKSPACE PROJECT</label>
          <select
            id="project-picker"
            value={selectedProjectId ?? ""}
            onChange={(event) => { setSelectedProjectId(event.target.value || undefined); setSelectedSprintId(undefined); setBacklogSearch(""); }}
          >
            <option value="">Select a project</option>
            {board.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <div className="toolbar-meta">
          <span className="meta-label">{board.project?.status ? titleCase(board.project.status) : "No project selected"}</span>
          <span className="meta-separator" />
          <span>Target: {formatDate(board.project?.targetDate)}</span>
          <button className="refresh-button" onClick={() => void refreshBoard()} disabled={boardLoading}>
            {boardLoading ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </section>

      {boardError && <div className="error-banner" role="alert">Workspace could not refresh: {boardError}</div>}

      {board.project && (
        <section className="project-summary-card">
          <div className="summary-icon">◎</div>
          <div className="summary-body">
            <div className="summary-title-row"><h3>{board.project.name}</h3><span className="project-id">{board.project.id}</span></div>
            <p>{board.project.objective}</p>
            {board.project.deliverables.length > 0 && (
              <div className="deliverables-strip">
                <div className="deliverables-heading">PHASED DELIVERABLES</div>
                <div className="deliverables-grid">
                  {board.project.deliverables.map((deliverable, index) => (
                    <article className="deliverable-card" key={`${deliverable.phase}-${index}`}>
                      <span>{deliverable.phase}</span>
                      <strong>{deliverable.title}</strong>
                      <small>{deliverable.outcome}</small>
                    </article>
                  ))}
                </div>
              </div>
            )}
            {board.project.scopeIn.length > 0 && <div className="scope-chips">{board.project.scopeIn.slice(0, 4).map((scope) => <span key={scope}>{scope}</span>)}</div>}
          </div>
        </section>
      )}

      {/* Main workspace on the left; conversational agent and approval cards on the right. */}
      <section className="dashboard-grid">
        <div className="main-workspace">
          <nav className="workspace-tabs" aria-label="Project planning views">
            <button className={activeTab === "backlog" ? "active" : ""} onClick={() => setActiveTab("backlog")}>
              <span className="tab-icon">☷</span> Backlog <span className="tab-count">{board.backlog.length}</span>
            </button>
            <button className={activeTab === "sprint" ? "active" : ""} onClick={() => setActiveTab("sprint")}>
              <span className="tab-icon">◷</span> Sprint plan <span className="tab-count">{board.sprints.length}</span>
            </button>
          </nav>

          {!board.project ? (
            <div className="workspace-empty">
              <div className="empty-illustration">✳</div>
              <p className="eyebrow accent">START WITH AN OBJECTIVE</p>
              <h3>Your project plan starts here.</h3>
              <p>Tell ProjectPilot what you want to deliver. It will clarify the objective, propose deliverables, and ask for approval before creating the project workspace.</p>
              <button className="primary-action" onClick={() => usePrompt(starterPrompts[0].prompt)}>Create a project brief <span>↗</span></button>
            </div>
          ) : activeTab === "backlog" ? (
            <section className="board-panel">
              {/* This tab is a read-only view of persisted epics, stories, and tasks. */}
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">DELIVERY WORK</p>
                  <h3>Product backlog</h3>
                  <p className="panel-subtitle">A prioritized breakdown of the work needed to deliver this objective.</p>
                </div>
                <button className="outline-action" onClick={() => usePrompt(starterPrompts[1].prompt)}>＋ Build backlog</button>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span>Total work items</span><strong>{board.backlog.length}</strong><small>Epics, stories and tasks</small></div>
                <div className="metric-card"><span>Must-have</span><strong>{mustHaveCount}</strong><small>Highest priority items</small></div>
                <div className="metric-card"><span>Estimated effort</span><strong>{totalEstimate}<em> pts</em></strong><small>Items with suggested estimates</small></div>
              </div>
              <div className="table-toolbar backlog-controls">
                <div className="filter-tabs" role="group" aria-label="Filter backlog by type">
                  {(["all", "epic", "story", "task"] as const).map((filter) => (
                    <button key={filter} className={backlogFilter === filter ? "selected" : ""} onClick={() => setBacklogFilter(filter)}>{filter === "all" ? "All items" : titleCase(filter)}</button>
                  ))}
                </div>
                <input
                  className="backlog-search"
                  value={backlogSearch}
                  onChange={(event) => setBacklogSearch(event.target.value)}
                  placeholder="Search title, description or ID…"
                  aria-label="Search backlog"
                />
                <select className="backlog-select" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)} aria-label="Filter by priority">
                  <option value="all">All priorities</option>
                  <option value="must">Must-have</option>
                  <option value="should">Should-have</option>
                  <option value="could">Could-have</option>
                  <option value="wont">Won't-have</option>
                </select>
                <select className="backlog-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="Filter by status">
                  <option value="all">All statuses</option>
                  <option value="backlog">Backlog</option>
                  <option value="ready">Ready</option>
                  <option value="in_progress">In progress</option>
                  <option value="blocked">Blocked</option>
                  <option value="done">Done</option>
                </select>
                <span className="row-count" aria-live="polite">{filteredBacklog.length} / {board.backlog.length} items</span>
              </div>
              {board.backlog.length === 0 ? (
                <div className="empty-board">
                  <div className="empty-board-icon">☷</div>
                  <h4>No backlog items yet</h4>
                  <p>Ask ProjectPilot to decompose the project objective into epics, user stories and implementation tasks.</p>
                  <button className="primary-action small" onClick={() => usePrompt(starterPrompts[1].prompt)}>Generate a backlog <span>↗</span></button>
                </div>
              ) : filteredBacklog.length === 0 ? (
                <div className="empty-board filter-empty">
                  <h4>No items match these filters</h4>
                  <p>Change the search or clear the filters to see the complete backlog.</p>
                  <button className="outline-action" onClick={() => { setBacklogFilter("all"); setBacklogSearch(""); setPriorityFilter("all"); setStatusFilter("all"); }}>Clear filters</button>
                </div>
              ) : (
                <div className="backlog-table-wrap">
                  {/* Each row shows a saved work item; opening its title reveals details. */}
                  <table className="backlog-table">
                    <thead><tr><th>WORK ITEM</th><th>TYPE</th><th>PRIORITY</th><th>STATUS</th><th className="estimate-column">EST.</th></tr></thead>
                    <tbody>
                      {filteredBacklog.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <details className="work-item-details">
                              <summary aria-label={`Show details for ${item.title}`}>
                                <span className="work-item-title">{item.title}</span>
                                <span className="work-item-id">{item.id} · click to view details</span>
                              </summary>
                              <div className="work-item-expanded">
                                <p>{item.description}</p>
                                {item.acceptanceCriteria.length > 0 && <><strong>Acceptance criteria</strong><ul>{item.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></>}
                                {item.dependencies.length > 0 && <p className="dependency-line">Dependencies: {item.dependencies.join(", ")}</p>}
                              </div>
                            </details>
                          </td>
                          <td><span className={`type-pill type-${item.type}`}>{item.type}</span></td>
                          <td><span className={`priority-pill priority-${item.priority}`}>{titleCase(item.priority)}</span></td>
                          <td><span className={`status-pill status-${item.status}`}>{titleCase(item.status)}</span></td>
                          <td className="estimate-column">{item.estimatePoints ?? "—"}<span className="points-suffix">{item.estimatePoints ? " pts" : ""}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="approval-note"><span>✓</span> New backlog items are only saved after you approve the proposed list in the agent panel.</div>
            </section>
          ) : (
            <section className="board-panel">
              {/* This tab displays saved draft proposals and deterministic warnings. */}
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">ITERATION PLANNING</p>
                  <h3>Sprint plan</h3>
                  <p className="panel-subtitle">A proposed sprint based on selected backlog items and explicit team capacity.</p>
                </div>
                <button className="outline-action" onClick={() => usePrompt(starterPrompts[2].prompt)}>＋ Propose sprint</button>
              </div>
              {board.sprints.length === 0 ? (
                <div className="empty-board sprint-empty">
                  <div className="empty-board-icon">◷</div>
                  <h4>No sprint proposals yet</h4>
                  <p>Ask ProjectPilot to inspect the backlog, confirm team capacity, and propose a sprint. It will save the draft only after your approval.</p>
                  <button className="primary-action small" onClick={() => usePrompt(starterPrompts[2].prompt)}>Plan a sprint <span>↗</span></button>
                </div>
              ) : selectedSprint ? (
                <>
                  <div className="sprint-select-row">
                    <label htmlFor="sprint-picker">SAVED PROPOSALS</label>
                    <select id="sprint-picker" value={selectedSprint.id} onChange={(event) => setSelectedSprintId(event.target.value)}>
                      {board.sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name} · {titleCase(sprint.status)}</option>)}
                    </select>
                    <span className="draft-pill">{titleCase(selectedSprint.status)}</span>
                  </div>
                  <div className="sprint-hero-card">
                    <div className="sprint-hero-top"><div><p className="eyebrow">SPRINT GOAL</p><h4>{selectedSprint.name}</h4></div><span className="draft-stamp">DRAFT PROPOSAL</span></div>
                    <p className="sprint-goal">{selectedSprint.goal}</p>
                    <div className="sprint-dates"><span>Start: <strong>{formatDate(selectedSprint.startDate)}</strong></span><span>End: <strong>{formatDate(selectedSprint.endDate)}</strong></span></div>
                  </div>
                  {/* Capacity is a visual representation of the server-calculated points. */}
                  <div className="capacity-card">
                    <div className="capacity-heading"><div><span>Planned capacity</span><strong>{selectedSprint.plannedPoints} <small>/ {selectedSprint.capacityPoints} pts</small></strong></div><span className={selectedSprint.remainingCapacity < 0 ? "capacity-over" : "capacity-remaining"}>{selectedSprint.remainingCapacity < 0 ? `${Math.abs(selectedSprint.remainingCapacity)} pts over` : `${selectedSprint.remainingCapacity} pts remaining`}</span></div>
                    <div className="capacity-track"><span style={{ width: `${Math.min(100, selectedSprint.capacityPoints > 0 ? (selectedSprint.plannedPoints / selectedSprint.capacityPoints) * 100 : 0)}%` }} className={selectedSprint.remainingCapacity < 0 ? "over" : ""} /></div>
                  </div>
                  {/* Show every validation warning returned by the deterministic evaluator. */}
                  {(selectedSprint.overCapacity || selectedSprint.unestimatedWorkItemIds.length > 0 || selectedSprint.dependencyWarnings.length > 0 || selectedSprint.unknownWorkItemIds.length > 0) ? (
                    <div className="sprint-warning-panel">
                      <strong>Review before accepting this sprint proposal</strong>
                      {selectedSprint.overCapacity && <p>Capacity is exceeded by {selectedSprint.overBy} points.</p>}
                      {selectedSprint.unestimatedWorkItemIds.length > 0 && <p>{selectedSprint.unestimatedWorkItemIds.length} selected item(s) have no estimate.</p>}
                      {selectedSprint.dependencyWarnings.length > 0 && <p>{selectedSprint.dependencyWarnings.length} dependency warning(s) need review.</p>}
                      {selectedSprint.unknownWorkItemIds.length > 0 && <p>{selectedSprint.unknownWorkItemIds.length} selected ID(s) are no longer in the backlog.</p>}
                    </div>
                  ) : (
                    <div className="sprint-clear-panel">Capacity and saved backlog dependencies have no detected warnings.</div>
                  )}
                  <div className="sprint-items-heading"><h4>Selected work items</h4><span>{selectedSprint.items.length} items</span></div>
                  <div className="sprint-item-list">
                    {selectedSprint.items.map((item) => (
                      <article className="sprint-item" key={item.id}>
                        <span className={`type-marker type-${item.type}`}>{item.type === "epic" ? "E" : item.type === "story" ? "S" : "T"}</span>
                        <div className="sprint-item-copy">
                          <strong>{item.title}</strong>
                          <small>{item.id} · {titleCase(item.priority)} priority</small>
                          <button className="text-link" onClick={() => {
                            setActiveTab("backlog");
                            setBacklogFilter(item.type);
                            setBacklogSearch(item.id);
                            setPriorityFilter("all");
                            setStatusFilter("all");
                          }}>View in backlog ↗</button>
                        </div>
                        <span className="sprint-item-points">{item.estimatePoints ?? "—"} <small>pts</small></span>
                      </article>
                    ))}
                  </div>
                  <div className="sprint-footnote">A saved sprint remains a draft proposal. It does not commit the team or update backlog item statuses.</div>
                </>
              ) : null}
            </section>
          )}
        </div>

        {/* The agent panel shows the conversation, tool execution states, and approval UI. */}
        <aside className="agent-panel" aria-label="ProjectPilot agent assistant">
          <div className="agent-panel-heading">
            <div className="agent-avatar">✳</div>
            <div><h3>ProjectPilot agent</h3><p>Objective · Backlog · Sprint</p></div>
            <span className="agent-live-dot" title="Agent connected" />
          </div>
          {chatError && <div className="chat-request-error" role="alert">{chatError}</div>}
          <div className="agent-scope"><strong>Focused skills</strong><div><span>01</span> Objective to deliverables</div><div><span>02</span> Backlog generation</div><div><span>03</span> Sprint proposal</div></div>
          <div className="agent-messages" aria-live="polite">
            {messages.length === 0 && (
              <div className="agent-welcome"><div className="welcome-spark">✳</div><h4>What are we planning?</h4><p>Share a project objective or choose a starting point below. I'll prepare the plan and ask before saving any changes.</p></div>
            )}
            {/* Render user/assistant text and any tool status emitted by the AI SDK. */}
            {messages.map((message) => (
              <article className={`chat-message ${message.role === "user" ? "chat-user" : "chat-assistant"}`} key={message.id}>
                <div className="chat-message-role">{message.role === "user" ? "YOU" : "PROJECTPILOT"}</div>
                {message.parts.map((part, index) => {
                  if (part.type === "text") return <p className="chat-message-text" key={index}>{part.text}</p>;
                  if (!isToolUIPart(part)) return null;
                  const toolName = getToolName(part);
                  const toolCallId = getToolCallId(part);
                  const toolState = getToolPartState(part);
                  // A pending approval is a hard pause: show the exact proposed input
                  // and send the user's decision back to the SDK. The database write
                  // remains on the server and only runs if the approval is granted.
                  if (("approval" in part && part.state === "approval-requested") || toolState === "waiting-approval") {
                    // Use Cloudflare's helper to normalize the SDK's approval payload.
                    const approval = getToolApproval(part);
                    const approvalId = approval?.id;
                    if (!approvalId) {
                      return <p className="chat-tool-error" key={toolCallId}>Approval could not be submitted because this tool call has no approval ID. Refresh the chat and retry.</p>;
                    }
                    return (
                      <div className="approval-card" key={toolCallId}>
                        <div className="approval-topline"><span className="approval-alert">ACTION REVIEW REQUIRED</span><span className="approval-shield">◇</span></div>
                        <h4>{actionLabel(toolName)}</h4>
                        <p>This operation will add records to your project workspace. Nothing is saved until you approve.</p>
                        <details className="approval-payload"><summary>Review exact proposed data</summary><pre>{pretty(getToolInput(part))}</pre></details>
                        <div className="approval-buttons">
                          <button type="button" className="approve-button" onClick={() => addToolApprovalResponse({ id: approvalId, approved: true })}>Approve & save</button>
                          <button type="button" className="reject-button" onClick={() => addToolApprovalResponse({ id: approvalId, approved: false })}>Reject</button>
                        </div>
                      </div>
                    );
                  }
                  if ("approval" in part && part.state === "approval-responded" && part.approval?.approved === true) {
                    return (
                      <div className="approval-card approval-processing" key={toolCallId}>
                        <div className="approval-topline"><span className="approval-alert">APPROVAL RECEIVED</span><span className="approval-shield">✓</span></div>
                        <strong>Saving approved changes…</strong>
                        <p>The agent is resuming the tool call. The workspace will update after the database write succeeds.</p>
                      </div>
                    );
                  }
                  if (toolState === "complete" || ("state" in part && part.state === "output-available")) {
                    return <details className="chat-tool-result" key={toolCallId}><summary>Completed: {toolName}</summary><pre>{pretty(getToolOutput(part))}</pre></details>;
                  }
                  if (toolState === "error" || ("state" in part && part.state === "output-error")) {
                    return (
                      <div className="chat-tool-error" key={toolCallId}>
                        <strong>Tool error · {toolName}</strong>
                        <p>{getToolErrorMessage(part)}</p>
                        <details>
                          <summary>Show diagnostic details</summary>
                          <pre>{pretty({ input: getToolInput(part), errorText: (part as unknown as Record<string, unknown>).errorText ?? null, state: toolState })}</pre>
                        </details>
                      </div>
                    );
                  }
                  if (toolState === "denied" || ("state" in part && part.state === "output-denied")) return <p className="chat-tool-denied" key={toolCallId}>Action rejected. No project data was changed.</p>;
                  return null;
                })}
              </article>
            ))}
            {status === "streaming" && <div className="agent-working"><span /><span /><span /> ProjectPilot is planning</div>}
          </div>
          <div className="quick-prompts">
            <p>START A WORKFLOW</p>
            {starterPrompts.map((prompt, index) => (
              <button key={prompt.label} onClick={() => usePrompt(prompt.prompt)} disabled={isChatBusy}>
                <span className="quick-index">0{index + 1}</span><span><strong>{prompt.label}</strong><small>{prompt.description}</small></span><b>↗</b>
              </button>
            ))}
          </div>
          {/* Submitting this form sends instructions only. Actual data changes happen
              later, inside an approval-gated server tool, if the user approves. */}
          <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }}
              placeholder={hasPendingApproval ? "Approve or reject the pending action above first…" : "Describe your project objective..."}
              rows={2}
              aria-label="Message ProjectPilot"
            />
            <button type="submit" disabled={!input.trim() || isChatBusy}>↑</button>
          </form>
          <div className="agent-panel-footnote"><span>◇</span> Every create action requires your approval before it writes to SQLite.</div>
        </aside>
      </section>

      <footer className="footer"><span>TESTINGMIND AI AGENT WORKSHOP · PROJECTPILOT</span><span>CLOUDFLARE AGENTS SDK · WORKERS AI · SQLITE</span></footer>
    </main>
  );
}
