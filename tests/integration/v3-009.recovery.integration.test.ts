import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerLeaseTools } from '../../mcp/server/tools/leases.js';
import { registerRecoveryTools } from '../../mcp/server/tools/recovery.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-009-int.sqlite';
const logPathA = '.tmp/v3-009-a.log';
const logPathB = '.tmp/v3-009-b.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
});

test('V3-009 integration: crash/restart recovery requeues lease-expired work and prevents double-complete', () => {
  const serverA = createServer({ dbPath, logPath: logPathA });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerAgentLifecycleTools(serverA);
  registerTaskBoardTools(serverA);
  registerLeaseTools(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'v3-009 exactly-once integration',
    profile: 'default',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const lead = serverA.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const agentA = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const agentB = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(agentA.ok, true);
  assert.equal(agentB.ok, true);

  const created = serverA.callTool('team_task_create', {
    team_id: teamId,
    title: 'recover and resume task',
    required_role: 'implementer',
    priority: 1
  });
  assert.equal(created.ok, true);
  const taskId = String(created.task.task_id);

  const claimed = serverA.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: String(agentA.agent.agent_id),
    expected_lock_version: Number(created.task.lock_version)
  }, {
    auth_agent_id: String(agentA.agent.agent_id)
  });
  assert.equal(claimed.ok, true);
  const staleLockVersion = Number(claimed.task.lock_version);

  const attempt = serverA.store.createExecutionAttempt({
    execution_id: 'exec_v3_009_int_1',
    team_id: teamId,
    task_id: taskId,
    attempt_no: 1,
    status: 'executing',
    lease_owner_agent_id: String(agentA.agent.agent_id),
    lease_expires_at: claimed.task.lease_expires_at,
    retry_count: 0,
    metadata: { source: 'v3-009-int' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  assert.equal(Boolean(attempt), true);

  const renewShort = serverA.callTool('team_task_lease_renew', {
    team_id: teamId,
    task_id: taskId,
    agent_id: String(agentA.agent.agent_id),
    lease_ms: 1
  });
  assert.equal(renewShort.ok, true);

  const staleHeartbeat = serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: String(agentA.agent.agent_id),
    heartbeat_at: '2000-01-01T00:00:00.000Z'
  });
  const freshHeartbeat = serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: String(agentB.agent.agent_id)
  });
  assert.equal(staleHeartbeat.ok, true);
  assert.equal(freshHeartbeat.ok, true);

  serverA.store.close();

  const waitLease = Date.now() + 5;
  while (Date.now() < waitLease) {
    // wait for short lease expiry before restart
  }

  const serverB = createServer({ dbPath, logPath: logPathB });
  serverB.start();
  registerTeamLifecycleTools(serverB);
  registerAgentLifecycleTools(serverB);
  registerTaskBoardTools(serverB);
  registerLeaseTools(serverB);
  registerRecoveryTools(serverB);

  const recovered = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered_tasks, 1);
  assert.equal(recovered.recovered_execution_attempts, 1);
  assert.equal(recovered.recovered_task_ids.includes(taskId), true);
  assert.equal(recovered.stale_agent_ids.includes(String(agentA.agent.agent_id)), true);
  assert.equal(recovered.recovery_snapshot_before.queue.in_progress_tasks >= 1, true);
  assert.equal(recovered.recovery_snapshot_after.queue.in_progress_tasks, 0);
  assert.equal(recovered.recovery_snapshot_after.queue.ready_tasks >= 1, true);

  const next = serverB.callTool('team_task_next', { team_id: teamId, limit: 10 });
  assert.equal(next.ok, true);
  assert.equal(next.ready_count, 1);
  assert.equal(String(next.tasks[0].task_id), taskId);

  const reclaimed = serverB.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskId,
    agent_id: String(agentB.agent.agent_id),
    expected_lock_version: Number(next.tasks[0].lock_version)
  }, {
    auth_agent_id: String(agentB.agent.agent_id)
  });
  assert.equal(reclaimed.ok, true);

  const done = serverB.callTool('team_task_update', {
    team_id: teamId,
    task_id: taskId,
    status: 'done',
    expected_lock_version: Number(reclaimed.task.lock_version)
  });
  assert.equal(done.ok, true);
  const lockAfterDone = Number(done.task.lock_version);

  const staleComplete = serverB.callTool('team_task_update', {
    team_id: teamId,
    task_id: taskId,
    status: 'done',
    expected_lock_version: staleLockVersion
  });
  assert.equal(staleComplete.ok, false);
  assert.match(String(staleComplete.error ?? ''), /lock conflict/);

  const finalTask = serverB.store.getTask(taskId);
  assert.equal(finalTask?.status, 'done');
  assert.equal(finalTask?.lock_version, lockAfterDone);

  const resume = serverB.callTool('team_resume', {
    team_id: teamId,
    agent_stale_ms: 1000
  });
  assert.equal(resume.ok, true);
  assert.equal(typeof resume.recovery_snapshot.queue.ready_tasks, 'number');
  assert.equal(typeof resume.recovery_snapshot.leases.expired_count, 'number');
  assert.equal(typeof resume.recovery_snapshot.workers.stale_agent_count, 'number');
  assert.equal(typeof resume.recovery_snapshot.inbox.pending_count, 'number');
  assert.equal(typeof resume.recovery_snapshot.execution.in_flight_count, 'number');
  assert.equal(Array.isArray(resume.recovery_snapshot.execution.in_flight_execution_ids), true);

  serverB.store.close();
});
