#!/usr/bin/env node

import { readFileSync } from 'node:fs';

interface Args {
  reportPath: string;
  chaosPath: string | null;
  minQuality: number;
  maxQualityDrop: number;
  minTokenReduction: number;
  maxFailedRunRate: number;
  maxMttrMs: number;
}

interface BenchmarkSummary {
  median_tokens: number;
  median_quality: number;
}

interface BenchmarkReport {
  pass: boolean;
  baseline_summary: BenchmarkSummary;
  candidate_summary: BenchmarkSummary;
}

interface ChaosReport {
  failed_run_rate?: number;
  mttr_ms?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    reportPath: '',
    chaosPath: null,
    minQuality: 0.95,
    maxQualityDrop: 0,
    minTokenReduction: 1,
    maxFailedRunRate: 0.1,
    maxMttrMs: 120000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') {
      out.reportPath = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--chaos-report') {
      out.chaosPath = argv[i + 1] ?? null;
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
    if (arg === '--max-failed-run-rate') {
      out.maxFailedRunRate = Number(argv[i + 1] ?? out.maxFailedRunRate);
      i += 1;
      continue;
    }
    if (arg === '--max-mttr-ms') {
      out.maxMttrMs = Number(argv[i + 1] ?? out.maxMttrMs);
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.reportPath) throw new Error('--report is required');
  return out;
}

function readChaos(path: string | null): ChaosReport {
  if (!path) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ChaosReport;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(args.reportPath, 'utf8')) as BenchmarkReport;
  const chaos = readChaos(args.chaosPath);

  const qualityDrop = report.baseline_summary.median_quality - report.candidate_summary.median_quality;
  const tokenReduction = report.baseline_summary.median_tokens - report.candidate_summary.median_tokens;
  const failedRunRate = Number.isFinite(Number(chaos.failed_run_rate)) ? Number(chaos.failed_run_rate) : 0;
  const mttrMs = Number.isFinite(Number(chaos.mttr_ms)) ? Number(chaos.mttr_ms) : 0;

  const checks = {
    benchmark_pass: report.pass === true,
    min_quality: report.candidate_summary.median_quality >= args.minQuality,
    max_quality_drop: qualityDrop <= args.maxQualityDrop,
    min_token_reduction: tokenReduction >= args.minTokenReduction,
    max_failed_run_rate: failedRunRate <= args.maxFailedRunRate,
    max_mttr: mttrMs <= args.maxMttrMs
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(`v3-eval-gates:report=${args.reportPath}`);
  console.log(`v3-eval-gates:chaos_report=${args.chaosPath ?? 'none'}`);
  console.log(`v3-eval-gates:candidate_quality=${report.candidate_summary.median_quality}`);
  console.log(`v3-eval-gates:baseline_quality=${report.baseline_summary.median_quality}`);
  console.log(`v3-eval-gates:quality_drop=${qualityDrop}`);
  console.log(`v3-eval-gates:token_reduction=${tokenReduction}`);
  console.log(`v3-eval-gates:failed_run_rate=${failedRunRate}`);
  console.log(`v3-eval-gates:mttr_ms=${mttrMs}`);
  console.log(`v3-eval-gates:benchmark_pass=${checks.benchmark_pass}`);
  console.log(`v3-eval-gates:min_quality_check=${checks.min_quality}`);
  console.log(`v3-eval-gates:max_quality_drop_check=${checks.max_quality_drop}`);
  console.log(`v3-eval-gates:min_token_reduction_check=${checks.min_token_reduction}`);
  console.log(`v3-eval-gates:max_failed_run_rate_check=${checks.max_failed_run_rate}`);
  console.log(`v3-eval-gates:max_mttr_check=${checks.max_mttr}`);
  console.log(`v3-eval-gates:pass=${ok}`);
  if (!ok) {
    process.exit(1);
  }
}

main();
