import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';
import { registerAgentLifecycleTools as registerMessagingTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/at008-int.sqlite';
const logPath = '.tmp/at008-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-008 integration: published artifact refs are exchanged via compact messages', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerMessagingTools(server);
  registerArtifactTools(server);

  const team = server.callTool('team_start', { objective: 'artifact exchange', max_threads: 3 });
  const teamId = team.team.team_id;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const worker = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });

  const artifact = server.callTool('team_artifact_publish', {
    team_id: teamId,
    name: 'Patch',
    content: 'diff --git a b',
    published_by: lead.agent.agent_id
  });
  assert.equal(artifact.ok, true);

  const send = server.callTool('team_send', {
    team_id: teamId,
    from_agent_id: lead.agent.agent_id,
    to_agent_id: worker.agent.agent_id,
    summary: 'review patch artifact',
    artifact_refs: [{ artifact_id: artifact.artifact.artifact_id, version: artifact.artifact.version }],
    idempotency_key: 'artifact-msg-1'
  });
  assert.equal(send.ok, true);

  const inbox = server.callTool('team_pull_inbox', {
    team_id: teamId,
    agent_id: worker.agent.agent_id,
    ack: true
  });

  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].payload.artifact_refs.length, 1);
  assert.equal(inbox.messages[0].payload.summary, 'review patch artifact');

  const read = server.callTool('team_artifact_read', {
    team_id: teamId,
    artifact_id: inbox.messages[0].payload.artifact_refs[0].artifact_id,
    version: inbox.messages[0].payload.artifact_refs[0].version
  });
  assert.equal(read.ok, true);
  assert.equal(read.artifact.content, 'diff --git a b');

  server.store.close();
});
