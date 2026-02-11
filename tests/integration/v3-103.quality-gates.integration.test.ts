import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v3-103-int.sqlite';
const logPath = '.tmp/v3-103-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V3-103 integration: team_task_update enforces tiered quality gates with deterministic failure reasons', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  server.policyEngine.cache.set('quality-tiered', {
    profile: 'quality-tiered',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    quality: {
      default_risk_tier: 'P2',
      by_risk_tier: {
        P0: {
          require_tests_before_complete: true,
          require_compliance_ack: true,
          min_artifact_refs: 2
        },
        P1: {
          require_tests_before_complete: true,
          require_compliance_ack: false,
          min_artifact_refs: 1
        },
        P2: {
          require_tests_before_complete: false,
          require_compliance_ack: false,
          min_artifact_refs: 0
        }
      }
    },
    permissions: {
      profiles: {
        unrestricted: { allow_all_tools: true }
      },
      role_binding: {
        default: 'unrestricted'
      }
    }
  });

  const started = server.callTool('team_start', {
    objective: 'tiered quality gate enforcement',
    profile: 'quality-tiered'
  });
  assert.equal(started.ok, true);
  const teamId = started.team.team_id;

  const implementer = server.callTool('team_spawn', {
    team_id: teamId,
    role: 'implementer'
  });
  assert.equal(implementer.ok, true);
  const implementerId = implementer.agent.agent_id;

  const p1Task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'CTO-P1-100 quality gated completion',
    priority: 1
  });
  assert.equal(p1Task.ok, true);

  const p1Claim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: p1Task.task.task_id,
    agent_id: implementerId,
    expected_lock_version: p1Task.task.lock_version
  }, {
    auth_agent_id: implementerId
  });
  assert.equal(p1Claim.ok, true);

  const p1Blocked = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: p1Task.task.task_id,
    status: 'done',
    expected_lock_version: p1Claim.task.lock_version,
    quality_checks_passed: true,
    artifact_refs_count: 0
  }, {
    auth_agent_id: implementerId
  });
  assert.equal(p1Blocked.ok, false);
  assert.match(String(p1Blocked.error ?? ''), /^quality_gate_failed tier=P1 failed=artifact_refs_low detail=/);

  const p1Done = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: p1Task.task.task_id,
    status: 'done',
    expected_lock_version: p1Claim.task.lock_version,
    quality_checks_passed: true,
    artifact_refs_count: 1
  }, {
    auth_agent_id: implementerId
  });
  assert.equal(p1Done.ok, true);
  assert.equal(p1Done.task.status, 'done');

  const p0Task = server.callTool('team_task_create', {
    team_id: teamId,
    title: 'critical completion',
    priority: 1
  });
  assert.equal(p0Task.ok, true);

  const p0Claim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: p0Task.task.task_id,
    agent_id: implementerId,
    expected_lock_version: p0Task.task.lock_version
  }, {
    auth_agent_id: implementerId
  });
  assert.equal(p0Claim.ok, true);

  const p0Blocked = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: p0Task.task.task_id,
    status: 'done',
    expected_lock_version: p0Claim.task.lock_version,
    risk_tier: 'P0',
    quality_checks_passed: true,
    artifact_refs_count: 2,
    compliance_ack: false
  }, {
    auth_agent_id: implementerId
  });
  assert.equal(p0Blocked.ok, false);
  assert.match(String(p0Blocked.error ?? ''), /^quality_gate_failed tier=P0 failed=compliance_missing detail=/);

  const p0Done = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: p0Task.task.task_id,
    status: 'done',
    expected_lock_version: p0Claim.task.lock_version,
    risk_tier: 'P0',
    quality_checks_passed: true,
    artifact_refs_count: 2,
    compliance_ack: true
  }, {
    auth_agent_id: implementerId
  });
  assert.equal(p0Done.ok, true);
  assert.equal(p0Done.task.status, 'done');

  const events = server.store.listEvents(teamId, 400);
  const blockedHookEvent = events.find((event) => {
    if (event.event_type !== 'hook_pre:task_complete') return false;
    const payload = event.payload as Record<string, unknown>;
    return payload.ok === false;
  });
  assert.ok(blockedHookEvent);
  const payload = blockedHookEvent?.payload as Record<string, unknown>;
  assert.equal(payload.blocked_by, 'builtin_quality_task_complete_gate');

  const traces = payload.traces as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(traces));
  assert.ok(traces.length > 0);
  const traceMetadata = traces[0].metadata as Record<string, unknown>;
  assert.equal(typeof traceMetadata.risk_tier, 'string');
  assert.ok(Array.isArray(traceMetadata.failure_codes));

  server.store.close();
});
