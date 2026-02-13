# ATX End-to-End Implementation Plan

Date: 2026-02-12
Prepared from:
- User-provided research bundle (Reddit/GitHub/TowardsAI links in session context)
- Internal architecture review against current repo (`README.md`, `mcp/runtime/*`, `mcp/server/*`, `mcp/store/*`, `scripts/*`)
- Codex app review findings provided by user in-session
Objective: deliver a production-safe Agent Teams upgrade that adds real-time worker UX, DAG-aware execution, mention/group collaboration, structured decision reporting, and cross-model routing without breaking existing deterministic contracts.

## 0) Execution Strategy (Required)

1. Execution mode: single-agent
2. Lead model: GPT-5 Codex
3. Worker model policy: same as lead
4. Teaming rule:
   - Execute all tickets in normal single-agent mode only.
   - Do not use agent-team/parallel-agent-team implementation lanes for this backlog run.
5. Order rule: always execute by priority `P0 -> P1 -> P2`.

## 1) Target Outcome

1. Runtime architecture is explicit and coherent: either host-driven orchestration remains default with an optional managed-runtime mode, or equivalent documented contract.
2. New capabilities (tmux/headless transport, wave scheduler telemetry, group mentions, decision reports, model routing) are persistent, secure, and schema-safe.
3. Existing deterministic operator surfaces (`team-tui`, `team-card`, `team_ui_state`) remain backward-compatible and test-stable.

## 2) Phases / Workstreams

## Workstream A: Architecture + Contracts
Owner: platform-architecture

### A1. Runtime contract decision + ADR
- Files:
  - `README.md`
  - `docs/proposals/agent-runtime-contract.md` (new)
  - `docs/codex-agent-teams-ui.md`
- Implement:
  - Define canonical runtime model: `host_orchestrated_default` with optional `managed_runtime` feature flag.
  - Document boundaries for worker spawning, persistence ownership, and UI behavior contracts.
- Required behavior:
  - No ambiguity between documentation and runtime bootstrap behavior.

### A2. Contract/schema extension plan
- Files:
  - `mcp/schemas/contracts.ts`
  - `mcp/schemas/entities/message.schema.json`
  - `mcp/schemas/tools/*.schema.json` (new and updated)
- Implement:
  - Add formal contract entries for new tools and payload fields before feature coding.

## Workstream B: Runtime Transport + Persistence
Owner: runtime-core

### B1. Transport bootstrap wiring
- Files:
  - `mcp/server/index.ts`
  - `mcp/server/server.ts`
  - `mcp/server/tools/agent-lifecycle.ts`
- Implement:
  - Wire default worker adapter/transport provisioning behind explicit options/flags.
  - Preserve existing behavior when transport is not configured.

### B2. Durable worker runtime session state
- Files:
  - `mcp/store/migrations/009_worker_runtime_sessions.sql` (new)
  - `mcp/store/entities.ts`
  - `mcp/store/sqlite-store.ts`
  - `mcp/server/tools/agent-lifecycle.ts`
- Implement:
  - Persist `worker_id`, transport/backend, pane/session metadata, and lifecycle state.
  - Replace in-memory-only `workerSessionByAgentId` as source of truth.

### B3. Safe instruction delivery protocol
- Files:
  - `mcp/runtime/transports/tmux-transport.ts` (new)
  - `mcp/runtime/transports/headless-transport.ts` (new)
  - `mcp/runtime/tmux-manager.ts` (new)
- Implement:
  - Avoid raw shell-injection-prone `sendKeys` for arbitrary payloads.
  - Use framed instruction channel (stdin/file/socket) with escaping and size limits.

## Workstream C: Scheduler + Wave Telemetry
Owner: scheduler-core

### C1. DAG analyzer and flagged wave dispatch
- Files:
  - `mcp/runtime/dag-analyzer.ts` (new)
  - `mcp/runtime/scheduler.ts`
  - `profiles/default.team.yaml`
  - `profiles/fast.team.yaml`
  - `profiles/deep.team.yaml`
- Implement:
  - Add cycle-safe DAG analysis and wave-scoped dispatch behind `scheduler.wave_dispatch.enabled`.
  - Preserve current fair queue fallback and starvation guarantees.

