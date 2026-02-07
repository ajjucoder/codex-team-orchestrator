# Benchmark Harness

Runs fixed evaluation scenarios to compare:
- Baseline: `fixed-6`
- Candidate: `adaptive`

## Run

```bash
./scripts/benchmark.sh --baseline fixed-6 --candidate adaptive
```

## Pass Gate

Pass requires:
- Candidate median tokens < baseline median tokens
- Candidate median quality >= baseline median quality
- Candidate median quality >= eval-set threshold

Reports are written to `benchmarks/output/*.json`.
