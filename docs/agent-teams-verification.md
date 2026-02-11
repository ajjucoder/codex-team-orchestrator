# Agent Teams Verification Status

Date: 2026-02-11

This document captures concrete evidence that agent-team coordination is implemented and working.

## Verified Capabilities

1. Specialized role-based team members are spawned and coordinated.
2. Agent-to-agent direct messaging works through the shared bus.
3. Broadcast messaging fan-out works to team peers.
4. Inbox pull + acknowledgement flow works.
5. Artifact references are exchanged across messages.
6. Cross-team message attempts are denied.
7. Runtime-enforced git branch/worktree isolation is allocated per active worker.
8. Worker execution context checks fail closed outside assigned worktree.
9. Team completion/abort cleanup removes orphan worker worktrees.
10. Trigger specialization supports static fanout and DAG-ready role shaping.
11. Operator UI-state surfaces stay coherent across `team_status`, `team_run_summary`, and `team_replay`.
12. TUI snapshot/control card contract is stable for operator automation (`pause/resume/drain/retry`).

## Wait/Poll Semantics (Important)

- Host tool logs may show `agents: none` after a wait call when no worker reached terminal state within that polling window.
- This means `still running (timeout window)`, not failure.
- Team prompts in this repo now require explicit user-facing timeout wording with live `running/completed/failed` counts.

## Runtime Implementation Points

- Message tools:
  - `mcp/server/tools/agent-lifecycle.ts:365` (`team_send`)
  - `mcp/server/tools/agent-lifecycle.ts:496` (`team_broadcast`)
  - `mcp/server/tools/agent-lifecycle.ts:624` (`team_pull_inbox`)
- Inbox persistence and ack:
  - `mcp/store/sqlite-store.ts:638` (`pullInbox`)
  - `mcp/store/sqlite-store.ts:662` (`ackInbox`)
- Runtime git isolation:
  - `mcp/runtime/git-manager.ts` (allocation, fail-closed guard, cleanup)
  - `mcp/runtime/scheduler.ts` (dispatch-time allocation + active/inactive cleanup)
- Trigger specialization + role-shaped staffing:
  - `mcp/server/tools/trigger.ts` (`team_trigger`)
  - `mcp/server/tools/agent-lifecycle.ts` (`team_spawn_ready_roles`)
- UI-state and replay:
  - `mcp/server/tools/team-lifecycle.ts` (`team_status`, `team_resume`, `team_finalize`)
  - `mcp/server/tools/observability.ts` (`team_run_summary`, `team_replay`)
- Operator UI contract:
  - `scripts/team-tui.ts` (sidecar snapshot + control command routing)
  - `scripts/team-card.ts` (chat card renderer for launch/progress/timeout/complete)
  - `scripts/team-console.ts` (legacy compatibility path)

## Test Evidence

- Agent lifecycle/message bus integration:
  - `tests/integration/at006.agent-lifecycle.integration.test.ts`
  - Covers broadcast, inbox pull/ack, duplicate suppression, and role-shaped spawn.
- Artifact-ref exchange:
  - `tests/integration/at008.artifacts.integration.test.ts`
- Cross-team isolation:
  - `tests/integration/at019.hardening.integration.test.ts:20`
- Git isolation and cleanup:
  - `tests/unit/v3-005.git-isolation.test.ts`
  - `tests/integration/v3-005.git-isolation.integration.test.ts`
- Hybrid Agent-Teams UI/TUI MVP evidence:
  - `tests/unit/v3-109.staffing-planner.test.ts`
  - `tests/integration/v3-109.staffing.integration.test.ts`
  - `tests/unit/v3-110.team-ui-state.test.ts`
  - `tests/integration/v3-110.ui-state.integration.test.ts`
  - `tests/unit/v3-111.team-card.test.ts`
  - `tests/integration/v3-111.tui.integration.test.ts`

## Verification Commands

```bash
node --import tsx --test tests/integration/at006.agent-lifecycle.integration.test.ts
node --import tsx --test tests/integration/at008.artifacts.integration.test.ts
node --import tsx --test tests/integration/at019.hardening.integration.test.ts
node --import tsx --test tests/unit/v3-005.git-isolation.test.ts
node --import tsx --test tests/integration/v3-005.git-isolation.integration.test.ts
node --import tsx --test tests/unit/v3-109.staffing-planner.test.ts
node --import tsx --test tests/integration/v3-109.staffing.integration.test.ts
node --import tsx --test tests/unit/v3-110.team-ui-state.test.ts
node --import tsx --test tests/integration/v3-110.ui-state.integration.test.ts
node --import tsx --test tests/unit/v3-111.team-card.test.ts
node --import tsx --test tests/integration/v3-111.tui.integration.test.ts
npm run test:unit:ts
npm run test:integration:ts
./scripts/check-config.sh
./scripts/verify.sh
```

## Latest Result Snapshot

- `AT-006` integration suite: pass
- `V3-109` unit/integration suites: pass
- `V3-110` unit/integration suites: pass
- `V3-111` unit/integration suites: pass
- Full unit suite: `95/95` pass
- Full integration suite: `48/48` pass
- `check-config`: pass
- `verify`: pass

## Benchmark Quality/Usage Status

Latest internal benchmark report confirms adaptive orchestration keeps quality while reducing usage:
- Report path: `.tmp/v2-audit-report.json`
- Median tokens: `11515` -> `10192.5` (`-1322.5`, about `11.49%`)
- Median quality: `1` -> `1`
- V2 gates: pass (`scripts/v2-eval-gates.ts`)

Note: this benchmark is internal baseline-vs-candidate, not a direct external A/B against Claude Agent Teams.