### C2. Persisted wave telemetry for cross-process UI
- Files:
  - `mcp/store/migrations/010_team_wave_state.sql` (new)
  - `mcp/store/sqlite-store.ts`
  - `mcp/server/team-ui-state.ts`
- Implement:
  - Persist current wave metadata to store/events so `team_ui_state` works across processes.

## Workstream D: Messaging + Collaboration
Owner: collaboration-runtime

### D1. Group delivery semantics and idempotency redesign
- Files:
  - `mcp/store/entities.ts`
  - `mcp/store/sqlite-store.ts`
  - `mcp/schemas/entities/message.schema.json`
  - `mcp/schemas/contracts.ts`
- Implement:
  - Introduce `group` mode with recipient-set-scoped route key and idempotency scope hash.
  - Prevent collisions where `to_agent_id=null` but recipients differ.

### D2. @mention parser and team_group_send
- Files:
  - `mcp/server/mention-parser.ts` (new)
  - `mcp/server/tools/agent-lifecycle.ts`
  - `mcp/schemas/tools/team_group_send.schema.json` (new)
- Implement:
  - Parse and resolve `@agent`, `@role`, `@all`; dedupe recipients.
  - Preserve immediate worker adapter dispatch semantics for active recipients.

### D3. Structured decision reporting as first-class records
- Files:
  - `mcp/store/migrations/011_agent_decision_reports.sql` (new)
  - `mcp/store/sqlite-store.ts`
  - `mcp/server/decision-tracker.ts` (new)
  - `mcp/server/tools/agent-lifecycle.ts`
  - `mcp/schemas/tools/team_agent_report.schema.json` (new)
- Implement:
  - Store per-agent, per-task, versioned reports (no metadata overwrite).

## Workstream E: UI/UX Surfaces
Owner: operator-experience

### E1. Preserve deterministic `team-tui`/`team-card` contracts
- Files:
  - `scripts/team-tui.ts`
  - `scripts/team-card.ts`
  - `scripts/team-ui-view.ts`
- Implement:
  - Keep existing one-shot deterministic output contract unchanged.
  - Add new fields only in backward-compatible manner.

### E2. Add separate tmux visualization sidecar
- Files:
  - `scripts/team-tmux-ui.ts` (new)
  - `docs/operator-console.md`
- Implement:
  - Build tmux-first real-time panel as separate entrypoint to avoid destabilizing deterministic CLI contract.

## Workstream F: Model Routing + QA + Release
Owner: runtime-integration

### F1. Extend existing model routing contract
- Files:
  - `mcp/server/tools/agent-lifecycle.ts`
  - `mcp/server/staffing-planner.ts`
  - `profiles/*.team.yaml`
- Implement:
  - Reuse existing `model_routing` policy path; extend keys compatibly for backend selection.
  - Avoid parallel routing systems.

### F2. Reliability/performance hardening
- Files:
  - `mcp/runtime/scheduler.ts`
  - `mcp/runtime/rebalancer.ts`
  - `tests/chaos/*`
- Implement:
  - Incremental DAG recomputation, performance guards, restart/failover coverage.

### F3. Docs/release gating updates
- Files:
  - `docs/AGENT_TEAMS_HYBRID_UX_FEATURE.md`
  - `docs/AGENT_TEAMS_INDUSTRY_PRACTICES.md`
  - `scripts/release-ready.sh`
- Implement:
  - Add gating for new schemas, migrations, and deterministic-contract checks.

## 3) Delivery Plan

## Week 1
1. `ATX-P0-001` through `ATX-P0-003` (architecture + bootstrap + persistence foundation).
2. Foundational tests and migration verification.
3. Exit gate: transport bootstrap deterministic, restart-safe session recovery verified.

## Week 2
1. `ATX-P0-004` through `ATX-P0-007` (secure transport, wave telemetry persistence, group idempotency, deterministic UI protection).
2. Security + compatibility integration tests.
3. Exit gate: no regression in `v3-111` deterministic suite.

## Week 3
1. `ATX-P1-001` through `ATX-P1-004` (wave dispatch flag, mention/group tools, decision reports, model-routing extension).
2. Cross-process and contract-level integration tests.
3. Exit gate: full unit + integration suites pass with flags on/off.

