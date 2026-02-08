# Codex Team Orchestrator - Implementation Plan V2 (Claude-Parity+)

## Goal
Ship V2 orchestration capabilities that match Claude experimental agent teams on core workflows and exceed it on control, safety, and scale, while preserving existing behavior and TypeScript reliability guarantees.

## Current Baseline (Already Implemented)
1. Team lifecycle (`team_start`, `team_status`, `team_finalize`, `team_resume`)
2. Task DAG with dependency-aware readiness and locking
3. Role spawning with readiness hints
4. Policy profiles (`fast/default/deep`) with runtime profile switching
5. Budget-aware adaptive fanout under `max_threads<=6`
6. Message deduplication and artifact version/checksum workflow
7. Guardrails (idle sweep, early stop) and compact artifact-reference messaging
8. Observability (run summaries, replay, telemetry usage samples)
9. Team/agent scope authorization checks

## V2 Must-Have Outcomes
1. Strict per-agent runtime permission enforcement (not metadata-only)
2. First-class operating modes with hard gates: `default`, `delegate`, `plan`
3. Robust orphan/crash recovery via heartbeat/lease + deterministic cleanup
4. Multi-team and hierarchical orchestration (parent/child teams)
5. No regressions in existing unit/integration behavior

## V2 Nice-to-Have Outcomes
1. Hook engine with block/allow policy decisions on lifecycle events
2. Runtime autoscaling/rebalancing loop (not only initial spawn sizing)
3. Artifact checkpoint compaction + context reset for long-running teams
4. Automated quality-vs-cost decision gates in CI/release flow

## Non-Negotiable Guardrails
1. Never exceed `max_threads=6` in any scenario.
2. Preserve current defaults unless a ticket explicitly changes behavior.
3. Structured logs must include evidence for all critical orchestration decisions.
4. TypeScript strict checks must remain passing throughout.
5. Benchmark gate must continue passing before final closeout.

## Strict Execution Prompt
Use this prompt to execute V2 sequentially:

```text
Implement `docs/implementation-plan-v2.md` end-to-end with strict execution control.

Manager directives:
1. Execute tickets sequentially from V2-001 to V2-016 with no skips.
2. For each ticket, complete: code + tests + docs + acceptance evidence.
3. After each ticket, output only:
   - Ticket(s) completed
   - Files changed
   - Tests run and results
   - Acceptance criteria evidence
   - Risks/follow-ups
   - Exact next ticket
4. Do not claim completion without command evidence.
5. If any verification fails, fix immediately before proceeding.
6. Preserve current behavior unless ticket explicitly allows change.
7. Continue automatically unless blocked by external credentials or missing dependencies.
8. If blocked, issue minimal unblock request and continue non-blocked work.

Hard quality gates:
1. Zero functional regressions in unit + integration tests.
2. TypeScript compilation passes with strict settings.
3. No run may exceed `max_threads=6`.
4. Final benchmark gate must pass.
```

## Ticket Plan (Sequential)

### V2-001 Baseline Freeze and Regression Contract
- Scope:
  - Capture baseline behavior snapshots for tools and orchestration flows.
  - Lock regression expectations before V2 feature changes.
- Code:
  - Add/update regression fixtures in `tests/fixtures/` and evidence docs.
  - Add baseline script(s) under `scripts/`.
- Tests:
  - Add baseline contract tests for currently shipped flows.
- Acceptance:
  - Baseline snapshot commands recorded and reproducible.
  - No behavior drift from current `main`.

### V2-002 Permission Profile Model and Contracts
- Scope:
  - Define explicit runtime permission model for tools/actions.
  - Add profile schema + policy fields for role-to-permission mapping.
- Code:
  - Update contracts in `mcp/schemas/`.
  - Add permission profile resolver in `mcp/server/`.
  - Update default policy YAML files in `profiles/`.
- Tests:
  - Schema validation tests and resolver unit tests.
