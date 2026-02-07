import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { arbitrateMerge } from '../../mcp/server/arbitration.js';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArbitrationTools } from '../../mcp/server/tools/arbitration.js';

const dbPath = '.tmp/at010-unit.sqlite';
const logPath = '.tmp/at010-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-010 consensus requires all approvals', () => {
  const result = arbitrateMerge({
    strategy: 'consensus',
    votes: [
      { agent_id: 'agent_a', decision: 'approve' },
      { agent_id: 'agent_b', decision: 'reject' }
    ]
  });

  assert.equal(result.decision, 'reject');
  assert.match(result.reason, /unanimous/);
});

test('AT-010 lead strategy prioritizes lead vote', () => {
  const result = arbitrateMerge({
    strategy: 'lead',
    lead_agent_id: 'agent_lead',
    votes: [
      { agent_id: 'agent_lead', decision: 'reject' },
      { agent_id: 'agent_a', decision: 'approve' },
      { agent_id: 'agent_b', decision: 'approve' }
    ]
  });

  assert.equal(result.decision, 'reject');
  assert.match(result.reason, /lead decision applied/);
});

test('AT-010 strict_vote enforces >= 2/3 and >= 3 votes', () => {
  const pass = arbitrateMerge({
    strategy: 'strict_vote',
    votes: [
      { agent_id: 'agent_a', decision: 'approve' },
      { agent_id: 'agent_b', decision: 'approve' },
      { agent_id: 'agent_c', decision: 'reject' }
    ]
  });
  assert.equal(pass.decision, 'approve');

  const fail = arbitrateMerge({
    strategy: 'strict_vote',
    votes: [
      { agent_id: 'agent_a', decision: 'approve' },
      { agent_id: 'agent_b', decision: 'reject' }
    ]
  });
  assert.equal(fail.decision, 'reject');
});

test('AT-010 merge decision tool validates team agents', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);

  const team = server.callTool('team_start', { objective: 'merge gate', max_threads: 3 });
  const teamId = team.team.team_id;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const decision = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'proposal-1',
    strategy: 'lead',
    lead_agent_id: lead.agent.agent_id,
    votes: [
      { agent_id: lead.agent.agent_id, decision: 'approve' },
      { agent_id: reviewer.agent.agent_id, decision: 'reject' }
    ]
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.decision, 'approve');

  const invalid = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'proposal-2',
    strategy: 'consensus',
    votes: [
      { agent_id: 'agent_foreign', decision: 'approve' }
    ]
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /not in team/);

  server.store.close();
});
