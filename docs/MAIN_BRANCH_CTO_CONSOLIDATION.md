# Main Branch CTO Consolidation Reference

Date: 2026-02-11  
Scope: Everything now merged into `main` from the CTO end-to-end consolidation and remediation streams.

## Context and Merge Evidence

Main now includes the full CTO consolidation line through these merge commits:

| Commit | Date (author/commit) | Evidence |
|---|---|---|
| `1714853` | 2026-02-11 21:12:22 +0545 | Merged `codex/implementation-fix-agentteam` into `feature/cto-end-to-end-release` |
| `afe6763` | 2026-02-11 21:40:52 +0545 | Merged `feature/cto-end-to-end-release` into `main` |

Verification commands:

```bash
git show --no-patch --pretty=fuller 1714853
git show --no-patch --pretty=fuller afe6763
```

## Key CTO Commit Timeline (High-Signal)

These are the core CTO commits now represented on `main`:

| Commit | Date (ISO) | Why it matters |
|---|---|---|
| `51a8ccf` | 2026-02-11T14:12:16+05:45 | P0-001 execution state envelope persistence |
| `73714f9` | 2026-02-11T14:39:38+05:45 | P0-002 autonomous scheduler runtime service |
| `0b6bcda` | 2026-02-11T15:07:30+05:45 | P0-003 codex worker adapter runtime |
| `766d965` | 2026-02-11T15:33:22+05:45 | P0-004 worker context isolation and recovery |
| `04ab6e0` | 2026-02-11T15:51:10+05:45 | P0-005 runtime git branch/worktree isolation |
| `64f3727` | 2026-02-11T16:30:06+05:45 | P0-005 enforced git-isolated `cwd` in `team_send` |
| `0d8e551` | 2026-02-11T16:46:40+05:45 | P0-008 merge gates via runtime coordinator |
| `4ea9716` | 2026-02-11T18:02:08+05:45 | P0-007 inbox ack/retry/dead-letter reliability |
| `0060d44` | 2026-02-11T18:23:45+05:45 | P0-009 crash-restart and resume hardening |
| `b002c01` | 2026-02-11T19:27:47+05:45 | P1/P2 end-to-end hardening and verification gates |
| `9192ed1` | 2026-02-11T20:40:49+05:45 | Remediation sweep (policy/adapter/executor/guardrail/optimizer/task paging) |
| `2c4b8e9` | 2026-02-11T20:40:49+05:45 | Remediation sweep carried into final integration history |
| `7303859` | 2026-02-11T21:10:09+05:45 | Missing-poll regression fix for non-adapter executor flow |

## Runtime Architecture on Main

### Control Plane

- `mcp/server/server.ts`: core MCP server, schema validation, permission/mode gates, hook dispatch, audit logging.
- `mcp/server/index.ts`: constructor wiring for store/logger/policy/hook engines and scheduler creation.
- `mcp/server/policy-engine.ts`: profile loading and team policy resolution from `profiles/`.
- `mcp/server/policy-hooks.ts`: built-in pre/post policy hooks and quality/approval gate enforcement.

### Runtime Modules (new CTO runtime layer)

- `mcp/runtime/context.ts`: context stream budgets, checkpoints, compaction/reset accounting.
- `mcp/runtime/executor.ts`: autonomous execution loop, validation/evidence publication, terminal status handling.
- `mcp/runtime/git-manager.ts`: branch/worktree assignment, context guard, orphan/team cleanup.
- `mcp/runtime/merge-coordinator.ts`: merge gate evaluation, conflict retries/escalation policy.
- `mcp/runtime/queue.ts`: fair task bucket queue across priority/role.
- `mcp/runtime/scheduler.ts`: ready-task dispatch, fairness rotation, lease recovery, assignment cleanup.
- `mcp/runtime/worker-adapter.ts`: provider-agnostic worker envelope and normalized failure semantics.

### Worker Provider

- `mcp/runtime/providers/codex.ts`: codex transport adapter with strict response validation.

## Server and Tooling Features

- Tool contracts + validation:
  - `mcp/server/contracts.ts`
  - `mcp/schemas/tools/*.json`
- Permission/mode enforcement before tool execution:
  - `mcp/server/permission-profiles.ts`
  - `mcp/server/mode-policy.ts`
  - `mcp/server/server.ts`
- Hook-based pre/post policy and quality gates:
  - `mcp/server/hooks.ts`
  - `mcp/server/policy-hooks.ts`
