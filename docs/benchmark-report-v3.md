# Benchmark Report v3

v3 release gating combines benchmark and resilience criteria.

## Inputs

- Benchmark report from `benchmarks/run-benchmark.ts`
- Optional chaos report with:
  - `failed_run_rate`
  - `mttr_ms`

## Gate Script

```bash
node --import tsx scripts/v3-eval-gates.ts \
  --report .tmp/v3-benchmark.json \
  --chaos-report .tmp/v3-chaos-report.json \
  --min-quality 0.95 \
  --max-quality-drop 0 \
  --min-token-reduction 1 \
  --max-failed-run-rate 0.1 \
  --max-mttr-ms 120000
```

## Required Dimensions

- Quality
- Cost (token reduction)
- Latency
- Reliability (failed-run-rate)
- Recovery (MTTR)
