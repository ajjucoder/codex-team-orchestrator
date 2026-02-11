# Git Orchestration

`scripts/pr-orchestrator.sh` validates ticket-level commit metadata and emits a deterministic integration queue.

## Manifest Contract

Each manifest entry must include:

- `ticket_id` (format `CTO-Px-###`)
- `branch` or `pushed_branch`
- `commit_sha`
- `risk_tier` (`P0|P1|P2`)
- `test_evidence`
- Optional `commit_message` (if present, must start with `<ticket_id>:`)

## Deterministic Queue Policy

- Sort by risk tier (`P0 -> P1 -> P2`), then lexical `ticket_id`.
- Emit queue order and per-item metadata for traceability.
- Default mode is dry-run.

## Usage

```bash
./scripts/pr-orchestrator.sh --manifest .tmp/pr-manifest.json --dry-run
```