- Tool families exposed by the server:
  - lifecycle: `mcp/server/tools/team-lifecycle.ts`, `mcp/server/tools/agent-lifecycle.ts`
  - tasking: `mcp/server/tools/task-board.ts`, `mcp/server/tools/leases.ts`
  - guardrails/optimizer: `mcp/server/tools/guardrails.ts`, `mcp/server/tools/fanout.ts`, `mcp/server/tools/rebalancer.ts`
  - observability/recovery: `mcp/server/tools/observability.ts`, `mcp/server/tools/recovery.ts`, `mcp/server/tools/checkpoints.ts`
  - hierarchy/roles/policies: `mcp/server/tools/hierarchy.ts`, `mcp/server/tools/roles.ts`, `mcp/server/tools/policies.ts`, `mcp/server/tools/modes.ts`

## Capability Map (Area -> Paths)

| Capability area | Primary paths |
|---|---|
| Team lifecycle/status/finalize/resume | `mcp/server/tools/team-lifecycle.ts` |
| Agent spawn/send/inbox/worker bridge | `mcp/server/tools/agent-lifecycle.ts`, `mcp/runtime/worker-adapter.ts`, `mcp/runtime/providers/codex.ts` |
| Task board, DAG dependencies, ready queue, role filtering | `mcp/server/tools/task-board.ts`, `mcp/store/sqlite-store.ts`, `mcp/runtime/queue.ts`, `mcp/runtime/scheduler.ts` |
| Guardrails and command policy | `mcp/server/guardrails.ts`, `mcp/server/tools/guardrails.ts` |
| Policy hooks and quality/approval gates | `mcp/server/policy-hooks.ts`, `mcp/server/hooks.ts` |
| Budget/fanout/rebalance optimization | `mcp/server/budget-controller.ts`, `mcp/server/fanout-controller.ts`, `mcp/server/rebalancer.ts`, `mcp/server/tools/fanout.ts`, `mcp/server/tools/rebalancer.ts` |
| Merge governance and semantic merge assist | `mcp/runtime/merge-coordinator.ts`, `mcp/server/semantic-merge.ts`, `mcp/server/tools/arbitration.ts` |
| Observability, replay, summaries | `mcp/server/observability.ts`, `mcp/server/tools/observability.ts`, `scripts/replay-audit.ts`, `scripts/team-console.ts` |
| Persistence and migrations | `mcp/store/sqlite-store.ts`, `mcp/store/migrations/*.sql`, `mcp/store/entities.ts` |
| API contracts and schema enforcement | `mcp/schemas/contracts.ts`, `mcp/schemas/entities/*.json`, `mcp/schemas/tools/*.json`, `mcp/server/contracts.ts` |
| Ops scripts and release gates | `scripts/verify.sh`, `scripts/check-config.sh`, `scripts/smoke.sh`, `scripts/benchmark.sh`, `scripts/v3-eval-gates.ts`, `scripts/release-ready.sh`, `scripts/pr-orchestrator.sh` |
| Profiles and operational policy defaults | `profiles/default.team.yaml`, `profiles/fast.team.yaml`, `profiles/deep.team.yaml` |
| Runbooks and operator docs | `docs/operator-console.md`, `docs/replay-forensics.md`, `docs/release-checklist.md`, `docs/git-orchestration.md`, `docs/semantic-merge.md`, `docs/integrations.md` |
| Test matrix and evidence suites | `tests/unit/*.test.ts`, `tests/integration/*.test.ts`, `tests/e2e/*.test.ts`, `tests/chaos/*.test.ts` |

## Remediation and Hardening Focus (Now on Main)

The latest remediation wave now merged includes:

- Policy hook approval dedupe and latest-decision semantics: `mcp/server/policy-hooks.ts`.
- Adapter dispatch rollback compensation (`team_send` failure path): `mcp/server/tools/agent-lifecycle.ts`, `mcp/store/sqlite-store.ts`.
- Executor terminal validation and evidence gating: `mcp/runtime/executor.ts`.
- Guardrail allow-prefix boundary hardening and chained command blocking: `mcp/server/guardrails.ts`.
- Optimizer budget capping to runtime remainder: `mcp/server/budget-controller.ts`.
- Role-aware ready-task retrieval before limit: `mcp/store/sqlite-store.ts`, `mcp/server/tools/task-board.ts`.