## Week 4+
1. `ATX-P1-005`, `ATX-P1-006`, and all `P2` hardening tickets.
2. Chaos/perf/release gate validation.
3. Exit gate: release-ready checks green with new feature set enabled.

## 4) Definition of Done (Required)

1. Regression test fails before fix and passes after fix (or equivalent new coverage where pre-fail cannot exist).
2. No silent fallback for critical logic.
3. Explicit statuses propagate to final output.
4. Evidence/provenance is present for critical values.
5. Ticket cannot be marked `done` without linked passing test evidence, or explicit blocker note.
6. Ticket cannot be marked `done` without git evidence:
   - `commit_sha`
   - `pushed_branch`
   - `pr_link` (or explicit note if PR not used)

## 5) Git Workflow Policy (Required)

1. Implement each ticket, run linked tests, then create an atomic commit.
2. Commit message format: `ATX-P[0|1|2]-###: <short summary>`.
3. Push every completed ticket to remote (feature/worker branch preferred).
4. Keep one ticket per commit whenever reasonable.
5. Never use destructive git operations.

## 6) Ticketing System

Ticket format:
- `ID`: `ATX-P0-###`, `ATX-P1-###`, `ATX-P2-###`
- `Title`: short defect/risk statement
- `Owner`: person/agent role
- `Risk Link`: source finding ID(s)
- `Root Cause`: technical cause
- `Scope`: files/modules
- `Acceptance Criteria`: objective pass/fail
- `Linked Tests`: test IDs and commands
- `Status`: `todo | in_progress | review | blocked | done`
- `Git Evidence`: `commit_sha`, `pushed_branch`, `pr_link`
- `Execution Evidence`: CI/test output

## 7) Master Ticket Backlog

## P0 Tickets (Blocking)

| Ticket ID | Title | Owner | Key Files | Linked Tests | Status |
|---|---|---|---|---|---|
| `ATX-P0-001` | Lock runtime architecture contract + ADR | platform-architecture | `README.md`, `docs/proposals/agent-runtime-contract.md`, `docs/codex-agent-teams-ui.md` | `T-ATX-P0-001` | todo |
| `ATX-P0-002` | Bootstrap worker transport/adapter wiring | runtime-core | `mcp/server/index.ts`, `mcp/server/server.ts`, `mcp/server/tools/agent-lifecycle.ts` | `T-ATX-P0-002` | todo |
| `ATX-P0-003` | Persist worker runtime sessions | runtime-core | `mcp/store/migrations/009_worker_runtime_sessions.sql`, `mcp/store/sqlite-store.ts`, `mcp/server/tools/agent-lifecycle.ts` | `T-ATX-P0-003` | todo |
| `ATX-P0-004` | Secure instruction protocol (no raw shell key injection path) | runtime-security | `mcp/runtime/transports/tmux-transport.ts`, `mcp/runtime/transports/headless-transport.ts`, `mcp/runtime/tmux-manager.ts` | `T-ATX-P0-004` | todo |
| `ATX-P0-005` | Persist wave telemetry for cross-process UI | scheduler-core | `mcp/store/migrations/010_team_wave_state.sql`, `mcp/runtime/scheduler.ts`, `mcp/server/team-ui-state.ts` | `T-ATX-P0-005` | todo |
| `ATX-P0-006` | Redesign group route/idempotency semantics | collaboration-runtime | `mcp/store/entities.ts`, `mcp/store/sqlite-store.ts`, `mcp/schemas/entities/message.schema.json`, `mcp/schemas/contracts.ts` | `T-ATX-P0-006` | todo |
| `ATX-P0-007` | Preserve deterministic TUI contract while adding tmux UX path | operator-experience | `scripts/team-tui.ts`, `scripts/team-ui-view.ts`, `tests/integration/v3-111.tui.integration.test.ts` | `T-ATX-P0-007` | todo |

## P1 Tickets (Stabilization)

