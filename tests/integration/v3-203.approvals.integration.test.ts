import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerArbitrationTools } from '../../mcp/server/tools/arbitration.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';

const dbPath = '.tmp/v3-203-approvals-int.sqlite';
const logPath = '.tmp/v3-203-approvals-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

test('V3-203 integration: approval timeout and chain metadata are replay-auditable', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerArbitrationTools(server);
  registerObservabilityTools(server);

  const team = server.callTool('team_start', { objective: 'approval integration', profile: 'default' });
  const teamId = team.team.team_id as string;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' }).agent.agent_id as string;
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' }).agent.agent_id as string;

  const timedOut = server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'timeout-case',
    strategy: 'lead',
    risk_tier: 'P1',
    lead_agent_id: lead,
    approval_requested_at: '2000-01-01T00:00:00.000Z',
    votes: [{ agent_id: reviewer, decision: 'approve' }],
    approval_chain: [{ agent_id: reviewer, decision: 'approve', reason: 'approved late', decided_at: '2000-01-01T00:10:00.000Z' }]
  });
  assert.equal(timedOut.ok, false);
  assert.match(String(timedOut.error ?? ''), /^approval_gate_failed tier=P1 code=approval_timeout/);

  const replay = server.callTool('team_replay', { team_id: teamId, limit: 200 });
  assert.equal(replay.ok, true);
  const hookEvent = replay.events.find((event: Record<string, unknown>) => event.event_type === 'hook_pre:merge_decide');
  assert.ok(hookEvent);
  const payload = hookEvent?.payload as Record<string, unknown>;
  const traces = Array.isArray(payload?.traces) ? payload.traces : [];
  const approvalTrace = traces.find((trace: Record<string, unknown>) => trace.name === 'builtin_merge_approval_gate');
  assert.ok(approvalTrace);
  const metadata = (approvalTrace as Record<string, unknown>).metadata as Record<string, unknown>;
  assert.equal(Array.isArray(metadata?.approval_chain), true);

  server.store.close();
  cleanup();
});
