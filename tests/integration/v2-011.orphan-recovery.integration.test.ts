import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerLeaseTools } from '../../mcp/server/tools/leases.js';
import { registerRecoveryTools } from '../../mcp/server/tools/recovery.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-011-int.sqlite';
const logPathA = '.tmp/v2-011-a.log';
const logPathB = '.tmp/v2-011-b.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
});

test('V2-011 integration: crash-restart recovery requeues orphaned work deterministically', () => {
  const serverA = createServer({ dbPath, logPath: logPathA });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerAgentLifecycleTools(serverA);
  registerTaskBoardTools(serverA);
  registerLeaseTools(serverA);

  const started = serverA.callTool('team_start', { objective: 'orphan recovery', profile: 'default' });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const agentA = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const agentB = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(agentA.ok, true);
  assert.equal(agentB.ok, true);

  const task = serverA.callTool('team_task_create', {
    team_id: teamId,
    title: 'recover this task',
    priority: 1
  });
  assert.equal(task.ok, true);

  const claim = serverA.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentA.agent.agent_id,
    expected_lock_version: task.task.lock_version
  }, {
    auth_agent_id: agentA.agent.agent_id
  });
  assert.equal(claim.ok, true);

  const renewShort = serverA.callTool('team_task_lease_renew', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentA.agent.agent_id,
    lease_ms: 1
  });
  assert.equal(renewShort.ok, true);

  const heartbeatA = serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: agentA.agent.agent_id,
    heartbeat_at: '2000-01-01T00:00:00.000Z'
  });
  assert.equal(heartbeatA.ok, true);
  const heartbeatB = serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: agentB.agent.agent_id
  });
  assert.equal(heartbeatB.ok, true);

  serverA.store.close();

  const waitTarget = Date.now() + 5;
  while (Date.now() < waitTarget) {
    // wait for short lease expiry before restart
  }

  const serverB = createServer({ dbPath, logPath: logPathB });
  serverB.start();
  registerTeamLifecycleTools(serverB);
  registerAgentLifecycleTools(serverB);
  registerTaskBoardTools(serverB);
  registerRecoveryTools(serverB);

  const recovered = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered_tasks, 1);
  assert.equal(recovered.stale_agent_ids.includes(agentA.agent.agent_id), true);
  assert.equal(recovered.stale_agent_ids.includes(agentB.agent.agent_id), false);

  const next = serverB.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(next.ok, true);
  assert.equal(next.ready_count, 1);
  assert.equal(next.tasks[0].task_id, task.task.task_id);

  const claimedRecovered = serverB.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: agentB.agent.agent_id,
    expected_lock_version: next.tasks[0].lock_version
  }, {
    auth_agent_id: agentB.agent.agent_id
  });
  assert.equal(claimedRecovered.ok, true);

  const secondSweep = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(secondSweep.ok, true);
  assert.equal(secondSweep.recovered_tasks, 0);

  serverB.store.close();
});
