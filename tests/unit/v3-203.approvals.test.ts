import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArbitrationTools } from '../../mcp/server/tools/arbitration.js';

const dbPath = '.tmp/v3-203-approvals-unit.sqlite';
const logPath = '.tmp/v3-203-approvals-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-203 unit: risk-tier approval hook blocks high-risk merge decisions with insufficient approvals', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);

  const team = server.callTool('team_start', { objective: 'approval unit', profile: 'default' });
  const teamId = team.team.team_id as string;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' }).agent.agent_id as string;
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' }).agent.agent_id as string;
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' }).agent.agent_id as string;

  const blocked = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'p0-blocked',
    strategy: 'strict_vote',
    risk_tier: 'P0',
    lead_agent_id: lead,
    votes: [{ agent_id: reviewer, decision: 'approve' }],
    approval_chain: [{ agent_id: reviewer, decision: 'approve', reason: 'looks good', decided_at: new Date().toISOString() }]
  });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error ?? ''), /^approval_gate_failed tier=P0 code=insufficient_approvals/);

  const passed = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'p0-pass',
    strategy: 'strict_vote',
    risk_tier: 'P0',
    lead_agent_id: lead,
    votes: [
      { agent_id: reviewer, decision: 'approve' },
      { agent_id: tester, decision: 'approve' },
      { agent_id: lead, decision: 'approve' }
    ],
    approval_chain: [
      { agent_id: reviewer, decision: 'approve', reason: 'review pass', decided_at: new Date().toISOString() },
      { agent_id: tester, decision: 'approve', reason: 'tests pass', decided_at: new Date().toISOString() }
    ]
  });
  assert.equal(passed.ok, true);
  assert.equal(passed.decision, 'approve');

  server.store.close();
  cleanup();
});
