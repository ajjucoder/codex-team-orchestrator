import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerArbitrationTools } from '../../mcp/server/tools/arbitration.js';

const dbPath = '.tmp/v3-108-replay-int.sqlite';
const logPath = '.tmp/v3-108-replay-int.log';
const outA = '.tmp/v3-108-replay-audit-a.json';
const outB = '.tmp/v3-108-replay-audit-b.json';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
  rmSync(outA, { force: true });
  rmSync(outB, { force: true });
}

test('V3-108 integration: replay audit script yields stable digest across repeated runs', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);
  registerArbitrationTools(server);

  const started = server.callTool('team_start', { objective: 'replay forensics', max_threads: 3 });
  const teamId = started.team.team_id as string;
  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' }).agent.agent_id as string;
  const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' }).agent.agent_id as string;
  const task = server.callTool('team_task_create', { team_id: teamId, title: 'forensic-task', priority: 1 }).task;
  const claim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task_id,
    agent_id: reviewer,
    expected_lock_version: task.lock_version
  });
  assert.equal(claim.ok, true);
  server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task_id,
    status: 'done',
    expected_lock_version: claim.task.lock_version,
    quality_checks_passed: true,
    artifact_refs_count: 1
  });
  server.callTool('team_merge_decide', {
    team_id: teamId,
    proposal_id: 'proposal-forensics',
    strategy: 'lead',
    lead_agent_id: lead,
    votes: [{ agent_id: lead, decision: 'approve' }]
  });
  server.store.close();

  const first = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/replay-audit.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--out',
    outA
  ], { encoding: 'utf8' });
  assert.match(first, /replay-audit:ok/);

  const second = execFileSync('node', [
    '--import',
    'tsx',
    'scripts/replay-audit.ts',
    '--db',
    dbPath,
    '--team',
    teamId,
    '--out',
    outB
  ], { encoding: 'utf8' });
  assert.match(second, /replay-audit:ok/);

  const reportA = JSON.parse(readFileSync(outA, 'utf8')) as Record<string, unknown>;
  const reportB = JSON.parse(readFileSync(outB, 'utf8')) as Record<string, unknown>;
  assert.equal(typeof reportA.digest, 'string');
  assert.equal(reportA.digest, reportB.digest);
  assert.equal(Number(reportA.event_count) > 0, true);

  cleanup();
});
