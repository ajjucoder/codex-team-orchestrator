# Agent Teams Hybrid UX Feature

Branch: `codex/agent-teams-hybrid-ux-e2e`  
Scope: user-land orchestration layer on top of the Codex Team Orchestrator MCP server.

## System Overview

End-to-end flow for hybrid UX execution:

1. User sends a prompt containing a trigger phrase such as `use agents team`.
2. `team_trigger` evaluates the strict parallel gate.
3. If gate passes, profile policy is loaded and staffing plan is generated.
4. Workers are auto-spawned with specialist metadata and git-isolated branch/worktree assignments.
5. Operator observes and controls execution through TUI/card surfaces backed by `team_ui_state`.
6. On team finalization, inactive-team cleanup integrates eligible worker branches and releases assignments/worktrees.
7. If gate fails, execution is routed to normal mode with a recommendation payload and no team startup/spawn.

## MCP Tools

### `team_trigger` (`mcp/server/tools/trigger.ts`)

Purpose: entry point for Agent Teams routing, gating, staffing, startup, and optional auto-spawn.

Input schema:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompt` | string | Yes | Must include trigger phrase/alias to activate. |
| `profile` | enum | No | `fast` \| `default` \| `deep`. |
| `task_size` | enum | No | `small` \| `medium` \| `high` (otherwise inferred). |
| `max_threads` | integer | No | 1..6, further bounded by profile policy. |
| `auto_spawn` | boolean | No | Defaults to `true`. |
| `estimated_parallel_tasks` | integer | No | Minimum 1. |
| `budget_tokens_remaining` | integer | No | Overrides profile soft budget for fanout. |
| `token_cost_per_agent` | integer | No | Optional optimizer input. |
| `active_session_model` | string | No | Forwarded to `team_start` call options. |

Output shape:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | Tool success. |
| `triggered` | boolean | Whether trigger phrase matched. |
| `accepted` | boolean | `true` when routed to Agent Teams; `false` when routed normal mode. |
| `route` | enum | `agent_teams` or `normal_mode`. |
| `parallel_gate` | object | Gate decision, reason code, signals, thresholds. |
| `recommendation` | object | Present for normal-mode fallback (`message`, `suggested_mode`, `objective`). |
| `team` | object | Present for accepted path (`team_start` payload). |
| `orchestration` | object | Task sizing, recommended threads, spawn strategy, staffing planner output, spawned agents, errors. |

Usage example:

```json
{
  "tool": "team_trigger",
  "input": {
    "prompt": "use agents team implement parallel migration across services",
    "profile": "default",
    "auto_spawn": true,
    "estimated_parallel_tasks": 4
  }
}
```

Accepted-path response excerpt:

```json
{
  "ok": true,
  "triggered": true,
  "accepted": true,
  "route": "agent_teams",
  "parallel_gate": {
    "passed": true,
    "reason_code": "parallelizable"
  },
  "orchestration": {
    "spawn_strategy": "static_sequence",
    "recommended_threads": 4,
    "staffing_planner": {
      "domain": "backend",
      "planned_roles": ["implementer", "reviewer", "planner", "tester"]
    },
    "spawned_count": 4
  }
}
```

Fallback response excerpt:

```json
{
  "ok": true,
  "triggered": true,
  "accepted": false,
  "route": "normal_mode",
  "parallel_gate": {
    "passed": false,
    "reason_code": "not_parallelizable_low_parallelism"
  },
  "recommendation": {
    "suggested_mode": "default"
  }
}
```

### `team_ui_state` (`mcp/server/team-ui-state.ts`, registered in `mcp/server/tools/observability.ts`)

Purpose: structured operator snapshot for monitoring and control surfaces.

Input schema:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `team_id` | string | Yes | Pattern: `^team_[A-Za-z0-9_-]+$`. |
| `recent_event_limit` | integer | No | 1..300. |
| `evidence_limit` | integer | No | 1..80. |
| `failure_limit` | integer | No | 1..80. |

Output shape:

| Field | Type | Notes |
| --- | --- | --- |
| `team` | object | Team identity/status/profile/objective/timestamps. |
| `workers` | object | Summary + roster with specialist metadata. |
| `tasks` | object | Total/open/counts/spotlight queue. |
| `progress` | object | Completion metrics and queue/inbox depth. |
| `blockers` | object | Blocked tasks, failed-terminal tasks, stale agents, expired leases. |
| `recent_events` | array | Recent replay events with summaries and replay links. |
| `evidence_links` | array | Done-task/artifact/merge decision evidence pointers. |
| `failure_highlights` | array | Event-derived failure summaries with severity. |
| `controls` | object | Allowed commands and per-command enablement map. |

Usage example:

```json
{
  "tool": "team_ui_state",
  "input": {
    "team_id": "team_abc123",
    "recent_event_limit": 40,
    "evidence_limit": 12,
    "failure_limit": 12
  }
}
```

Response excerpt:

```json
{
  "ok": true,
  "team_id": "team_abc123",
  "workers": {
    "summary": { "total": 4, "busy": 2, "idle": 2, "offline": 0, "utilization_pct": 50 }
  },
  "progress": {
    "completion_pct": 67,
    "done_tasks": 8,
    "total_tasks": 12
  },
  "controls": {
    "enabled": {
      "team_resume": false,
      "team_finalize": true,
      "team_spawn_ready_roles": true
    }
  }
}
```

### `team_staff_plan` (`mcp/server/staffing-planner.ts`, registered in `mcp/server/tools/observability.ts`)

Purpose: compute recommended thread count and specialist sequence for an objective/prompt.

Input schema:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `team_id` | string | No | If provided, objective defaults from team when not passed explicitly. |
| `objective` | string | No | Optional standalone objective. |
| `prompt` | string | No | Optional alternate objective source. |
| `task_size` | enum | No | `small` \| `medium` \| `high` (otherwise inferred). |
| `max_threads` | integer | No | 1..6. |
| `estimated_parallel_tasks` | integer | No | 1..6. |
| `preferred_threads` | integer | No | 1..6 (forces preferred recommendation when valid). |

Output shape:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | Tool success. |
| `team_id` | string/null | Resolved team context when available. |
| `objective` | string | Objective used for planning. |
| `plan` | `StaffingPlan` | Contains recommendation, specialist metadata, role sequence, reasoning. |

`StaffingPlan` canonical fields:

| Field | Notes |
| --- | --- |
| `recommended_threads` | Final bounded recommendation. |
| `specialists` | Specialist metadata list (`specialist_handle`, `specialist_domain`, `focus`, `spawn_reason`, `priority`). |
| `planned_roles` | Ordered role sequence used for spawning. |
| `reasons` | Planner reasoning strings. |
| `dynamic_expansion` | `base_threads`, `estimated_parallel_tasks`, `signal_boost`, `bounded_max`. |

Usage example:

```json
{
  "tool": "team_staff_plan",
  "input": {
    "objective": "Refactor backend API and data pipeline with parallel validation",
    "task_size": "high",
    "max_threads": 6,
    "estimated_parallel_tasks": 5
  }
}
```

Response excerpt:

```json
{
  "ok": true,
  "objective": "Refactor backend API and data pipeline with parallel validation",
  "plan": {
    "domain": "backend",
    "recommended_threads": 6,
    "planned_roles": ["implementer", "reviewer", "planner", "tester", "researcher", "lead"],
    "specialists": [
      {
        "role": "implementer",
        "specialist_handle": "@backend-dev",
        "specialist_domain": "backend",
        "spawn_reason": "role implementer selected by tpl_backend_v1 template for backend objective"
      }
    ],
    "reasons": ["domain template selected: backend"]
  }
}
```

## Parallel Gate (`mcp/server/parallel-gate.ts`)

Signal detection:

| Signal Type | Keyword examples |
| --- | --- |
| Parallel | `parallel`, `independent`, `across`, `multi-file`, `multiple`, `workstream`, `modules`, `services`, `migration` |
| Sequential | `small`, `quick`, `typo`, `single file`, `one file`, `rename`, `minor`, `simple fix` |

Reason codes:

| Code | Meaning |
| --- | --- |
| `parallelizable` | Passed strict gate. |
| `parallelizable_policy_disabled` | Passed because strict gate disabled by policy. |
| `not_parallelizable_low_parallelism` | Failed due to low recommended/estimated parallelism or low parallel-signal count. |
| `not_parallelizable_sequential_signals` | Failed due to sequential-signal overload without strong parallel override. |

Default thresholds:

| Setting | Default |
| --- | --- |
| `strict_parallel_gate` | `true` |
| `min_threads_for_team` | `2` |
| `min_parallel_signals` | `1` |
| `max_sequential_signals` | `0` |

Normal-mode fallback behavior:

1. `team_trigger` logs `team_trigger_routed_normal_mode`.
2. Returns `route: "normal_mode"` and `accepted: false`.
3. Includes a recommendation payload for default-mode continuation.
4. Skips team startup and worker spawn.

## Staffing Planner (`mcp/server/staffing-planner.ts`)

Domain detection uses keyword matching and selects one template domain:

| Domain | Keyword families |
| --- | --- |
| `frontend` | `ui`, `ux`, `react`, `component`, `css`, `tailwind`, `accessibility` |
| `backend` | `api`, `service`, `endpoint`, `database`, `orm`, `cache`, `queue` |
| `data` | `pipeline`, `etl`, `warehouse`, `analytics`, `batch`, `schema`, `sql` |
| `infra` | `kubernetes`, `terraform`, `deploy`, `ci`, `cd`, `ops`, `sre` |
| `security` | `auth`, `permission`, `vulnerability`, `threat`, `secret`, `compliance`, `hardening` |
| `general` | fallback when no domain template scores > 0 |

Specialist templates:

| Domain | Template ID | Role sequence start |
| --- | --- | --- |
| frontend | `tpl_frontend_v1` | `implementer, reviewer, tester, planner, ...` |
| backend | `tpl_backend_v1` | `implementer, reviewer, planner, tester, ...` |
| data | `tpl_data_v1` | `planner, implementer, reviewer, tester, ...` |
| infra | `tpl_infra_v1` | `implementer, tester, reviewer, planner, ...` |
| security | `tpl_security_v1` | `reviewer, tester, implementer, planner, ...` |
| general | `tpl_general_v1` | `implementer, reviewer, planner, tester, ...` |

Dynamic thread sizing:

1. Base threads by task size: `small=2`, `medium=4`, `high=6`.
2. Compute `estimated_parallel_tasks` (or default to base).
3. Add signal boost from dynamic keywords (`migration`, `refactor`, `parallel`, `across`, `multi-file`, `end-to-end`, `e2e`, `incident`, `hotfix`, `rollout`): `+1` for >=2 hits, `+2` for >=5 hits.
4. Bound by profile/runtime max threads and hard cap.
5. Apply `preferred_threads` override when provided.

Hard cap: `6` threads.

Output contract mapping:

| Concept | Canonical field |
| --- | --- |
| Recommended threads | `recommended_threads` |
| Specialist metadata | `specialists[]` |
| Role sequence | `planned_roles[]` |
| Reasoning | `reasons[]` |

## Team Profiles (`profiles/*.team.yaml`)

All profiles enforce `trigger.strict_parallel_gate: true`.

| Profile | Threads | Token Budget | Idle Shutdown | Quality Floor | Arbitration |
| --- | ---: | ---: | --- | ---: | --- |
| fast | 2 | 8,000 | 90s | 0.75 | strict_vote |
| default | 4 | 12,000 | 180s | 0.8 | lead |
| deep | 5 | 22,000 | 300s | 0.85 | consensus |

## Operator CLI Tools

### `team-tui` (`scripts/team-tui.ts`)

Purpose: live terminal monitor with periodic snapshot refresh from `loadTeamUiSnapshot()` and optional interactive controls.

Usage:

```bash
npx tsx scripts/team-tui.ts --team <id> --db <path> [--interval-ms 1200] [--once] [--no-input] [--command pause|resume|drain|retry] [--task <task_id>] [--recent-event-limit 40] [--evidence-limit 12] [--failure-limit 12] [--replay-limit 360] [--feed-limit 14]
```

Controls:

| Key | Action |
| --- | --- |
| `p` | pause (`team_finalize` with `reason=operator_pause`) |
| `r` | resume (`team_resume`) |
| `d` | drain tasks (cancel `todo` and `blocked`) |
| `t` | retry blocked tasks (set to `todo`) |
| `q` | quit |

Headless mode: `--once` implies non-interactive one-shot snapshot rendering.

### `team-card` (`scripts/team-card.ts`)

Purpose: render Markdown status cards from snapshot data.

Modes: `launch`, `progress`, `timeout`, `complete`.

Usage:

```bash
npx tsx scripts/team-card.ts --mode progress --team <id> --db <path> [--recent-event-limit 40] [--evidence-limit 12] [--failure-limit 12] [--replay-limit 360]
```

### `team-ui-view` (`scripts/team-ui-view.ts`)

Purpose: shared view model for operator surfaces.

Exports include:

| API | Purpose |
| --- | --- |
| `loadTeamUiSnapshot()` | Loads `team_ui_state`, normalizes records, derives active tasks/feed. |
| Worker tree builder | Builds communication graph from replay events and worker roster. |
| Task/feed classifiers | Classifies active vs failed-terminal tasks and feed event kind. |
| Formatting helpers | `formatIsoTime`, `renderShortId`, `renderTaskOwner`, `renderTaskRole`. |

## Git Isolation Hardening

File: `mcp/runtime/git-manager.ts`.

`cleanupInactiveTeam` flow:

1. Team `paused` -> skip cleanup/integration (`reason: paused`).
2. Inactive team with open tasks -> skip integration (`reason: open_tasks`).
3. Inactive team with any non-git assignment (`git_managed !== true`) -> release assignments/worktrees without integration (`reason: non_git_assignments`), log `git_auto_integration_skipped_non_git_assignments`.
4. Inactive team with git-managed assignments and no open tasks -> integrate assignment branches into current target branch, then release assignments/worktrees (`reason: completed` or `cleanup_failed`).

Auto-integration behavior:

- Target branch is resolved from current `HEAD` symbolic ref.
- Merge sequence is ordered by worker slot.
- Each branch is merged with `git merge --no-ff --no-edit`.
- Merge failure triggers `git merge --abort` and aborts cleanup integration path.

P1 fix:

- Non-git-managed assignments are explicitly released in git-enabled runtimes instead of returning early and stranding metadata/worktrees.

P2 fix:

- `mcp/store/sqlite-store.ts` adds `replayEventsTail(teamId, limit)` with bounded tail query:
  - inner: `ORDER BY id DESC LIMIT ?`
  - outer: `ORDER BY id ASC`
- `buildTeamUiState` consumes `replayEventsTail` with bounded replay window instead of loading full history and slicing.

## Schema & Contract Changes

New tool JSON schemas:

| File | Change |
| --- | --- |
| `mcp/schemas/tools/team_staff_plan.schema.json` | Adds `team_staff_plan` input contract with bounded thread fields and optional objective/team context. |
| `mcp/schemas/tools/team_ui_state.schema.json` | Adds `team_ui_state` input contract with bounded event/evidence/failure limits. |

Contracts:

| File | Change |
| --- | --- |
| `mcp/schemas/contracts.ts` | Adds tool input contracts for `team_staff_plan` and `team_ui_state`; adds `team_trigger` input/output contract entries; extends `TaskStatusContract` with `failed_terminal`. |

## Test Coverage

| Test file | Coverage |
| --- | --- |
| `tests/unit/v3-109.staffing-planner.test.ts` | Staffing planner role readiness, dedupe behavior, capacity bounds, specialist handle readability, bounded expansion. |
| `tests/integration/v3-109.staffing.integration.test.ts` | Trigger-to-staffing integration and deterministic specialist auto-spawn ordering. |
| `tests/unit/v3-110.team-ui-state.test.ts` | Snapshot coherence, repeated replay stability, bounded recent/evidence/failure surfacing, spawn controls with offline worker edge case. |
| `tests/integration/v3-110.ui-state.integration.test.ts` | UI-state tool coherence across queue/failure/status and pause/resume transitions. |
| `tests/unit/v3-111.team-card.test.ts` | Deterministic markdown rendering across launch/progress/timeout/complete modes. |
| `tests/integration/v3-111.tui.integration.test.ts` | Deterministic TUI command path and status output. |
| `tests/unit/v3-112.parallel-gate.test.ts` | Gate pass/fail behavior for low parallelism, sequential overload, clear parallel prompts, strict-gate disable path. |
| `tests/unit/v3-005.git-isolation.test.ts` | Expanded git isolation coverage, including regression test for inactive non-git-managed assignment cleanup in git-enabled runtime. |

## Known Limitations

1. Staffing planner uses deterministic keyword matching rather than ML-based intent/domain classification.
2. Hybrid UX flow is tightly coupled to Codex/Claude Code runtime behaviors and tool contracts.
3. `mcp/store/sqlite-store.ts` remains a large monolith (2,500+ lines) and is marked for future modular split.

## Release Runbook: Flags, Migrations, Fallback, Rollback

### Feature Flags / Runtime Controls

| Surface | Setting | Effect |
| --- | --- | --- |
| Runtime mode | `runtimeMode=managed_runtime` or `managedRuntime.enabled=true` | Enables managed worker adapter lifecycle. |
| Transport selection | `managedRuntime.transportMode` or env `ATX_MANAGED_RUNTIME_TRANSPORT` / `CODEX_MANAGED_RUNTIME_TRANSPORT` | Select `auto`, `headless`, or `tmux`. |
| DAG wave dispatch | `scheduler.wave_dispatch.enabled` | Enables wave-depth dispatch mode instead of fair queue-only behavior. |
| DAG perf guard | `scheduler.wave_dispatch.perf_guard.*` | Threshold-based telemetry/guardrail events for DAG recomputation cost. |

### Migration Steps (runtime + observability)

1. Ensure the following migrations exist and are included in release artifacts:
   - `mcp/store/migrations/009_worker_runtime_sessions.sql`
   - `mcp/store/migrations/010_team_wave_state.sql`
   - `mcp/store/migrations/011_agent_decision_reports.sql`
2. Start the server once against the target DB path to apply pending migrations.
3. Validate migration regression gates:
   - `npm run test:unit:ts -- tests/unit/v4-002.worker-session-persistence.test.ts tests/unit/v4-004.wave-telemetry.test.ts tests/unit/v4-009.decision-reports.test.ts`

### Fallback Behavior

1. Transport `auto` deterministically falls back to `headless` in CI and non-TTY environments.
2. Explicit `tmux` mode falls back to `headless` when tmux is unavailable.
3. Unsupported runtime backend requests fail closed at spawn with actionable error (`BACKEND_COMMAND_UNSUPPORTED`) and supported-backend hints.
4. Recovery cleanup removes stale/orphan worker runtime sessions during `team_orphan_recover` to prevent stale-dispatch loops after restart.

### Rollback Procedure

1. Set runtime back to host-orchestrated mode (`runtimeMode=host_orchestrated_default`) and restart services.
2. Disable wave dispatch (`scheduler.wave_dispatch.enabled=false`) if queue fairness regressions are suspected.
3. Pin managed runtime transport to `headless` if tmux-specific behavior is implicated (`managedRuntime.transportMode=headless`).
4. Re-run deterministic surface gates to verify output contracts remain stable:
   - `npm run test:unit:ts -- tests/unit/v3-111.team-card.test.ts`
   - `npm run test:integration:ts -- tests/integration/v3-111.tui.integration.test.ts`
