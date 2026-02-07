# Benchmark Harness

Runs fixed evaluation scenarios to compare:
- Baseline: `fixed-6`
- Candidate: `adaptive`
- Mode:
  - `replay` (default): executes real orchestrator flows and scores via usage telemetry
  - `synthetic`: legacy formula-based estimator

## Run

```bash
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
```

Use explicit mode/eval set:

```bash
./scripts/benchmark.sh --mode replay --eval-set benchmarks/replay-eval-set.json
```

## Pass Gate

Pass requires:
- Candidate median tokens < baseline median tokens
- Candidate median quality >= baseline median quality
- Candidate median quality >= eval-set threshold

Reports are written to `benchmarks/output/*.json`.