| Ticket ID | Title | Owner | Key Files | Linked Tests | Status |
|---|---|---|---|---|---|
| `ATX-P1-001` | DAG wave dispatch behind profile flag with fairness fallback | scheduler-core | `mcp/runtime/dag-analyzer.ts`, `mcp/runtime/scheduler.ts`, `profiles/*.team.yaml` | `T-ATX-P1-001` | todo |
| `ATX-P1-002` | Add mention parser and `team_group_send` with active-recipient dispatch | collaboration-runtime | `mcp/server/mention-parser.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/schemas/tools/team_group_send.schema.json` | `T-ATX-P1-002` | todo |
| `ATX-P1-003` | Implement decision reports as first-class persisted records | collaboration-runtime | `mcp/store/migrations/011_agent_decision_reports.sql`, `mcp/server/decision-tracker.ts`, `mcp/server/tools/agent-lifecycle.ts` | `T-ATX-P1-003` | todo |
| `ATX-P1-004` | Extend existing model routing contract (no duplicate router) | runtime-integration | `mcp/server/tools/agent-lifecycle.ts`, `profiles/*.team.yaml`, `mcp/schemas/contracts.ts` | `T-ATX-P1-004` | todo |
| `ATX-P1-005` | Implement transport factory with tmux/headless fallback | runtime-core | `mcp/runtime/transport-factory.ts`, `mcp/runtime/providers/codex.ts`, `mcp/runtime/transports/*` | `T-ATX-P1-005` | todo |
| `ATX-P1-006` | Add separate `team-tmux-ui` sidecar + operator controls | operator-experience | `scripts/team-tmux-ui.ts`, `docs/operator-console.md` | `T-ATX-P1-006` | todo |

## P2 Tickets (Future-proofing)

| Ticket ID | Title | Owner | Key Files | Linked Tests | Status |
|---|---|---|---|---|---|
| `ATX-P2-001` | Incremental DAG caching and scheduler performance guards | scheduler-core | `mcp/runtime/scheduler.ts`, `mcp/runtime/rebalancer.ts` | `T-ATX-P2-001` | todo |
| `ATX-P2-002` | Add pluggable backend command builder for codex/claude/opencode | runtime-integration | `mcp/runtime/model-router.ts`, `mcp/runtime/transports/tmux-transport.ts` | `T-ATX-P2-002` | todo |
| `ATX-P2-003` | Add restart/failover chaos tests for session + transport recovery | qa-reliability | `tests/chaos/*`, `tests/integration/*` | `T-ATX-P2-003` | todo |
| `ATX-P2-004` | Release/runbook hardening for new runtime modes and flags | release-engineering | `docs/AGENT_TEAMS_HYBRID_UX_FEATURE.md`, `docs/AGENT_TEAMS_INDUSTRY_PRACTICES.md`, `scripts/release-ready.sh` | `T-ATX-P2-004` | todo |

## 8) Detailed Ticket Specs

### ATX-P0-001 Runtime contract ADR
- owner: platform-architecture
- scope/files: `README.md`, `docs/proposals/agent-runtime-contract.md`, `docs/codex-agent-teams-ui.md`
- acceptance criteria:
  - Runtime ownership model is explicit and non-conflicting.
  - Default behavior remains backward-compatible and documented.
  - New feature flags and boundaries are documented with examples.
- linked tests:
  - `T-ATX-P0-001` -> `npm run test:integration:ts -- tests/integration/v3-111.tui.integration.test.ts`
- status: todo

### ATX-P0-002 Transport bootstrap wiring
- owner: runtime-core
- scope/files: `mcp/server/index.ts`, `mcp/server/server.ts`, `mcp/server/tools/agent-lifecycle.ts`
- acceptance criteria:
  - Server can instantiate with configured worker adapter/transport.
  - Existing call-sites without adapter keep current behavior.
  - Bootstrap path covered by unit/integration tests.
- linked tests:
  - `T-ATX-P0-002` -> `npm run test:unit:ts -- tests/unit/v4-001.transport-bootstrap.test.ts`
  - `T-ATX-P0-002` -> `npm run test:integration:ts -- tests/integration/v4-001.transport-bootstrap.integration.test.ts`
- status: todo

### ATX-P0-003 Durable worker session state
- owner: runtime-core
- scope/files: `mcp/store/migrations/009_worker_runtime_sessions.sql`, `mcp/store/sqlite-store.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/store/entities.ts`
- acceptance criteria:
  - Worker session bindings survive process restart.
  - `team_send` and `team_pull_inbox` can resolve active worker session post-restart.
  - Migration is backward-compatible.
