# CTO End-to-End Implementation Plan (Claude-Parity++ Program)

Date: 2026-02-11  
Prepared from: `README.md`, `docs/agent-teams-verification.md`, current runtime/tooling tests  
Objective: Upgrade Codex Team Orchestrator from "orchestration contracts + host-driven execution" to a fully autonomous, branch-isolated, multi-worker execution runtime that reaches Claude Agent Teams parity and exceeds it on auditability, policy control, reliability, and optimization.

## 0) Execution Strategy (Required)

1. Execution mode for implementation: `parallel-agent-team`.
2. Lead model recommendation: `GPT-5.3 extra high` (or equivalent highest-reasoning model available).
3. Worker model policy:
   - `P0`: same reasoning tier as lead.
   - `P1/P2`: mixed models allowed when reviewer/tester remains high-reasoning.
4. Teaming rule:
   - Use multi-worker parallel execution for multi-file and dependency-separated tickets.
   - Use single-worker fallback only for tightly coupled or tiny scoped tasks.
5. Order rule: execute strictly by priority `P0 -> P1 -> P2`.

## 1) Target Outcome

1. Every team worker has an isolated execution context and can independently execute coding tasks in parallel.
2. Worker execution is autonomous (scheduler-driven), not dependent on manual lead-agent stepping for each unit of work.
3. Git branch/worktree isolation is enforced by runtime, not only documented in skill guidance.
4. Team communication, task claiming, and merge integration are reliable under retries/crashes.
5. System quality is provable via deterministic replay, hard gates, and benchmark scorecards.
6. The platform includes capabilities beyond Claude baseline: stronger policy proofs, failure forensics, and adaptive optimization loops.

## 2) Current "No -> Yes" Conversion Map

1. Autonomous worker scheduler: `No -> Yes` (`CTO-P0-002`, `CTO-P0-006`)
2. Runtime-enforced worker worktrees: `No -> Yes` (`CTO-P0-005`)
3. Worker execution backend abstraction: `Partial -> Yes` (`CTO-P0-003`)
4. Exactly-once execution + recovery guarantees: `Partial -> Yes` (`CTO-P0-009`)
5. Interactive team console and operational UX: `Partial -> Yes` (`CTO-P1-001`)
6. Policy + quality gates before ticket completion: `Partial -> Yes` (`CTO-P1-003`)
7. Replay-grade audit and forensic timeline: `Partial -> Yes` (`CTO-P1-008`)
8. Better-than-Claude differentiators (learning, chaos, semantic merge): `No -> Yes` (`CTO-P2-001..006`)

## 3) Architecture Direction

## Workstream A: Autonomous Execution Runtime
Owner: Runtime

1. Persistent scheduler loop with queue fairness, backpressure, and lease-aware dispatch.
2. Worker adapter abstraction to run Codex sub-agents (and future providers) as first-class workers.
3. Team execution loop that continuously claims/executes/updates tasks until completion or explicit block.

## Workstream B: Isolation and Git Safety
Owner: Git Platform

1. Runtime-enforced branch/worktree provisioning per worker.
2. Branch ownership boundaries; no cross-worker file mutation without lead arbitration.
3. Controlled integration merge pipeline with required reviewer/tester gates.

## Workstream C: Reliability and Recovery
Owner: Runtime Reliability

1. Idempotent execution envelopes and exactly-once task progression.
2. Crash-safe checkpoints and deterministic resume.
3. Dead-letter handling and message retry controls.

## Workstream D: Quality, Policy, and Security
Owner: Platform Governance

1. Mandatory quality gates for task completion.
2. Role+action policy proofs attached to critical transitions.
3. Command and secret handling controls for worker sessions.

## Workstream E: Operations and Differentiation
Owner: Product/Infra

1. Team console for live state, command/control, and evidence.
2. Cost/latency/quality optimization controller.
3. Learning, semantic merge assist, chaos harness, and benchmark scorecards.

## 4) Phase Gates

## Phase 1: Parity Foundations (P0-001..P0-005)
1. Goal: Runtime can spawn and isolate workers safely with formal state machine + worktrees.
2. Exit gate:
   - Autonomous dispatcher service running in tests.
   - Worktree enforcement tests pass.
   - No cross-worker branch collisions in stress tests.

