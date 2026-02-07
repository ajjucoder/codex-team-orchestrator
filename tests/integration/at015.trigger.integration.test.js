import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTriggerTools } from '../../mcp/server/tools/trigger.js';

const dbPath = '.tmp/at015-int.sqlite';
const logPath = '.tmp/at015-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-015 integration: trigger phrase creates orchestration team and logs invocation', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTriggerTools(server);

  const triggered = server.callTool('team_trigger', {
    prompt: 'use agent teams deliver milestone M4',
    profile: 'default',
    max_threads: 4,
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(triggered.ok, true);
  assert.equal(triggered.triggered, true);

  const status = server.callTool('team_status', { team_id: triggered.team.team_id });
  assert.equal(status.ok, true);
  assert.equal(status.team.status, 'active');

  const logs = readFileSync(logPath, 'utf8');
  assert.match(logs, /tool_call:team_trigger/);
  assert.match(logs, /tool_call:team_start/);

  server.store.close();
});
