---
name: agent-teams
description: Enable Codex-led team orchestration with worker specialization, shared task board, and compact artifact exchange. Use when the user asks for team mode or says "use agent teams", "use agents team", "$agent-teams", or "/agent-teams/skill".
license: Complete terms in LICENSE.txt
---

# Agent Teams Skill

Trigger phrases:
- Primary: `use agents team`
- Accepted aliases: `use agent teams`, `use agnet teams`, `use agnet team`, `$agent-teams`, `/agent-teams/skill`

Purpose:
- Run large coding tasks in parallel with specialist workers while keeping work isolated, reviewable, and merge-safe.

When to use:
- Multi-file implementation, migration, refactor, incident response, release hardening, or any task where parallel execution helps.

## Role Pack
- `lead`: orchestration, sequencing, final acceptance.
- `planner`: ticket decomposition, dependency gates.
- `implementer`: code changes.
- `reviewer`: correctness/regression review.
- `tester`: verification and evidence.
- `researcher`: focused evidence gathering.

## Non-Negotiable Defaults
- Preserve active-session model inheritance unless explicitly overridden.
- Hard cap: `max_threads=6`.
- Use compact artifact references and concise summaries between workers.
- No destructive git operations.
- Default integration base branch to `main` unless the user explicitly provides another base branch.
- When user explicitly requests agent teams (`use agent teams` / `use agents team`), run multi-agent mode with at least 2 workers unless user asks for single-agent mode.

## Runtime Isolation Defaults (v3-005)
- Scheduler allocates a unique branch + worktree binding per active worker assignment.
- Worker execution is fail-closed outside its assigned worktree path.
- Finalized/aborted teams trigger assignment cleanup to prevent orphan worktrees.

## Branch + Worktree Isolation (Required)
Every worker must run in its own branch/worktree to avoid collisions.

1. Create a run id and choose a base branch.
   - Default base branch: `main`.
   - If the user explicitly names another base branch, use that branch instead.
2. For each worker, use branch pattern `team/<run-id>/<role>-<index>` and worktree path `.tmp/agent-teams/<run-id>/<role>-<index>`.
3. Create worktree with `git worktree add -b team/<run-id>/implementer-1 .tmp/agent-teams/<run-id>/implementer-1 <base-branch>`.
4. Assign worker ownership; workers edit only assigned files/components unless lead reassigns.
5. Merge order: `reviewer`/`tester` branches after implementer review; integrate on base branch after validation.

## Worker Lifecycle Protocol (Required)
- Maintain a local worker-state table: `pending_init | running | completed | failed`.
- Spawn workers with explicit scope, constraints, and output format.
- Poll workers with `wait` timeout windows `>=120000ms`.
- If no worker completes in a poll window, report `still running (timeout window)` with `running=<n> completed=<n> failed=<n>`.
- Do not report timeout polls as failures.
- Remove completed/failed worker IDs from future wait calls.
- Keep user-facing progress messages explicit and deterministic, even if tool logs show `agents: none`.

## Strict Update Cadence (Required)
- Emit a lead update immediately after staffing is decided (before first worker poll).
- During active execution, emit at least one structured update per wait cycle.
- If a wait cycle times out with no terminal workers, emit `still running (timeout window)` and include `running/completed/failed` counts.
- Emit an update immediately after each control action (`pause`, `resume`, `drain`, `retry`) with outcome counts.
- Do not batch multiple wait cycles into a single user update.
- Do not claim `done` for any ticket without test evidence or explicit blocker note.

## Codex Tooling Contract (Required)
- Use `spawn_agent` to create each worker; do not emulate team mode with a single linear execution path.
- Use `send_input` to coordinate worker handoffs and clarifications.
- Use `wait` for polling and honor timeout semantics from the lifecycle protocol.
- Use `close_agent` after worker completion/failure to keep orchestration state clean.

## Communication Contract (Required)
Workers communicate through compact structured updates:
- `ticket_id`
- `status`
- `files_touched`
- `tests_run`
- `risks_or_blockers`
- `next_action`

Never exchange long raw transcripts between workers; pass summaries + artifact refs only.

## Card Templates (Required)
Use these exact card headers and key ordering in lead updates:

1. `STAFFING_CARD`
- `mode`: `static_sequence | dag_ready_roles`
- `planned_roles`: comma-separated ordered roles
- `spawned_count`: integer
- `hard_cap`: integer (must be `<=6`)

2. `QUEUE_CARD`
- `todo`
- `in_progress`
- `blocked`
- `done`
- `queue_depth` (`todo + in_progress + blocked`)

3. `FAILURE_CARD`
- `count`
- `top_blockers` (up to 5 task IDs, comma-separated, or `none`)

4. `EVIDENCE_CARD`
- `task_id`
- `test_refs`
- `artifact_refs`
- `replay_refs`

5. `CONTROL_CARD` (only when control actions occur)
- `command`: `pause | resume | drain | retry`
- `effect_count`
- `post_status`

## Execution Flow
1. Parse objective and derive role staffing (`<=6` workers).
2. Build ticket queue with dependency order.
3. Start worktrees/branches and spawn workers with explicit ownership.
4. Run implementation/review/test loops in parallel where dependencies allow.
5. Reconcile outputs, resolve conflicts, and merge in controlled order.
6. Run final lint/typecheck/tests on integration branch.
7. Return concise completion report with evidence.

## Final User Report Format
- Tickets completed / in progress / blocked
- Branches/worktrees used
- Files changed
- Tests run + pass/fail evidence
- Blockers
- Next 1-3 actions
