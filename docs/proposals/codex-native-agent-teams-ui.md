# Proposal: Codex-Native Agent-Teams UI (Hybrid MVP)

## Objective

Ship a codex-native Hybrid Agent-Teams UI that keeps orchestration deterministic while exposing planner specialization, queue health, and operator controls.

## Motivation

- Current capabilities exist in tools and logs but need a stable UX contract.
- Operators need compact cards and strict control semantics for automation.
- Verification must prove stable behavior without timing-dependent tests.

## Proposed UX Layers

1. Planner Layer
- Present trigger specialization outcomes (`spawn_strategy`, `planned_roles`, `spawned_agents`).
- Highlight backlog-driven role shaping from ready tasks.

2. State Layer
- Use `team_ui_state` as the canonical state model.
- Keep `team_status`, `team_run_summary`, and `team_replay` as compatibility/readiness surfaces.
  - Compute queue and failure indicators deterministically.

3. Control Layer
- Keep current control verbs (`pause`, `resume`, `drain`, `retry`).
- Emit stable command acknowledgements and counters.

## Wire Contract (MVP)

- Card lines remain line-oriented (`team-tui:*` / markdown sections) for scriptability.
- Evidence links use `replay://<team_id>/event/<id>`.
- Hard cap and staffing constraints remain unchanged (`max_threads <= 6`).
- Plan previews are served by `team_staff_plan` with support for `team_id` or direct `prompt/objective`.

## Verification Plan

- Unit coverage:
  - `tests/unit/v3-109.staffing-planner.test.ts`
  - `tests/unit/v3-110.team-ui-state.test.ts`
  - `tests/unit/v3-111.team-card.test.ts`
- Integration coverage:
  - `tests/integration/v3-109.staffing.integration.test.ts`
  - `tests/integration/v3-110.ui-state.integration.test.ts`
  - `tests/integration/v3-111.tui.integration.test.ts`

## Risks and Mitigations

- Risk: card format drift breaks automation.
  - Mitigation: treat card templates as protocol; assert exact markers in tests.
- Risk: state mismatch across tool surfaces.
  - Mitigation: explicit coherence assertions in UI-state tests.
- Risk: flaky timing in TUI loops.
  - Mitigation: one-shot command and snapshot tests only.

## Out of Scope

- New GUI rendering layer.
- New persistence schema.
- Any increase beyond six concurrent workers.
