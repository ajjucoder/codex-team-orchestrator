import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';

const dbPath = '.tmp/at004-int.sqlite';
const logPath = '.tmp/at004-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-004 integration: server logs structured tool events', () => {
  const server = createServer({ dbPath, logPath });
  server.start();

  server.registerTool('team_start', 'team_start.schema.json', (input) => ({
    ok: true,
    profile: input.profile ?? 'default'
  }));

  const result = server.callTool('team_start', {
    objective: 'implement health checks',
    profile: 'default',
    session_model: 'gpt-5'
  }, {
    team_id: 'team_demo',
    agent_id: 'agent_lead'
  });

  assert.equal(result.ok, true);

  const events = server.store.listEvents('team_demo', 20);
  assert.equal(events.length >= 1, true);
  assert.match(events[0].event_type, /tool_call:team_start/);

  const logText = readFileSync(logPath, 'utf8');
  assert.match(logText, /tool_call:team_start/);

  server.store.close();
});
