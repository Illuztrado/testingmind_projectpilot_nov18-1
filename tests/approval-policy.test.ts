import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/app.tsx", import.meta.url), "utf8");

// These source-level tests protect the human-in-the-loop contract. They fail if
// someone adds a write tool without an approval gate or moves persistence outside it.
test("every exposed write tool requires approval before execute", () => {
  const writeTools = ["createProject", "createBacklogItems", "draftSprintPlan"];
  for (const name of writeTools) {
    const start = server.indexOf(`${name}: tool({`);
    assert.notEqual(start, -1, `Expected ${name} to be exposed as a tool`);
    const nextTool = server.indexOf("\n\n        ", start + 1);
    const block = server.slice(start, nextTool === -1 ? server.length : nextTool);
    assert.match(block, /needsApproval:\s*true/, `${name} must require approval`);
    assert.ok(block.indexOf("needsApproval: true") < block.indexOf("execute:"), `${name} approval must be declared before its execute handler`);
  }
});

test("the focused agent exposes no update or delete tools", () => {
  assert.doesNotMatch(server, /updateProjectDetails:\s*tool\(/);
  assert.doesNotMatch(server, /updateWorkItem:\s*tool\(/);
  assert.doesNotMatch(server, /delete(Project|Backlog|WorkItem|Sprint).*:\s*tool\(/i);
});

test("the system prompt explicitly invokes approval-gated write tools for save requests", () => {
  assert.match(server, /proposal written only in chat text does not create an approval card/i);
  assert.match(server, /call createBacklogItems exactly once/i);
  assert.match(server, /call draftSprintPlan exactly once/i);
  assert.match(server, /Approve & save.*only approval/i);
  assert.match(server, /persisted: true/i);
});

test("the UI renders explicit approval requests and sends approve/reject responses", () => {
  assert.match(app, /part\.state === "approval-requested"/);
  assert.match(app, /part\.state === "approval-requested"/);
  assert.match(app, /getToolApproval\(part\)/);
  assert.match(app, /const approvalId = approval\?\.id/);
  assert.match(app, /addToolApprovalResponse\(\{ id: approvalId, approved: true \}\)/);
  assert.match(app, /addToolApprovalResponse\(\{ id: approvalId, approved: false \}\)/);
  assert.match(app, /approval-gated createBacklogItems action/);
  assert.match(app, /approval-gated draftSprintPlan action/);
});


// This narrow version intentionally allows only three INSERT statements and no
// UPDATE/DELETE statements. New mutation tools must expand this test deliberately.
test("all application data writes are limited to the three approval-gated inserts", () => {
  const inserts = [...server.matchAll(/INSERT\s+INTO\s+(projects|work_items|sprints)/gi)];
  assert.deepEqual(inserts.map((match) => match[1].toLowerCase()).sort(), ["projects", "sprints", "work_items"]);
  assert.doesNotMatch(server, /\bUPDATE\s+(projects|work_items|sprints)\b/i);
  assert.doesNotMatch(server, /\bDELETE\s+FROM\s+(projects|work_items|sprints)\b/i);
});

test("approved project briefs persist phased deliverables and the board returns them", () => {
  assert.match(server, /deliverables: z\.array\(z\.object\(/);
  assert.match(server, /JSON\.stringify\(deliverables\)/);
  assert.match(server, /deliverables: parseJson<Array<\{ phase: string; title: string; outcome: string \}>>/);
  assert.match(app, /board\.project\.deliverables\.map/);
});

test("approved tool calls automatically resume on the server", () => {
  assert.match(app, /autoContinueAfterToolResult:\s*true/);
  assert.match(app, /addToolApprovalResponse\(\{ id: approvalId, approved: true \}\)/);
  assert.match(app, /addToolApprovalResponse\(\{ id: approvalId, approved: false \}\)/);
});

test("workspace refresh requires a persisted success result from the approved write", () => {
  assert.match(app, /if \(output\?\.persisted !== true\) continue/);
  assert.match(server, /persisted: true/);
});

test("typed prompts carry the selected project context into the agent conversation", () => {
  assert.match(app, /Current selected workspace project/);
  assert.match(app, /Project ID: \$\{board\.project\.id\}/);
  assert.match(app, /function usePrompt\(prompt: string\) \{\s*submit\(prompt\);/);
});

test("saved backlog and sprint writes trigger a read-after-write workspace refresh", () => {
  assert.match(app, /rawState !== "output-available" && normalizedState !== "complete"/);
  assert.match(app, /\["createProject", "createBacklogItems", "draftSprintPlan"\]/);
  assert.match(app, /void refreshBoard\(targetProjectId, preferredSprintId\)/);
  assert.match(app, /onTurnEnd: \(\{ outcome, error \}\)/);
  assert.match(app, /processCompletedWriteMessages\(latestMessagesRef\.current\)/);
  assert.match(app, /setActiveTab\("backlog"\)/);
  assert.match(app, /setActiveTab\("sprint"\)/);
  assert.match(app, /preferredSprintId && next\.sprints\.some/);
  assert.match(app, /boardRequestSequence\.current/);
  assert.match(app, /skipSelectionRefreshRef\.current = \{ pending: true, projectId: resolvedProjectId \}/);
  assert.match(app, /if \(skip\.projectId === selectedProjectId\) return/);
});

test("tool failures render the AI SDK errorText field instead of an empty tool output", () => {
  assert.match(app, /record\.errorText/);
  assert.match(app, /getToolErrorMessage\(part\)/);
  assert.match(app, /Show diagnostic details/);
});

test("the backlog has usable search, priority, status, and type filters", () => {
  assert.match(app, /aria-label="Search backlog"/);
  assert.match(app, /aria-label="Filter by priority"/);
  assert.match(app, /aria-label="Filter by status"/);
  assert.match(app, /aria-label="Filter backlog by type"/);
});

test("sprint items can navigate to their source backlog item", () => {
  assert.match(app, /View in backlog/);
  assert.match(app, /setActiveTab\("backlog"\)/);
  assert.match(app, /setBacklogSearch\(item\.id\)/);
});

test("optional date and estimate fields accept null or blank values from model tool calls", () => {
  assert.match(server, /z\.literal\(""\)/);
  assert.match(server, /normalizeOptionalDate\(value\?: string \| null\)/);
  assert.match(server, /estimatePoints: z\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.nullable\(\)\.optional\(\)/);
});

test("the composer is locked while a tool approval is unresolved", () => {
  assert.match(app, /const hasPendingApproval = messages\.some/);
  assert.match(app, /status === "submitted" \|\| status === "streaming" \|\| hasPendingApproval/);
  assert.match(app, /Approve or reject the pending action above first/);
});
