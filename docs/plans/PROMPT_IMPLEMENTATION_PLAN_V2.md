# Fresh Codex Prompt (Implementation Plan v2 Continuation)

```text
You are continuing an existing implementation (do not restart from scratch) for codex-team-orchestrator.

Primary files to follow:
1) docs/plans/IMPLEMENTATION_PLAN_END_TO_END.md (v2 plan; source of truth for sequencing and parallelization)
2) docs/plans/SPRINT_PROGRESS.md (canonical tracker; update this file as work progresses)

Current baseline (already delivered):
- CTO-P0-001: done (commit 20fc6d5)
- CTO-P0-002: done (commit 9e9b79a)
- CTO-P0-003: done (commit a66c4a7)
- CTO-P0-004: done (commit 04d4920)
- CTO-P0-005: done (commit 89ba973)
- CTO-P0-006: done (commits 4fddd0c, 2a2a01e)
- CTO-P0-007: done (commit c5a3189)
- CTO-P0-008: done (commit 6b2ecf5)
- CTO-P0-009: done (commit 19234c0)

Execution requirements:
- Mode: parallel-agent-team
- Use agent teams skill and strict branch/worktree isolation.
- Keep main branch clean; all coding in team/<run-id>/<role>-<index> branches.
- Execute by priority P0 -> P1 -> P2, but parallelize independent tickets per v2 wave plan.
- Do not reduce quality gates from v1/v2 plans.

Mandatory quality and evidence gates per ticket before status=done:
- linked passing tests (focused + full relevant suites)
- commit_sha
- pushed_branch
- pr_link (or explicit no-pr note)

Immediate objective:
1) Start P1 wave with CTO-P1-003 (quality gates) and CTO-P1-002 (DAG staffing upgrades).
2) Continue P1-only execution until all P1 tickets are accepted, then move to P2.
3) Keep docs/plans/SPRINT_PROGRESS.md updated after each accepted ticket with completion math.

Reporting format in each update:
- tickets completed / in_progress / blocked
- branches/worktrees used
- files changed
- tests run + pass/fail evidence
- blockers
- next 1-3 actions
```
