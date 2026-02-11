# CTO End-to-End Implementation Plan (Agent Teams Remediation Run)

Date: 2026-02-11
Prepared from: user remediation plan + codebase validation (`mcp/*`, `tests/*`)
Objective: implement and verify six remediation findings covering approvals, dispatch reliability, executor terminal semantics, command guardrails, optimizer budgets, and role-aware task paging.

## 0) Execution Strategy (Required)

1. Execution mode: `parallel-agent-team`
2. Run settings:
   - `max_threads`: `6`
   - `run_id`: `run-20260211-201619`
   - `base_branch`: `codex/implementation-fix-agentteam`
3. Lead model: `GPT-5 Codex`
4. Worker model policy:
   - `P0`: n/a for this run
   - `P1/P2`: mixed implementer lanes with lead integration and full-suite validation
5. Priority order rule: `P0 -> P1 -> P2` (this run contains only `P1` and `P2`)
6. Parallelization rule:
   - execute dependency-safe lane groups in parallel
   - keep tightly coupled store/tool changes in one lane
7. Tracking rule:
   - canonical tracker: `docs/plans/SPRINT_PROGRESS.md`

## 0.1) Continuation Baseline (Required for Non-Fresh Runs)

1. Existing baseline delivery from prior program remains complete (`CTO-P0-*`, `CTO-P1-*`, `CTO-P2-*`).
2. This run is a targeted remediation continuation, not a restart.
3. New remediation backlog for this run:
   - `CTO-P1-009`
   - `CTO-P1-010`
   - `CTO-P1-011`
   - `CTO-P1-012`
   - `CTO-P2-007`
   - `CTO-P2-008`

## 1) Worker Topology + Isolation (Required)

1. Worker roles:
   - `lead`: orchestration, integration, acceptance
   - `implementer-1`: policy + executor
   - `implementer-2`: lifecycle reliability + task-board role paging
   - `implementer-3`: guardrails + optimizer
2. Branch/worktree naming:
   - Branch: `team/run-20260211-201619/<role>-<index>`
   - Worktree: `.tmp/agent-teams/run-20260211-201619/<role>-<index>`
3. Isolation policy:
   - no implementation on `main`
   - worker file ownership boundaries enforced by assignment
   - no destructive git operations

## 2) Parallelization Design (Required)

### Lane Topology

| Lane | Focus | Candidate Tickets |
|---|---|---|
| A | Policy + executor validation | `CTO-P1-009`, `CTO-P1-010` |
| B | Direct-message reliability + role paging | `CTO-P1-011`, `CTO-P2-008` |
| C | Command guardrails + optimizer budgeting | `CTO-P1-012`, `CTO-P2-007` |

### Dependency Waves

1. Wave 1: lane A/B/C implementation in parallel
2. Wave 2: lead integration + conflict resolution
3. Wave 3: full validation pass (unit + integration + typecheck)

### Dependency Table

| Ticket | Depends On | Lane | Wave | Can Parallelize With |
|---|---|---|---|---|
| `CTO-P1-009` | none | A | 1 | `CTO-P1-011`, `CTO-P1-012`, `CTO-P2-007`, `CTO-P2-008` |
| `CTO-P1-010` | none | A | 1 | `CTO-P1-011`, `CTO-P1-012`, `CTO-P2-007`, `CTO-P2-008` |
| `CTO-P1-011` | none | B | 1 | `CTO-P1-009`, `CTO-P1-010`, `CTO-P1-012`, `CTO-P2-007` |
| `CTO-P2-008` | `CTO-P1-011` (shared store/tool context) | B | 1 | `CTO-P1-009`, `CTO-P1-010`, `CTO-P1-012`, `CTO-P2-007` |
| `CTO-P1-012` | none | C | 1 | `CTO-P1-009`, `CTO-P1-010`, `CTO-P1-011`, `CTO-P2-008` |
| `CTO-P2-007` | none | C | 1 | `CTO-P1-009`, `CTO-P1-010`, `CTO-P1-011`, `CTO-P2-008` |

## 3) Workstreams

## Workstream A: Policy + Runtime Validation
Owner: `W-Implementer-1` with lead integration

### A1. Approval gate dedupe/latest semantics
- Files:
  - `mcp/server/policy-hooks.ts`
  - `tests/unit/v3-203.approvals.test.ts`
- Implement:
  - dedupe approval chain by `agent_id`
  - latest decision precedence using parseable `decided_at` with input-order fallback
  - threshold checks based on deduped approvals only
  - metadata counters for raw/unique chain size

### A2. Executor terminal-state validation logic
- Files:
  - `mcp/runtime/executor.ts`
  - `tests/unit/v3-006.execution-loop.test.ts`
  - `tests/integration/v3-006.autonomous-loop.integration.test.ts`
- Implement:
  - terminal success/failure classifier
  - non-terminal validation skip path (leave task `in_progress`)
  - terminal failure -> blocked
  - terminal success requires evidence signal before done

## Workstream B: Reliability + Task Queue Correctness
Owner: `W-Implementer-2` with lead integration

