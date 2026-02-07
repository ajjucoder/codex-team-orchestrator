import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

test('AT-019 integration: smoke scripts validate fanout bands and hard cap', () => {
  const small = execFileSync('bash', ['./scripts/smoke.sh', 'small'], { encoding: 'utf8' });
  const medium = execFileSync('bash', ['./scripts/smoke.sh', 'medium'], { encoding: 'utf8' });
  const high = execFileSync('bash', ['./scripts/smoke.sh', 'high'], { encoding: 'utf8' });

  assert.match(small, /smoke:ok/);
  assert.match(medium, /smoke:ok/);
  assert.match(high, /smoke:ok/);
  assert.match(high, /smoke:threads=5|smoke:threads=6/);
});

test('AT-019 integration: cross-team messaging is denied while in-team messaging is allowed', () => {
  const dbPath = '.tmp/at019-cross-team-int.sqlite';
  const logPath = '.tmp/at019-cross-team-int.log';
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });

  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  const teamA = server.callTool('team_start', { objective: 'A', max_threads: 3 });
  const teamB = server.callTool('team_start', { objective: 'B', max_threads: 3 });
  const a1 = server.callTool('team_spawn', { team_id: teamA.team.team_id, role: 'lead' });
  const a2 = server.callTool('team_spawn', { team_id: teamA.team.team_id, role: 'reviewer' });
  const b1 = server.callTool('team_spawn', { team_id: teamB.team.team_id, role: 'implementer' });

  const cross = server.callTool('team_send', {
    team_id: teamA.team.team_id,
    from_agent_id: b1.agent.agent_id,
    to_agent_id: a2.agent.agent_id,
    summary: 'cross-team',
    artifact_refs: [],
    idempotency_key: 'at019-cross'
  });
  assert.equal(cross.ok, false);
  assert.match(cross.error, /from_agent not in team/);

  const valid = server.callTool('team_send', {
    team_id: teamA.team.team_id,
    from_agent_id: a1.agent.agent_id,
    to_agent_id: a2.agent.agent_id,
    summary: 'in-team',
    artifact_refs: [],
    idempotency_key: 'at019-valid'
  });
  assert.equal(valid.ok, true);

  server.store.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});
