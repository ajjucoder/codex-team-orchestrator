import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArbitrationTools } from '../../mcp/server/tools/arbitration.js';

const dbPath = '.tmp/at010-int.sqlite';
const logPath = '.tmp/at010-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('AT-010 integration: arbitration decision persisted in structured events', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);

  const team = server.callTool('team_start', {
    objective: 'arbitrate merge',
    max_threads: 4
  });
  const teamId = team.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const reviewerA = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
  const reviewerB = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });

  const decision = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'artifact_patch_v3',
    strategy: 'strict_vote',
    votes: [
      { agent_id: lead.agent.agent_id, decision: 'approve' },
      { agent_id: reviewerA.agent.agent_id, decision: 'approve' },
      { agent_id: reviewerB.agent.agent_id, decision: 'reject' }
    ]
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.decision, 'approve');

  const events = server.store.listEvents(teamId, 20);
  assert.equal(events.some((event) => event.event_type === 'merge_decision'), true);

  const logs = readFileSync(logPath, 'utf8');
  assert.match(logs, /tool_call:team_merge_decide/);

  server.store.close();
});
