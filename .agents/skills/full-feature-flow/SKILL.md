---
name: full-feature-flow
description: Use ONLY when the user explicitly asks for the full feature flow, full-feature-flow, or this skill by name. Do not use for ordinary feature work, bugfixes, or planning unless the user names this skill or flow.
---

# Full Feature Flow

Orchestrate a feature through dedicated subagents. The parent does not explore, implement, or review in place of those subagents.

## When to run

Run this skill only after an explicit request such as "use full feature flow", "run full-feature-flow", or "implement this with the planning/implementing/review pipeline".

The user's message is the feature task. If the task is missing or too vague to plan, ask one clarifying question and stop until they answer.

## Pipeline

Run these steps in order. Do not skip ahead. Do not start implementation until the planner returns a plan.

### 1. Planning agent

Invoke the Task tool with `subagent_type: "feature-planner"`.

Tell it to:

- Explore the existing code related to the feature.
- Return a high-level architecture plan.
- Name reusable utilities, modules, and main entry points that should be used.
- Not give detailed code instructions, line-level edits, function bodies, or file-by-file implementation recipes.

If the planner reports blocking questions, ask the user and re-run planning. Do not implement yet.

Show the user the plan in a short summary, then continue. Do not wait for approval unless the user asked to review the plan first.

### 2. Implementing agent

Invoke the Task tool with `subagent_type: "feature-implementer"`.

Give it the original feature task and the full planner output. Tell it to implement the plan, follow `AGENTS.md`, and not stop until `mise exec -- pn test` passes. That test command needs a timeout of at least 300 seconds.

If implementation fails or tests fail, send the implementer the failure output and have it fix the work. Do not move to review until tests pass.

### 3. Review subagent

Invoke the Task tool with `subagent_type: "feature-reviewer"`.

Tell it the feature task, the plan, and which files changed. It must not edit files, run formatters, or commit. It only reports bugs, regressions, missing tests, and convention violations.

### 4. Parent fixes and commits

Fix the review findings yourself. Do not re-run the implementer for small review fixes.

Then:

1. Run `mise exec -- pn test` with a timeout of at least 300 seconds.
2. If tests fail, fix them and run `pn test` again.
3. Load the `create-commits` skill and commit the feature.

Do not commit unrelated user changes.