### B1. team_send compensation rollback
- Files:
  - `mcp/server/tools/agent-lifecycle.ts`
  - `mcp/store/sqlite-store.ts`
  - `tests/unit/at006.agent-lifecycle.test.ts`
  - `tests/integration/v3-003.adapter.integration.test.ts`
- Implement:
  - transactional rollback API for inserted message/inbox rows
  - rollback + telemetry event on adapter send failure
  - failure envelope includes adapter error + rollback outcome

### B2. role-aware ready-task retrieval before limit
- Files:
  - `mcp/store/sqlite-store.ts`
  - `mcp/server/tools/task-board.ts`
  - `tests/unit/at007.task-board.test.ts`
  - `tests/integration/at007.task-board.integration.test.ts`
- Implement:
  - `listReadyTasksByRole(teamId, requiredRole, limit)` query
  - `team_task_next` role branch uses role-aware query before limiting

## Workstream C: Guardrails + Optimizer
Owner: `W-Implementer-3` with lead integration

### C1. allow-prefix boundary-safe matching and chain blocking
- Files:
  - `mcp/server/guardrails.ts`
  - `tests/unit/v3-106.security.test.ts`
  - `tests/integration/v3-106.security.integration.test.ts`
- Implement:
  - boundary-aware prefix matcher (exact or whitespace boundary)
  - chained operator block (`&&`, `||`, `;`, `|`) in allow-prefix path

### C2. runtime-capped optimizer token budget
- Files:
  - `mcp/server/budget-controller.ts`
  - `tests/unit/v3-105.optimizer.test.ts`
  - `tests/integration/v3-105.optimizer.integration.test.ts`
- Implement:
  - `token_budget = min(policy_soft_limit, floor(max(0, budget_tokens_remaining)))`
  - consistent usage in constraints, `meets_slo.cost`, and scoring

## 4) Delivery Plan (Wave-Based)

## Wave 1 (Parallel)
1. lane A/B/C implementations
2. focused test updates per ticket
3. exit gate: lane-level unit tests pass

## Wave 2 (Integration)
1. integrate lane outputs onto `codex/implementation-fix-agentteam`
2. reconcile overlap in `sqlite-store.ts` and related tests
3. exit gate: integrated unit + integration runs pass

## Wave 3 (Acceptance)
1. run full unit suite (`npm run test:unit:ts -- ...`)
2. run full integration suite (`npm run test:integration:ts -- ...`)
3. run `npm run typecheck`
4. exit gate: all pass, no open blockers

## 5) Definition of Done (Required)

1. Ticket must include linked passing test evidence, or explicit blocker note.
2. Ticket must include touched files and verification commands.
3. Critical behavior changes must be traceable via deterministic tests.
4. No schema-breaking external tool API changes.

## 6) Worker Lifecycle + Anti-Stall Protocol (Required)

1. Worker state machine: `pending_init | running | completed | failed`
2. Wait timeout windows: `>=120000ms`
3. Timeout handling:
   - emit `still running (timeout window) running=<n> completed=<n> failed=<n>`
   - send structured heartbeat request (`ticket_id`, `status`, `files_touched`, `tests_run`, `risks_or_blockers`, `eta_minutes`)
4. This run observed timeout windows and heartbeat recovery before lead integration takeover.

## 7) Ticketing System

Ticket format used:
- `ID`: `CTO-P1-009` ... `CTO-P2-008`
- `Owner`: worker lane + lead integration
- `Scope`: explicit file list
- `Acceptance`: objective assertions in linked unit/integration tests
- `Linked Tests`: command + file mapping
- `Status`: `done`

## 8) Master Ticket Backlog

## P1 Tickets (Stabilization)

| Ticket ID | Title | Owner | Lane | Wave | Depends On | Key Files | Linked Tests | Status |
|---|---|---|---|---|---|---|---|---|
| `CTO-P1-009` | Approval dedupe + latest decision semantics | W-Implementer-1 + Lead | A | 1 | none | `mcp/server/policy-hooks.ts` | `tests/unit/v3-203.approvals.test.ts` | done |
| `CTO-P1-010` | Executor requires terminal success + evidence before done | W-Implementer-1 + Lead | A | 1 | none | `mcp/runtime/executor.ts` | `tests/unit/v3-006.execution-loop.test.ts`, `tests/integration/v3-006.autonomous-loop.integration.test.ts` | done |
| `CTO-P1-011` | team_send rollback compensation on adapter send failure | W-Implementer-2 + Lead | B | 1 | none | `mcp/server/tools/agent-lifecycle.ts`, `mcp/store/sqlite-store.ts` | `tests/unit/at006.agent-lifecycle.test.ts`, `tests/integration/v3-003.adapter.integration.test.ts` | done |
| `CTO-P1-012` | allow-prefix boundary-safe matching + chain blocking | W-Implementer-3 + Lead | C | 1 | none | `mcp/server/guardrails.ts` | `tests/unit/v3-106.security.test.ts`, `tests/integration/v3-106.security.integration.test.ts` | done |

