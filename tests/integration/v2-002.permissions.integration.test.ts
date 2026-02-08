import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerPolicyTools } from '../../mcp/server/tools/policies.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/v2-002-int.sqlite';
const logPath = '.tmp/v2-002-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-002 integration: v2 permission bindings apply deterministic profile names on spawn', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerPolicyTools(server);
  registerAgentLifecycleTools(server);

  server.policyEngine.cache.set('secure', {
    profile: 'secure',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    permissions: {
      profiles: {
        unrestricted: {
          allow_all_tools: true
        },
        safe_read: {
          allow_all_tools: false,
          tools: {
            team_status: true,
            team_policy_get: true
          }
        },
        review_only: {
          allow_all_tools: false,
          tools: {
            team_status: true,
            team_policy_get: true,
            team_run_summary: true
          }
        }
      },
      role_binding: {
        default: 'safe_read',
        reviewer: 'review_only'
      }
    }
  });

  const team = server.callTool('team_start', {
    objective: 'permission mapping integration',
    profile: 'secure'
  });
  assert.equal(team.ok, true);

  const reviewer = server.callTool('team_spawn', {
    team_id: team.team.team_id,
    role: 'reviewer'
  });
  const planner = server.callTool('team_spawn', {
    team_id: team.team.team_id,
    role: 'planner'
  });

  assert.equal(reviewer.ok, true);
  assert.equal(planner.ok, true);
  assert.equal(reviewer.agent.metadata.permission_profile, 'review_only');
  assert.equal(planner.agent.metadata.permission_profile, 'safe_read');

  server.store.close();
});

test('V2-002 integration: policy swap rejects invalid permission profile config', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerPolicyTools(server);

  server.policyEngine.cache.set('invalid-permissions', {
    profile: 'invalid-permissions',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    permissions: {
      profiles: {
        broken: {
          allow_all_tools: 1
        }
      },
      role_binding: {
        default: 'broken'
      }
    }
  });

  const team = server.callTool('team_start', {
    objective: 'policy validation integration',
    profile: 'default'
  });
  assert.equal(team.ok, true);

  const swap = server.callTool('team_policy_set_profile', {
    team_id: team.team.team_id,
    profile: 'invalid-permissions'
  });
  assert.equal(swap.ok, false);
  assert.match(swap.error, /invalid permissions config/);

  server.store.close();
});
