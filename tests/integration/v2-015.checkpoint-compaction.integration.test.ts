import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerCheckpointTools } from '../../mcp/server/tools/checkpoints.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-015-int.sqlite';
const logPath = '.tmp/v2-015-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-015 integration: compaction and reset preserve checkpoint recoverability', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArtifactTools(server);
  registerObservabilityTools(server);
  registerCheckpointTools(server);

  const started = server.callTool('team_start', {
    objective: 'integration checkpoint',
    max_threads: 4,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(implementer.ok, true);

  for (let i = 0; i < 8; i += 1) {
    const sent = server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: lead.agent.agent_id,
      to_agent_id: implementer.agent.agent_id,
      summary: `integration-message-${i}`,
      artifact_refs: [],
      idempotency_key: `v2-015-int-msg-${i}`
    });
    assert.equal(sent.ok, true);
  }

  const artifactV1 = server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_patch',
    name: 'Patch',
    content: 'patch-v1',
    published_by: lead.agent.agent_id
  });
  const artifactV2 = server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_patch',
    name: 'Patch',
    content: 'patch-v2',
    published_by: lead.agent.agent_id
  });
  assert.equal(artifactV1.ok, true);
  assert.equal(artifactV2.ok, true);

  const compacted = server.callTool('team_checkpoint_compact', {
    team_id: teamId,
    keep_recent_messages: 1,
    keep_recent_events: 30
  });
  assert.equal(compacted.ok, true);
  assert.equal(compacted.compaction.deleted_messages >= 1, true);
  assert.equal(compacted.compaction.footprint_after.message_count <= 1, true);

  const reset = server.callTool('team_context_reset', {
    team_id: teamId
  });
  assert.equal(reset.ok, true);

  const resumed = server.callTool('team_resume', { team_id: teamId });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.recovery_snapshot.checkpoint.artifact_id, 'artifact_checkpoint_context');
  assert.equal(
    resumed.recovery_snapshot.context_reset.checkpoint_checksum,
    resumed.recovery_snapshot.checkpoint.checksum
  );

  const checkpoint = server.callTool('team_artifact_read', {
    team_id: teamId,
    artifact_id: resumed.recovery_snapshot.checkpoint.artifact_id,
    version: resumed.recovery_snapshot.checkpoint.version
  });
  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.artifact.checksum, resumed.recovery_snapshot.checkpoint.checksum);

  const latestPatch = server.callTool('team_artifact_read', {
    team_id: teamId,
    artifact_id: 'artifact_patch'
  });
  assert.equal(latestPatch.ok, true);
  assert.equal(latestPatch.artifact.version, 2);

  const replay = server.callTool('team_replay', { team_id: teamId, limit: 100 });
  assert.equal(replay.ok, true);
  assert.equal(replay.event_count > 0, true);

  server.store.close();
});
