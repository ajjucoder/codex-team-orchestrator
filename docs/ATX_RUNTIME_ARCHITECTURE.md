# ATX Runtime Architecture

Last updated: 2026-02-13  
Scope: ATX backlog delivery (`ATX-P0-001` .. `ATX-P2-004`) now merged to `main`.

## 1) Executive Summary

ATX extends the orchestrator with managed-runtime transport support, durable worker session recovery, wave telemetry persistence, group messaging semantics, mention-aware dispatch, decision-report persistence, and pluggable backend command routing, while keeping deterministic operator surfaces stable (`team-tui`, `team-card`, `team_ui_state`).

Default runtime behavior is unchanged:

- Canonical default mode: `host_orchestrated_default`
- Optional mode: `managed_runtime` (explicit enable only)

Reference ADR: `docs/proposals/agent-runtime-contract.md`.

## 2) Capability Map

| Ticket | Capability | Primary Files |
|---|---|---|
| `ATX-P0-001` | Runtime contract ADR + compatibility alignment | `docs/proposals/agent-runtime-contract.md`, `README.md` |
| `ATX-P0-002` | Managed runtime bootstrap wiring | `mcp/server/index.ts`, `mcp/server/server.ts` |
| `ATX-P0-003` | Durable worker session persistence + restart-safe recovery | `mcp/store/migrations/009_worker_runtime_sessions.sql`, `mcp/server/tools/agent-lifecycle.ts` |
| `ATX-P0-004` | Secure framed instruction protocol + safe tmux interrupt targeting | `mcp/runtime/transports/tmux-transport.ts`, `mcp/runtime/tmux-manager.ts`, `mcp/runtime/transports/headless-transport.ts` |
| `ATX-P0-005` | Persisted wave telemetry for cross-process UI | `mcp/store/migrations/010_team_wave_state.sql`, `mcp/runtime/scheduler.ts`, `mcp/server/team-ui-state.ts` |
| `ATX-P0-006` | Group route/idempotency redesign | `mcp/store/entities.ts`, `mcp/store/sqlite-store.ts`, `mcp/schemas/entities/message.schema.json` |
| `ATX-P0-007` | Deterministic `team-tui` / `team-card` compatibility preserved | `scripts/team-tui.ts`, `scripts/team-card.ts`, `tests/integration/v3-111.tui.integration.test.ts` |
| `ATX-P1-001` | DAG wave dispatch (flagged) + fairness fallback | `mcp/runtime/dag-analyzer.ts`, `mcp/runtime/scheduler.ts`, `profiles/*.team.yaml` |
| `ATX-P1-002` | Mention parser + `team_group_send` active-recipient dispatch | `mcp/server/mention-parser.ts`, `mcp/schemas/tools/team_group_send.schema.json` |
| `ATX-P1-003` | Decision reports as persisted first-class records | `mcp/store/migrations/011_agent_decision_reports.sql`, `mcp/server/decision-tracker.ts`, `mcp/schemas/tools/team_agent_report.schema.json` |
| `ATX-P1-004` | Backward-compatible model-routing extension | `mcp/server/tools/agent-lifecycle.ts`, `profiles/*.team.yaml` |
| `ATX-P1-005` | Transport factory with tmux/headless fallback | `mcp/runtime/transport-factory.ts` |
| `ATX-P1-006` | Separate tmux sidecar UI | `scripts/team-tmux-ui.ts`, `docs/operator-console.md` |
| `ATX-P2-001` | DAG cache + scheduler performance guardrails | `mcp/runtime/scheduler.ts`, `tests/unit/v4-013.scheduler-dag-perf.test.ts` |
| `ATX-P2-002` | Pluggable backend command builder (`codex/claude/opencode`) | `mcp/runtime/model-router.ts` |
| `ATX-P2-003` | Restart/failover reliability tests | `tests/chaos/v4-001.runtime-recovery.chaos.test.ts`, `tests/integration/v4-012.runtime-recovery.integration.test.ts` |
| `ATX-P2-004` | Release/runbook hardening | `scripts/release-ready.sh`, docs in `docs/` |

## 3) Runtime Modes and Selection

## Canonical Modes

- `host_orchestrated_default`:
  - host process drives orchestration and tool sequencing
  - no implicit managed worker transport bootstrap
- `managed_runtime`:
  - explicitly enabled runtime-managed worker adapter/transport behavior
  - durable worker session re-establish logic enabled through tool paths

## Bootstrap Entry Point

`createServer` in `mcp/server/index.ts` resolves mode from:

1. `managedRuntime.enabled === true`, or
2. `runtimeMode === 'managed_runtime'`

If managed runtime is enabled and no adapter is supplied, transport is resolved with `createCodexTransport` in `mcp/runtime/transport-factory.ts`.

## Transport Mode Resolution (`createCodexTransport`)

Inputs:

- explicit option: `managedRuntime.transportMode`
- env vars: `ATX_MANAGED_RUNTIME_TRANSPORT`, `CODEX_MANAGED_RUNTIME_TRANSPORT`
- runtime context: CI, TTY availability, tmux binary availability

