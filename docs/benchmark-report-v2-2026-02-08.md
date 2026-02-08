# Benchmark Report (V2) - 2026-02-08

## Scope
This report validates the V2 objective: maintain high quality while reducing usage.

## Commands run
```bash
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive --out .tmp/v2-claude-advantage-report.json
node --import tsx ./scripts/v2-eval-gates.ts \
  --report .tmp/v2-claude-advantage-report.json \
  --min-quality 0.95 \
  --max-quality-drop 0 \
  --min-token-reduction 1
```

## Benchmark summary
Source: `.tmp/v2-claude-advantage-report.json`

- benchmark mode: `replay`
- eval set: `replay-eval-set-v1`
- baseline: `fixed-6`
- candidate: `adaptive`

### Median metrics
- baseline median tokens: `11515`
- candidate median tokens: `10192.5`
- token delta: `-1322.5` (candidate uses fewer tokens)
- baseline median quality: `1`
- candidate median quality: `1`
- quality delta: `0` (no degradation)

### Gate evaluation
- benchmark pass: `true`
- min quality check (`>= 0.95`): `true`
- max quality drop check (`<= 0`): `true`
- min token reduction check (`>= 1`): `true`
- overall gate pass: `true`

## Conclusion
The adaptive orchestration policy preserved quality (`1.0` median) and reduced median token usage by `1322.5` vs fixed-6 baseline, satisfying the V2 quality-vs-usage release gates.

## Caveat
This is an internal baseline-vs-candidate benchmark. It is strong evidence of better efficiency at equal quality inside this system, but it is not yet a direct external A/B against Claude Team mode.
