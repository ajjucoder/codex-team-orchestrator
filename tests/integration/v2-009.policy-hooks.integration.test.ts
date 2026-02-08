import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v2-009-int.sqlite';
const logPath = '.tmp/v2-009-int.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-009 integration: quality hooks block completion until configured gates pass', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerAgentLifecycleTools(server);
  registerTaskBoardTools(server);

  server.policyEngine.cache.set('quality-gated', {
    profile: 'quality-gated',
    limits: { default_max_threads: 4, hard_max_threads: 6 },
    quality: {
      require_tests_before_complete: true,
      require_compliance_ack: true,
      min_artifact_refs: 2
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
    objective: 'quality gate enforcement',
    profile: 'quality-gated'
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
    title: 'quality gated completion',
    priority: 1
  });
  assert.equal(task.ok, true);

  const claim = server.callTool('team_task_claim', {
    team_id: teamId,
    task_id: task.task.task_id,
    agent_id: implementer.agent.agent_id,
    expected_lock_version: task.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(claim.ok, true);

  const blockedMissingChecks = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task.task_id,
    status: 'done',
    expected_lock_version: claim.task.lock_version
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(blockedMissingChecks.ok, false);
  assert.match(String(blockedMissingChecks.error ?? ''), /tests must pass/);

  const blockedArtifactThreshold = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task.task_id,
    status: 'done',
    expected_lock_version: claim.task.lock_version,
    quality_checks_passed: true,
    compliance_ack: true,
    artifact_refs_count: 1
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(blockedArtifactThreshold.ok, false);
  assert.match(String(blockedArtifactThreshold.error ?? ''), /artifact_refs_count 1 < required 2/);

  const completed = server.callTool('team_task_update', {
    team_id: teamId,
    task_id: task.task.task_id,
    status: 'done',
    expected_lock_version: claim.task.lock_version,
    quality_checks_passed: true,
    compliance_ack: true,
    artifact_refs_count: 2
  }, {
    auth_agent_id: implementer.agent.agent_id
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.task.status, 'done');

  const events = server.store.listEvents(teamId, 200);
  const blockedHookEvent = events.find((event) => event.event_type === 'hook_pre:task_complete' && (event.payload as Record<string, unknown>).ok === false);
  assert.ok(blockedHookEvent);
  const payload = blockedHookEvent?.payload as Record<string, unknown>;
  assert.equal(payload.blocked_by, 'builtin_quality_task_complete_gate');

  server.store.close();
});
