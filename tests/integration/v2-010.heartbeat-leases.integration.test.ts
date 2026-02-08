import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerLeaseTools } from '../../mcp/server/tools/leases.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-010-int.sqlite';
const logPath = '.tmp/v2-010-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-010 integration: lease tools enforce contention and stale-lease recovery', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);
  registerLeaseTools(server);

  const started = server.callTool('team_start', { objective: 'lease integration', profile: 'default' });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const agentA = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const agentB = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(agentA.ok, true);
  assert.equal(agentB.ok, true);

  const task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'lease claim',
    priority: 1
  });
  assert.equal(task.ok, true);

  const claim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentA.agent.agent_id,
    expected_lock_version: task.task.lock_version
  }, {
    auth_agent_id: agentA.agent.agent_id
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.task.lease_owner_agent_id, agentA.agent.agent_id);

  const deniedAcquire = server.callTool('team_task_lease_acquire', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentB.agent.agent_id
  });
  assert.equal(deniedAcquire.ok, false);

  const renewedShort = server.callTool('team_task_lease_renew', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentA.agent.agent_id,
    lease_ms: 1
  });
  assert.equal(renewedShort.ok, true);

  const target = Date.now() + 5;
  while (Date.now() < target) {
    // wait for lease expiry
  }

  const recoveredAcquire = server.callTool('team_task_lease_acquire', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentB.agent.agent_id
  });
  assert.equal(recoveredAcquire.ok, true);
  assert.equal(recoveredAcquire.task.lease_owner_agent_id, agentB.agent.agent_id);

  const heartbeat = server.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: agentA.agent.agent_id
  });
  assert.equal(heartbeat.ok, true);
  assert.ok(heartbeat.last_heartbeat_at);

  const released = server.callTool('team_task_lease_release', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentB.agent.agent_id
  });
  assert.equal(released.ok, true);
  assert.equal(released.task.lease_owner_agent_id, null);
  assert.equal(released.task.lease_expires_at, null);

  server.store.close();
});
