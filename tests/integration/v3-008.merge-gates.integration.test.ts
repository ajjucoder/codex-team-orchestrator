import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArbitrationTools } from '../../mcp/server/tools/arbitration.js';
import { registerGuardrailTools } from '../../mcp/server/tools/guardrails.js';

const dbPath = '.tmp/v3-008-int.sqlite';
const logPath = '.tmp/v3-008-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V3-008 integration: integration merge blocks without tester evidence and emits structured gate events', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);
  registerGuardrailTools(server);

  const team = server.callTool('team_start', {
    objective: 'integration merge gating',
    max_threads: 4
  });
  const teamId = team.team.team_id;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });

  assert.equal(lead.ok, true);
  assert.equal(reviewer.ok, true);
  assert.equal(tester.ok, true);

  const merge = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'integration_patch_v3_008',
    strategy: 'lead',
    lead_agent_id: lead.agent.agent_id,
    votes: [
      { agent_id: lead.agent.agent_id, decision: 'approve' },
      { agent_id: reviewer.agent.agent_id, decision: 'approve' }
    ]
  });

  assert.equal(merge.ok, true);
  assert.equal(merge.decision, 'reject');
  assert.equal(merge.blocked, true);
  assert.equal(merge.action, 'block');
  assert.deepEqual(merge.failed_gates, ['tester_pass_evidence']);
  assert.match(String(merge.reason ?? ''), /missing tester approval evidence/);

  const check = server.callTool('team_guardrail_check', {
    team_id: teamId,
    consensus_reached: true,
    open_tasks: 0
  });
  assert.equal(check.ok, true);
  assert.equal(check.merge_gate.gate_id, 'merge_readiness_consensus');
  assert.equal(check.merge_gate.passed, true);

  const events = server.store.listEvents(teamId, 30);
  const mergeGateEvent = events.find((event) => event.event_type === 'merge_gate_decision');
  const guardrailGateEvent = events.find((event) => event.event_type === 'guardrail_gate_decision');

  assert.equal(Boolean(mergeGateEvent), true);
  assert.equal(Boolean(guardrailGateEvent), true);
  assert.equal(mergeGateEvent?.payload.outcome.action, 'block');
  assert.equal(mergeGateEvent?.payload.failed_gates[0], 'tester_pass_evidence');
  assert.equal(guardrailGateEvent?.payload.gate.gate_id, 'merge_readiness_consensus');

  server.store.close();
});

test('V3-008 integration: conflict handling performs deterministic retry then escalation', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);

  const team = server.callTool('team_start', {
    objective: 'integration conflict retry escalation',
    max_threads: 5
  });
  const teamId = team.team.team_id;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewerA = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const reviewerB = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const tester = server.callTool('team_spawn', { team_id: teamId, role: 'tester' });

  const proposalId = 'integration_conflict_v3_008';
  const input = {
    team_id: teamId,
    proposal_id: proposalId,
    strategy: 'strict_vote',
    votes: [
      { agent_id: lead.agent.agent_id, decision: 'approve' },
      { agent_id: reviewerA.agent.agent_id, decision: 'approve' },
      { agent_id: reviewerB.agent.agent_id, decision: 'reject' },
      { agent_id: tester.agent.agent_id, decision: 'approve' }
    ]
  };

  const first = server.callTool('team_merge_decide', input);
  assert.equal(first.ok, true);
  assert.equal(first.decision, 'reject');
  assert.equal(first.action, 'retry');
  assert.equal(first.conflict.retry_attempt, 1);
  assert.equal(first.conflict.next_action, 'retry');

  const second = server.callTool('team_merge_decide', input);
  assert.equal(second.ok, true);
  assert.equal(second.decision, 'reject');
  assert.equal(second.action, 'escalate');
  assert.equal(second.conflict.retry_attempt, 2);
  assert.equal(second.conflict.next_action, 'escalate');

  const gateEvents = server
    .store
    .listEvents(teamId, 40)
    .filter((event) => event.event_type === 'merge_gate_decision' && event.payload.proposal_id === proposalId);

  assert.equal(gateEvents.length >= 2, true);
  const latest = gateEvents[0];
  assert.equal(latest.payload.outcome.action, 'escalate');
  assert.equal(latest.payload.conflict.next_action, 'escalate');

  server.store.close();
});
