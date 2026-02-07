#!/usr/bin/env node

import { runBenchmark } from './harness.js';

interface RunBenchmarkArgs {
  baseline?: string;
  candidate?: string;
  evalSetPath?: string;
  outputPath?: string;
  mode?: string;
}

interface BenchmarkSummary {
  median_tokens: number;
  median_quality: number;
  median_time_ms: number;
}

interface BenchmarkReport {
  baseline: string;
  candidate: string;
  benchmark_mode: string;
  baseline_summary: BenchmarkSummary;
  candidate_summary: BenchmarkSummary;
  deltas: {
    median_tokens: number;
    median_quality: number;
    median_time_ms: number;
  };
  pass: boolean;
}

interface BenchmarkRunResult {
  report: BenchmarkReport;
  output_path: string;
}

function parseArgs(argv: string[]): RunBenchmarkArgs {
  const out: RunBenchmarkArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') out.baseline = argv[i + 1];
    if (arg === '--candidate') out.candidate = argv[i + 1];
    if (arg === '--eval-set') out.evalSetPath = argv[i + 1];
    if (arg === '--out') out.outputPath = argv[i + 1];
    if (arg === '--mode') out.mode = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const benchmarkArgs = args as unknown as Parameters<typeof runBenchmark>[0];
const { report, output_path } = runBenchmark(benchmarkArgs) as BenchmarkRunResult;

console.log(`benchmark:baseline=${report.baseline}`);
console.log(`benchmark:candidate=${report.candidate}`);
console.log(`benchmark:mode=${report.benchmark_mode}`);
console.log(`benchmark:median_tokens_baseline=${report.baseline_summary.median_tokens}`);
console.log(`benchmark:median_tokens_candidate=${report.candidate_summary.median_tokens}`);
console.log(`benchmark:median_quality_baseline=${report.baseline_summary.median_quality}`);
console.log(`benchmark:median_quality_candidate=${report.candidate_summary.median_quality}`);
console.log(`benchmark:delta_tokens=${report.deltas.median_tokens}`);
console.log(`benchmark:delta_quality=${report.deltas.median_quality}`);
console.log(`benchmark:delta_time_ms=${report.deltas.median_time_ms}`);
console.log(`benchmark:pass=${report.pass}`);
console.log(`benchmark:report=${output_path}`);

if (!report.pass) {
  process.exit(1);
}
