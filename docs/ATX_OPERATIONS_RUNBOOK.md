# ATX Operations Runbook

Last updated: 2026-02-13  
Audience: platform operators, release engineers, and on-call maintainers.

## 1) Purpose

This runbook covers operational usage of ATX runtime features merged to `main`, including runtime-mode selection, transport behavior, operator controls, recovery procedures, and release-safe command sequences.

## 2) Preconditions

- Node `>=24` (see `package.json`)
- Dependencies installed: `npm ci`
- Profile files present under `profiles/`
- SQLite DB path available (default `.tmp/team-orchestrator.sqlite`)

Fast safety checks:

```bash
npm run lint
npm run typecheck
npm run verify
./scripts/check-config.sh
```

## 3) Runtime Mode Selection

## Default (recommended baseline)

Use default host-orchestrated behavior when managed runtime transport control is not required.

Behavior:

- no implicit managed transport bootstrap
- existing tool and deterministic UI behavior remains unchanged

## Managed runtime (explicit only)

Enable managed runtime only when worker transport management is intended.

Entry points:

- `runtimeMode: 'managed_runtime'`, or
- `managedRuntime.enabled: true`

Transport selection:

- option: `managedRuntime.transportMode`
- env fallback: `ATX_MANAGED_RUNTIME_TRANSPORT` or `CODEX_MANAGED_RUNTIME_TRANSPORT`
- values: `auto | tmux | headless`

## 4) Operator UIs and Control Commands

## Deterministic sidecar (`team-tui`)

One-shot snapshot:

```bash
npm run team:tui -- --db .tmp/team-orchestrator.sqlite --team <team_id> --once --no-input
```

One-shot command:

```bash
npm run team:tui -- --db .tmp/team-orchestrator.sqlite --team <team_id> --command pause --once --no-input
```

## Tmux sidecar (`team-tmux-ui`)

One-shot live view:

```bash
npm run team:tmux-ui -- --db .tmp/team-orchestrator.sqlite --team <team_id> --once --show-wave
```

One-shot command:

```bash
npm run team:tmux-ui -- --db .tmp/team-orchestrator.sqlite --team <team_id> --command resume --once
```

Supported commands:

- `pause` -> `team_finalize(reason=operator_pause)`
- `resume` -> `team_resume`
- `drain` -> cancels `todo|blocked` tasks
- `retry` -> retries blocked tasks (optionally `--task <task_id>`)

## 5) Collaboration Tooling (ATX Additions)

## Group message dispatch

Tool: `team_group_send`

Supported recipient routing inputs:

- summary mentions: `@all`, `@agent:<id>`, `@role:<role>`, `@agent_x`
- explicit `mentions` array
- explicit `recipient_agent_ids` array

Operational expectation:

- deduped recipients
- active recipient dispatch through managed worker path when available
- idempotency scoped to recipient-set route semantics

## Decision reports

Tool: `team_agent_report`

Operational expectation:

- creates revisioned records (`agent_decision_reports`)
- rejects stale/non-monotonic revisions
- history retrievable for operator evidence and card views

## 6) Incident Playbooks

## A) Worker dispatch fails after restart (`WORKER_NOT_FOUND`)

Expected ATX behavior:

- process-scoped stale worker sessions are detected
- worker sessions are re-established before send/pull operations

Operator actions:

1. Check recent events with replay: verify `worker_session_reestablished` and related dispatch events.
2. Run UI snapshot and confirm queue/inbox movement:
   - `npm run team:tui -- --db <db> --team <team_id> --once --no-input`
3. If still blocked, issue controlled pause/resume cycle:
   - `pause` then `resume`
4. Re-run focused recovery tests if needed:
   - `node --import tsx --test tests/unit/v4-002.worker-session-persistence.test.ts`
   - `node --import tsx --test tests/integration/v4-002.restart-recovery.integration.test.ts`

## B) Tmux interrupt appears ineffective

Expected ATX behavior:

- tmux pane target uses preserved `session:window.pane` format for interrupts

