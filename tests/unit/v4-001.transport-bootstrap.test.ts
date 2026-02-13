import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { WorkerAdapter, type WorkerProvider } from '../../mcp/runtime/worker-adapter.js';
import type { CodexTransport } from '../../mcp/runtime/providers/codex.js';

const dbPath = '.tmp/v4-001-transport-bootstrap-unit.sqlite';
const logPath = '.tmp/v4-001-transport-bootstrap-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

afterEach(cleanup);

test('V4-001 unit: createServer default keeps host-orchestrated behavior when adapter is not configured', () => {
  cleanup();

  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  assert.equal(server.runtimeMode, 'host_orchestrated_default');
  assert.equal(server.managedRuntimeEnabled, false);
  assert.equal(Boolean(server.workerAdapter), false);

  const started = server.callTool('team_start', {
    objective: 'default mode bootstrap'
  });
  assert.equal(started.ok, true);

  const spawned = server.callTool('team_spawn', {
    team_id: started.team.team_id,
    role: 'implementer'
  });
  assert.equal(spawned.ok, true);
  assert.equal(spawned.worker_session ?? null, null);
  assert.equal(spawned.runtime_mode, 'host_orchestrated_default');
  assert.equal(spawned.managed_runtime_enabled, false);

  server.store.close();
});

test('V4-001 unit: createServer accepts explicit workerAdapter bootstrap wiring', () => {
  cleanup();

  let spawnCalls = 0;
  const provider: WorkerProvider = {
    name: 'v4-bootstrap-provider',
    spawn: (input) => {
      spawnCalls += 1;
      return {
        worker_id: `worker_${input.agent_id}`,
        status: 'spawned'
      };
    },
    sendInstruction: () => ({ accepted: true, instruction_id: 'inst_1', status: 'queued' }),
    poll: (input) => ({ worker_id: input.worker_id, status: 'running', events: [] }),
    interrupt: () => ({ interrupted: true, status: 'interrupted' }),
    collectArtifacts: (input) => ({ worker_id: input.worker_id, artifacts: [] })
  };

  const server = createServer({
    dbPath,
    logPath,
    runtimeMode: 'managed_runtime',
    workerAdapter: new WorkerAdapter(provider)
  });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'explicit worker adapter'
  });
  assert.equal(started.ok, true);

  const spawned = server.callTool('team_spawn', {
    team_id: started.team.team_id,
    role: 'reviewer'
  });
  assert.equal(spawned.ok, true);
  assert.equal(spawnCalls, 1);
  assert.equal(spawned.worker_session.provider, 'v4-bootstrap-provider');
  assert.match(String(spawned.worker_session.worker_id), /^worker_agent_/);
  assert.equal(spawned.runtime_mode, 'managed_runtime');
  assert.equal(spawned.managed_runtime_enabled, true);

  server.store.close();
});

test('V4-001 unit: managedRuntime transport wiring bootstraps codex adapter when transport is provided', () => {
  cleanup();

  let spawnCalls = 0;
  const transport: CodexTransport = {
    spawn: (input) => {
      spawnCalls += 1;
      return {
        worker_id: `transport_${input.agent_id}`,
        status: 'spawned'
      };
    },
    sendInstruction: () => ({ accepted: true, instruction_id: 'inst_2', status: 'queued' }),
    poll: (input) => ({ worker_id: input.worker_id, status: 'running', events: [] }),
    interrupt: () => ({ interrupted: true, status: 'interrupted' }),
    collectArtifacts: (input) => ({ worker_id: input.worker_id, artifacts: [] })
  };

  const server = createServer({
    dbPath,
    logPath,
    managedRuntime: {
      enabled: true,
      provider: 'codex',
      transport
    }
  });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'managed runtime transport wiring'
  });
  assert.equal(started.ok, true);

  const spawned = server.callTool('team_spawn', {
    team_id: started.team.team_id,
    role: 'tester'
  });
  assert.equal(spawned.ok, true);
  assert.equal(spawnCalls, 1);
  assert.equal(spawned.worker_session.provider, 'codex');
  assert.match(String(spawned.worker_session.worker_id), /^transport_agent_/);
  assert.equal(spawned.runtime_mode, 'managed_runtime');
  assert.equal(spawned.managed_runtime_enabled, true);

  server.store.close();
});
