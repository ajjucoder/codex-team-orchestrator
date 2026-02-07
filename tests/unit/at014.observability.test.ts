import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { parseStructuredLogFile, makeRunSummary } from '../../mcp/server/observability.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';

const dbPath = '.tmp/at014-unit.sqlite';
const logPath = '.tmp/at014-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-014 parse structured log file', () => {
  writeFileSync(logPath, '{"event_type":"a"}\n{"event_type":"b"}\n', 'utf8');
  const records = parseStructuredLogFile(logPath);
  assert.equal(records.length, 2);
  assert.equal(records[0].event_type, 'a');
});

test('AT-014 run summary tool returns aggregate metrics', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerObservabilityTools(server);

  const team = server.callTool('team_start', { objective: 'summary test', profile: 'default' });
  const teamId = team.team.team_id;
  server.callTool('team_status', { team_id: teamId });
  const summary = server.callTool('team_run_summary', { team_id: teamId });

  assert.equal(summary.ok, true);
  assert.equal(summary.summary.metrics.agents, 0);
  assert.equal(summary.summary.metrics.messages, 0);
  assert.equal(summary.summary.metrics.events >= 0, true);
  assert.equal(summary.summary.usage.sample_count >= 1, true);

  const direct = makeRunSummary(server.store, teamId);
  assert.equal(direct.team_id, teamId);
  assert.equal(direct.usage.sample_count >= 1, true);

  server.store.close();
});
