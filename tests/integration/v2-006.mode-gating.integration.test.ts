import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-006-int.sqlite';
const logPath = '.tmp/v2-006-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-006 integration: plan/delegate/default mode gates are enforced', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const started = server.callTool('team_start', {
    objective: 'mode gating',
    profile: 'default'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'lead'
  });
  assert.equal(lead.ok, true);

  const implementer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(implementer.ok, true);

  const planMode = server.store.updateTeamMode(teamId, 'plan');
  assert.equal(planMode?.mode, 'plan');

  const blockedSpawn = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'tester'
  });
  assert.equal(blockedSpawn.ok, false);
  assert.match(String(blockedSpawn.error ?? ''), /plan mode blocks execution tool team_spawn/);

  const delegateMode = server.store.updateTeamMode(teamId, 'delegate');
  assert.equal(delegateMode?.mode, 'delegate');

  const taskDelegate = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'delegate claim',
    priority: 1
  });
  assert.equal(taskDelegate.ok, true);

  const leadClaimDenied = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskDelegate.task.task_id,
    agent_id: lead.agent.agent_id,
    expected_lock_version: taskDelegate.task.lock_version
  }, {
    auth_agent_id: lead.agent.agent_id
  });
  assert.equal(leadClaimDenied.ok, false);
  assert.match(String(leadClaimDenied.error ?? ''), /delegate mode blocks lead/);

  const implementerClaim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskDelegate.task.task_id,
    agent_id: implementer.agent.agent_id,
    expected_lock_version: taskDelegate.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(implementerClaim.ok, true);

  const defaultMode = server.store.updateTeamMode(teamId, 'default');
  assert.equal(defaultMode?.mode, 'default');

  const taskDefault = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'default claim',
    priority: 1
  });
  assert.equal(taskDefault.ok, true);

  const leadClaimAllowed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: taskDefault.task.task_id,
    agent_id: lead.agent.agent_id,
    expected_lock_version: taskDefault.task.lock_version
  }, {
    auth_agent_id: lead.agent.agent_id
  });
  assert.equal(leadClaimAllowed.ok, true);

  server.store.close();
});