## Phase 2: Autonomous Team Execution (P0-006..P0-009)
1. Goal: End-to-end execution loop with recovery and reliable merge integration.
2. Exit gate:
   - E2E "large objective" run finishes without manual per-ticket intervention.
   - Crash-restart recovery replay proves no double-completion.

## Phase 3: Better-than-Claude Platform Layer (P1 + P2)
1. Goal: Operational UX, governance, optimization, and differentiators.
2. Exit gate:
   - Benchmark suite shows parity+ quality and better control/reliability scorecards.

## 5) Definition of Done

1. Ticket status can only be `done` with linked passing test evidence or explicit blocker note.
2. Runtime enforces worker isolation and branch policy mechanically, not conventionally.
3. Scheduler-driven autonomous execution works for multi-ticket dependency DAGs.
4. Recovery invariants hold under injected failure scenarios.
5. Quality gates, policy decisions, and merge decisions are replayable and auditable.
6. Every ticket completion includes an atomic commit whose message starts with the ticket ID (for example, `CTO-P0-001: ...`).
7. Every completed ticket is pushed to remote (feature/worker branch preferred), with push evidence captured in sprint tracker.
8. No ticket may move to `done` without commit SHA, pushed branch reference (and PR link when applicable), plus test evidence.

## 5.1) Git Workflow Policy (Required)

1. Execute tickets in order `P0 -> P1 -> P2`; for each ticket run: implement -> test -> commit -> push -> update tracker.
2. Commit granularity: one atomic commit per ticket whenever reasonable.
3. Required commit format: `<TICKET_ID>: <short imperative summary>`.
4. Required tracker evidence fields for `done` tickets:
   - `commit_sha`
   - `pushed_branch`
   - `pr_link` (or explicit note if PR not used)
   - `test_evidence`

## 6) Master Ticket Backlog

## P0 Tickets (Blocking)

| Ticket ID | Title | Owner | Key Files | Mandatory Tests | Status |
|---|---|---|---|---|---|
| `CTO-P0-001` | Runtime state machine + execution envelope schema | Runtime | `mcp/store/migrations/*`, `mcp/store/sqlite-store.ts`, `mcp/server/contracts.ts`, `mcp/schemas/*` | `T-CTO-P0-001` | todo |
| `CTO-P0-002` | Persistent autonomous scheduler service | Runtime | `mcp/runtime/scheduler.ts`, `mcp/runtime/queue.ts`, `mcp/server/index.ts`, `scripts/*` | `T-CTO-P0-002` | todo |
| `CTO-P0-003` | Worker execution adapter (Codex backend) | Runtime | `mcp/runtime/worker-adapter.ts`, `mcp/runtime/providers/codex.ts`, `mcp/server/tools/*` | `T-CTO-P0-003` | todo |
| `CTO-P0-004` | Per-worker context window isolation and limits | Runtime | `mcp/runtime/context.ts`, `mcp/server/usage-estimator.ts`, `mcp/server/tools/checkpoints.ts` | `T-CTO-P0-004` | todo |
| `CTO-P0-005` | Runtime-enforced branch/worktree isolation manager | Git Platform | `mcp/runtime/git-manager.ts`, `mcp/runtime/scheduler.ts`, `skills/agent-teams/SKILL.md` | `T-CTO-P0-005` | todo |
| `CTO-P0-006` | Autonomous team execution loop (claim -> execute -> update) | Runtime | `mcp/runtime/executor.ts`, `mcp/server/tools/task-board.ts`, `mcp/server/tools/agent-lifecycle.ts` | `T-CTO-P0-006` | todo |
| `CTO-P0-007` | Reliable inter-worker messaging (ack/retry/dead-letter) | Runtime Reliability | `mcp/store/sqlite-store.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/server/tools/recovery.ts` | `T-CTO-P0-007` | todo |
| `CTO-P0-008` | Merge coordinator with mandatory review/test gates | Git Platform | `mcp/runtime/merge-coordinator.ts`, `mcp/server/tools/arbitration.ts`, `mcp/server/tools/guardrails.ts` | `T-CTO-P0-008` | todo |
| `CTO-P0-009` | Exactly-once recovery and resumability hardening | Runtime Reliability | `mcp/server/tools/recovery.ts`, `mcp/server/tools/team-lifecycle.ts`, `mcp/store/sqlite-store.ts` | `T-CTO-P0-009` | todo |

