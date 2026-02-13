# Operator Console

`scripts/team-tui.ts` provides the primary deterministic sidecar TUI for Hybrid Agent-Teams operations.
`scripts/team-tmux-ui.ts` provides the live tmux-oriented sidecar view as a separate command path.
`scripts/team-card.ts` provides chat-embedded markdown cards (`launch|progress|timeout|complete`) for Codex App/CLI message streams.
`scripts/team-console.ts` remains supported for backward compatibility.

## Snapshot Cards

The sidecar TUI emits stable snapshot lines for operator parsing:

- Team card: `team-tui team=<team_id> status=<status>`
- Worker card: `workers total=<n> idle=<n> busy=<n> offline=<n> util=<pct>%`
- Queue card: `tasks running=<n> todo=<n> blocked=<n> done=<n> failed=<n> cancelled=<n> total=<n>`
- Queue-depth card: `queue depth=<n> ready=<n> in_progress=<n> blocked=<n> pending_inbox=<n>`
- Process marker: `team-tui:ok`

These lines are intentionally compact and should be treated as the wire contract for TUI integration tests.

## Control Path

- `pause`: maps to `team_finalize` with `reason=operator_pause`.
- `resume`: maps to `team_resume`.
- `drain`: cancels all `todo` and `blocked` tasks.
- `retry`: moves blocked tasks (optionally scoped by `--task`) back to `todo`.

Command responses always emit `team-tui:command=<name>` and command-specific counters when applicable:

- `drain`: `team-tui:drained=<count>`
- `retry`: `team-tui:retried=<count>`

`team-tmux-ui` supports the same operator command flags in one-shot mode and emits:

- `team-tmux-ui:command=<name>`
- `team-tmux-ui:error=<message>` on command failure
- `team-tmux-ui:ok` success marker

## Runbook

1. Verify current state with one snapshot.
2. If run should pause immediately, execute `pause`.
3. If backlog must stop growing, execute `drain`.
4. If a specific blocked task is ready to retry, execute `retry --task <task_id>`.
5. Resume execution with `resume`.
6. Re-run snapshot and confirm queue/failure cards match expected post-command state.

## Usage

```bash
node --import tsx scripts/team-tui.ts --db .tmp/team.sqlite --team team_abc --once --no-input
node --import tsx scripts/team-tui.ts --db .tmp/team.sqlite --team team_abc --command pause --once --no-input
node --import tsx scripts/team-tui.ts --db .tmp/team.sqlite --team team_abc --command resume --once --no-input
node --import tsx scripts/team-tui.ts --db .tmp/team.sqlite --team team_abc --command drain --once --no-input
node --import tsx scripts/team-tui.ts --db .tmp/team.sqlite --team team_abc --command retry --task task_123 --once --no-input
node --import tsx scripts/team-tmux-ui.ts --db .tmp/team.sqlite --team team_abc --once --show-wave
node --import tsx scripts/team-tmux-ui.ts --db .tmp/team.sqlite --team team_abc --command pause --once
node --import tsx scripts/team-card.ts --db .tmp/team.sqlite --team team_abc --mode progress
```

## Verification

For MVP UI/TUI checks, run:

```bash
node --import tsx --test tests/unit/v3-111.team-card.test.ts
node --import tsx --test tests/integration/v3-111.tui.integration.test.ts
node --import tsx --test tests/integration/v4-011.team-tmux-ui.integration.test.ts
```
