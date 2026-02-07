import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  hasAgentTeamsTrigger,
  extractObjectiveFromPrompt,
  inferTaskSizeFromPrompt,
  REQUIRED_TRIGGER_PHRASE
} from '../../mcp/server/trigger.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';
import { registerTriggerTools } from '../../mcp/server/tools/trigger.js';

const dbPath = '.tmp/at015-unit.sqlite';
const logPath = '.tmp/at015-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-015 trigger detection is case-insensitive and exact phrase-based', () => {
  assert.equal(hasAgentTeamsTrigger('Please USE AGENT TEAMS for this run'), true);
  assert.equal(hasAgentTeamsTrigger('use teams'), false);
  assert.equal(REQUIRED_TRIGGER_PHRASE, 'use agent teams');
});

test('AT-015 objective extraction removes trigger phrase', () => {
  const objective = extractObjectiveFromPrompt('use agent teams implement ticket AT-015');
  assert.equal(objective, 'implement ticket AT-015');
});

test('AT-015 infers task size from prompt complexity signals', () => {
  assert.equal(inferTaskSizeFromPrompt('use agent teams tiny fix'), 'small');
  assert.equal(inferTaskSizeFromPrompt('use agent teams implement feature and tests'), 'medium');
  assert.equal(inferTaskSizeFromPrompt('use agent teams refactor across modules with end-to-end migration'), 'high');
});

test('AT-015 trigger tool starts team automatically', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTriggerTools(server);

  const result = server.callTool('team_trigger', {
    prompt: 'use agent teams build release candidate',
    profile: 'fast',
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(result.ok, true);
  assert.equal(result.triggered, true);
  assert.match(result.team.team_id, /^team_/);
  assert.equal(result.team.session_model, 'gpt-5-codex');
  assert.equal(result.orchestration.auto_spawn_enabled, true);

  server.store.close();
});

test('AT-015 trigger auto-spawns specialists by complexity with cap at six', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);
  registerTriggerTools(server);

  const result = server.callTool('team_trigger', {
    prompt: 'use agent teams refactor multiple services with end-to-end migration and parallel validation',
    profile: 'deep',
    task_size: 'high',
    max_threads: 6,
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(result.ok, true);
  assert.equal(result.triggered, true);
  assert.equal(result.orchestration.task_size, 'high');
  assert.equal(result.orchestration.recommended_threads, 6);
  assert.equal(result.orchestration.spawned_count, 6);
  assert.equal(result.orchestration.errors.length, 0);
  assert.equal(result.orchestration.spawned_agents.every((agent) => agent.model === 'gpt-5-codex'), true);
  assert.ok(result.orchestration.budget_controller);
  assert.notEqual(result.orchestration.budget_controller.source, 'explicit_input');

  server.store.close();
});

test('AT-015 trigger uses telemetry budget estimator by default when token_cost_per_agent is omitted', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);
  registerTriggerTools(server);

  const seedTeam = server.callTool('team_start', {
    objective: 'seed telemetry for trigger',
    profile: 'default',
    max_threads: 4
  });
  const seedTeamId = seedTeam.team.team_id;
  const seedSender = server.callTool('team_spawn', { team_id: seedTeamId, role: 'implementer' });
  const seedReceiver = server.callTool('team_spawn', { team_id: seedTeamId, role: 'reviewer' });
  for (let i = 0; i < 10; i += 1) {
    server.callTool('team_send', {
      team_id: seedTeamId,
      from_agent_id: seedSender.agent.agent_id,
      to_agent_id: seedReceiver.agent.agent_id,
      summary: `trigger-telemetry-seed-${i}-${'x'.repeat(700)}`,
      artifact_refs: [],
      idempotency_key: `trigger-telemetry-seed-${i}`
    });
  }

  const triggered = server.callTool('team_trigger', {
    prompt: 'use agent teams plan medium implementation and tests',
    profile: 'default',
    task_size: 'medium',
    auto_spawn: false,
    max_threads: 4,
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(triggered.ok, true);
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.orchestration.auto_spawn_enabled, false);
  assert.ok(triggered.orchestration.budget_controller);
  assert.equal(triggered.orchestration.budget_controller.source, 'global_telemetry');
  assert.equal(triggered.orchestration.budget_controller.sample_count >= 8, true);

  server.store.close();
});
