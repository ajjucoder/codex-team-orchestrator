# ADR: Agent Runtime Contract

Date: 2026-02-12
Status: accepted
Owner: platform-architecture
Ticket: `ATX-P0-001`

## Context

The repository has host-orchestrated tool flows (`team_start`, `team_spawn`, `team_send`, scheduler ticks, UI state) and optional worker-adapter integration points. Prior docs mixed host-driven and managed-runtime language, which can cause rollout and compatibility risk.

## Decision

Use one canonical runtime contract:

1. Default mode: `host_orchestrated_default`
2. Optional mode: `managed_runtime` (explicitly enabled only)

## Runtime Ownership Boundaries

### Host-Orchestrated Default

- Host process owns orchestration flow and tool sequencing.
- Store (`SqliteStore`) is source of truth for durable state.
- Worker transport execution is optional and only active when a worker adapter is configured.
- `team-tui`, `team-card`, and `team_ui_state` remain deterministic one-shot compatible surfaces.

### Managed Runtime (Optional)

- Enabled only when runtime options explicitly request it.
- Runtime bootstraps worker transport/provider wiring and durable session recovery paths.
- Must preserve schema/tool backward compatibility with host-orchestrated mode.
- Must fail closed when transport/runtime prerequisites are invalid.

## Non-Goals

- No implicit default switch from host-orchestrated mode to managed runtime.
- No contract-breaking changes to existing deterministic CLI/UI outputs.

## Compatibility Rules

1. Existing call-sites without runtime transport config must behave exactly as before.
2. New runtime metadata fields must be additive.
3. Deterministic `v3-111` surfaces are release-gating compatibility checks.

## Operational Notes

- Any managed-runtime rollout must include:
  - explicit feature flag enablement,
  - migration verification,
  - deterministic contract checks (`team-tui` / `team-card` / `team_ui_state`).

