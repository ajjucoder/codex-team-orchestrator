import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { recommendFanout } from '../../mcp/server/fanout-controller.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';

const dbPath = '.tmp/at012-unit.sqlite';
const logPath = '.tmp/at012-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-012 fanout ranges map to small/medium/high constraints', () => {
  const policy = {
    fanout: {
      small_min: 1,
      small_max: 2,
      medium_min: 3,
      medium_max: 4,
      high_min: 5,
      high_max: 6
    }
  };

  const small = recommendFanout({
    policy,
    task_size: 'small',
    estimated_parallel_tasks: 2,
    budget_tokens_remaining: 10000,
    token_cost_per_agent: 1000,
    team_max_threads: 6
  });
  assert.equal(small.recommended_threads >= 1 && small.recommended_threads <= 2, true);

  const medium = recommendFanout({
    policy,
    task_size: 'medium',
    estimated_parallel_tasks: 4,
    budget_tokens_remaining: 10000,
    token_cost_per_agent: 1000,
    team_max_threads: 6
  });
  assert.equal(medium.recommended_threads >= 3 && medium.recommended_threads <= 4, true);

  const high = recommendFanout({
    policy,
    task_size: 'high',
    estimated_parallel_tasks: 8,
    budget_tokens_remaining: 20000,
    token_cost_per_agent: 1000,
    team_max_threads: 6
  });
  assert.equal(high.recommended_threads >= 5 && high.recommended_threads <= 6, true);
});

test('AT-012 fanout hard-caps at 6 regardless of inputs', () => {
  const result = recommendFanout({
    policy: { fanout: { high_min: 5, high_max: 6 } },
    task_size: 'high',
    estimated_parallel_tasks: 99,
    budget_tokens_remaining: 999999,
    token_cost_per_agent: 1,
    team_max_threads: 99
  });

  assert.equal(result.recommended_threads <= 6, true);
  assert.equal(result.hard_cap, 6);
});

test('AT-012 fanout allows lower-than-band recommendation under hard budget pressure', () => {
  const result = recommendFanout({
    policy: {
      fanout: {
        medium_min: 3,
        medium_max: 4
      }
    },
    task_size: 'medium',
    estimated_parallel_tasks: 4,
    budget_tokens_remaining: 1200,
    token_cost_per_agent: 1200,
    team_max_threads: 6
  });

  assert.equal(result.recommended_threads, 1);
  assert.match(result.reasons.join(' '), /budget constrained recommendation below size-profile minimum/);
});

test('AT-012 fanout tool uses team profile policy', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerFanoutTools(server);

  const team = server.callTool('team_start', {
    objective: 'fanout planning',
    profile: 'default'
  });

  const plan = server.callTool('team_plan_fanout', {
    team_id: team.team.team_id,
    task_size: 'medium',
    estimated_parallel_tasks: 10,
    budget_tokens_remaining: 20000,
    token_cost_per_agent: 2000
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.recommended_threads >= 3 && plan.recommendation.recommended_threads <= 4, true);
  assert.equal(plan.budget_controller.source, 'explicit_input');

  server.store.close();
});

test('AT-012 fanout tool derives token-cost estimate from telemetry when not provided', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);

  const team = server.callTool('team_start', {
    objective: 'fanout telemetry estimate',
    profile: 'default',
    max_threads: 4
  });
  const teamId = team.team.team_id;
  const sender = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const receiver = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const heavySummary = 'x'.repeat(1200);
  for (let i = 0; i < 10; i += 1) {
    server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: sender.agent.agent_id,
      to_agent_id: receiver.agent.agent_id,
      summary: `${heavySummary}-${i}`,
      artifact_refs: [],
      idempotency_key: `telemetry-${i}`
    });
  }

  const plan = server.callTool('team_plan_fanout', {
    team_id: teamId,
    task_size: 'medium',
    estimated_parallel_tasks: 4,
    budget_tokens_remaining: 5000
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.budget_controller.source, 'telemetry');
  assert.equal(plan.budget_controller.sample_count >= 8, true);
  assert.equal(plan.budget_controller.token_cost_per_agent > 0, true);

  server.store.close();
});