- linked tests:
  - `T-ATX-P0-003` -> `npm run test:unit:ts -- tests/unit/v4-002.worker-session-persistence.test.ts`
  - `T-ATX-P0-003` -> `npm run test:integration:ts -- tests/integration/v4-002.restart-recovery.integration.test.ts`
- status: todo

### ATX-P0-004 Secure instruction channel
- owner: runtime-security
- scope/files: `mcp/runtime/transports/tmux-transport.ts`, `mcp/runtime/transports/headless-transport.ts`, `mcp/runtime/tmux-manager.ts`
- acceptance criteria:
  - No raw command concatenation with untrusted instruction text.
  - Multiline payloads delivered reliably.
  - Injection-oriented tests pass.
- linked tests:
  - `T-ATX-P0-004` -> `npm run test:unit:ts -- tests/unit/v4-003.transport-security.test.ts`
  - `T-ATX-P0-004` -> `npm run test:integration:ts -- tests/integration/v4-003.transport-security.integration.test.ts`
- status: todo

### ATX-P0-005 Persisted wave telemetry
- owner: scheduler-core
- scope/files: `mcp/store/migrations/010_team_wave_state.sql`, `mcp/runtime/scheduler.ts`, `mcp/server/team-ui-state.ts`
- acceptance criteria:
  - `team_ui_state` returns wave metrics consistently across process boundaries.
  - Wave progress values are consistent with task completion.
- linked tests:
  - `T-ATX-P0-005` -> `npm run test:unit:ts -- tests/unit/v4-004.wave-telemetry.test.ts`
  - `T-ATX-P0-005` -> `npm run test:integration:ts -- tests/integration/v4-004.wave-telemetry.integration.test.ts`
- status: todo

### ATX-P0-006 Group route/idempotency redesign
- owner: collaboration-runtime
- scope/files: `mcp/store/entities.ts`, `mcp/store/sqlite-store.ts`, `mcp/schemas/entities/message.schema.json`, `mcp/schemas/contracts.ts`
- acceptance criteria:
  - Distinct recipient sets produce distinct route/idempotency scopes.
  - Duplicate suppression works within identical recipient set only.
  - Direct/broadcast semantics remain unchanged.
- linked tests:
  - `T-ATX-P0-006` -> `npm run test:unit:ts -- tests/unit/v4-005.group-idempotency.test.ts`
  - `T-ATX-P0-006` -> `npm run test:integration:ts -- tests/integration/v4-005.group-idempotency.integration.test.ts`
- status: todo

### ATX-P0-007 Deterministic TUI compatibility
- owner: operator-experience
- scope/files: `scripts/team-tui.ts`, `scripts/team-ui-view.ts`, `tests/integration/v3-111.tui.integration.test.ts`, `tests/unit/v3-111.team-card.test.ts`
- acceptance criteria:
  - Existing deterministic output markers remain unchanged.
  - New runtime features do not break existing one-shot workflows.
- linked tests:
  - `T-ATX-P0-007` -> `npm run test:integration:ts -- tests/integration/v3-111.tui.integration.test.ts`
  - `T-ATX-P0-007` -> `npm run test:unit:ts -- tests/unit/v3-111.team-card.test.ts`
- status: todo

### ATX-P1-001 Flagged DAG wave dispatch
- owner: scheduler-core
- scope/files: `mcp/runtime/dag-analyzer.ts`, `mcp/runtime/scheduler.ts`, `profiles/*.team.yaml`
- acceptance criteria:
  - Wave dispatch can be enabled/disabled by policy.
  - Cycle detection falls back safely.
  - Fairness/starvation baseline tests remain green.
- linked tests:
  - `T-ATX-P1-001` -> `npm run test:unit:ts -- tests/unit/v4-006.dag-wave-dispatch.test.ts tests/unit/v3-002.scheduler.test.ts`
  - `T-ATX-P1-001` -> `npm run test:integration:ts -- tests/integration/v4-006.dag-wave-dispatch.integration.test.ts`
- status: todo

### ATX-P1-002 Mention parser + team_group_send
- owner: collaboration-runtime
- scope/files: `mcp/server/mention-parser.ts`, `mcp/server/tools/agent-lifecycle.ts`, `mcp/schemas/tools/team_group_send.schema.json`
- acceptance criteria:
  - Supports `@agent`, `@role`, `@all` with deterministic dedupe.
  - Group send creates correct inbox entries and immediate dispatch for active recipients.
