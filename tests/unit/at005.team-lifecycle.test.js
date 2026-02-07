import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/at005-unit.sqlite';
const logPath = '.tmp/at005-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-005 team_start creates active team with model inheritance', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const result = server.callTool('team_start', {
    objective: 'deliver milestone',
    profile: 'default',
    max_threads: 4
  }, {
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(result.ok, true);
  assert.match(result.team.team_id, /^team_/);
  assert.equal(result.team.status, 'active');
  assert.equal(result.team.session_model, 'gpt-5-codex');
  assert.equal(result.team.max_threads, 4);

  server.store.close();
});

test('AT-005 team_status and finalize transition lifecycle state', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);

  const started = server.callTool('team_start', {
    objective: 'close ticket',
    profile: 'fast',
    max_threads: 2
  });
  const teamId = started.team.team_id;

  const status = server.callTool('team_status', { team_id: teamId });
  assert.equal(status.ok, true);
  assert.equal(status.team.status, 'active');

  const finalized = server.callTool('team_finalize', { team_id: teamId, reason: 'done' });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.team.status, 'finalized');

  const statusAfter = server.callTool('team_status', { team_id: teamId });
  assert.equal(statusAfter.team.status, 'finalized');

  server.store.close();
});
