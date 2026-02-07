import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { PolicyEngine } from '../mcp/server/policy-engine.js';
import { recommendFanout } from '../mcp/server/fanout-controller.js';
import { createServer } from '../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../mcp/server/tools/task-board.js';
import { registerFanoutTools } from '../mcp/server/tools/fanout.js';
import { registerObservabilityTools } from '../mcp/server/tools/observability.js';
import type { ToolResult, ToolServerLike } from '../mcp/server/tools/types.js';
import type { UsageSample } from '../mcp/store/entities.js';

type BenchmarkMode = 'synthetic' | 'replay';
type RunMode = 'fixed-6' | 'adaptive';
type TaskSize = 'small' | 'medium' | 'high';

interface EvalCase {
  id: string;
  task_size: TaskSize;
  estimated_parallel_tasks: number;
  budget_tokens_remaining: number;
  token_cost_per_agent: number;
  base_tokens: number;
  agent_token_overhead: number;
  required_threads: number;
  base_time_ms: number;
  profile?: string;
  kickoff_chars?: number;
  task_count?: number;
  layer_width?: number;
  update_chars?: number;
}

interface EvalSet {
  name: string;
  quality_threshold?: number;
  cases: EvalCase[];
}

interface BenchmarkRow {
  case_id: string;
  mode: RunMode;
  threads: number;
  tokens: number;
  quality: number;
  time_ms: number;
  benchmark_mode: BenchmarkMode;
}

interface BenchmarkSummary {
  median_tokens: number;
  median_quality: number;
  median_time_ms: number;
}

interface BenchmarkReport {
  generated_at: string;
  benchmark_mode: BenchmarkMode;
  eval_set: string;
  baseline: RunMode;
  candidate: RunMode;
  baseline_summary: BenchmarkSummary;
  candidate_summary: BenchmarkSummary;
  deltas: {
    median_tokens: number;
    median_quality: number;
    median_time_ms: number;
  };
  pass: boolean;
  cases: BenchmarkRow[];
}

interface BenchmarkStoreLike {
  listUsageSamples(teamId: string, limit?: number): UsageSample[];
  close(): void;
}

interface RunBenchmarkInput {
  evalSetPath?: string;
  baseline?: RunMode;
  candidate?: RunMode;
  mode?: BenchmarkMode;
  outputPath?: string | null;
}

