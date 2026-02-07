import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { compactPayload, evaluateEarlyStop, evaluateIdleTeams } from '../../mcp/server/guardrails.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerGuardrailTools } from '../../mcp/server/tools/guardrails.js';

const dbPath = '.tmp/at013-unit.sqlite';
const logPath = '.tmp/at013-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-013 compact payload keeps summary + artifact refs only', () => {
  const payload = compactPayload('summary', [{ artifact_id: 'artifact_a', version: 1 }]);
  assert.deepEqual(payload, {
    summary: 'summary',
    artifact_refs: [{ artifact_id: 'artifact_a', version: 1 }]
  });
});

test('AT-013 early stop triggers on consensus + no open tasks', () => {
  const decision = evaluateEarlyStop({
    policy: { guardrails: { early_stop_on_consensus: true } },
    consensus_reached: true,
    open_tasks: 0
  });
  assert.equal(decision.should_stop, true);
});

test('AT-013 idle evaluator identifies stale teams by profile thresholds', () => {
  const nowMs = Date.parse('2026-02-07T12:00:00.000Z');
  const teams = [
    { team_id: 'team_a', profile: 'fast', last_active_at: '2026-02-07T11:50:00.000Z' },
    { team_id: 'team_b', profile: 'deep', last_active_at: '2026-02-07T11:58:30.000Z' }
  ];

  const stale = evaluateIdleTeams({
    teams,
    nowMs,
    policyByProfile: (profile) => {
      if (profile === 'fast') return { budgets: { idle_shutdown_ms: 300000 } };
      return { budgets: { idle_shutdown_ms: 120000 } };
    }
  });

  assert.equal(stale.length, 1);
  assert.equal(stale[0].team_id, 'team_a');
});

test('AT-013 guardrail tools enforce early stop and idle shutdown', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerGuardrailTools(server);

  const team = server.callTool('team_start', {
    objective: 'guardrail checks',
    profile: 'fast'
  });
  const teamId = team.team.team_id;

  const check = server.callTool('team_guardrail_check', {
    team_id: teamId,
    consensus_reached: true,
    open_tasks: 0
  });
  assert.equal(check.ok, true);
  assert.equal(check.early_stop.should_stop, true);

  server.store.db.prepare('UPDATE teams SET last_active_at = ? WHERE team_id = ?').run('2026-02-07T00:00:00.000Z', teamId);

  const sweep = server.callTool('team_idle_sweep', {
    now_iso: '2026-02-07T12:00:00.000Z'
  });
  assert.equal(sweep.ok, true);
  assert.equal(sweep.finalized_count, 1);

  const updated = server.store.getTeam(teamId);
  assert.equal(updated.status, 'finalized');

  server.store.close();
});