## P1 Tickets (Stabilization)

| Ticket ID | Title | Owner | Key Files | Mandatory Tests | Status |
|---|---|---|---|---|---|
| `CTO-P1-001` | Team console and live execution telemetry stream | Product/Runtime | `mcp/server/tools/observability.ts`, `scripts/team-console.*`, `docs/*` | `T-CTO-P1-001` | todo |
| `CTO-P1-002` | Role planner v2 and DAG-aware staffing upgrades | Runtime | `mcp/server/tools/fanout.ts`, `mcp/server/tools/rebalancer.ts`, `mcp/server/trigger.ts` | `T-CTO-P1-002` | todo |
| `CTO-P1-003` | Mandatory quality gate engine for task completion | Governance | `mcp/server/hooks.ts`, `mcp/server/policy-hooks.ts`, `mcp/server/tools/task-board.ts` | `T-CTO-P1-003` | todo |
| `CTO-P1-004` | Atomic commit/PR orchestration pipeline | Git Platform | `mcp/runtime/git-manager.ts`, `scripts/*`, `docs/*` | `T-CTO-P1-004` | todo |
| `CTO-P1-005` | Cost-latency-quality optimizer with SLO budgets | Runtime | `mcp/server/budget-controller.ts`, `mcp/server/usage-estimator.ts`, `profiles/*.yaml` | `T-CTO-P1-005` | todo |
| `CTO-P1-006` | Security hardening (secret boundary + command policy) | Security | `mcp/server/guardrails.ts`, `mcp/server/server.ts`, `mcp/server/tools/policies.ts` | `T-CTO-P1-006` | todo |
| `CTO-P1-007` | Federation protocol for parent/child teams | Runtime | `mcp/server/tools/hierarchy.ts`, `mcp/server/tools/team-lifecycle.ts`, `mcp/schemas/*` | `T-CTO-P1-007` | todo |
| `CTO-P1-008` | Deterministic replay and forensic timeline | Runtime Reliability | `mcp/server/tools/observability.ts`, `mcp/server/tracing.ts`, `scripts/replay-audit.*` | `T-CTO-P1-008` | todo |

## P2 Tickets (Future-proofing)

| Ticket ID | Title | Owner | Key Files | Mandatory Tests | Status |
|---|---|---|---|---|---|
| `CTO-P2-001` | Learning controller for adaptive policy tuning | Applied Runtime | `mcp/runtime/learning-controller.ts`, `benchmarks/*`, `profiles/*` | `T-CTO-P2-001` | todo |
| `CTO-P2-002` | Semantic merge assist for conflict-heavy branches | Git Platform | `mcp/runtime/semantic-merge.ts`, `mcp/runtime/merge-coordinator.ts` | `T-CTO-P2-002` | todo |
| `CTO-P2-003` | Human approval workflow by risk tier | Governance | `mcp/server/tools/modes.ts`, `mcp/server/tools/guardrails.ts`, `mcp/schemas/*` | `T-CTO-P2-003` | todo |
| `CTO-P2-004` | External event bridge (GitHub/Jira/Slack) | Integrations | `mcp/integrations/*`, `scripts/*`, `docs/*` | `T-CTO-P2-004` | todo |
| `CTO-P2-005` | Public scorecard benchmark suite (Claude+ scenarios) | Benchmarking | `benchmarks/*`, `scripts/benchmark*.sh`, `docs/*` | `T-CTO-P2-005` | todo |
| `CTO-P2-006` | Chaos/fault-injection harness for orchestration resilience | Runtime Reliability | `tests/chaos/*`, `scripts/chaos/*`, `mcp/runtime/*` | `T-CTO-P2-006` | todo |

## 7) Detailed Ticket Specs

### `CTO-P0-001` Runtime State Machine + Execution Envelope Schema
- owner: Runtime
- scope/files: `mcp/store/migrations/*`, `mcp/store/sqlite-store.ts`, `mcp/server/contracts.ts`, `mcp/schemas/*`
- acceptance criteria:
  - New execution states (`queued`, `dispatching`, `executing`, `validating`, `integrating`, `failed_terminal`) are persisted.
  - Every task execution attempt has immutable `execution_id`, lease metadata, and retry counters.
  - Old data migrates without breaking existing tests.
