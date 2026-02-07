import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArtifactTools } from '../../mcp/server/tools/artifacts.js';

const dbPath = '.tmp/at008-unit.sqlite';
const logPath = '.tmp/at008-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

function setup() {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArtifactTools(server);

  const team = server.callTool('team_start', {
    objective: 'artifact flow',
    max_threads: 2
  });

  return {
    server,
    teamId: team.team.team_id
  };
}

test('AT-008 publish increments versions and checksum tracks content', () => {
  const { server, teamId } = setup();

  const first = server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_patchset',
    name: 'Patch Set',
    content: 'v1-content'
  });
  assert.equal(first.ok, true);
  assert.equal(first.artifact.version, 1);

  const second = server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_patchset',
    name: 'Patch Set',
    content: 'v2-content'
  });
  assert.equal(second.ok, true);
  assert.equal(second.artifact.version, 2);
  assert.notEqual(second.artifact.checksum, first.artifact.checksum);

  server.store.close();
});

test('AT-008 read latest/version and list latest artifacts', () => {
  const { server, teamId } = setup();

  server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_doc',
    name: 'Doc',
    content: 'draft'
  });

  server.callTool('team_artifact_publish', {
    team_id: teamId,
    artifact_id: 'artifact_doc',
    name: 'Doc',
    content: 'final'
  });

  const latest = server.callTool('team_artifact_read', {
    team_id: teamId,
    artifact_id: 'artifact_doc'
  });
  assert.equal(latest.ok, true);
  assert.equal(latest.artifact.version, 2);
  assert.equal(latest.artifact.content, 'final');

  const v1 = server.callTool('team_artifact_read', {
    team_id: teamId,
    artifact_id: 'artifact_doc',
    version: 1
  });
  assert.equal(v1.ok, true);
  assert.equal(v1.artifact.content, 'draft');

  const listed = server.callTool('team_artifact_list', { team_id: teamId });
  assert.equal(listed.ok, true);
  assert.equal(listed.artifacts.length, 1);
  assert.equal(listed.artifacts[0].version, 2);

  server.store.close();
});