interface RunBenchmarkOutput {
  report: BenchmarkReport;
  output_path: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requireOk(result: ToolResult, message: string): Record<string, unknown> {
  if (result.ok !== true) {
    throw new Error(message);
  }
  return asRecord(result) ?? {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function computeQuality(threads: number, requiredThreads: number): number {
  if (threads >= requiredThreads) return 1;
  return Number((threads / requiredThreads).toFixed(4));
}

function computeTokens(baseTokens: number, overheadPerAgent: number, threads: number): number {
  return baseTokens + overheadPerAgent * threads;
}

function computeTimeMs(baseTimeMs: number, threads: number): number {
  const parallelSpeedup = Math.max(1, Math.round(24000 / threads));
  return baseTimeMs + parallelSpeedup;
}

function runSyntheticCaseForMode(testCase: EvalCase, mode: RunMode, policyEngine: PolicyEngine): BenchmarkRow {
  const teamMaxThreads = 6;
  let threads: number;

  if (mode === 'fixed-6') {
    threads = 6;
  } else {
    const policy = policyEngine.loadProfile(testCase.profile ?? 'default');
    threads = recommendFanout({
      policy,
      task_size: testCase.task_size,
      estimated_parallel_tasks: testCase.estimated_parallel_tasks,
      budget_tokens_remaining: testCase.budget_tokens_remaining,
      token_cost_per_agent: testCase.token_cost_per_agent,
      team_max_threads: teamMaxThreads
    }).recommended_threads;
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
    time_ms,
    benchmark_mode: 'synthetic'
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultTaskCount(taskSize: TaskSize): number {
  if (taskSize === 'small') return 4;
  if (taskSize === 'medium') return 8;
  return 12;
}

function resolveThreadsForMode({
  mode,
  testCase,
  toolServer,
  teamId
}: {
  mode: RunMode;
  testCase: EvalCase;
  toolServer: ToolServerLike;
  teamId: string;
}): number {
  if (mode === 'fixed-6') return 6;
  const plan = toolServer.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: testCase.task_size,
    estimated_parallel_tasks: testCase.estimated_parallel_tasks,
    budget_tokens_remaining: testCase.budget_tokens_remaining,
    token_cost_per_agent: testCase.token_cost_per_agent
  });
  const parsed = requireOk(plan, `replay benchmark fanout failed for ${testCase.id}`);
  const recommendation = asRecord(parsed.recommendation) ?? {};
  return Number(recommendation.recommended_threads);
}

function cleanupBenchmarkArtifacts(dbPath: string, logPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function runReplayCaseForMode(testCase: EvalCase, mode: RunMode, runId: number): BenchmarkRow {
  const dbPath = `.tmp/benchmark-${runId}-${testCase.id}-${mode}.sqlite`;
  const logPath = `.tmp/benchmark-${runId}-${testCase.id}-${mode}.log`;
  cleanupBenchmarkArtifacts(dbPath, logPath);

  const server = createServer({ dbPath, logPath });
  server.start();
  const toolServer = server as unknown as ToolServerLike;
  registerTeamLifecycleTools(toolServer);
  registerAgentLifecycleTools(toolServer);
  registerTaskBoardTools(toolServer);
  registerFanoutTools(toolServer);
  registerObservabilityTools(toolServer);

  const teamStart = toolServer.callTool('team_start', {
    objective: `benchmark-replay-${testCase.id}`,
    profile: testCase.profile ?? 'default',
    max_threads: 6
  }, {
    active_session_model: 'benchmark-model'
  });
  const teamResult = requireOk(teamStart, `replay benchmark team_start failed for ${testCase.id}`);
  const team = asRecord(teamResult.team) ?? {};
  const teamId = readString(team, 'team_id');
  const threads = clamp(resolveThreadsForMode({ mode, testCase, toolServer, teamId }), 1, 6);

  const leadSpawn = toolServer.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const leadResult = requireOk(leadSpawn, `replay benchmark lead spawn failed for ${testCase.id}`);
  const lead = asRecord(leadResult.agent) ?? {};
  const leadAgentId = readString(lead, 'agent_id');

  const workerCount = clamp(threads - 1, 1, 5);
  const workers: Array<Record<string, unknown>> = [];
  const workerRoles = ['implementer', 'reviewer', 'tester', 'researcher', 'planner'];
  for (let i = 0; i < workerCount; i += 1) {
    const spawn = toolServer.callTool('team_spawn', {
      team_id: teamId,
      role: workerRoles[i % workerRoles.length]
    });
    const spawnResult = requireOk(spawn, `replay benchmark worker spawn failed for ${testCase.id}`);
    workers.push(asRecord(spawnResult.agent) ?? {});
  }

  const kickoffChars = Number(testCase.kickoff_chars ?? 480);
  for (const worker of workers) {
    const workerAgentId = readString(worker, 'agent_id');
    toolServer.callTool('team_send', {
      team_id: teamId,
      from_agent_id: leadAgentId,
      to_agent_id: workerAgentId,
      summary: `kickoff-${testCase.id}-${'k'.repeat(kickoffChars)}`,
      artifact_refs: [],
      idempotency_key: `bench-kickoff-${testCase.id}-${workerAgentId}-${nowIso()}`
    });
  }

  const taskCount = Number(testCase.task_count ?? defaultTaskCount(testCase.task_size));
  const layerWidth = clamp(
    Number(testCase.layer_width ?? Math.max(1, Math.min(testCase.estimated_parallel_tasks, 4))),
    1,
    4
  );
  const tasks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < taskCount; i += 1) {
    const dependencyIndex = i - layerWidth;
    const dependsOnTaskId = dependencyIndex >= 0 ? readString(tasks[dependencyIndex], 'task_id') : '';
    const dependsOn = dependsOnTaskId ? [dependsOnTaskId] : [];
    const created = toolServer.callTool('team_task_create', {
      team_id: teamId,
      title: `case-${testCase.id}-task-${i}`,
      priority: ((i % 5) + 1),
      depends_on_task_ids: dependsOn
    });
    const createdResult = requireOk(created, `replay benchmark task_create failed for ${testCase.id}`);
    tasks.push(asRecord(createdResult.task) ?? {});
  }

  let completed = 0;
  let iteration = 0;
  const maxIterations = taskCount * 6;
  let workerIdx = 0;
  const updateChars = Number(testCase.update_chars ?? 300);

  while (iteration < maxIterations) {
    iteration += 1;
    const next = toolServer.callTool('team_task_next', { team_id: teamId, limit: workerCount });
    const nextResult = requireOk(next, `replay benchmark task_next failed for ${testCase.id}`);
    const nextTasks = Array.isArray(nextResult.tasks)
      ? nextResult.tasks.filter(asRecord)
      : [];
    if (!nextTasks.length) break;

    for (const task of nextTasks) {
      const worker = workers[workerIdx % workers.length];
      workerIdx += 1;
      const workerAgentId = readString(worker, 'agent_id');
      const claim = toolServer.callTool('team_task_claim', {
        team_id: teamId,
        task_id: readString(task, 'task_id'),
        agent_id: workerAgentId,
        expected_lock_version: readNumber(task, 'lock_version', 0)
      });
      if (claim.ok !== true) continue;
      const claimRecord = asRecord(claim) ?? {};
      const claimTask = asRecord(claimRecord.task) ?? {};

      toolServer.callTool('team_send', {
        team_id: teamId,
        from_agent_id: workerAgentId,
        to_agent_id: leadAgentId,
        summary: `update-${readString(task, 'task_id')}-${'u'.repeat(updateChars)}`,
        artifact_refs: [{
          artifact_id: `artifact_${testCase.id}_${readString(task, 'task_id')}`,
          version: 1
        }],
        idempotency_key: `bench-update-${readString(task, 'task_id')}-${nowIso()}`
      });

      const done = toolServer.callTool('team_task_update', {
        team_id: teamId,
        task_id: readString(task, 'task_id'),
        status: 'done',
        expected_lock_version: readNumber(claimTask, 'lock_version', 0)
      });
      if (done.ok === true) {
        completed += 1;
      }
    }
  }

  const summary = toolServer.callTool('team_run_summary', { team_id: teamId });
  requireOk(summary, `replay benchmark summary failed for ${testCase.id}`);

  const store = server.store as unknown as BenchmarkStoreLike;
  const usageSamples = store.listUsageSamples(teamId, 5000);
  const tokens = usageSamples.reduce((sum, sample) => sum + sample.estimated_tokens, 0);
  const time_ms = usageSamples.reduce((sum, sample) => sum + sample.latency_ms, 0);
  const quality = Number((completed / taskCount).toFixed(4));

  store.close();
  cleanupBenchmarkArtifacts(dbPath, logPath);

  return {
    case_id: testCase.id,
    mode,
    threads,
    tokens,
    quality,
    time_ms,
    benchmark_mode: 'replay'
  };
}

function aggregate(mode: RunMode, rows: BenchmarkRow[]): BenchmarkSummary {
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
  mode = 'synthetic',
  outputPath = null
}: RunBenchmarkInput = {}): RunBenchmarkOutput {
  const policyEngine = new PolicyEngine('profiles');
  const evalSet = JSON.parse(readFileSync(evalSetPath, 'utf8')) as EvalSet;
  const benchmarkMode: BenchmarkMode = mode === 'replay' ? 'replay' : 'synthetic';

  const rows: BenchmarkRow[] = [];
  const runId = Date.now();
  for (const testCase of evalSet.cases) {
    if (benchmarkMode === 'replay') {
      rows.push(runReplayCaseForMode(testCase, baseline, runId));
      rows.push(runReplayCaseForMode(testCase, candidate, runId));
    } else {
      rows.push(runSyntheticCaseForMode(testCase, baseline, policyEngine));
      rows.push(runSyntheticCaseForMode(testCase, candidate, policyEngine));
    }
  }

  const baselineSummary = aggregate(baseline, rows);
  const candidateSummary = aggregate(candidate, rows);

  const tokenDelta = Number((candidateSummary.median_tokens - baselineSummary.median_tokens).toFixed(2));
  const qualityDelta = Number((candidateSummary.median_quality - baselineSummary.median_quality).toFixed(4));
  const timeDeltaMs = Number((candidateSummary.median_time_ms - baselineSummary.median_time_ms).toFixed(2));

  const pass = candidateSummary.median_tokens < baselineSummary.median_tokens &&
    candidateSummary.median_quality >= baselineSummary.median_quality &&
    candidateSummary.median_quality >= (evalSet.quality_threshold ?? 0.95);

  const report: BenchmarkReport = {
    generated_at: new Date().toISOString(),
    benchmark_mode: benchmarkMode,
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