- Acceptance:
  - Invalid permission configs rejected.
  - Valid configs resolve deterministic allow/deny maps.

### V2-003 Runtime Permission Enforcement Middleware
- Scope:
  - Enforce per-agent permission profile on every tool invocation.
- Code:
  - Add authorization layer in `mcp/server/server.ts` (or dedicated middleware module).
  - Enforce per-tool + per-action access checks using resolved profile.
- Tests:
  - Unit and integration deny/allow matrix tests across roles.
- Acceptance:
  - Unauthorized tool calls fail with explicit denial reason.
  - Authorized calls remain unchanged.

### V2-004 Permission Observability and Audit Evidence
- Scope:
  - Emit structured permission decision logs for every tool call.
  - Add explainability fields: source profile, matched rule, deny reason.
- Code:
  - Extend event payload contracts and telemetry log emitters.
- Tests:
  - Verify logs include permission decision metadata.
- Acceptance:
  - Audit trail is present and deterministic in replay.

### V2-005 Team Operating Mode Data Model
- Scope:
  - Introduce team runtime mode state: `default`, `delegate`, `plan`.
- Code:
  - Add storage/migration updates in `mcp/store/migrations/`.
  - Add mode read/write utilities in store and tools.
- Tests:
  - Migration + persistence + default-value tests.
- Acceptance:
  - Existing teams default to `default`.
  - Mode state is persisted and visible via status APIs.

### V2-006 Mode Gating Rules (Default/Delegate/Plan)
- Scope:
  - Enforce mode-specific tool permissions and workflow boundaries.
- Code:
  - Mode policy engine in `mcp/server/`.
  - Gate spawn/delegate/update behavior based on active mode.
- Tests:
  - Matrix tests for each mode and restricted tool actions.
- Acceptance:
  - `plan` mode blocks execution-side actions.
  - `delegate` mode allows delegated execution with guardrails.
  - `default` preserves current behavior.

### V2-007 Mode Transition APIs and Safety Controls
- Scope:
  - Add controlled mode transitions with role checks and audit events.
- Code:
  - New tools: set/get mode, transition constraints, optional TTL/reset.
- Tests:
  - Transition validation tests (allowed, denied, rollback cases).
- Acceptance:
  - Invalid transitions blocked.
  - Transition events logged with actor and reason.

### V2-008 Hook Engine Core (Block/Allow Pipeline)
- Scope:
  - Implement lifecycle hook engine with pre/post event interception.
- Code:
  - Hook registry and dispatcher in `mcp/server/hooks.ts` (or equivalent).
  - Hook points: spawn, task claim, task complete, finalize, resume.
- Tests:
  - Hook ordering, timeout behavior, block/allow semantics.
- Acceptance:
  - Hooks can block unsafe operations with explicit error and trace.

### V2-009 Policy/Quality Hook Adapters
- Scope:
  - Add built-in hooks for policy, quality, and compliance checks.
- Code:
  - Built-in adapters (e.g., test-required-before-complete, policy threshold checks).
- Tests:
  - End-to-end tests verifying blocked completion when gates fail.
- Acceptance:
  - Quality hooks enforce configured constraints without regressions.

### V2-010 Heartbeat and Lease Infrastructure
- Scope:
  - Add heartbeat + lease state for active agents and task ownership.
- Code:
  - Schema/migration updates for heartbeat timestamps and lease expiry.
  - Lease acquire/renew/release logic in store/server modules.
- Tests:
  - Lease contention and expiry tests.
- Acceptance:
  - Stale leases become recoverable without data corruption.

### V2-011 Orphan Recovery and Deterministic Cleanup
- Scope:
  - Recover orphaned tasks/agents after crash/interruption.
- Code:
  - Recovery sweeper and reattach/cleanup flows.
  - Safe idempotent retry semantics.
- Tests:
  - Simulated crash/restart recovery integration tests.
- Acceptance:
  - Orphaned work is deterministically reassigned or safely finalized.

