---
name: agent-teams
description: Enable Codex-led team orchestration with worker specialization, shared task board, and compact artifact exchange. Use when the user asks for team mode or says "use agents team".
license: Complete terms in LICENSE.txt
---

# Agent Teams Skill

Trigger phrases:
- Primary: `use agents team`
- Accepted aliases: `use agent teams`, `use agnet teams`, `use agnet team`

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

## Runtime Isolation Defaults (v3-005)
- Scheduler allocates a unique branch + worktree binding per active worker assignment.
- Worker execution is fail-closed outside its assigned worktree path.
- Finalized/aborted teams trigger assignment cleanup to prevent orphan worktrees.

## Branch + Worktree Isolation (Required)
Every worker must run in its own branch/worktree to avoid collisions.

1. Create a run id and a base branch.
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

## Communication Contract (Required)
Workers communicate through compact structured updates:
- `ticket_id`
- `status`
- `files_touched`
- `tests_run`
- `risks_or_blockers`
- `next_action`

Never exchange long raw transcripts between workers; pass summaries + artifact refs only.

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
