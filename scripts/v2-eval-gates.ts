#!/usr/bin/env node

import { readFileSync } from 'node:fs';

interface Args {
  reportPath: string;
  minQuality: number;
  maxQualityDrop: number;
  minTokenReduction: number;
}

interface BenchmarkSummary {
  median_tokens: number;
  median_quality: number;
}

interface BenchmarkReport {
  pass: boolean;
  baseline_summary: BenchmarkSummary;
  candidate_summary: BenchmarkSummary;
  deltas: {
    median_tokens: number;
    median_quality: number;
  };
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    reportPath: '',
    minQuality: 0.95,
    maxQualityDrop: 0,
    minTokenReduction: 1
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') {
      out.reportPath = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--min-quality') {
      out.minQuality = Number(argv[i + 1] ?? out.minQuality);
      i += 1;
      continue;
    }
    if (arg === '--max-quality-drop') {
      out.maxQualityDrop = Number(argv[i + 1] ?? out.maxQualityDrop);
      i += 1;
      continue;
    }
    if (arg === '--min-token-reduction') {
      out.minTokenReduction = Number(argv[i + 1] ?? out.minTokenReduction);
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.reportPath) {
    throw new Error('--report is required');
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(args.reportPath, 'utf8')) as BenchmarkReport;
  const qualityDrop = report.baseline_summary.median_quality - report.candidate_summary.median_quality;
  const tokenReduction = report.baseline_summary.median_tokens - report.candidate_summary.median_tokens;
  const checks = {
    benchmark_pass: report.pass === true,
    min_quality: report.candidate_summary.median_quality >= args.minQuality,
    max_quality_drop: qualityDrop <= args.maxQualityDrop,
    min_token_reduction: tokenReduction >= args.minTokenReduction
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(`v2-eval-gates:report=${args.reportPath}`);
  console.log(`v2-eval-gates:benchmark_pass=${checks.benchmark_pass}`);
  console.log(`v2-eval-gates:candidate_quality=${report.candidate_summary.median_quality}`);
  console.log(`v2-eval-gates:baseline_quality=${report.baseline_summary.median_quality}`);
  console.log(`v2-eval-gates:quality_drop=${qualityDrop}`);
  console.log(`v2-eval-gates:token_reduction=${tokenReduction}`);
  console.log(`v2-eval-gates:min_quality_check=${checks.min_quality}`);
  console.log(`v2-eval-gates:max_quality_drop_check=${checks.max_quality_drop}`);
  console.log(`v2-eval-gates:min_token_reduction_check=${checks.min_token_reduction}`);
  console.log(`v2-eval-gates:pass=${ok}`);

  if (!ok) {
    process.exit(1);
  }
}

main();