- linked tests: `tests/unit/v3-001.execution-state.test.ts`, `tests/integration/v3-001.execution-state.integration.test.ts`
- status: todo

### `CTO-P0-002` Persistent Autonomous Scheduler Service
- owner: Runtime
- scope/files: `mcp/runtime/scheduler.ts`, `mcp/runtime/queue.ts`, `mcp/server/index.ts`, `scripts/run-scheduler.sh`
- acceptance criteria:
  - Scheduler continuously dispatches runnable tasks without manual triggers.
  - Fairness policy prevents starvation across roles/priority bands.
  - Scheduler safe-stop/restart semantics preserve in-flight ownership.
- linked tests: `tests/unit/v3-002.scheduler.test.ts`, `tests/integration/v3-002.scheduler.integration.test.ts`
- status: todo

### `CTO-P0-003` Worker Execution Adapter (Codex Backend)
- owner: Runtime
- scope/files: `mcp/runtime/worker-adapter.ts`, `mcp/runtime/providers/codex.ts`, `mcp/server/tools/agent-lifecycle.ts`
- acceptance criteria:
  - Adapter can spawn, send instructions, poll, interrupt, and collect artifacts from workers.
  - Worker failures are normalized into structured error envelopes.
  - Provider interface is extensible for future non-Codex backends.
- linked tests: `tests/unit/v3-003.adapter.test.ts`, `tests/integration/v3-003.adapter.integration.test.ts`
- status: todo

### `CTO-P0-004` Per-Worker Context Window Isolation
- owner: Runtime
- scope/files: `mcp/runtime/context.ts`, `mcp/server/usage-estimator.ts`, `mcp/server/tools/checkpoints.ts`
- acceptance criteria:
  - Each worker gets dedicated context budget and checkpoint stream.
  - Cross-worker context bleed is impossible by construction.
  - Context compaction triggers before hard limits with deterministic recovery.
- linked tests: `tests/unit/v3-004.context-isolation.test.ts`, `tests/integration/v3-004.context-isolation.integration.test.ts`
- status: todo

### `CTO-P0-005` Runtime-Enforced Branch/Worktree Isolation Manager
- owner: Git Platform
- scope/files: `mcp/runtime/git-manager.ts`, `mcp/runtime/scheduler.ts`, `skills/agent-teams/SKILL.md`, `docs/agent-teams-verification.md`
- acceptance criteria:
  - Scheduler allocates unique branch/worktree per active worker.
  - Worker commands fail closed if executed outside assigned worktree.
  - Cleanup guarantees no orphan worktrees after completion or abort.
- linked tests: `tests/unit/v3-005.git-isolation.test.ts`, `tests/integration/v3-005.git-isolation.integration.test.ts`
- status: todo

### `CTO-P0-006` Autonomous Team Execution Loop
- owner: Runtime
- scope/files: `mcp/runtime/executor.ts`, `mcp/server/tools/task-board.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/server/tools/rebalancer.ts`
- acceptance criteria:
  - Loop performs: pick task -> assign worker -> execute -> run validations -> post artifact -> update status.
  - Tickets transition automatically to `done` or `blocked` with evidence payload.
  - Lead can supervise without directly performing implementer work.
- linked tests: `tests/integration/v3-006.autonomous-loop.integration.test.ts`, `tests/e2e/v3-006.large-objective.e2e.test.ts`
- status: todo

### `CTO-P0-007` Reliable Inter-Worker Messaging
- owner: Runtime Reliability
- scope/files: `mcp/store/sqlite-store.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/server/tools/recovery.ts`
- acceptance criteria:
  - At-least-once delivery with dedupe guarantees per route/idempotency scope.
  - Retries with backoff and dead-letter queue for repeated failures.
  - Inbox ack semantics support partial and explicit acknowledgment sets.
- linked tests: `tests/unit/v3-007.messaging-reliability.test.ts`, `tests/integration/v3-007.messaging-reliability.integration.test.ts`
- status: todo