Linked tests for these areas:

- `tests/unit/v3-203.approvals.test.ts`
- `tests/unit/v3-006.execution-loop.test.ts`
- `tests/integration/v3-006.autonomous-loop.integration.test.ts`
- `tests/unit/at006.agent-lifecycle.test.ts`
- `tests/integration/v3-003.adapter.integration.test.ts`
- `tests/unit/v3-106.security.test.ts`
- `tests/integration/v3-106.security.integration.test.ts`
- `tests/unit/v3-105.optimizer.test.ts`
- `tests/integration/v3-105.optimizer.integration.test.ts`
- `tests/unit/at007.task-board.test.ts`
- `tests/integration/at007.task-board.integration.test.ts`

## Storage and Migration Coverage

Current migration set (`mcp/store/migrations/001_initial.sql` through `008_message_reliability.sql`):

- `001_initial.sql`: foundational teams/agents/messages/inbox/tasks/artifacts/events schema.
- `002_task_dependencies.sql`: DAG dependency edges for task readiness.
- `003_task_required_role.sql`: role hints on tasks + role-aware index.
- `004_team_mode.sql`: team operation mode.
- `005_agent_heartbeat_and_task_leases.sql`: heartbeat and lease columns/indexes.
- `006_team_hierarchy.sql`: parent/root/depth and closure table for team trees.
- `007_task_execution_attempts.sql`: persisted execution attempt tracking.
- `008_message_reliability.sql`: route/idempotency scope, retry/dead-letter fields, reliability indexes.

## Profiles and Policy Surface

Profiles:

- `default`: `default_max_threads=4`, `hard_max_threads=6`, `token_soft_limit=12000`.
- `fast`: `default_max_threads=2`, `hard_max_threads=6`, lower latency/cost budgets.
- `deep`: `default_max_threads=5`, `hard_max_threads=6`, higher budgets and deeper arbitration posture.

All three profiles currently enforce:

- deny-by-default command policy with allow prefixes.
- plan-mode command execution block.
- deny patterns for destructive command families.

## Schemas and Contracts

- Entity JSON schemas: `mcp/schemas/entities/*.json`.
- Tool input JSON schemas: `mcp/schemas/tools/*.json`.
- Typed contract registry and required-field matrices: `mcp/schemas/contracts.ts`.
- Runtime tool validation bridge: `mcp/server/contracts.ts`.

## Testing Matrix

| Layer | Command | Coverage |
|---|---|---|
| Unit | `npm run test:unit` | core store/server/runtime behaviors, policy/guardrail/optimizer logic |
| Integration | `npm run test:integration` | tool-to-store/runtime integrations and cross-module workflows |
| E2E | `node --import tsx --test tests/e2e/v3-006.large-objective.e2e.test.ts` | autonomous large-objective run path |
| Chaos | `node --import tsx --test tests/chaos/*.test.ts` | crash-restart and resilience harness |
| Type safety | `npm run typecheck` | TypeScript contract/runtime consistency |
| Release gate | `./scripts/release-ready.sh` | lint/tests/verify/benchmarks/gates/package pipeline |

## Docs and Runbooks Introduced/Updated

- Operator workflow: `docs/operator-console.md`.
- Replay forensics: `docs/replay-forensics.md`.
- Release procedure: `docs/release-checklist.md`.
- PR queue orchestration policy: `docs/git-orchestration.md`.
- Merge strategy guidance: `docs/semantic-merge.md`.
- Integration adapters contract: `docs/integrations.md`.
- Verification evidence: `docs/agent-teams-verification.md`.
- Remediation planning/evidence: `docs/plans/IMPLEMENTATION_PLAN_END_TO_END.md`, `docs/plans/SPRINT_PROGRESS.md`.

## Operational Workflows

### 1) Triggered orchestration

- Trigger phrase detection and objective extraction: `mcp/server/trigger.ts`.
- Auto-start and optional role-based spawn shaping: `mcp/server/tools/trigger.ts`.

### 2) Scheduling and execution loop

- Ready queue and assignment fairness: `mcp/runtime/scheduler.ts`, `mcp/runtime/queue.ts`.
- Worker instruction/validation/evidence lifecycle: `mcp/runtime/executor.ts`.

### 3) Isolation and secure dispatch

- Assignment + `cwd` boundary checks: `mcp/runtime/git-manager.ts`, `mcp/server/tools/agent-lifecycle.ts`.