Possible modes: `auto | tmux | headless`.

Selection behavior:

- explicit `headless` -> headless transport
- explicit `tmux` + tmux available -> tmux transport
- explicit `tmux` + tmux unavailable -> headless fallback
- `auto` in CI/non-TTY -> headless
- `auto` with tmux available -> tmux
- `auto` without tmux -> headless fallback

## 4) Data Model Changes (Persistent Storage)

ATX introduced three durable tables:

## `worker_runtime_sessions`

Migration: `mcp/store/migrations/009_worker_runtime_sessions.sql`

Purpose:

- binds `agent_id -> worker_id` and transport/session metadata
- persists lifecycle for restart-safe managed runtime dispatch/polling

Key fields:

- `worker_id`, `provider`, `transport_backend`
- `session_ref`, `pane_ref`
- `lifecycle_state`, `last_seen_at`
- `metadata_json`

## `team_wave_state`

Migration: `mcp/store/migrations/010_team_wave_state.sql`

Purpose:

- cross-process wave/tick telemetry for operator UI and observability

Key fields:

- `wave_id`, `tick_count`
- per-tick and cumulative dispatch/recovery/cleanup counters
- queue/progress counters and `completion_pct`
- `metadata_json` (includes dispatch mode, selected wave, DAG perf info)

## `agent_decision_reports`

Migration: `mcp/store/migrations/011_agent_decision_reports.sql`

Purpose:

- immutable, revisioned decision records per `team/agent/task`

Key fields:

- `report_id`, `revision`
- `decision`, `summary`, optional `confidence`
- `metadata_json`, `created_at`

Unique constraint:

- `(team_id, agent_id, task_id, revision)`

## 5) Messaging and Collaboration Contracts

## Group Delivery

`delivery_mode` now supports `group` with recipient-set-scoped semantics to prevent collisions where different group recipient sets share nullable direct targets.

References:

- `mcp/schemas/entities/message.schema.json`
- `mcp/store/sqlite-store.ts`

## Mention-Aware Group Send

`team_group_send` (schema: `mcp/schemas/tools/team_group_send.schema.json`) supports:

- summary mention parsing (`@all`, `@agent:<id>`, `@role:<role>`, `@agent_x`)
- explicit `mentions` list
- explicit `recipient_agent_ids`
- deduped recipient resolution via `mcp/server/mention-parser.ts`

## Decision Reports

`team_agent_report` (schema: `mcp/schemas/tools/team_agent_report.schema.json`) records structured decision revisions via `mcp/server/decision-tracker.ts` and surfaces data in operator/card views.

## 6) Scheduler, DAG, and Wave Semantics

- `scheduler.wave_dispatch.enabled` profile flag controls DAG wave dispatch behavior.
- If DAG cycle detected, scheduler logs fallback and uses fair queue mode.
- If wave dispatch is disabled, fair queue remains primary mode.
- DAG analysis is cached incrementally and performance-guarded.
- Wave state is persisted every tick for cross-process continuity.

References:

- `mcp/runtime/dag-analyzer.ts`
- `mcp/runtime/scheduler.ts`
- `mcp/server/team-ui-state.ts`
- `profiles/default.team.yaml`
- `profiles/fast.team.yaml`
- `profiles/deep.team.yaml`

## 7) Security and Safety Controls

- Instruction payloads use framed JSON transport with byte-size bounds (no raw command argument injection path).
- Tmux interrupts preserve exact pane target format (`session:window.pane`).
- Secret-like payload scanning and policy guardrails remain enforced in message tooling.
- Command policy/deny rules remain profile-controlled.

References:

- `mcp/runtime/transports/tmux-transport.ts`
- `mcp/runtime/transports/headless-transport.ts`
- `mcp/runtime/tmux-manager.ts`
- `mcp/server/tools/agent-lifecycle.ts`
- `mcp/server/guardrails.ts`

## 8) Compatibility Guarantees

ATX preserves deterministic operator surfaces and backward compatibility:

- deterministic one-shot contracts for `scripts/team-tui.ts`
- deterministic card rendering in `scripts/team-card.ts`
- stable UI-state structure from `team_ui_state`
- additive schema/contract evolution in `mcp/schemas/contracts.ts`

Release gate includes deterministic contract tests:

- `tests/unit/v3-111.team-card.test.ts`
- `tests/integration/v3-111.tui.integration.test.ts`

## 9) Verification and Release Gate

Primary verification command:

```bash
npm run verify
```

Release-grade gate:

```bash
./scripts/release-ready.sh
```

Release gate validates:

- required ATX migrations exist
- deterministic UI contract tests pass
- migration regression tests pass
- lint/unit/integration/verify/config/benchmark/package all pass

## 10) Production Readiness Statement

As of merge to `main` on 2026-02-13, ATX capabilities are fully integrated with:

- full ticket completion (`17/17`)
- green local verification (`npm run verify`)
- green GitHub CI on `main`
- deterministic compatibility preserved for operator-facing contracts

