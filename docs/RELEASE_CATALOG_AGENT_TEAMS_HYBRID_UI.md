# Release Catalog: Agent Teams Hybrid UI Chain

Release track: `codex/agent-teams-hybrid-ux-e2e`  
Catalog date: 2026-02-12  
Base: `main@afe6763`  
Feature head: `85a46e7`

## 1) Release Contents

## Hybrid UI/CLI capabilities

- Staffing planner tool: `team_staff_plan`
- Unified UI state tool: `team_ui_state`
- Trigger specialization + DAG-ready role shaping integration
- Sidecar TUI command channel (`pause/resume/drain/retry`)
- Chat card rendering modes (`launch/progress/timeout/complete`)

## Key files added/changed

- `mcp/server/staffing-planner.ts`
- `mcp/server/team-ui-state.ts`
- `mcp/schemas/tools/team_staff_plan.schema.json`
- `mcp/schemas/tools/team_ui_state.schema.json`
- `scripts/team-card.ts`
- `scripts/team-tui.ts`
- `scripts/team-ui-view.ts`
- `tests/unit/v3-109.staffing-planner.test.ts`
- `tests/unit/v3-110.team-ui-state.test.ts`
- `tests/unit/v3-111.team-card.test.ts`
- `tests/integration/v3-109.staffing.integration.test.ts`
- `tests/integration/v3-110.ui-state.integration.test.ts`
- `tests/integration/v3-111.tui.integration.test.ts`

## 2) Validation Evidence

Executed on this branch:

- Unit suite: `162/162` pass.
- Integration suite: `90/90` pass.
- E2E large-objective: `1/1` pass.
- Chaos slice: `2/2` pass.

Command set used:

```bash
npm run test:unit:ts -- tests/unit/v3-109.staffing-planner.test.ts tests/unit/v3-110.team-ui-state.test.ts tests/unit/v3-111.team-card.test.ts tests/unit/v3-006.execution-loop.test.ts tests/unit/at006.agent-lifecycle.test.ts tests/unit/at007.task-board.test.ts
npm run test:integration:ts -- tests/integration/v3-109.staffing.integration.test.ts tests/integration/v3-110.ui-state.integration.test.ts tests/integration/v3-111.tui.integration.test.ts tests/integration/v3-006.autonomous-loop.integration.test.ts tests/integration/v3-003.adapter.integration.test.ts tests/integration/v3-101.console.integration.test.ts tests/integration/at007.task-board.integration.test.ts
node --import tsx --test tests/e2e/v3-006.large-objective.e2e.test.ts
node --import tsx --test tests/chaos/v3-009.crash-restart.chaos.test.ts tests/chaos/v3-206.chaos-harness.test.ts
```

## 3) Release Risk Summary

## Strengths

- Deterministic UI-state and TUI contract tests are present and passing.
- Backward-compatible legacy console path remains available.
- Core reliability and autonomous execution regressions were rechecked and passed.

## Known ergonomic gaps

- `--help` is not yet supported in `scripts/team-tui.ts` and `scripts/team-card.ts`.
- `scripts/team-ui-view.ts` is primarily a programmatic view builder, not a standalone operator CLI.

## 4) Rollback and Recovery

Rollback strategy:

- Revert commit `85a46e7` (or the PR merge commit containing it).

Runtime recovery posture remains available via:

- `team_resume` / `team_finalize` lifecycle controls
- replay and summary evidence via `team_replay` and `team_run_summary`

## 5) Merge Recommendation

Recommendation: `READY_FOR_PR_REVIEW`

Rationale:

- High-confidence validation coverage for both new UI chain and existing core runtime invariants.
- Remaining issues are UX polish items, not correctness/safety blockers.

