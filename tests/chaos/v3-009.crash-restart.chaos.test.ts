import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerLeaseTools } from '../../mcp/server/tools/leases.js';
import { registerRecoveryTools } from '../../mcp/server/tools/recovery.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-009-chaos.sqlite';
const logPathA = '.tmp/v3-009-chaos-a.log';
const logPathB = '.tmp/v3-009-chaos-b.log';
const logPathC = '.tmp/v3-009-chaos-c.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
  rmSync(logPathC, { force: true });
});

test('V3-009 chaos: repeated crash/restart recovery remains idempotent and avoids double completion', () => {
  const serverA = createServer({ dbPath, logPath: logPathA });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerAgentLifecycleTools(serverA);
  registerTaskBoardTools(serverA);
  registerLeaseTools(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'v3-009 chaos run',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const agentA = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const agentB = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(agentA.ok, true);
  assert.equal(agentB.ok, true);

  const taskIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const created = serverA.callTool('team_task_create', {
      team_id: teamId,
      title: `chaos-task-${i + 1}`,
      required_role: 'implementer',
      priority: i + 1
    });
    assert.equal(created.ok, true);
    const taskId = String(created.task.task_id);
    taskIds.push(taskId);

    const claimed = serverA.callTool('team_task_claim', {
      team_id: teamId,
      task_id: taskId,
      agent_id: String(agentA.agent.agent_id),
      expected_lock_version: Number(created.task.lock_version)
    }, {
      auth_agent_id: String(agentA.agent.agent_id)
    });
    assert.equal(claimed.ok, true);

    const attempt = serverA.store.createExecutionAttempt({
      execution_id: `exec_v3_009_chaos_${i + 1}`,
      team_id: teamId,
      task_id: taskId,
      attempt_no: 1,
      status: 'executing',
      lease_owner_agent_id: String(agentA.agent.agent_id),
      lease_expires_at: claimed.task.lease_expires_at,
      retry_count: 0,
      metadata: { source: 'v3-009-chaos' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    assert.equal(Boolean(attempt), true);

    const renew = serverA.callTool('team_task_lease_renew', {
      team_id: teamId,
      task_id: taskId,
      agent_id: String(agentA.agent.agent_id),
      lease_ms: 1
    });
    assert.equal(renew.ok, true);
  }

  const staleHeartbeat = serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: String(agentA.agent.agent_id),
    heartbeat_at: '2000-01-01T00:00:00.000Z'
  });
  assert.equal(staleHeartbeat.ok, true);

  serverA.store.close();

  const waitLease = Date.now() + 5;
  while (Date.now() < waitLease) {
    // wait for lease expiry
  }

  const serverB = createServer({ dbPath, logPath: logPathB });
  serverB.start();
  registerTeamLifecycleTools(serverB);
  registerAgentLifecycleTools(serverB);
  registerTaskBoardTools(serverB);
  registerLeaseTools(serverB);
  registerRecoveryTools(serverB);

  const firstRecover = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(firstRecover.ok, true);
  assert.equal(firstRecover.recovered_tasks, 2);
  assert.equal(firstRecover.recovered_execution_attempts, 2);

  const secondRecover = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(secondRecover.ok, true);
  assert.equal(secondRecover.recovered_tasks, 0);
  assert.equal(secondRecover.recovered_execution_attempts, 0);

  const next = serverB.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(next.ok, true);
  assert.equal(next.ready_count, 2);

  for (const task of next.tasks as Array<Record<string, unknown>>) {
    const taskId = String(task.task_id);
    const claim = serverB.callTool('team_task_claim', {
      team_id: teamId,
      task_id: taskId,
      agent_id: String(agentB.agent.agent_id),
      expected_lock_version: Number(task.lock_version)
    }, {
      auth_agent_id: String(agentB.agent.agent_id)
    });
    assert.equal(claim.ok, true);

    const done = serverB.callTool('team_task_update', {
      team_id: teamId,
      task_id: taskId,
      status: 'done',
      expected_lock_version: Number(claim.task.lock_version)
    });
    assert.equal(done.ok, true);
  }

  serverB.store.close();

  const serverC = createServer({ dbPath, logPath: logPathC });
  serverC.start();
  registerTeamLifecycleTools(serverC);
  registerAgentLifecycleTools(serverC);
  registerTaskBoardTools(serverC);
  registerLeaseTools(serverC);
  registerRecoveryTools(serverC);

  const postCompletionRecover = serverC.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(postCompletionRecover.ok, true);
  assert.equal(postCompletionRecover.recovered_tasks, 0);
  assert.equal(postCompletionRecover.recovered_execution_attempts, 0);

  for (const taskId of taskIds) {
    const task = serverC.store.getTask(taskId);
    assert.equal(task?.status, 'done');
  }

  const resumed = serverC.callTool('team_resume', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.recovery_snapshot.queue.open_tasks, 0);
  assert.equal(resumed.recovery_snapshot.queue.in_progress_tasks, 0);
  assert.equal(resumed.recovery_snapshot.execution.in_flight_count, 0);
  assert.equal(resumed.recovery_snapshot.leases.expired_count, 0);

  serverC.store.close();
});
