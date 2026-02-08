import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-004-unit.sqlite';
const logPath = '.tmp/v2-004-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-004 permission decision metadata is emitted in store events and logs', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);

  server.policyEngine.cache.set('audit-profile', {
    profile: 'audit-profile',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    permissions: {
      profiles: {
        read_only: {
          allow_all_tools: false,
          tools: {
            team_status: true
          }
        }
      },
      role_binding: {
        default: 'read_only'
      }
    }
  });

  const started = server.callTool('team_start', {
    objective: 'permission observability',
    profile: 'audit-profile'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const reviewer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(reviewer.ok, true);

  const status = server.callTool('team_status', {
    team_id: teamId
  }, {
    auth_agent_id: reviewer.agent.agent_id
  });
  assert.equal(status.ok, true);

  const events = server.store.listEvents(teamId, 50);
  const permissionEvent = events.find((event) => event.event_type === 'permission_decision:team_status');
  assert.ok(permissionEvent);
  const permissionPayload = permissionEvent?.payload as Record<string, unknown>;
  assert.equal(permissionPayload.source_profile, 'read_only');
  assert.equal(permissionPayload.matched_rule, 'team_status');
  assert.equal(permissionPayload.deny_reason, null);

  const toolCallEvent = events.find((event) => event.event_type === 'tool_call:team_status');
  assert.ok(toolCallEvent);
  const toolPayload = toolCallEvent?.payload as Record<string, unknown>;
  const permission = toolPayload.permission as Record<string, unknown>;
  assert.equal(permission.source_profile, 'read_only');
  assert.equal(permission.matched_rule, 'team_status');

  const logText = readFileSync(logPath, 'utf8');
  assert.match(logText, /permission_decision:team_status/);
  assert.match(logText, /"source_profile":"read_only"/);

  server.store.close();
});
