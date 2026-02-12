# Agent Teams Industry Practices (Codex App + Codex CLI)

This document captures industry-grade implementation practices for multi-agent orchestration UX in CLI and app environments, aligned to this repository.

## 1) Design Contracts First

Practice:

- Define strict, testable contracts for every operator-facing surface before UI polish.

In this repo:

- Tool contracts: `mcp/schemas/tools/*.json`
- Contract registry: `mcp/schemas/contracts.ts`
- Hybrid UI contracts: `mcp/schemas/tools/team_staff_plan.schema.json`, `mcp/schemas/tools/team_ui_state.schema.json`

Why:

- Prevents drift between CLI/UI renderers and backend semantics.

## 2) Deterministic Operator Surfaces

Practice:

- Emit stable line-oriented cards for automation and incident tooling.
- Ensure snapshots are deterministic for the same state.

In this repo:

- Sidecar TUI: `scripts/team-tui.ts`
- Chat cards: `scripts/team-card.ts`
- UI-state builder: `mcp/server/team-ui-state.ts`
- Deterministic tests: `tests/unit/v3-111.team-card.test.ts`, `tests/integration/v3-111.tui.integration.test.ts`

Why:

- Deterministic output allows reliable parsers, bots, and CI assertions.

## 3) Reliability Before Throughput

Practice:

- Fail closed on unsafe paths.
- Use transactional compensation when partial side effects are possible.

In this repo:

- Dispatch rollback compensation: `mcp/server/tools/agent-lifecycle.ts`, `mcp/store/sqlite-store.ts`
- Worker terminal validation and evidence gating: `mcp/runtime/executor.ts`
- Retry/dead-letter behavior: `mcp/store/migrations/008_message_reliability.sql`, `mcp/store/sqlite-store.ts`

Why:

- Operator trust depends on correctness under failure, not only happy-path speed.

## 4) Isolation Boundaries Are Non-Negotiable

Practice:

- Assign each active worker an isolated branch/worktree boundary.
- Enforce `cwd` checks against the assigned boundary.

In this repo:

- Isolation manager: `mcp/runtime/git-manager.ts`
- Scheduler integration: `mcp/runtime/scheduler.ts`
- Runtime guard in send path: `mcp/server/tools/agent-lifecycle.ts`

Why:

- Eliminates cross-worker contamination and reduces merge risk in multi-agent runs.

## 5) Observable State for Humans and Automation

Practice:

- Treat observability as product surface: status, progress, blockers, failures, replay links.

In this repo:

- Summaries/replay: `mcp/server/tools/observability.ts`
- Console compatibility: `scripts/team-console.ts`
- Replay auditing: `scripts/replay-audit.ts`

Why:

- Operators need fast diagnosis and deterministic evidence trails.

## 6) Policy-Driven Behavior, Not Hard-Coded Behavior

Practice:

- Keep runtime limits, guardrails, and quality gates configurable by profiles.

In this repo:

- Profiles: `profiles/default.team.yaml`, `profiles/fast.team.yaml`, `profiles/deep.team.yaml`
- Policy engine/hooks: `mcp/server/policy-engine.ts`, `mcp/server/policy-hooks.ts`
- Guardrail evaluator: `mcp/server/guardrails.ts`

Why:

- Enables one codebase to support different risk/speed postures safely.

## 7) Defense in Depth for Command Safety

Practice:

- Deny dangerous patterns first.
- Require boundary-safe allow-prefix matches.
- Block chained operator bypasses.

In this repo:

- Command policy enforcement: `mcp/server/guardrails.ts`
- Security tests: `tests/unit/v3-106.security.test.ts`, `tests/integration/v3-106.security.integration.test.ts`

Why:

- Reduces command injection and policy bypass risk in tool-assisted workflows.

## 8) Role-Aware Scheduling and Fairness

Practice:

- Prioritize ready work by dependency state and role suitability.
- Avoid starvation and queue-order artifacts.

In this repo:

- Fair queueing: `mcp/runtime/queue.ts`
- Scheduler dispatch: `mcp/runtime/scheduler.ts`
- Role-aware next-task query: `mcp/store/sqlite-store.ts`, `mcp/server/tools/task-board.ts`
- Tests: `tests/unit/at007.task-board.test.ts`, `tests/integration/at007.task-board.integration.test.ts`

Why:

- Prevents silent throughput collapse in heterogeneous specialist teams.

## 9) Release Governance with Explicit Gates

Practice:

- Define a release gate that combines correctness, cost, and resilience.

In this repo:

- Gates: `scripts/v3-eval-gates.ts`
- Benchmark flow: `scripts/benchmark.sh`, `benchmarks/v3/eval-set.json`
- Chaos inputs: `scripts/chaos/run-chaos.sh`, `tests/chaos/*.test.ts`
- Packaging gate: `scripts/release-ready.sh`

Why:

- “Green tests only” is insufficient for orchestration systems.

## 10) Documentation as a Living Control Surface

Practice:

- Maintain runbooks, verification status, and consolidation notes in-repo.

In this repo:

- Verification ledger: `docs/agent-teams-verification.md`
- Consolidation reference: `docs/MAIN_BRANCH_CTO_CONSOLIDATION.md`
- Operator/TUI runbook: `docs/operator-console.md`
- Hybrid UX contract: `docs/codex-agent-teams-ui.md`

Why:

- Shared operational language reduces incident MTTR and onboarding cost.

## Practical Checklist for New Features

Use this checklist before shipping a new Agent Teams feature:

1. Add/extend tool schema and typed contract.
2. Add unit tests for deterministic behavior.
3. Add integration tests for end-to-end tool/store/runtime path.
4. Add operator-facing doc update (runbook + examples).
5. Add release-gate impact note (quality/cost/reliability).
6. Verify branch/worktree and command-guardrail safety is unchanged.
7. Run full unit + integration suites before PR.

