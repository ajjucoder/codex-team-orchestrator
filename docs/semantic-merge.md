# Semantic Merge Assist

`mcp/server/semantic-merge.ts` ranks merge strategies with confidence and explicit rationale.

## Strategies

- `ours`: keep local branch resolution
- `theirs`: keep incoming branch resolution
- `combine`: merge non-overlapping semantic units
- `manual`: fallback when confidence is below threshold

## Safety Rule

If selected confidence is below `min_confidence`, result falls back to `manual` and requires reviewer intervention.