### 4) Recovery and resume

- Snapshot/replay/recovery views: `mcp/server/tools/recovery.ts`, `mcp/server/tools/observability.ts`, `mcp/store/sqlite-store.ts`.

### 5) Merge and release governance

- Merge decision gating: `mcp/runtime/merge-coordinator.ts`.
- Deterministic PR queue ordering: `scripts/pr-orchestrator.sh`.
- Benchmark/reliability release gates: `scripts/v3-eval-gates.ts`.

## How to Use on Main Today

### Baseline setup and verification

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
./scripts/check-config.sh
./scripts/verify.sh
```

### Start runtime scheduler loop

```bash
DB_PATH=.tmp/team-orchestrator.sqlite \
LOG_PATH=.tmp/team-events.log \
TICK_INTERVAL_MS=250 \
./scripts/run-scheduler.sh
```

### Run operator console and replay audit

```bash
node --import tsx scripts/team-console.ts --db .tmp/team-orchestrator.sqlite --team <team_id> --once
node --import tsx scripts/replay-audit.ts --db .tmp/team-orchestrator.sqlite --team <team_id> --out .tmp/replay-audit.json
```

### Benchmark and release checks

```bash
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive --out .tmp/v3-release-benchmark-report.json
npm run gates:v3
./scripts/release-ready.sh
```

### Chat trigger for team mode

Use one of the accepted runtime trigger phrases in your prompt:

- `use agents team`
- `use agent teams`
- `use agnet teams`
- `use agnet team`

## What Changed vs Pre-Consolidation

- Main now includes the full CTO runtime stack (`mcp/runtime/*`) rather than only policy/tool surface.
- Scheduling, fair queueing, execution loop, and merge coordinator are now first-class runtime modules.
- Worker adapter behavior is normalized with structured envelopes and provider-safe error semantics.
- Message dispatch now includes rollback compensation on downstream worker send failures.
- Executor completion now requires terminal-success state and evidence signals before task closure.
- Command guardrails tightened around allow-prefix boundaries and chained command operators.
- Optimizer budget computations are constrained by runtime remaining-budget signals.
- Ready-task selection now supports role-aware filtering before SQL limit truncation.
- Team hierarchy, leases, execution attempts, and reliable inbox retry/dead-letter persistence are all migrated in schema.
- Operational tooling (scheduler runner, console, replay audit, PR queue orchestration, v3 gates) is now integrated and documented.

## Known Constraints and Defaults

### `max_threads`

- Hard ceiling is `6` at schema and tool policy level.
- Team defaults are profile-dependent (`default=4`, `fast=2`, `deep=5`), then clamped by profile hard limit and global cap.
- Relevant files: `mcp/schemas/entities/team.schema.json`, `mcp/server/tools/team-lifecycle.ts`, `profiles/*.team.yaml`.

### Branch/worktree isolation

- Runtime assignment defaults:
  - branch prefix: `team`
  - worktree root: `.tmp/agent-teams`
  - run id shape: `run-<timestamp>-<team-suffix>`
- `team_send` with active worker adapter enforces `cwd` inside assigned worktree.
- Cleanup releases orphan/inactive assignments and removes stale worktree paths.
- Relevant files: `mcp/runtime/git-manager.ts`, `mcp/runtime/scheduler.ts`, `mcp/server/tools/agent-lifecycle.ts`.

### Trigger phrases

- Runtime detector accepts only:
  - `use agents team`
  - `use agent teams`
  - `use agnet teams`
  - `use agnet team`
- Relevant files: `mcp/server/trigger.ts`, `mcp/server/tools/trigger.ts`.

### Worker adapter behavior

- Adapter surface: `spawn`, `send_instruction`, `poll`, `interrupt`, `collect_artifacts`.
- Adapter failures are normalized into structured `worker_adapter` error envelopes.
- Invalid adapter configuration fails closed (`INVALID_WORKER_ADAPTER`) for lifecycle operations.
- On `team_send` insert success + adapter send failure, dispatch rollback compensation is attempted and reported.
- Executor behavior:
  - active adapter + missing poll => blocked
  - non-terminal poll => skipped
  - terminal failure => blocked
  - terminal success without evidence => blocked
  - terminal success with evidence => artifact publish + task `done`
- Relevant files: `mcp/runtime/worker-adapter.ts`, `mcp/runtime/providers/codex.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/runtime/executor.ts`.
