# Codex Agent-Teams UI (Hybrid MVP)

This document defines the Hybrid Agent-Teams UX MVP contract used by tests and runbooks.

## Scope

- Staffing planner visibility for trigger-driven and DAG-ready role shaping.
- Operator UI-state coherence from existing tools.
- Console/TUI card templates and command control path.
- Runtime contract alignment with `host_orchestrated_default` and optional `managed_runtime`.

## Runtime Contract

- Default: `host_orchestrated_default` (host drives orchestration and tool flow).
- Optional: `managed_runtime` enabled only by explicit runtime configuration.
- No implicit runtime transport bootstrap in default mode.
- Deterministic UI/CLI contracts remain mandatory in both modes.

## Data Surfaces

UI state is now exposed directly via these tool outputs:

- `team_ui_state`: structured state (`team`, `workers`, `tasks`, `progress`, `blockers`, `recent_events`, `evidence_links`, `failure_highlights`, `controls`).
- `team_staff_plan`: specialization plan preview for a `team_id` or direct `prompt/objective`.
- `team_spawn_ready_roles` and `team_trigger`: runtime staffing/spawn decisions and role shaping.
- `team_status`/`team_run_summary`/`team_replay`: backward-compatible observability surfaces.

## Staffing Planner UX Contract (`team_staff_plan`)

- Show `spawn_strategy` (`static_sequence` or `dag_ready_roles`).
- Show `planned_roles` in order.
- Show `spawned_count`, `spawned_agents`, and `errors`.
- Keep role decisions bounded by `max_threads <= 6`.

## UI-State Contract (`team_ui_state`)

- Team status string must match between `team_status.team.status` and `team_run_summary.summary.status`.
- Queue depth must be computed as `todo + in_progress + blocked` from summary task metrics.
- Failure count must be derived from replay events where:
  - `event_type` contains `failed|error|blocked`, or
  - `payload.ok === false`.
- Replay digest should be stable for identical event sets.
- `team_ui_state` must remain available and parse-compatible regardless of runtime mode.

## Console Card Templates

Snapshot cards are line-oriented and must remain parseable:

- `console:team=<team_id>`
- `console:workers total=<n> idle=<n> busy=<n> offline=<n>`
- `console:tasks todo=<n> in_progress=<n> blocked=<n> done=<n> queue_depth=<n>`
- `console:failures count=<n>`
- `console:blockers=<task_ids|none>`
- `console:evidence task=<task_id> link=replay://<team_id>/event/<id>`
- `console:snapshot=ok`
- `console:ok`

## TUI Control Path Contract

- `pause` -> `team_finalize(reason=operator_pause)`
- `resume` -> `team_resume`
- `drain` -> cancels `todo|blocked` tasks
- `retry` -> blocked task(s) back to `todo`

Each command emits `console:command=<name>` and optional counters:

- `console:drained=<count>`
- `console:retried=<count>`

Runtime mode cannot change command semantics or marker formats.

## Determinism Rules

- Use one-shot snapshots (`--once`) in tests.
- Do not depend on watch-loop timing.
- Validate exact card markers and deterministic aggregates.
