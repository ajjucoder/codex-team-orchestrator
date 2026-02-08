import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-004-int.sqlite';
const logPath = '.tmp/v2-004-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-004 integration: replay contains deterministic permission audit trail', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerObservabilityTools(server);

  server.policyEngine.cache.set('audit-secure', {
    profile: 'audit-secure',
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
    objective: 'replay permissions',
    profile: 'audit-secure'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const reviewer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(reviewer.ok, true);

  const denied = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'tester'
  }, {
    auth_agent_id: reviewer.agent.agent_id
  });
  assert.equal(denied.ok, false);

  const replay = server.callTool('team_replay', {
    team_id: teamId,
    limit: 200
  });
  assert.equal(replay.ok, true);

  const permissionEvent = replay.events.find((event: Record<string, unknown>) => {
    if (event.event_type !== 'permission_decision:team_spawn') return false;
    const payload = event.payload as Record<string, unknown>;
    return typeof payload.deny_reason === 'string' && payload.deny_reason.length > 0;
  });
  assert.ok(permissionEvent);
  const decisionPayload = permissionEvent.payload as Record<string, unknown>;
  assert.equal(decisionPayload.source_profile, 'read_only');
  assert.equal(decisionPayload.matched_rule, 'implicit_deny');
  assert.match(String(decisionPayload.deny_reason ?? ''), /does not allow team_spawn/);

  const toolCallEvent = replay.events.find((event: Record<string, unknown>) => {
    if (event.event_type !== 'tool_call:team_spawn') return false;
    const payload = event.payload as Record<string, unknown>;
    return payload.ok === false;
  });
  assert.ok(toolCallEvent);
  const toolPermission = (toolCallEvent.payload as Record<string, unknown>).permission as Record<string, unknown>;
  assert.equal(toolPermission.source_profile, decisionPayload.source_profile);
  assert.equal(toolPermission.matched_rule, decisionPayload.matched_rule);
  assert.equal(toolPermission.deny_reason, decisionPayload.deny_reason);

  server.store.close();
});
