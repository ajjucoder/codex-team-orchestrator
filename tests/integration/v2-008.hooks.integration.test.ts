import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-008-int.sqlite';
const logPath = '.tmp/v2-008-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-008 integration: lifecycle hook points execute for spawn/claim/complete/finalize/resume', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  const seen: string[] = [];
  for (const event of ['spawn', 'task_claim', 'task_complete', 'finalize', 'resume']) {
    server.hookEngine?.register({
      name: `pre_${event}`,
      event,
      phase: 'pre',
      order: 10,
      handler: () => {
        seen.push(`pre:${event}`);
        return { allow: true };
      }
    });
    server.hookEngine?.register({
      name: `post_${event}`,
      event,
      phase: 'post',
      order: 10,
      handler: () => {
        seen.push(`post:${event}`);
        return { allow: true };
      }
    });
  }

  const started = server.callTool('team_start', { objective: 'hook points', profile: 'default' });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
  const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
  assert.equal(lead.ok, true);
  assert.equal(implementer.ok, true);

  const createdTask = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'complete hook path',
    priority: 1
  });
  assert.equal(createdTask.ok, true);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: createdTask.task.task_id,
    agent_id: implementer.agent.agent_id,
    expected_lock_version: createdTask.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(claimed.ok, true);

  const completed = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: createdTask.task.task_id,
    status: 'done',
    expected_lock_version: claimed.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(completed.ok, true);

  const finalized = server.callTool('team_finalize', {
    team_id: teamId,
    reason: 'done'
  }, {
    agent_id: lead.agent.agent_id
  });
  assert.equal(finalized.ok, true);

  const resumed = server.callTool('team_resume', { team_id: teamId });
  assert.equal(resumed.ok, true);

  for (const key of ['pre:spawn', 'post:spawn', 'pre:task_claim', 'post:task_claim', 'pre:task_complete', 'post:task_complete', 'pre:finalize', 'post:finalize', 'pre:resume', 'post:resume']) {
    assert.equal(seen.includes(key), true, `missing hook trace ${key}`);
  }

  server.store.close();
});

test('V2-008 integration: blocking pre-hook rejects unsafe operation with trace', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  server.hookEngine?.register({
    name: 'block_spawn',
    event: 'spawn',
    phase: 'pre',
    handler: () => ({
      allow: false,
      reason: 'blocked by safety hook'
    })
  });

  const started = server.callTool('team_start', { objective: 'block spawn', profile: 'default' });
  assert.equal(started.ok, true);

  const blocked = server.callTool('team_spawn', { team_id: started.team.team_id, role: 'lead' });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error ?? ''), /blocked by safety hook/);
  assert.equal(blocked.hook.phase, 'pre');
  assert.equal(blocked.hook.blocked_by, 'block_spawn');
  assert.equal(Array.isArray(blocked.hook.traces), true);

  server.store.close();
});
