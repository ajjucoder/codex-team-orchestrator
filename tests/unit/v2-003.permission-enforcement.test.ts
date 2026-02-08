import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { evaluatePermissionDecision } from '../../mcp/server/permission-profiles.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-003-unit.sqlite';
const logPath = '.tmp/v2-003-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-003 evaluatePermissionDecision supports per-action overrides', () => {
  const policy = {
    permissions: {
      profiles: {
        execute: {
          allow_all_tools: false,
          tools: {
            team_task_update: false,
            'team_task_update:status:done': true
          }
        }
      },
      role_binding: {
        default: 'execute'
      }
    }
  } as unknown as Record<string, unknown>;

  const done = evaluatePermissionDecision({
    policy,
    role: 'implementer',
    tool_name: 'team_task_update',
    action: 'status:done'
  });
  assert.equal(done.allowed, true);
  assert.equal(done.matched_rule, 'team_task_update:status:done');

  const inProgress = evaluatePermissionDecision({
    policy,
    role: 'implementer',
    tool_name: 'team_task_update',
    action: 'status:in_progress'
  });
  assert.equal(inProgress.allowed, false);
  assert.equal(inProgress.matched_rule, 'team_task_update');
});

test('V2-003 server enforces per-agent permission profile at runtime', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  server.policyEngine.cache.set('secure-runtime', {
    profile: 'secure-runtime',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    permissions: {
      profiles: {
        unrestricted: {
          allow_all_tools: true
        },
        read_only: {
          allow_all_tools: false,
          tools: {
            team_status: true
          }
        }
      },
      role_binding: {
        default: 'read_only',
        lead: 'unrestricted'
      }
    }
  });

  const started = server.callTool('team_start', {
    objective: 'runtime enforcement',
    profile: 'secure-runtime'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const reviewer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(reviewer.ok, true);

  const deniedSpawn = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'tester'
  }, {
    auth_agent_id: reviewer.agent.agent_id
  });
  assert.equal(deniedSpawn.ok, false);
  assert.match(String(deniedSpawn.error ?? deniedSpawn.errors?.[0] ?? ''), /denies team_spawn|does not allow team_spawn/);

  const allowedStatus = server.callTool('team_status', {
    team_id: teamId
  }, {
    auth_agent_id: reviewer.agent.agent_id
  });
  assert.equal(allowedStatus.ok, true);

  server.store.close();
});
