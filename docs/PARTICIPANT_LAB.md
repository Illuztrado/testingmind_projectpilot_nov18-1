# Participant Lab — ProjectPilot

**Goal:** Turn one software project objective into a project brief, a backlog and a draft sprint — with human approval before every write.

## Exercise 1 — Objective to deliverables (10 minutes)

Send ProjectPilot:

```text
I want to build a customer self-service portal where customers can view policies and submit service requests. Target delivery is 10 weeks. Ask me for missing information, then propose a short project brief and phased deliverables. Show the exact project fields and wait for my approval before saving.
```

Review the brief. Check the name, objective, scope, dates and deliverable breakdown. Select **Approve & save** only when the proposed project information is correct. Reject it to observe that no project is created.

## Exercise 2 — Deliverables to backlog (15 minutes)

With the saved project selected, send:

```text
Break this project's objective into epics, user stories and implementation tasks. Include concise descriptions, acceptance criteria, MoSCoW priorities, suggested story points and dependencies. Do not invent owners or due dates. Show the full proposed backlog and wait for my approval before saving.
```

Inspect the approval card. Expand **Review exact proposed data**. Approve the proposed backlog, then open the **Backlog** view. Filter by epic, story and task. Expand individual items to inspect acceptance criteria and dependencies.

## Exercise 3 — Backlog to sprint (15 minutes)

Send:

```text
Inspect the saved backlog and propose a two-week sprint with a capacity of 24 story points. Select sensible work items, write a sprint goal, and flag missing estimates or unfinished dependencies. Show the complete proposed sprint and wait for my approval before saving.
```

Review the selected items and capacity. Reject the proposal once to see that it is not saved, then try again and approve. Open **Sprint plan** to inspect the saved draft.

## Exercise 4 — Verify human oversight (10 minutes)

For each write tool (`createProject`, `createBacklogItems`, `draftSprintPlan`), confirm that:

- The UI displays an approval card before the write runs.
- The exact input can be inspected.
- Reject prevents persistence.
- Approve permits persistence and refreshes the board.

Discuss why reads can run automatically but writes require human approval.

## Wrap-up (10 minutes)

Discuss how the model proposes work, how the tools validate and persist data, and why the application—not the LLM—enforces the approval gate.
