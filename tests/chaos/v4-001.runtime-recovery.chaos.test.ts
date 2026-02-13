import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerLeaseTools } from '../../mcp/server/tools/leases.js';
import { registerRecoveryTools } from '../../mcp/server/tools/recovery.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';

const dbPath = '.tmp/v4-001-runtime-recovery-chaos.sqlite';
const logPathA = '.tmp/v4-001-runtime-recovery-chaos-a.log';
const logPathB = '.tmp/v4-001-runtime-recovery-chaos-b.log';
const logPathC = '.tmp/v4-001-runtime-recovery-chaos-c.log';
const logPathD = '.tmp/v4-001-runtime-recovery-chaos-d.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPathA, { force: true });
  rmSync(logPathB, { force: true });
  rmSync(logPathC, { force: true });
  rmSync(logPathD, { force: true });
}

function registerLifecycle(server: ReturnType<typeof createServer>): void {
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerLeaseTools(server);
  registerRecoveryTools(server);
}

function boot(logPath: string, adapter: WorkerAdapter) {
  const server = createServer({
    dbPath,
    logPath,
    runtimeMode: 'managed_runtime',
    workerAdapter: adapter
  });
  server.start();
  registerLifecycle(server);
  return server;
}

afterEach(cleanup);

test('V4-001 chaos: repeated crash/restart recovery keeps worker sessions consistent and orphan-free', () => {
  cleanup();

  const provider: WorkerProvider = {
    name: 'v4-001-chaos-provider',
    spawn: (input) => ({ worker_id: `worker_${input.agent_id}`, status: 'spawned' }),
    sendInstruction: () => ({ accepted: true, instruction_id: 'inst_chaos', status: 'queued' }),
    poll: (input) => ({ worker_id: input.worker_id, status: 'running', events: [] }),
    interrupt: () => ({ interrupted: true, status: 'interrupted' }),
    collectArtifacts: (input) => ({ worker_id: input.worker_id, artifacts: [] })
  };
  const adapter = new WorkerAdapter(provider);

  const serverA = boot(logPathA, adapter);

  const started = serverA.callTool('team_start', {
    objective: 'v4-001 chaos runtime recovery',
    max_threads: 6
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id as string;

  const lead = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  const workerA = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  const workerB = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'tester'
  });
  assert.equal(lead.ok, true);
  assert.equal(workerA.ok, true);
  assert.equal(workerB.ok, true);

  const sessionsBefore = serverA.store.listWorkerRuntimeSessionsByTeam(teamId);
  assert.equal(sessionsBefore.length, 3);

  serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: workerA.agent.agent_id,
    heartbeat_at: '2000-01-01T00:00:00.000Z'
  });
  serverA.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: workerB.agent.agent_id,
    heartbeat_at: '2000-01-01T00:00:00.000Z'
  });

  serverA.store.close();

  const serverB = boot(logPathB, adapter);
  const firstRecover = serverB.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000,
    now_iso: '2000-01-01T00:00:02.000Z'
  });
  assert.equal(firstRecover.ok, true);
  assert.equal(firstRecover.recovered_worker_sessions, 2);
  assert.equal(firstRecover.recovered_worker_session_agent_ids.includes(workerA.agent.agent_id), true);
  assert.equal(firstRecover.recovered_worker_session_agent_ids.includes(workerB.agent.agent_id), true);
  assert.equal(serverB.store.listWorkerRuntimeSessionsByTeam(teamId).length, 1);

  const replacement = serverB.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(replacement.ok, true);
  assert.equal(serverB.store.listWorkerRuntimeSessionsByTeam(teamId).length, 2);

  serverB.callTool('team_agent_heartbeat', {
    team_id: teamId,
    agent_id: replacement.agent.agent_id,
    heartbeat_at: '2000-01-01T00:00:01.000Z'
  });
  serverB.store.close();

  const serverC = boot(logPathC, adapter);
  const secondRecover = serverC.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000,
    now_iso: '2000-01-01T00:00:03.000Z'
  });
  assert.equal(secondRecover.ok, true);
  assert.equal(secondRecover.recovered_worker_sessions, 1);
  assert.equal(secondRecover.recovered_worker_session_agent_ids.includes(replacement.agent.agent_id), true);
  assert.equal(serverC.store.listWorkerRuntimeSessionsByTeam(teamId).length, 1);
  serverC.store.close();

  const serverD = boot(logPathD, adapter);
  const thirdRecover = serverD.callTool('team_orphan_recover', {
    team_id: teamId,
    agent_stale_ms: 1000,
    now_iso: '2000-01-01T00:00:04.000Z'
  });
  assert.equal(thirdRecover.ok, true);
  assert.equal(thirdRecover.recovered_worker_sessions, 0);
  assert.equal(serverD.store.listWorkerRuntimeSessionsByTeam(teamId).length, 1);

  serverD.store.close();
});
