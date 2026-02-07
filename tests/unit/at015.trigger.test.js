import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { hasAgentTeamsTrigger, extractObjectiveFromPrompt, REQUIRED_TRIGGER_PHRASE } from '../../mcp/server/trigger.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTriggerTools } from '../../mcp/server/tools/trigger.js';

const dbPath = '.tmp/at015-unit.sqlite';
const logPath = '.tmp/at015-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-015 trigger detection is case-insensitive and exact phrase-based', () => {
  assert.equal(hasAgentTeamsTrigger('Please USE AGENT TEAMS for this run'), true);
  assert.equal(hasAgentTeamsTrigger('use teams'), false);
  assert.equal(REQUIRED_TRIGGER_PHRASE, 'use agent teams');
});

test('AT-015 objective extraction removes trigger phrase', () => {
  const objective = extractObjectiveFromPrompt('use agent teams implement ticket AT-015');
  assert.equal(objective, 'implement ticket AT-015');
});

test('AT-015 trigger tool starts team automatically', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerTriggerTools(server);

  const result = server.callTool('team_trigger', {
    prompt: 'use agent teams build release candidate',
    profile: 'fast',
    active_session_model: 'gpt-5-codex'
  });

  assert.equal(result.ok, true);
  assert.equal(result.triggered, true);
  assert.match(result.team.team_id, /^team_/);
  assert.equal(result.team.session_model, 'gpt-5-codex');

  server.store.close();
});