- linked tests:
  - `T-ATX-P1-002` -> `npm run test:unit:ts -- tests/unit/v4-007.mention-parser.test.ts tests/unit/v4-008.team-group-send.test.ts`
  - `T-ATX-P1-002` -> `npm run test:integration:ts -- tests/integration/v4-007.group-send.integration.test.ts`
- status: todo

### ATX-P1-003 Persisted decision reports
- owner: collaboration-runtime
- scope/files: `mcp/store/migrations/011_agent_decision_reports.sql`, `mcp/store/sqlite-store.ts`, `mcp/server/decision-tracker.ts`, `mcp/server/tools/agent-lifecycle.ts`, `scripts/team-card.ts`
- acceptance criteria:
  - Reports are stored per `team_id + agent_id + task_id + revision`.
  - UI/card surfaces can show latest and history without overwrites.
- linked tests:
  - `T-ATX-P1-003` -> `npm run test:unit:ts -- tests/unit/v4-009.decision-reports.test.ts`
  - `T-ATX-P1-003` -> `npm run test:integration:ts -- tests/integration/v4-008.decision-reports.integration.test.ts`
- status: todo

### ATX-P1-004 Model routing extension
- owner: runtime-integration
- scope/files: `mcp/server/tools/agent-lifecycle.ts`, `mcp/server/staffing-planner.ts`, `profiles/*.team.yaml`, `mcp/schemas/contracts.ts`
- acceptance criteria:
  - Existing `model_routing` keys remain supported.
  - Backend selection extension is additive and backward-compatible.
- linked tests:
  - `T-ATX-P1-004` -> `npm run test:unit:ts -- tests/unit/v4-010.model-routing-compat.test.ts tests/unit/v3-109.staffing-planner.test.ts`
  - `T-ATX-P1-004` -> `npm run test:integration:ts -- tests/integration/v4-009.model-routing-compat.integration.test.ts`
- status: todo

### ATX-P1-005 Transport factory + fallback
- owner: runtime-core
- scope/files: `mcp/runtime/transport-factory.ts`, `mcp/runtime/providers/codex.ts`, `mcp/runtime/transports/tmux-transport.ts`, `mcp/runtime/transports/headless-transport.ts`
- acceptance criteria:
  - Auto-select transport based on env and feature flags.
  - Headless fallback is deterministic in CI and non-TTY.
- linked tests:
  - `T-ATX-P1-005` -> `npm run test:unit:ts -- tests/unit/v4-011.transport-factory.test.ts tests/unit/v4-012.headless-transport.test.ts`
  - `T-ATX-P1-005` -> `npm run test:integration:ts -- tests/integration/v4-010.transport-fallback.integration.test.ts`
- status: todo

### ATX-P1-006 Separate tmux sidecar UI
- owner: operator-experience
- scope/files: `scripts/team-tmux-ui.ts`, `docs/operator-console.md`, `package.json`
- acceptance criteria:
  - Live tmux UX exists as separate command path.
  - Existing `team:tui` output contract unchanged.
- linked tests:
  - `T-ATX-P1-006` -> `npm run test:integration:ts -- tests/integration/v3-111.tui.integration.test.ts tests/integration/v4-011.team-tmux-ui.integration.test.ts`
- status: todo

### ATX-P2-001 DAG performance hardening
- owner: scheduler-core
- scope/files: `mcp/runtime/scheduler.ts`, `mcp/runtime/rebalancer.ts`
- acceptance criteria:
  - Avoid full DAG recomputation each tick when graph unchanged.
  - Add perf guard metrics and thresholds.
- linked tests:
  - `T-ATX-P2-001` -> `npm run test:unit:ts -- tests/unit/v4-013.scheduler-dag-perf.test.ts`
- status: todo

### ATX-P2-002 Pluggable backend command builder
- owner: runtime-integration
- scope/files: `mcp/runtime/model-router.ts`, `mcp/runtime/transports/tmux-transport.ts`
- acceptance criteria:
  - Backend command construction is provider-pluggable.
  - Unsupported backend states fail closed with actionable error.
- linked tests:
  - `T-ATX-P2-002` -> `npm run test:unit:ts -- tests/unit/v4-014.backend-command-builder.test.ts`