### `CTO-P0-008` Merge Coordinator with Mandatory Gates
- owner: Git Platform
- scope/files: `mcp/runtime/merge-coordinator.ts`, `mcp/server/tools/arbitration.ts`, `mcp/server/tools/guardrails.ts`
- acceptance criteria:
  - Integration branch merge requires reviewer + tester pass evidence.
  - Failed quality gates block merge and emit traceable reason.
  - Conflict handling supports deterministic retry and escalation path.
- linked tests: `tests/unit/v3-008.merge-gates.test.ts`, `tests/integration/v3-008.merge-gates.integration.test.ts`
- status: todo

### `CTO-P0-009` Exactly-Once Recovery + Resume Hardening
- owner: Runtime Reliability
- scope/files: `mcp/server/tools/recovery.ts`, `mcp/server/tools/team-lifecycle.ts`, `mcp/store/sqlite-store.ts`, `mcp/server/tools/leases.ts`
- acceptance criteria:
  - Crash/restart never double-completes tasks.
  - Stale leases are safely reclaimed and reassigned.
  - Resume snapshot includes actionable queue/task/worker recovery details.
- linked tests: `tests/integration/v3-009.recovery.integration.test.ts`, `tests/chaos/v3-009.crash-restart.chaos.test.ts`
- status: todo

### `CTO-P1-001` Team Console + Live Telemetry
- owner: Product/Runtime
- scope/files: `mcp/server/tools/observability.ts`, `scripts/team-console.ts`, `docs/operator-console.md`
- acceptance criteria:
  - Operators can view workers, tasks, queue depth, failures, and blockers in real time.
  - Commands: pause/resume team, drain queue, retry failed task.
  - Evidence links for each ticket outcome are visible in console output.
- linked tests: `tests/integration/v3-101.console.integration.test.ts`
- status: todo

### `CTO-P1-002` Role Planner v2 + DAG-Aware Staffing
- owner: Runtime
- scope/files: `mcp/server/tools/fanout.ts`, `mcp/server/tools/rebalancer.ts`, `mcp/server/trigger.ts`, `profiles/*.yaml`
- acceptance criteria:
  - Staffing plan accounts for critical path depth and dependency bottlenecks.
  - Dynamic role mix updates during run based on backlog state.
  - Does not violate `max_threads=6` hard cap.
- linked tests: `tests/unit/v3-102.staffing.test.ts`, `tests/integration/v3-102.staffing.integration.test.ts`
- status: todo

### `CTO-P1-003` Mandatory Quality Gate Engine
- owner: Governance
- scope/files: `mcp/server/hooks.ts`, `mcp/server/policy-hooks.ts`, `mcp/server/tools/task-board.ts`, `profiles/*.yaml`
- acceptance criteria:
  - Task cannot transition to `done` without required gate evidence.
  - Gate sets are policy-driven by ticket risk tier (`P0/P1/P2`).
  - Failure reasons are compact, deterministic, and replayable.
- linked tests: `tests/unit/v3-103.quality-gates.test.ts`, `tests/integration/v3-103.quality-gates.integration.test.ts`
- status: todo

### `CTO-P1-004` Atomic Commit/PR Orchestration
- owner: Git Platform
- scope/files: `mcp/runtime/git-manager.ts`, `scripts/pr-orchestrator.sh`, `docs/git-orchestration.md`
- acceptance criteria:
  - Worker outputs are committed atomically per ticket.
  - PR metadata includes ticket id, test evidence, and risk classification.
  - Integration merge queue enforces deterministic order.
- linked tests: `tests/integration/v3-104.pr-flow.integration.test.ts`
- status: todo

### `CTO-P1-005` Cost-Latency-Quality Optimizer
- owner: Runtime
- scope/files: `mcp/server/budget-controller.ts`, `mcp/server/usage-estimator.ts`, `mcp/server/policy-engine.ts`, `profiles/*.yaml`
- acceptance criteria:
  - Runtime chooses model/parallelism settings to meet configured SLO budgets.
  - Cost and latency budgets are tracked per team and per ticket.
  - Quality floor never regresses below configured threshold.
- linked tests: `tests/unit/v3-105.optimizer.test.ts`, `tests/integration/v3-105.optimizer.integration.test.ts`
- status: todo

### `CTO-P1-006` Security Hardening for Worker Execution
- owner: Security
- scope/files: `mcp/server/guardrails.ts`, `mcp/server/server.ts`, `mcp/server/tools/policies.ts`, `scripts/check-config.sh`
- acceptance criteria:
  - Secrets are redacted and blocked from artifact/message leakage.
  - Restricted command policy enforced by role and mode.
  - Security events included in structured run logs.
