import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerRecoveryTools } from '../../mcp/server/tools/recovery.js';
import { registerLeaseTools } from '../../mcp/server/tools/leases.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';

const dbPath = '.tmp/v4-012-runtime-recovery-int.sqlite';
const logPathA = '.tmp/v4-012-runtime-recovery-a.log';
const logPathB = '.tmp/v4-012-runtime-recovery-b.log';
const logPathC = '.tmp/v4-012-runtime-recovery-c.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
  rmSync(logPathC, { force: true });
}

function registerLifecycle(server: ReturnType<typeof createServer>): void {
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerLeaseTools(server);
  registerRecoveryTools(server);
}

afterEach(cleanup);

test('V4-012 integration: runtime recovery removes stale worker sessions and remains restart-safe', () => {
  cleanup();

  const provider: WorkerProvider = {
    name: 'v4-012-recovery-provider',
    spawn: (input) => ({ worker_id: `worker_${input.agent_id}`, status: 'spawned' }),
    sendInstruction: () => ({ accepted: true, instruction_id: 'inst_v4_012', status: 'queued' }),
    poll: (input) => ({ worker_id: input.worker_id, status: 'running', events: [] }),
    interrupt: () => ({ interrupted: true, status: 'interrupted' }),
    collectArtifacts: (input) => ({ worker_id: input.worker_id, artifacts: [] })
  };
  const adapter = new WorkerAdapter(provider);

  const serverA = createServer({
    dbPath,
    logPath: logPathA,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  serverA.start();
  registerLifecycle(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'v4-012 runtime recovery test',
    max_threads: 4
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const lead = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const reviewer = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(lead.ok, true);
  assert.equal(reviewer.ok, true);

  const sessionsBefore = serverA.store.listWorkerRuntimeSessionsByTeam(teamId);
  assert.equal(sessionsBefore.length, 2);

  const staleHeartbeat = serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: reviewer.agent.agent_id,
    heartbeat_at: '2000-01-01T00:00:00.000Z'
  });
  assert.equal(staleHeartbeat.ok, true);

  serverA.store.close();

  const serverB = createServer({
    dbPath,
    logPath: logPathB,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  serverB.start();
  registerLifecycle(serverB);

  const recovered = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000,
    now_iso: '2000-01-01T00:00:01.500Z'
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.marked_agents_offline, 1);
  assert.equal(recovered.recovered_worker_sessions, 1);
  assert.equal(recovered.recovered_worker_session_agent_ids.includes(reviewer.agent.agent_id), true);

  const sessionsAfter = serverB.store.listWorkerRuntimeSessionsByTeam(teamId);
  assert.equal(sessionsAfter.length, 1);
  assert.equal(sessionsAfter[0]?.agent_id, lead.agent.agent_id);

  const reviewerPull = serverB.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: reviewer.agent.agent_id,
    ack: true
  });
  assert.equal(reviewerPull.ok, true);
  assert.equal(reviewerPull.worker_adapter_active, false);

  serverB.store.close();

  const serverC = createServer({
    dbPath,
    logPath: logPathC,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  serverC.start();
  registerLifecycle(serverC);

  const sessionsAfterRestart = serverC.store.listWorkerRuntimeSessionsByTeam(teamId);
  assert.equal(sessionsAfterRestart.length, 1);
  assert.equal(sessionsAfterRestart[0]?.agent_id, lead.agent.agent_id);

  const secondRecover = serverC.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000,
    now_iso: '2000-01-01T00:00:03.000Z'
  });
  assert.equal(secondRecover.ok, true);
  assert.equal(secondRecover.recovered_worker_sessions, 0);

  serverC.store.close();
});
