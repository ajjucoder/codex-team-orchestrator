import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerCheckpointTools } from '../../mcp/server/tools/checkpoints.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-004-int.sqlite';
const logPath = '.tmp/v3-004-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readWorkerStream(teamMetadata: Record<string, unknown>, workerId: string): Record<string, unknown> {
  const streams = asRecord(teamMetadata.context_streams);
  return asRecord(streams[`worker:${workerId}`]);
}

test('V3-004 integration: worker-scoped checkpoint metadata/reset streams are isolated in the same team', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerCheckpointTools(server);

  const started = server.callTool('team_start', {
    objective: 'context isolation integration',
    max_threads: 4,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const workerA = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const workerB = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(lead.ok, true);
  assert.equal(workerA.ok, true);
  assert.equal(workerB.ok, true);

  for (let i = 0; i < 4; i += 1) {
    const toA = server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: lead.agent.agent_id,
      to_agent_id: workerA.agent.agent_id,
      summary: `isolation-worker-a-${i}`,
      artifact_refs: [],
      idempotency_key: `v3-004-a-${i}`
    });
    const toB = server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: lead.agent.agent_id,
      to_agent_id: workerB.agent.agent_id,
      summary: `isolation-worker-b-${i}`,
      artifact_refs: [],
      idempotency_key: `v3-004-b-${i}`
    });
    assert.equal(toA.ok, true);
    assert.equal(toB.ok, true);
  }

  const compactA = server.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 20
    },
    {
      worker_id: workerA.agent.agent_id,
      auth_agent_id: workerA.agent.agent_id
    }
  );
  const compactB = server.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 20
    },
    {
      worker_id: workerB.agent.agent_id,
      auth_agent_id: workerB.agent.agent_id
    }
  );
  assert.equal(compactA.ok, true);
  assert.equal(compactB.ok, true);
  assert.equal(compactA.checkpoint.artifact_id === compactB.checkpoint.artifact_id, false);

  const metadataAfterCompaction = asRecord(server.store.getTeam(teamId)?.metadata);
  const workerAStream = readWorkerStream(metadataAfterCompaction, workerA.agent.agent_id);
  const workerBStream = readWorkerStream(metadataAfterCompaction, workerB.agent.agent_id);
  assert.equal(
    asRecord(workerAStream.context_checkpoint).artifact_id,
    compactA.checkpoint.artifact_id
  );
  assert.equal(
    asRecord(workerBStream.context_checkpoint).artifact_id,
    compactB.checkpoint.artifact_id
  );

  const crossReset = server.callTool(
    'team_context_reset',
    {
      team_id: teamId,
      checkpoint_artifact_id: compactB.checkpoint.artifact_id,
      checkpoint_version: compactB.checkpoint.version
    },
    {
      worker_id: workerA.agent.agent_id,
      auth_agent_id: workerA.agent.agent_id
    }
  );
  assert.equal(crossReset.ok, false);
  assert.match(String(crossReset.error ?? ''), /does not belong to worker stream/);

  const resetA = server.callTool(
    'team_context_reset',
    {
      team_id: teamId
    },
    {
      worker_id: workerA.agent.agent_id,
      auth_agent_id: workerA.agent.agent_id
    }
  );
  const resetB = server.callTool(
    'team_context_reset',
    {
      team_id: teamId
    },
    {
      worker_id: workerB.agent.agent_id,
      auth_agent_id: workerB.agent.agent_id
    }
  );
  assert.equal(resetA.ok, true);
  assert.equal(resetB.ok, true);
  assert.equal(resetA.context_reset.checkpoint_artifact_id, compactA.checkpoint.artifact_id);
  assert.equal(resetB.context_reset.checkpoint_artifact_id, compactB.checkpoint.artifact_id);

  const compactASecond = server.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 15
    },
    {
      worker_id: workerA.agent.agent_id,
      auth_agent_id: workerA.agent.agent_id
    }
  );
  assert.equal(compactASecond.ok, true);

  const metadataAfterSecond = asRecord(server.store.getTeam(teamId)?.metadata);
  const workerAStreamAfterSecond = readWorkerStream(metadataAfterSecond, workerA.agent.agent_id);
  const workerBStreamAfterSecond = readWorkerStream(metadataAfterSecond, workerB.agent.agent_id);
  assert.equal(
    asRecord(workerAStreamAfterSecond.context_checkpoint).version,
    compactASecond.checkpoint.version
  );
  assert.equal(
    asRecord(workerBStreamAfterSecond.context_checkpoint).version,
    compactB.checkpoint.version
  );
  assert.equal(
    asRecord(workerAStreamAfterSecond.context_reset).checkpoint_artifact_id,
    compactA.checkpoint.artifact_id
  );
  assert.equal(
    asRecord(workerBStreamAfterSecond.context_reset).checkpoint_artifact_id,
    compactB.checkpoint.artifact_id
  );

  const teamCompact = server.callTool('team_checkpoint_compact', {
    team_id: teamId,
    keep_recent_messages: 1,
    keep_recent_events: 30
  });
  assert.equal(teamCompact.ok, true);
  assert.equal(teamCompact.checkpoint.artifact_id, 'artifact_checkpoint_context');
  assert.equal(teamCompact.scope, 'team');

  server.store.close();
});