- status: todo

### ATX-P2-003 Chaos/restart/failover suite
- owner: qa-reliability
- scope/files: `tests/chaos/v4-001.runtime-recovery.chaos.test.ts`, `tests/integration/v4-012.runtime-recovery.integration.test.ts`
- acceptance criteria:
  - Worker restart recovery validated under crash/restart conditions.
  - No orphaned runtime session entries after cleanup.
- linked tests:
  - `T-ATX-P2-003` -> `npm run test:integration:ts -- tests/integration/v4-012.runtime-recovery.integration.test.ts`
  - `T-ATX-P2-003` -> `node --import tsx --test tests/chaos/v4-001.runtime-recovery.chaos.test.ts`
- status: todo

### ATX-P2-004 Docs and release-gate hardening
- owner: release-engineering
- scope/files: `docs/AGENT_TEAMS_HYBRID_UX_FEATURE.md`, `docs/AGENT_TEAMS_INDUSTRY_PRACTICES.md`, `scripts/release-ready.sh`
- acceptance criteria:
  - Runbooks include feature flags, migration steps, fallback behavior, and rollback procedures.
  - Release gate checks new migrations and deterministic contract tests.
- linked tests:
  - `T-ATX-P2-004` -> `npm run verify`
- status: todo

## 9) Ticket-to-Test Matrix

| Test ID | Type | Covers Ticket(s) | Description |
|---|---|---|---|
| `T-ATX-P0-001` | Integration | `ATX-P0-001` | Contract/doc alignment with existing deterministic UI behavior |
| `T-ATX-P0-002` | Unit+Integration | `ATX-P0-002` | Bootstrap wiring and default compatibility |
| `T-ATX-P0-003` | Unit+Integration | `ATX-P0-003` | Worker session persistence + restart recovery |
| `T-ATX-P0-004` | Unit+Integration | `ATX-P0-004` | Instruction-channel security and multiline robustness |
| `T-ATX-P0-005` | Unit+Integration | `ATX-P0-005` | Cross-process wave telemetry correctness |
| `T-ATX-P0-006` | Unit+Integration | `ATX-P0-006` | Group message route/idempotency collision prevention |
| `T-ATX-P0-007` | Integration | `ATX-P0-007` | Deterministic `team-tui`/`team-card` compatibility |
| `T-ATX-P1-001` | Unit+Integration | `ATX-P1-001` | Flagged DAG dispatch + fairness fallback |
| `T-ATX-P1-002` | Unit+Integration | `ATX-P1-002` | Mention parsing and group send routing |
| `T-ATX-P1-003` | Unit+Integration | `ATX-P1-003` | Decision report persistence + rendering |
| `T-ATX-P1-004` | Unit+Integration | `ATX-P1-004` | Model routing backward compatibility |
| `T-ATX-P1-005` | Unit+Integration | `ATX-P1-005` | Transport factory selection and fallback |
| `T-ATX-P1-006` | Integration | `ATX-P1-006` | New tmux sidecar without `team-tui` regressions |
| `T-ATX-P2-001` | Unit | `ATX-P2-001` | DAG recompute performance limits |
| `T-ATX-P2-002` | Unit | `ATX-P2-002` | Backend command builder correctness |
| `T-ATX-P2-003` | Chaos+Integration | `ATX-P2-003` | Crash/restart/failover reliability |
| `T-ATX-P2-004` | Release Gate | `ATX-P2-004` | Docs and release readiness enforcement |

## 10) Completion Math (Required)

- `overall_completion_pct = done_tickets / total_tickets * 100`
- `p0_completion_pct = done_p0 / total_p0 * 100`
- `p1_completion_pct = done_p1 / total_p1 * 100`
- `p2_completion_pct = done_p2 / total_p2 * 100`

Always report both counts and percentages.

## 11) Anti-Recurrence Controls

1. No runtime state that affects dispatch/delivery may remain memory-only without explicit durability rationale.
2. Any new delivery mode must define route-key + idempotency semantics and collision tests.
3. Any scheduling enhancement must preserve fairness tests and have a feature-flag fallback.
4. Deterministic CLI contract (`v3-111`) is a release-blocking gate.
5. Any ticket status `done` without linked test evidence and git evidence is invalid and must revert to `blocked` or `in_progress`.