### V2-012 Multi-Team Hierarchy Data Model
- Scope:
  - Introduce parent/child team relationships and hierarchy metadata.
- Code:
  - Migrations for hierarchy fields/tables.
  - Store APIs for parent-child queries.
- Tests:
  - Persistence and integrity tests for hierarchy relations.
- Acceptance:
  - Parent-child links are validated and queryable.

### V2-013 Hierarchical Orchestration Tools
- Scope:
  - Add tools for creating/managing child teams and delegating scoped work.
- Code:
  - New lifecycle/delegation tools in `mcp/server/tools/`.
  - Hierarchical access controls (no unsafe cross-tenant movement).
- Tests:
  - Integration tests for delegation, status rollups, and scoped isolation.
- Acceptance:
  - Parent team can delegate/monitor child teams safely.
  - No unauthorized cross-team action paths.

### V2-014 Runtime Autoscaling and Rebalancing
- Scope:
  - Add dynamic fanout rebalance loop during execution.
- Code:
  - Planner/controller updates to adjust active agents at runtime from telemetry and backlog.
- Tests:
  - Load tests and integration scenarios showing scale-up/down behavior.
- Acceptance:
  - Runtime rebalancing improves utilization and remains within hard caps.

### V2-015 Artifact Checkpoint Compaction and Context Reset
- Scope:
  - Implement checkpoint compaction pipeline for long runs.
  - Add resumable context reset flow that preserves recoverability.
- Code:
  - Artifact checkpoint tooling + compaction metadata.
  - Resume logic to hydrate compacted context safely.
- Tests:
  - Large-run compaction/resume tests with checksum integrity checks.
- Acceptance:
  - Token footprint decreases while replay/resume correctness remains intact.

### V2-016 Evaluation Gates, Hardening, and Release Evidence
- Scope:
  - Final hardening, docs, and automation of quality/cost gates.
- Code:
  - CI/release scripts enforcing quality-vs-cost thresholds.
  - Final benchmark and evidence report generation.
- Tests:
  - Full suite + benchmark + release-ready checks.
- Acceptance:
  - All prior tickets verified.
  - Benchmark gate passes.
  - Release docs and evidence artifacts complete.

## Dependency Map
1. `V2-001` -> `V2-002` -> `V2-003` -> `V2-004`
2. `V2-004` -> `V2-005` -> `V2-006` -> `V2-007`
3. `V2-007` -> `V2-008` -> `V2-009`
4. `V2-009` -> `V2-010` -> `V2-011`
5. `V2-011` -> `V2-012` -> `V2-013`
6. `V2-013` -> `V2-014` -> `V2-015` -> `V2-016`

## Per-Ticket Exit Checklist
1. Code implemented.
2. Unit tests added/updated and passing.
3. Integration tests added/updated and passing.
4. Docs updated.
5. Acceptance evidence captured with commands/output.
6. No regressions in existing suite.
7. `max_threads<=6` invariant preserved.

## Verification Command Template
```bash
# static checks
npm run lint
npm run typecheck

# tests
npm run test:unit
npm run test:integration
npm test

# orchestrator gates
./scripts/verify.sh
./scripts/release-ready.sh
```

## Required Evidence per Ticket
1. Ticket(s) completed
2. Files changed
3. Tests run and results
4. Acceptance criteria evidence
5. Risks/follow-ups
6. Exact next ticket

## Global V2 Acceptance Criteria
1. Runtime permission enforcement blocks disallowed actions per agent profile.
2. Mode gating (`default/delegate/plan`) is enforced and auditable.
3. Orphan recovery is deterministic and validated by crash/restart tests.
4. Multi-team hierarchy works with strict scoped permissions.
5. Hook engine can block unsafe lifecycle events.
6. Runtime autoscaling rebalances safely under budget + thread caps.
7. Checkpoint compaction/context reset reduces token usage on long runs.
8. Full regression + benchmark + release-ready gates pass.