Operator actions:

1. Verify target format and command path (`team-tmux-ui` or managed runtime interrupt path).
2. Re-run transport security regression:
   - `node --import tsx --test tests/unit/v4-003.transport-security.test.ts`
3. Validate integration path:
   - `node --import tsx --test tests/integration/v4-003.transport-security.integration.test.ts`

## C) Scheduler queue appears stalled

Operator actions:

1. Collect `team_ui_state` snapshot and inspect:
   - `progress.queue_depth`, `progress.wave`, `blockers`
2. Confirm profile flag behavior:
   - `scheduler.wave_dispatch.enabled`
3. Verify DAG fallback/perf guard events in replay.
4. Run wave dispatch and recovery tests:
   - `node --import tsx --test tests/unit/v4-006.dag-wave-dispatch.test.ts tests/unit/v4-013.scheduler-dag-perf.test.ts`
   - `node --import tsx --test tests/integration/v4-006.dag-wave-dispatch.integration.test.ts`

## D) CI reports runtime regression

Operator actions:

1. Run local full gate:
   - `npm run verify`
2. Run release gate:
   - `./scripts/release-ready.sh`
3. If migration-related, verify files exist:
   - `mcp/store/migrations/009_worker_runtime_sessions.sql`
   - `mcp/store/migrations/010_team_wave_state.sql`
   - `mcp/store/migrations/011_agent_decision_reports.sql`

## 7) Standard Recovery Controls

- `team_orphan_recover` for stale leases and orphaned task states
- `team_resume` after intentional pause/finalize where applicable
- `team_finalize` for controlled stop
- `drain` and `retry` commands through sidecar UIs for backlog management

Use `team_ui_state.controls.enabled` as the source of truth for command availability.

## 8) Verification Matrix

Minimum confidence set for ATX runtime changes:

```bash
node --import tsx --test tests/unit/v4-002.worker-session-persistence.test.ts
node --import tsx --test tests/unit/v4-003.transport-security.test.ts
node --import tsx --test tests/unit/v4-005.group-idempotency.test.ts
node --import tsx --test tests/unit/v4-006.dag-wave-dispatch.test.ts
node --import tsx --test tests/unit/v4-009.decision-reports.test.ts
node --import tsx --test tests/unit/v4-010.model-routing-compat.test.ts
node --import tsx --test tests/unit/v4-011.transport-factory.test.ts
node --import tsx --test tests/unit/v4-014.backend-command-builder.test.ts
node --import tsx --test tests/integration/v4-002.restart-recovery.integration.test.ts
node --import tsx --test tests/integration/v4-007.group-send.integration.test.ts
node --import tsx --test tests/integration/v4-008.decision-reports.integration.test.ts
node --import tsx --test tests/integration/v4-010.transport-fallback.integration.test.ts
node --import tsx --test tests/integration/v4-011.team-tmux-ui.integration.test.ts
node --import tsx --test tests/integration/v4-012.runtime-recovery.integration.test.ts
node --import tsx --test tests/integration/v3-111.tui.integration.test.ts
```

Full gate:

```bash
npm run verify
```

## 9) Rollback Strategy

If a release regression is detected:

1. Freeze new managed-runtime enablement.
2. Roll back to previous green `main` commit.
3. Re-run deterministic contract tests (`v3-111`) and ATX recovery tests.
4. Re-enable managed runtime only after green verify + release gate.

## 10) Ownership and Escalation

Primary ownership areas:

- Runtime core: `mcp/runtime/*`, `mcp/server/index.ts`
- Collaboration/runtime tools: `mcp/server/tools/agent-lifecycle.ts`
- Persistence: `mcp/store/*`
- Operator UX: `scripts/team-tui.ts`, `scripts/team-tmux-ui.ts`, `scripts/team-card.ts`

Escalate when:

- deterministic UI contracts fail
- migration tables are missing or incompatible
- restart recovery fails for worker session dispatch/poll
- release gate (`scripts/release-ready.sh`) is not green

