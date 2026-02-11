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

test('V3-203 unit: duplicate approvals from same agent do not satisfy threshold and metadata reports dedupe counts', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);

  const team = server.callTool('team_start', { objective: 'approval dedupe', profile: 'default' });
  const teamId = team.team.team_id as string;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' }).agent.agent_id as string;
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' }).agent.agent_id as string;
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' }).agent.agent_id as string;

  const blocked = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'p0-duplicate-votes',
    strategy: 'strict_vote',
    risk_tier: 'P0',
    lead_agent_id: lead,
    votes: [
      { agent_id: reviewer, decision: 'approve' },
      { agent_id: tester, decision: 'approve' }
    ],
    approval_chain: [
      { agent_id: reviewer, decision: 'approve', reason: 'first', decided_at: '2026-02-11T10:00:00.000Z' },
      { agent_id: reviewer, decision: 'approve', reason: 'second', decided_at: '2026-02-11T11:00:00.000Z' }
    ]
  });

  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error ?? ''), /^approval_gate_failed tier=P0 code=insufficient_approvals/);
  const traces = Array.isArray(blocked.hook?.traces) ? blocked.hook.traces : [];
  const approvalTrace = traces.find((trace: Record<string, unknown>) => trace.name === 'builtin_merge_approval_gate');
  const metadata = approvalTrace && typeof approvalTrace.metadata === 'object'
    ? approvalTrace.metadata as Record<string, unknown>
    : {};
  assert.equal(metadata.approval_chain_raw_count, 2);
  assert.equal(metadata.approval_chain_unique_count, 1);

  server.store.close();
  cleanup();
});

test('V3-203 unit: latest decision per agent wins when approvals contain duplicates', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);

  const team = server.callTool('team_start', { objective: 'latest decision semantics', profile: 'default' });
  const teamId = team.team.team_id as string;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' }).agent.agent_id as string;
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' }).agent.agent_id as string;

  const blocked = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'p1-latest-reject',
    strategy: 'strict_vote',
    risk_tier: 'P1',
    lead_agent_id: lead,
    votes: [{ agent_id: reviewer, decision: 'approve' }],
    approval_chain: [
      { agent_id: reviewer, decision: 'approve', reason: 'initial', decided_at: '2026-02-11T10:00:00.000Z' },
      { agent_id: reviewer, decision: 'reject', reason: 'latest', decided_at: '2026-02-11T11:00:00.000Z' }
    ]
  });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error ?? ''), /^approval_gate_failed tier=P1 code=insufficient_approvals/);

  const allowed = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'p1-latest-approve',
    strategy: 'consensus',
    risk_tier: 'P1',
    lead_agent_id: lead,
    votes: [{ agent_id: reviewer, decision: 'approve' }],
    approval_chain: [
      { agent_id: reviewer, decision: 'reject', reason: 'initial', decided_at: '2026-02-11T10:00:00.000Z' },
      { agent_id: reviewer, decision: 'approve', reason: 'latest', decided_at: '2026-02-11T11:00:00.000Z' }
    ]
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.decision, 'approve');

  server.store.close();
  cleanup();
});
