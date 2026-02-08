import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-003-int.sqlite';
const logPath = '.tmp/v2-003-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-003 integration: allow/deny matrix enforces per-action runtime permissions', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  server.policyEngine.cache.set('action-secure', {
    profile: 'action-secure',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    permissions: {
      profiles: {
        lead_all: {
          allow_all_tools: true
        },
        implementer_limited: {
          allow_all_tools: false,
          tools: {
            team_task_claim: true,
            team_task_update: false,
            'team_task_update:status:done': true
          }
        }
      },
      role_binding: {
        default: 'implementer_limited',
        lead: 'lead_all',
        implementer: 'implementer_limited'
      }
    }
  });

  const started = server.callTool('team_start', {
    objective: 'permission matrix',
    profile: 'action-secure'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const implementer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(implementer.ok, true);

  const task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'execute update',
    priority: 1
  });
  assert.equal(task.ok, true);

  const claimed = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: implementer.agent.agent_id,
    expected_lock_version: task.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(claimed.ok, true);

  const deniedIntermediateUpdate = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task.task_id,
    status: 'in_progress',
    expected_lock_version: claimed.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(deniedIntermediateUpdate.ok, false);
  assert.match(String(deniedIntermediateUpdate.error ?? ''), /team_task_update/);

  const doneUpdate = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task.task_id,
    status: 'done',
    expected_lock_version: claimed.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(doneUpdate.ok, true);
  assert.equal(doneUpdate.task.status, 'done');

  server.store.close();
});
