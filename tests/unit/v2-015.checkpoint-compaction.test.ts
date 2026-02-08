import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerCheckpointTools } from '../../mcp/server/tools/checkpoints.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-015-unit.sqlite';
const logPath = '.tmp/v2-015-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-015 checkpoint compaction prunes context and context reset is resumable', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArtifactTools(server);
  registerCheckpointTools(server);

  const started = server.callTool('team_start', {
    objective: 'checkpoint',
    max_threads: 4,
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  assert.equal(lead.ok, true);
  assert.equal(reviewer.ok, true);

  for (let i = 0; i < 6; i += 1) {
    const sent = server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: lead.agent.agent_id,
      to_agent_id: reviewer.agent.agent_id,
      summary: `checkpoint-message-${i}`,
      artifact_refs: [],
      idempotency_key: `v2-015-msg-${i}`
    });
    assert.equal(sent.ok, true);
  }

  const published = server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_work',
    name: 'Work',
    content: 'artifact payload v1',
    published_by: lead.agent.agent_id
  });
  assert.equal(published.ok, true);

  const compacted = server.callTool('team_checkpoint_compact', {
    team_id: teamId,
    keep_recent_messages: 2,
    keep_recent_events: 40
  });
  assert.equal(compacted.ok, true);
  assert.equal(compacted.compaction.deleted_messages >= 1, true);
  assert.equal(compacted.compaction.footprint_after.message_count <= 2, true);
  assert.equal(compacted.checkpoint.artifact_id, 'artifact_checkpoint_context');

  const checkpointRead = server.callTool('team_artifact_read', {
    team_id: teamId,
    artifact_id: compacted.checkpoint.artifact_id,
    version: compacted.checkpoint.version
  });
  assert.equal(checkpointRead.ok, true);
  assert.equal(checkpointRead.artifact.checksum, compacted.checkpoint.checksum);

  const reset = server.callTool('team_context_reset', {
    team_id: teamId,
    checkpoint_artifact_id: compacted.checkpoint.artifact_id,
    checkpoint_version: compacted.checkpoint.version
  });
  assert.equal(reset.ok, true);
  assert.equal(reset.context_reset.checkpoint_artifact_id, compacted.checkpoint.artifact_id);

  const resumed = server.callTool('team_resume', { team_id: teamId });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.recovery_snapshot.checkpoint.artifact_id, compacted.checkpoint.artifact_id);
  assert.equal(
    resumed.recovery_snapshot.context_reset.checkpoint_checksum,
    compacted.checkpoint.checksum
  );

  server.store.close();
});
