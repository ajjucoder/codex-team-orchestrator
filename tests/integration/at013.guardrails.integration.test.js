import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerGuardrailTools } from '../../mcp/server/tools/guardrails.js';

const dbPath = '.tmp/at013-int.sqlite';
const logPath = '.tmp/at013-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-013 integration: idle sweep finalizes stale teams and logs structured events', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerGuardrailTools(server);

  const active = server.callTool('team_start', {
    objective: 'stale team simulation',
    profile: 'fast'
  });

  server.store.db.prepare('UPDATE teams SET last_active_at = ? WHERE team_id = ?').run(
    '2026-02-07T00:00:00.000Z',
    active.team.team_id
  );

  const sweep = server.callTool('team_idle_sweep', {
    now_iso: '2026-02-07T12:00:00.000Z'
  });

  assert.equal(sweep.ok, true);
  assert.equal(sweep.finalized_count, 1);

  const events = server.store.listEvents(active.team.team_id, 20);
  assert.equal(events.some((event) => event.event_type === 'idle_shutdown'), true);

  const logs = readFileSync(logPath, 'utf8');
  assert.match(logs, /tool_call:team_idle_sweep/);
  assert.match(logs, /tool_call:team_guardrail_check|tool_call:team_idle_sweep/);

  server.store.close();
});
