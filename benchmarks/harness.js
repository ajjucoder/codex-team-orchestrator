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

function runSyntheticCaseForMode(testCase, mode, policyEngine) {
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
    time_ms,
    benchmark_mode: 'synthetic'
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function defaultTaskCount(taskSize) {
  if (taskSize === 'small') return 4;
  if (taskSize === 'medium') return 8;
  return 12;
}

function resolveThreadsForMode({ mode, testCase, server, teamId }) {
  if (mode === 'fixed-6') return 6;
  if (mode === 'adaptive') {
    const plan = server.callTool('team_plan_fanout', {
      team_id: teamId,
      task_size: testCase.task_size,
      estimated_parallel_tasks: testCase.estimated_parallel_tasks,
      budget_tokens_remaining: testCase.budget_tokens_remaining,
      token_cost_per_agent: testCase.token_cost_per_agent
    });
    if (!plan.ok) {
      throw new Error(`replay benchmark fanout failed for ${testCase.id}`);
    }
    return Number(plan.recommendation.recommended_threads);
  }
  throw new Error(`unsupported benchmark mode: ${mode}`);
}

function cleanupBenchmarkArtifacts(dbPath, logPath) {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function runReplayCaseForMode(testCase, mode, runId) {
  const dbPath = `.tmp/benchmark-${runId}-${testCase.id}-${mode}.sqlite`;
  const logPath = `.tmp/benchmark-${runId}-${testCase.id}-${mode}.log`;
  cleanupBenchmarkArtifacts(dbPath, logPath);

  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);
  registerFanoutTools(server);
  registerObservabilityTools(server);

  const team = server.callTool('team_start', {
    objective: `benchmark-replay-${testCase.id}`,
    profile: testCase.profile ?? 'default',
    max_threads: 6
  }, {
    active_session_model: 'benchmark-model'
  });
  if (!team.ok) {
    throw new Error(`replay benchmark team_start failed for ${testCase.id}`);
  }

  const teamId = team.team.team_id;
  const threads = clamp(resolveThreadsForMode({ mode, testCase, server, teamId }), 1, 6);
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  if (!lead.ok) {
    throw new Error(`replay benchmark lead spawn failed for ${testCase.id}`);
  }

  const workerCount = clamp(threads - 1, 1, 5);
  const workers = [];
  const workerRoles = ['implementer', 'reviewer', 'tester', 'researcher', 'planner'];
  for (let i = 0; i < workerCount; i += 1) {
    const spawn = server.callTool('team_spawn', {
      team_id: teamId,
      role: workerRoles[i % workerRoles.length]
    });
    if (!spawn.ok) {
      throw new Error(`replay benchmark worker spawn failed for ${testCase.id}`);
    }
    workers.push(spawn.agent);
  }

  const kickoffChars = Number(testCase.kickoff_chars ?? 480);
  for (const worker of workers) {
    server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: lead.agent.agent_id,
      to_agent_id: worker.agent_id,
      summary: `kickoff-${testCase.id}-${'k'.repeat(kickoffChars)}`,
      artifact_refs: [],
      idempotency_key: `bench-kickoff-${testCase.id}-${worker.agent_id}-${nowIso()}`
    });
  }

  const taskCount = Number(testCase.task_count ?? defaultTaskCount(testCase.task_size));
  const layerWidth = clamp(
    Number(testCase.layer_width ?? Math.max(1, Math.min(testCase.estimated_parallel_tasks, 4))),
    1,
    4
  );
  const tasks = [];
  for (let i = 0; i < taskCount; i += 1) {
    const dependencyIndex = i - layerWidth;
    const dependsOn = dependencyIndex >= 0 ? [tasks[dependencyIndex].task_id] : [];
    const created = server.callTool('team_task_create', {
      team_id: teamId,
      title: `case-${testCase.id}-task-${i}`,
      priority: ((i % 5) + 1),
      depends_on_task_ids: dependsOn
    });
    if (!created.ok) {
      throw new Error(`replay benchmark task_create failed for ${testCase.id}`);
    }
    tasks.push(created.task);
  }

  let completed = 0;
  let iteration = 0;
  const maxIterations = taskCount * 6;
  let workerIdx = 0;
  const updateChars = Number(testCase.update_chars ?? 300);

  while (iteration < maxIterations) {
    iteration += 1;
    const next = server.callTool('team_task_next', { team_id: teamId, limit: workerCount });
    if (!next.ok) {
      throw new Error(`replay benchmark task_next failed for ${testCase.id}`);
    }
    if (!next.tasks.length) break;

    for (const task of next.tasks) {
      const worker = workers[workerIdx % workers.length];
      workerIdx += 1;
      const claim = server.callTool('team_task_claim', {
        team_id: teamId,
        task_id: task.task_id,
        agent_id: worker.agent_id,
        expected_lock_version: task.lock_version
      });
      if (!claim.ok) continue;

      server.callTool('team_send', {
        team_id: teamId,
        from_agent_id: worker.agent_id,
        to_agent_id: lead.agent.agent_id,
        summary: `update-${task.task_id}-${'u'.repeat(updateChars)}`,
        artifact_refs: [{
          artifact_id: `artifact_${testCase.id}_${task.task_id}`,
          version: 1
        }],
        idempotency_key: `bench-update-${task.task_id}-${nowIso()}`
      });

      const done = server.callTool('team_task_update', {
        team_id: teamId,
        task_id: task.task_id,
        status: 'done',
        expected_lock_version: claim.task.lock_version
      });
      if (done.ok) {
        completed += 1;
      }
    }
  }

  const summary = server.callTool('team_run_summary', { team_id: teamId });
  if (!summary.ok) {
    throw new Error(`replay benchmark summary failed for ${testCase.id}`);
  }

  const usageSamples = server.store.listUsageSamples(teamId, 5000);
  const tokens = usageSamples.reduce((sum, sample) => sum + sample.estimated_tokens, 0);
  const time_ms = usageSamples.reduce((sum, sample) => sum + sample.latency_ms, 0);
  const quality = Number((completed / taskCount).toFixed(4));

  server.store.close();
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
  mode = 'synthetic',
  outputPath = null
} = {}) {
  const policyEngine = new PolicyEngine('profiles');
  const evalSet = JSON.parse(readFileSync(evalSetPath, 'utf8'));
  const benchmarkMode = mode === 'replay' ? 'replay' : 'synthetic';

  const rows = [];
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

  const report = {
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
