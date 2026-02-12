import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';
import { buildForensicTimeline, computeReplayDigest } from '../../mcp/server/observability.js';

const dbPath = '.tmp/v3-110-ui-state-int.sqlite';
const logPath = '.tmp/v3-110-ui-state-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

afterEach(cleanup);

test('V3-110 integration: ui-state tools return coherent queue/failure/status values for operator surfaces', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'ui-state integration',
      max_threads: 4
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
    assert.equal(implementer.ok, true);

    const doneTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'done-task',
      priority: 1
    }).task;
    const doneClaim = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: doneTask.task_id,
      agent_id: implementer.agent.agent_id,
      expected_lock_version: doneTask.lock_version
    });
    assert.equal(doneClaim.ok, true);
    const doneUpdate = server.callTool('team_task_update', {
      team_id: teamId,
      task_id: doneTask.task_id,
      status: 'done',
      expected_lock_version: doneClaim.task.lock_version,
      quality_checks_passed: true,
      artifact_refs_count: 1
    });
    assert.equal(doneUpdate.ok, true);

    const roleTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'review-only',
      priority: 2,
      required_role: 'reviewer'
    }).task;
    const failedClaim = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: roleTask.task_id,
      agent_id: implementer.agent.agent_id,
      expected_lock_version: roleTask.lock_version
    });
    assert.equal(failedClaim.ok, false);

    const blockedBase = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-base',
      priority: 3
    }).task;
    server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-child',
      priority: 4,
      depends_on_task_ids: [blockedBase.task_id]
    });

    const status = server.callTool('team_status', { team_id: teamId });
    const summary = server.callTool('team_run_summary', { team_id: teamId });
    const replay = server.callTool('team_replay', { team_id: teamId, limit: 500 });

    assert.equal(status.ok, true);
    assert.equal(summary.ok, true);
    assert.equal(replay.ok, true);

    const statusMetrics = asRecord(status.metrics);
    const summaryRecord = asRecord(summary.summary);
    const summaryMetrics = asRecord(summaryRecord.metrics);
    const taskMetrics = asRecord(summaryMetrics.tasks);

    assert.equal(String(summaryRecord.status ?? ''), 'active');
    assert.equal(Number(statusMetrics.agents ?? -1), Number(summaryMetrics.agents ?? -2));

    const queueDepth = Number(taskMetrics.todo ?? 0)
      + Number(taskMetrics.in_progress ?? 0)
      + Number(taskMetrics.blocked ?? 0);
    assert.equal(queueDepth, 3);
    assert.equal(Number(taskMetrics.done ?? 0), 1);

    const events = Array.isArray(replay.events)
      ? replay.events.filter((event) => event && typeof event === 'object').map((event) => event as Record<string, unknown>)
      : [];
    assert.equal(events.length > 0, true);

    const failureCount = events.filter((event) => {
      const eventType = String(event.event_type ?? '');
      if (/failed|error|blocked/.test(eventType)) return true;
      const payload = asRecord(event.payload);
      return payload.ok === false;
    }).length;
    assert.equal(failureCount >= 1, true);

    const digest = computeReplayDigest(buildForensicTimeline(events));
    assert.equal(typeof digest, 'string');
    assert.equal(digest.length, 64);

    const uiState = server.callTool('team_ui_state', { team_id: teamId, recent_event_limit: 40 });
    assert.equal(uiState.ok, true);
    assert.equal(uiState.team.team_id, teamId);
    assert.equal(typeof uiState.controls, 'object');
    assert.equal(Array.isArray(uiState.recent_events), true);
    assert.equal(Array.isArray(uiState.evidence_links), true);
    assert.equal(Array.isArray(uiState.failure_highlights), true);
    assert.equal(Number(uiState.tasks.counts.done ?? 0), 1);
    assert.equal(Number(uiState.tasks.counts.blocked ?? 0) >= 1, true);

    const planFromTeam = server.callTool('team_staff_plan', { team_id: teamId });
    assert.equal(planFromTeam.ok, true);
    assert.equal(planFromTeam.team_id, teamId);
    assert.equal(typeof planFromTeam.plan.recommended_threads, 'number');
    assert.equal(Array.isArray(planFromTeam.plan.specialists), true);

    const planFromPrompt = server.callTool('team_staff_plan', {
      prompt: 'use agent teams for infra rollout and migration',
      task_size: 'medium',
      preferred_threads: 3
    });
    assert.equal(planFromPrompt.ok, true);
    assert.equal(planFromPrompt.team_id, null);
    assert.equal(planFromPrompt.plan.recommended_threads, 3);
    assert.equal(Array.isArray(planFromPrompt.plan.specialists), true);
  } finally {
    server.store.close();
  }
});

test('V3-110 integration: ui-state tools reflect pause/resume transitions without polling delays', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'ui-state transitions',
      max_threads: 3
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const paused = server.callTool('team_finalize', {
      team_id: teamId,
      reason: 'operator_pause'
    });
    assert.equal(paused.ok, true);

    const pausedStatus = server.callTool('team_status', { team_id: teamId });
    const pausedSummary = server.callTool('team_run_summary', { team_id: teamId });
    assert.equal(pausedStatus.ok, true);
    assert.equal(pausedSummary.ok, true);
    assert.equal(pausedStatus.team.status, 'finalized');
    assert.equal(pausedSummary.summary.status, 'finalized');

    const finalizedUiState = server.callTool('team_ui_state', { team_id: teamId });
    assert.equal(finalizedUiState.ok, true);
    assert.equal(finalizedUiState.team.status, 'finalized');
    const finalizedControls = asRecord(finalizedUiState.controls);
    const finalizedEnabled = asRecord(finalizedControls.enabled);
    assert.equal(finalizedEnabled.team_resume, true);

    const resumed = server.callTool('team_resume', { team_id: teamId });
    assert.equal(resumed.ok, true);

    const resumedStatus = server.callTool('team_status', { team_id: teamId });
    const resumedSummary = server.callTool('team_run_summary', { team_id: teamId });
    const replay = server.callTool('team_replay', { team_id: teamId, limit: 300 });

    assert.equal(resumedStatus.ok, true);
    assert.equal(resumedSummary.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(resumedStatus.team.status, 'active');
    assert.equal(resumedSummary.summary.status, 'active');

    const uiState = server.callTool('team_ui_state', { team_id: teamId });
    assert.equal(uiState.ok, true);
    assert.equal(uiState.team.status, 'active');
    assert.equal(typeof uiState.controls, 'object');

    const events = Array.isArray(replay.events)
      ? replay.events.filter((event) => event && typeof event === 'object').map((event) => event as Record<string, unknown>)
      : [];
    const eventTypes = events.map((event) => String(event.event_type ?? ''));

    assert.equal(eventTypes.includes('tool_call:team_finalize'), true);
    assert.equal(eventTypes.includes('team_finalized'), true);
    assert.equal(eventTypes.includes('tool_call:team_resume'), true);
    assert.equal(eventTypes.includes('team_resumed'), true);
  } finally {
    server.store.close();
  }
});
