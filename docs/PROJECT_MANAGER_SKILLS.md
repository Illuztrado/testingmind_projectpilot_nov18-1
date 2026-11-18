# ProjectPilot — In-scope skills

ProjectPilot is intentionally limited to three capabilities for the Testingmind workshop.

## 1. Objective to project brief and deliverables

**Input:** A project objective, expected outcome, constraints, target timeframe and known scope.

**Agent behavior:** Clarify missing information; summarize the objective; suggest in-scope/out-of-scope boundaries; split the outcome into phased deliverables; distinguish confirmed facts from assumptions.

**Output:** A proposed project brief and 3–6 phased deliverables, each with a phase, title, and verifiable outcome.

**Persistence:** `createProject` saves the project brief and deliverables only after human approval. Deliverables are stored with the project and displayed in the workspace.

## 2. Deliverables to backlog

**Input:** An approved project brief and deliverables.

**Agent behavior:** Decompose work into epics, stories and implementation tasks; add clear descriptions and acceptance criteria; recommend MoSCoW priority; provide optional story-point suggestions; identify known dependencies. It must not invent owners or due dates.

**Output:** A proposed backlog shown to the user in the approval card, then rendered in the Backlog UI after approval.

**Persistence:** `createBacklogItems` inserts items only after human approval.

## 3. Backlog to sprint proposal

**Input:** A saved backlog, an explicit team capacity in story points and (optionally) sprint dates.

**Agent behavior:** Read the backlog; propose a sprint goal and selected backlog items; explain selection trade-offs; flag over-capacity, missing estimates, unknown IDs and incomplete/missing dependencies.

**Output:** A sprint proposal with selected work, planned points, remaining capacity, warnings and draft status, displayed in the Sprint plan UI after approval.

**Persistence:** `draftSprintPlan` inserts a draft sprint only after human approval. It does not mark backlog work as committed or change work-item statuses.

## Out of scope

Project status reports, RAID management, meeting transcription, release readiness, scope-change management, external integrations, automatic task assignment, notifications, code execution and deletion are deliberately excluded from this workshop app.