## P2 Tickets (Future-proofing)

| Ticket ID | Title | Owner | Lane | Wave | Depends On | Key Files | Linked Tests | Status |
|---|---|---|---|---|---|---|---|---|
| `CTO-P2-007` | Optimizer token budget capped by runtime remainder | W-Implementer-3 + Lead | C | 1 | none | `mcp/server/budget-controller.ts` | `tests/unit/v3-105.optimizer.test.ts`, `tests/integration/v3-105.optimizer.integration.test.ts` | done |
| `CTO-P2-008` | team_task_next applies role filter before limit | W-Implementer-2 + Lead | B | 1 | `CTO-P1-011` | `mcp/store/sqlite-store.ts`, `mcp/server/tools/task-board.ts` | `tests/unit/at007.task-board.test.ts`, `tests/integration/at007.task-board.integration.test.ts` | done |

## 9) Detailed Ticket Specs

### CTO-P1-009 Approval dedupe + latest decision semantics
- owner: `W-Implementer-1 + Lead`
- scope/files: `mcp/server/policy-hooks.ts`, `tests/unit/v3-203.approvals.test.ts`
- acceptance criteria:
  - duplicate approvals by same `agent_id` count once
  - latest decision wins by parseable timestamp; fallback to last occurrence
  - metadata includes `approval_chain_raw_count` and `approval_chain_unique_count`
- linked tests:
  - `npm run test:unit:ts -- tests/unit/v3-203.approvals.test.ts`
- status: done

### CTO-P1-010 Executor terminal success validation
- owner: `W-Implementer-1 + Lead`
- scope/files: `mcp/runtime/executor.ts`, `tests/unit/v3-006.execution-loop.test.ts`, `tests/integration/v3-006.autonomous-loop.integration.test.ts`
- acceptance criteria:
  - non-terminal/absent poll => skipped (task stays `in_progress`)
  - terminal failure => blocked
  - terminal success with missing evidence => blocked
  - only terminal success + evidence publishes artifact and marks done
- linked tests:
  - `npm run test:unit:ts -- tests/unit/v3-006.execution-loop.test.ts`
  - `npm run test:integration:ts -- tests/integration/v3-006.autonomous-loop.integration.test.ts`
- status: done

### CTO-P1-011 team_send rollback compensation
- owner: `W-Implementer-2 + Lead`
- scope/files: `mcp/server/tools/agent-lifecycle.ts`, `mcp/store/sqlite-store.ts`, `tests/unit/at006.agent-lifecycle.test.ts`, `tests/integration/v3-003.adapter.integration.test.ts`
- acceptance criteria:
  - on sendInstruction failure after insert, rollback removes inbox then message transactionally
  - rollback telemetry event emitted
  - retry with same idempotency key can dispatch successfully
- linked tests:
  - `npm run test:unit:ts -- tests/unit/at006.agent-lifecycle.test.ts`
  - `npm run test:integration:ts -- tests/integration/v3-003.adapter.integration.test.ts`
- status: done

### CTO-P1-012 allow-prefix boundary and chain hardening
- owner: `W-Implementer-3 + Lead`
- scope/files: `mcp/server/guardrails.ts`, `tests/unit/v3-106.security.test.ts`, `tests/integration/v3-106.security.integration.test.ts`
- acceptance criteria:
  - allow-prefix matches only exact/whitespace boundary
  - chained commands in allow-prefix path are denied with explicit rule marker
  - deny-pattern precedence unchanged
- linked tests:
  - `npm run test:unit:ts -- tests/unit/v3-106.security.test.ts`
  - `npm run test:integration:ts -- tests/integration/v3-106.security.integration.test.ts`
- status: done

### CTO-P2-007 runtime-capped optimizer budget
- owner: `W-Implementer-3 + Lead`
- scope/files: `mcp/server/budget-controller.ts`, `tests/unit/v3-105.optimizer.test.ts`, `tests/integration/v3-105.optimizer.integration.test.ts`
- acceptance criteria:
  - `constraints.token_budget` equals min(soft limit, runtime budget)
  - cost SLO decisions reflect runtime-capped budget
- linked tests:
  - `npm run test:unit:ts -- tests/unit/v3-105.optimizer.test.ts`
  - `npm run test:integration:ts -- tests/integration/v3-105.optimizer.integration.test.ts`
- status: done

### CTO-P2-008 role-aware ready queue before limit
- owner: `W-Implementer-2 + Lead`
- scope/files: `mcp/store/sqlite-store.ts`, `mcp/server/tools/task-board.ts`, `tests/unit/at007.task-board.test.ts`, `tests/integration/at007.task-board.integration.test.ts`
- acceptance criteria:
  - role-aware query applies role predicate before LIMIT
  - `team_task_next(for_agent_id, limit)` returns role-matching tasks even when global first page is other roles
- linked tests:
  - `npm run test:unit:ts -- tests/unit/at007.task-board.test.ts`
  - `npm run test:integration:ts -- tests/integration/at007.task-board.integration.test.ts`
- status: done
