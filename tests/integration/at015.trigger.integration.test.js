import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerFanoutTools } from '../../mcp/server/tools/fanout.js';
import { registerTriggerTools } from '../../mcp/server/tools/trigger.js';

const dbPath = '.tmp/at015-int.sqlite';
const logPath = '.tmp/at015-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-015 integration: trigger phrase creates orchestration team and logs invocation', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTriggerTools(server);

  const triggered = server.callTool('team_trigger', {
    prompt: 'use agent teams deliver milestone M4',
    profile: 'default',
    max_threads: 4,
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(triggered.ok, true);
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.orchestration.task_size, 'small');

  const status = server.callTool('team_status', { team_id: triggered.team.team_id });
  assert.equal(status.ok, true);
  assert.equal(status.team.status, 'active');

  const logs = readFileSync(logPath, 'utf8');
  assert.match(logs, /tool_call:team_trigger/);
  assert.match(logs, /tool_call:team_start/);

  server.store.close();
});

test('AT-015 integration: complexity-based trigger auto-spawns workers within cap', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);
  registerTriggerTools(server);

  const triggered = server.callTool('team_trigger', {
    prompt: 'use agent teams ship a high-complexity refactor across modules with parallel streams',
    profile: 'deep',
    task_size: 'high',
    max_threads: 6,
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(triggered.ok, true);
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.orchestration.recommended_threads, 6);
  assert.equal(triggered.orchestration.spawned_count, 6);
  assert.ok(triggered.orchestration.budget_controller);
  assert.notEqual(triggered.orchestration.budget_controller.source, 'explicit_input');

  const status = server.callTool('team_status', { team_id: triggered.team.team_id });
  assert.equal(status.ok, true);
  assert.equal(status.metrics.agents, 6);

  server.store.close();
});

test('AT-015 integration: trigger fanout planning defaults to telemetry estimator', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerFanoutTools(server);
  registerTriggerTools(server);

  const warmTeam = server.callTool('team_start', {
    objective: 'warm telemetry for trigger integration',
    profile: 'default',
    max_threads: 4
  });
  const warmTeamId = warmTeam.team.team_id;
  const warmSender = server.callTool('team_spawn', { team_id: warmTeamId, role: 'implementer' });
  const warmReceiver = server.callTool('team_spawn', { team_id: warmTeamId, role: 'reviewer' });
  for (let i = 0; i < 10; i += 1) {
    server.callTool('team_send', {
      team_id: warmTeamId,
      from_agent_id: warmSender.agent.agent_id,
      to_agent_id: warmReceiver.agent.agent_id,
      summary: `trigger-int-warm-${i}-${'x'.repeat(750)}`,
      artifact_refs: [],
      idempotency_key: `trigger-int-warm-${i}`
    });
  }

  const triggered = server.callTool('team_trigger', {
    prompt: 'use agent teams build medium scope workstream',
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
