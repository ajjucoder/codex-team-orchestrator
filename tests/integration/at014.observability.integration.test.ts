import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';

const dbPath = '.tmp/at014-int.sqlite';
const logPath = '.tmp/at014-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-014 integration: replay returns ordered events and summary reflects activity', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerObservabilityTools(server);

  const team = server.callTool('team_start', { objective: 'observe', max_threads: 2 });
  const teamId = team.team.team_id;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });

  server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    to_agent_id: worker.agent.agent_id,
    summary: 'sync',
    artifact_refs: [],
    idempotency_key: 'obs-1'
  });

  const summary = server.callTool('team_run_summary', { team_id: teamId });
  assert.equal(summary.ok, true);
  assert.equal(summary.summary.metrics.agents, 2);
  assert.equal(summary.summary.metrics.messages, 1);
  assert.equal(summary.summary.usage.sample_count >= 3, true);
  assert.equal(summary.summary.usage.by_tool.team_send.samples >= 1, true);

  const replay = server.callTool('team_replay', {
    team_id: teamId,
    limit: 50
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.event_count >= 3, true);
  for (let i = 1; i < replay.events.length; i += 1) {
    assert.equal(replay.events[i].id > replay.events[i - 1].id, true);
  }

  const logs = readFileSync(logPath, 'utf8');
  assert.match(logs, /tool_call:team_run_summary/);
  assert.match(logs, /tool_call:team_replay/);

  server.store.close();
});
