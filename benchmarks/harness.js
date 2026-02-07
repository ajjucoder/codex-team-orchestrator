import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PolicyEngine } from '../mcp/server/policy-engine.js';
import { recommendFanout } from '../mcp/server/fanout-controller.js';

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function computeQuality(threads, requiredThreads) {
  if (threads >= requiredThreads) return 1;
  return Number((threads / requiredThreads).toFixed(4));
}

function computeTokens(baseTokens, overheadPerAgent, threads) {
  return baseTokens + overheadPerAgent * threads;
}

function computeTimeMs(baseTimeMs, threads) {
  const parallelSpeedup = Math.max(1, Math.round(24000 / threads));
  return baseTimeMs + parallelSpeedup;
}

function runCaseForMode(testCase, mode, policyEngine) {
  const teamMaxThreads = 6;
  let threads;

  if (mode === 'fixed-6') {
    threads = 6;
  } else if (mode === 'adaptive') {
    const policy = policyEngine.loadProfile(testCase.profile ?? 'default');
    threads = recommendFanout({
      policy,
      task_size: testCase.task_size,
      estimated_parallel_tasks: testCase.estimated_parallel_tasks,
      budget_tokens_remaining: testCase.budget_tokens_remaining,
      token_cost_per_agent: testCase.token_cost_per_agent,
      team_max_threads: teamMaxThreads
    }).recommended_threads;
  } else {
    throw new Error(`unsupported benchmark mode: ${mode}`);
  }

  threads = Math.min(threads, 6);

  const tokens = computeTokens(testCase.base_tokens, testCase.agent_token_overhead, threads);
  const quality = computeQuality(threads, testCase.required_threads);
  const time_ms = computeTimeMs(testCase.base_time_ms, threads);

  return {
    case_id: testCase.id,
    mode,
    threads,
    tokens,
    quality,
    time_ms
  };
}

function aggregate(mode, rows) {
  const only = rows.filter((row) => row.mode === mode);
  return {
    median_tokens: median(only.map((row) => row.tokens)),
    median_quality: median(only.map((row) => row.quality)),
    median_time_ms: median(only.map((row) => row.time_ms))
  };
}

export function runBenchmark({
  evalSetPath = 'benchmarks/eval-set.json',
  baseline = 'fixed-6',
  candidate = 'adaptive',
  outputPath = null
} = {}) {
  const policyEngine = new PolicyEngine('profiles');
  const evalSet = JSON.parse(readFileSync(evalSetPath, 'utf8'));

  const rows = [];
  for (const testCase of evalSet.cases) {
    rows.push(runCaseForMode(testCase, baseline, policyEngine));
    rows.push(runCaseForMode(testCase, candidate, policyEngine));
  }

  const baselineSummary = aggregate(baseline, rows);
  const candidateSummary = aggregate(candidate, rows);

  const tokenDelta = Number((candidateSummary.median_tokens - baselineSummary.median_tokens).toFixed(2));
  const qualityDelta = Number((candidateSummary.median_quality - baselineSummary.median_quality).toFixed(4));
  const timeDeltaMs = Number((candidateSummary.median_time_ms - baselineSummary.median_time_ms).toFixed(2));

  const pass = candidateSummary.median_tokens < baselineSummary.median_tokens &&
    candidateSummary.median_quality >= baselineSummary.median_quality &&
    candidateSummary.median_quality >= (evalSet.quality_threshold ?? 0.95);

  const report = {
    generated_at: new Date().toISOString(),
    eval_set: evalSet.name,
    baseline,
    candidate,
    baseline_summary: baselineSummary,
    candidate_summary: candidateSummary,
    deltas: {
      median_tokens: tokenDelta,
      median_quality: qualityDelta,
      median_time_ms: timeDeltaMs
    },
    pass,
    cases: rows
  };

  const out = outputPath ?? `benchmarks/output/report-${Date.now()}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    report,
    output_path: out
  };
}
