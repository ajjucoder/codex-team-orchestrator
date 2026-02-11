# Replay Forensics

`scripts/replay-audit.ts` reconstructs an ordered timeline for a team and computes a deterministic digest.

## What It Produces

- Chronological timeline with stable ordering.
- Replay digest (`sha256`) over canonicalized timeline data.
- JSON artifact containing:
  - `team_id`
  - `event_count`
  - `digest`
  - `timeline`

## Usage

```bash
node --import tsx scripts/replay-audit.ts --db .tmp/team.sqlite --team team_abc --out .tmp/replay-audit.json
```