- linked tests: `tests/unit/v3-106.security.test.ts`, `tests/integration/v3-106.security.integration.test.ts`
- status: todo

### `CTO-P1-007` Federation Protocol for Parent/Child Teams
- owner: Runtime
- scope/files: `mcp/server/tools/hierarchy.ts`, `mcp/server/tools/team-lifecycle.ts`, `mcp/schemas/tools/*.json`
- acceptance criteria:
  - Parent team delegates scoped objectives and tracks child outcomes.
  - Child failure propagation supports retry/escalation policies.
  - No unauthorized cross-team task or message operations.
- linked tests: `tests/integration/v3-107.federation.integration.test.ts`
- status: todo

### `CTO-P1-008` Deterministic Replay + Forensics
- owner: Runtime Reliability
- scope/files: `mcp/server/tools/observability.ts`, `mcp/server/tracing.ts`, `scripts/replay-audit.ts`, `docs/replay-forensics.md`
- acceptance criteria:
  - Any run can be replayed to reconstruct key decisions chronologically.
  - Forensic bundles include scheduler, policy, merge, and failure events.
  - Replay output is stable across repeated runs.
- linked tests: `tests/unit/v3-108.replay.test.ts`, `tests/integration/v3-108.replay.integration.test.ts`
- status: todo

### `CTO-P2-001` Learning Controller for Adaptive Tuning
- owner: Applied Runtime
- scope/files: `mcp/runtime/learning-controller.ts`, `benchmarks/*.json`, `profiles/*.yaml`
- acceptance criteria:
  - Suggests staffing/policy updates from historical execution traces.
  - Recommendations are reversible and guarded by confidence thresholds.
  - Never auto-applies risky policy change without approval configuration.
- linked tests: `tests/unit/v3-201.learning-controller.test.ts`
- status: todo

### `CTO-P2-002` Semantic Merge Assist
- owner: Git Platform
- scope/files: `mcp/runtime/semantic-merge.ts`, `mcp/runtime/merge-coordinator.ts`, `docs/semantic-merge.md`
- acceptance criteria:
  - Detects structural conflicts and proposes ranked merge resolutions.
  - Produces explainable resolution rationale for reviewer.
  - Falls back to manual merge when confidence is low.
- linked tests: `tests/unit/v3-202.semantic-merge.test.ts`, `tests/integration/v3-202.semantic-merge.integration.test.ts`
- status: todo

### `CTO-P2-003` Human Approval Workflow by Risk
- owner: Governance
- scope/files: `mcp/server/tools/modes.ts`, `mcp/server/tools/guardrails.ts`, `mcp/schemas/tools/*.json`
- acceptance criteria:
  - Configurable approvals required for high-risk actions (e.g., prod-impacting merges).
  - Approval chain is logged with actor/time/reason.
  - Timeouts and escalation policies are configurable.
- linked tests: `tests/unit/v3-203.approvals.test.ts`, `tests/integration/v3-203.approvals.integration.test.ts`
- status: todo

### `CTO-P2-004` External Event Bridge
- owner: Integrations
- scope/files: `mcp/integrations/github.ts`, `mcp/integrations/jira.ts`, `mcp/integrations/slack.ts`, `docs/integrations.md`
- acceptance criteria:
  - Team state and ticket updates can be synced to external systems.
  - Incoming events can create/update orchestrator tasks safely.
  - Integration failures are isolated and retriable.
- linked tests: `tests/integration/v3-204.integrations.integration.test.ts`
- status: todo

### `CTO-P2-005` Public Scorecard Benchmark Suite
- owner: Benchmarking
- scope/files: `benchmarks/v3/*`, `scripts/benchmark.sh`, `scripts/v3-eval-gates.ts`, `docs/benchmark-report-v3.md`
- acceptance criteria:
  - Benchmark includes parity and differentiator scenarios.
  - Reports quality, latency, cost, reliability, and recovery metrics.
  - Release gate fails on quality regression or reliability regression.
- linked tests: `tests/integration/v3-205.benchmark-gates.integration.test.ts`
- status: todo