test('V3-004 integration: worker scope rejects spoofed worker_id and missing auth context', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerCheckpointTools(server);

  const started = server.callTool('team_start', {
    objective: 'auth binding checks',
    max_threads: 3,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const workerA = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  const workerB = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(workerA.ok, true);
  assert.equal(workerB.ok, true);

  const spoofed = server.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 10
    },
    {
      worker_id: workerB.agent.agent_id,
      auth_agent_id: workerA.agent.agent_id
    }
  );
  assert.equal(spoofed.ok, false);
  assert.match(String(spoofed.error ?? ''), /does not match authenticated agent/);

  const missingAuth = server.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 10
    },
    {
      worker_id: workerA.agent.agent_id
    }
  );
  assert.equal(missingAuth.ok, false);
  assert.match(String(missingAuth.error ?? ''), /require authenticated agent context/);

  const agentIdOnlyCompact = server.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 10
    },
    {
      worker_id: workerA.agent.agent_id,
      agent_id: workerA.agent.agent_id
    }
  );
  assert.equal(agentIdOnlyCompact.ok, false);
  assert.match(String(agentIdOnlyCompact.error ?? ''), /require authenticated agent context/);

  const agentIdOnlyReset = server.callTool(
    'team_context_reset',
    {
      team_id: teamId
    },
    {
      worker_id: workerA.agent.agent_id,
      agent_id: workerA.agent.agent_id
    }
  );
  assert.equal(agentIdOnlyReset.ok, false);
  assert.match(String(agentIdOnlyReset.error ?? ''), /require authenticated agent context/);

  server.store.close();
});

test('V3-004 integration: worker stream budget counters persist and increment across restart', () => {
  const serverA = createServer({ dbPath, logPath });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerAgentLifecycleTools(serverA);
  registerCheckpointTools(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'restart budget determinism',
    max_threads: 3,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const worker = serverA.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(worker.ok, true);

  const compactFirst = serverA.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 10
    },
    {
      worker_id: worker.agent.agent_id,
      auth_agent_id: worker.agent.agent_id
    }
  );
  assert.equal(compactFirst.ok, true);

  const resetFirst = serverA.callTool(
    'team_context_reset',
    {
      team_id: teamId
    },
    {
      worker_id: worker.agent.agent_id,
      auth_agent_id: worker.agent.agent_id
    }
  );
  assert.equal(resetFirst.ok, true);

  const metadataAfterFirst = asRecord(serverA.store.getTeam(teamId)?.metadata);
  const streamAfterFirst = readWorkerStream(metadataAfterFirst, worker.agent.agent_id);
  const budgetAfterFirst = asRecord(streamAfterFirst.budget);
  assert.equal(Number(budgetAfterFirst.compact_count ?? 0), 1);
  assert.equal(Number(budgetAfterFirst.reset_count ?? 0), 1);
  serverA.store.close();

  const serverB = createServer({ dbPath, logPath });
  serverB.start();
  registerTeamLifecycleTools(serverB);
  registerAgentLifecycleTools(serverB);
  registerCheckpointTools(serverB);

  const compactSecond = serverB.callTool(
    'team_checkpoint_compact',
    {
      team_id: teamId,
      keep_recent_messages: 1,
      keep_recent_events: 10
    },
    {
      worker_id: worker.agent.agent_id,
      auth_agent_id: worker.agent.agent_id
    }
  );
  assert.equal(compactSecond.ok, true);

  const resetSecond = serverB.callTool(
    'team_context_reset',
    {
      team_id: teamId
    },
    {
      worker_id: worker.agent.agent_id,
      auth_agent_id: worker.agent.agent_id
    }
  );
  assert.equal(resetSecond.ok, true);

  const metadataAfterSecond = asRecord(serverB.store.getTeam(teamId)?.metadata);
  const streamAfterSecond = readWorkerStream(metadataAfterSecond, worker.agent.agent_id);
  const budgetAfterSecond = asRecord(streamAfterSecond.budget);
  assert.equal(Number(budgetAfterSecond.compact_count ?? 0), 2);
  assert.equal(Number(budgetAfterSecond.reset_count ?? 0), 2);
  serverB.store.close();
});
