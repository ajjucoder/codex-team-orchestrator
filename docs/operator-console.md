# Operator Console

`scripts/team-console.ts` provides a lightweight live operator view for a team run.

## Features

- Live snapshot: workers, task queue depth, blockers, failures.
- Evidence links: emits `replay://<team_id>/event/<id>` for recent done-task updates.
- Control commands:
  - `pause` -> `team_finalize` with `operator_pause` reason.
  - `resume` -> `team_resume`.
  - `drain` -> cancels `todo` and `blocked` tasks.
  - `retry` -> moves blocked task(s) back to `todo`.

## Usage

```bash
node --import tsx scripts/team-console.ts --db .tmp/team.sqlite --team team_abc --once
node --import tsx scripts/team-console.ts --db .tmp/team.sqlite --team team_abc --command pause --once
node --import tsx scripts/team-console.ts --db .tmp/team.sqlite --team team_abc --command resume --once
node --import tsx scripts/team-console.ts --db .tmp/team.sqlite --team team_abc --command drain --once
node --import tsx scripts/team-console.ts --db .tmp/team.sqlite --team team_abc --command retry --task task_123 --once
```