### `CTO-P2-006` Chaos/Fault-Injection Harness
- owner: Runtime Reliability
- scope/files: `tests/chaos/*`, `scripts/chaos/*.sh`, `mcp/runtime/*`
- acceptance criteria:
  - Injected failures (worker crash, lease loss, merge conflict storm) are recoverable.
  - MTTR and failed-run rates are reported per scenario.
  - Chaos suite is CI-runnable in bounded runtime.
- linked tests: `tests/chaos/v3-206.chaos-harness.test.ts`
- status: todo

## 8) Ticket-to-Test Matrix

| Test ID | Type | Covers Ticket(s) | Description |
|---|---|---|---|
| `T-CTO-P0-001` | Unit + Integration | `CTO-P0-001` | Execution state machine persistence + migration correctness |
| `T-CTO-P0-002` | Integration | `CTO-P0-002` | Scheduler lifecycle, fairness, restart stability |
| `T-CTO-P0-003` | Unit + Integration | `CTO-P0-003` | Worker provider adapter semantics and failure envelopes |
| `T-CTO-P0-004` | Unit + Integration | `CTO-P0-004` | Context boundary and budget enforcement per worker |
| `T-CTO-P0-005` | Unit + Integration | `CTO-P0-005` | Hard branch/worktree boundary and cleanup |
| `T-CTO-P0-006` | Integration + E2E | `CTO-P0-006` | Autonomous ticket execution loop and evidence emission |
| `T-CTO-P0-007` | Unit + Integration | `CTO-P0-007` | Messaging retry, dead-letter, scoped dedupe |
| `T-CTO-P0-008` | Unit + Integration | `CTO-P0-008` | Merge gating and conflict retry flow |
| `T-CTO-P0-009` | Integration + Chaos | `CTO-P0-009` | Exactly-once crash-restart recovery |
| `T-CTO-P1-001` | Integration | `CTO-P1-001` | Console streaming + operator command control |
| `T-CTO-P1-002` | Unit + Integration | `CTO-P1-002` | DAG-aware staffing behavior under backlog changes |
| `T-CTO-P1-003` | Unit + Integration | `CTO-P1-003` | Gate enforcement by risk tier and mode |
| `T-CTO-P1-004` | Integration | `CTO-P1-004` | Atomic commit and ordered merge queue correctness |
| `T-CTO-P1-005` | Unit + Integration | `CTO-P1-005` | Optimizer meets budget constraints without quality regression |
| `T-CTO-P1-006` | Unit + Integration | `CTO-P1-006` | Secret and command policy enforcement |
| `T-CTO-P1-007` | Integration | `CTO-P1-007` | Parent/child federation safety and delegation correctness |
| `T-CTO-P1-008` | Unit + Integration | `CTO-P1-008` | Replay determinism and forensic completeness |
| `T-CTO-P2-001` | Unit | `CTO-P2-001` | Learning recommendations safety and reversibility |
| `T-CTO-P2-002` | Unit + Integration | `CTO-P2-002` | Semantic merge scoring and fallback behavior |
| `T-CTO-P2-003` | Unit + Integration | `CTO-P2-003` | Risk-tier approval workflow correctness |
| `T-CTO-P2-004` | Integration | `CTO-P2-004` | Integration bridge sync and retry behavior |
| `T-CTO-P2-005` | Integration | `CTO-P2-005` | Benchmark scorecard + release gate behavior |
| `T-CTO-P2-006` | Chaos | `CTO-P2-006` | Fault injection resilience envelope |

## 9) Completion Math (Required)

- `overall_completion_pct = done_tickets / total_tickets * 100`
- `p0_completion_pct = done_p0 / total_p0 * 100`
- `p1_completion_pct = done_p1 / total_p1 * 100`
- `p2_completion_pct = done_p2 / total_p2 * 100`

Always report both counts and percentages in `SPRINT_PROGRESS.md`.

## 10) Anti-Recurrence Controls

1. Runtime invariants codified as tests: no cross-team/cross-worker context or branch leaks.
2. Every lifecycle action emits replay-grade structured events.
3. Merge and task completion are policy-gated with explicit evidence references.
4. Recovery and chaos suites are mandatory in release pipeline.
5. Benchmark scorecard includes reliability and recovery, not only token usage.
