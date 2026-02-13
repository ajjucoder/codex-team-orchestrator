# ATX Release Readiness

Last updated: 2026-02-13  
Release line: ATX end-to-end backlog (`ATX-P0-001` .. `ATX-P2-004`)

## 1) Release Decision

Status: `READY_FOR_PRODUCTION`

Rationale:

- All ATX tickets completed: `17/17 (100.0%)`
- P0/P1/P2 completion all at `100.0%`
- Local full verification green (`npm run verify`)
- `main` CI green after merge
- Deterministic operator contracts preserved (`team-tui`, `team-card`)

## 2) Scope Delivered

Core delivery highlights:

- Runtime contract formalized with explicit managed-runtime optionality
- Managed runtime bootstrap + transport factory fallback behavior
- Durable worker runtime session storage and restart-safe re-establish flow
- Secure framed instruction transport and corrected tmux interrupt targeting
- Persisted scheduler wave telemetry for cross-process UI continuity
- Group route/idempotency redesign and mention-aware group send
- Persisted decision reports with revisioned history
- Pluggable backend command routing (`codex`, `claude`, `opencode`)
- Tmux sidecar operator UI with deterministic legacy path preserved
- Reliability hardening with recovery integration + chaos coverage

## 3) Readiness Gates

## Mandatory commands

```bash
npm run verify
./scripts/release-ready.sh
```

`scripts/release-ready.sh` additionally enforces:

- ATX migration presence checks:
  - `009_worker_runtime_sessions.sql`
  - `010_team_wave_state.sql`
  - `011_agent_decision_reports.sql`
- deterministic UI contract tests:
  - `tests/unit/v3-111.team-card.test.ts`
  - `tests/integration/v3-111.tui.integration.test.ts`
- migration regression unit tests (`v4-002`, `v4-004`, `v4-009`)
- benchmark + gates + package flow

## CI evidence

- Branch merged to `main` commit: `db325a7`
- GitHub Actions run for merge commit: `21979238161` -> `success`
- Workflow URL:
  - `https://github.com/ajjucoder/codex-team-orchestrator-private/actions/runs/21979238161`

## 4) Risk Review

## Highest-risk areas and controls

- Restart recovery:
  - control: process-scoped stale worker sessions are re-established before managed-runtime dispatch/poll
  - evidence: `tests/unit/v4-002.worker-session-persistence.test.ts`, `tests/integration/v4-002.restart-recovery.integration.test.ts`
- Tmux command safety:
  - control: framed instruction protocol, target-preserving interrupts
  - evidence: `tests/unit/v4-003.transport-security.test.ts`, `tests/integration/v4-003.transport-security.integration.test.ts`
- Deterministic UX compatibility:
  - control: dedicated deterministic test gates for `team-tui` and `team-card`
  - evidence: `tests/unit/v3-111.team-card.test.ts`, `tests/integration/v3-111.tui.integration.test.ts`

## Residual risk

- Runtime behavior in non-standard host environments (custom tmux setups or non-default shell wrappers) can still require environment-specific validation.
- Managed-runtime mode should remain explicitly enabled and not auto-switched in production configuration templates.

## 5) Rollout Guidance

1. Keep default runtime mode (`host_orchestrated_default`) for baseline stability.
2. Enable managed runtime intentionally per environment.
3. Validate transport selection behavior (`auto`, `tmux`, `headless`) in that environment.
4. Run deterministic UI contract tests and restart-recovery tests before broad rollout.
5. Monitor replay events and `team_ui_state.progress.wave` for early anomaly detection.

## 6) Rollback Guidance

If any release-blocking regression appears:

1. Stop managed-runtime enablement changes.
2. Roll back to last green `main` commit.
3. Re-run `npm run verify` and targeted ATX regression suites.
4. Re-approve rollout only after deterministic and migration gates are green.

## 7) Documentation Index

- Architecture: `docs/ATX_RUNTIME_ARCHITECTURE.md`
- Runbook: `docs/ATX_OPERATIONS_RUNBOOK.md`
- Operator console behavior: `docs/operator-console.md`
- Runtime ADR: `docs/proposals/agent-runtime-contract.md`
- Sprint evidence: `docs/plans/SPRINT_PROGRESS.md`

