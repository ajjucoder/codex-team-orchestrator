import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerObservabilityTools } from '../../mcp/server/tools/observability.js';
import { buildForensicTimeline, computeReplayDigest } from '../../mcp/server/observability.js';

const dbPath = '.tmp/v3-110-team-ui-state-unit.sqlite';
const logPath = '.tmp/v3-110-team-ui-state-unit.log';

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

function readUiStateSnapshot(server: ReturnType<typeof createServer>, teamId: string): {
  queueDepth: number;
  failureCount: number;
  digest: string;
  status: string;
  summaryAgents: number;
  statusAgents: number;
} {
  const status = server.callTool('team_status', { team_id: teamId });
  const summary = server.callTool('team_run_summary', { team_id: teamId });
  const replay = server.callTool('team_replay', { team_id: teamId, limit: 300 });

  assert.equal(status.ok, true);
  assert.equal(summary.ok, true);
  assert.equal(replay.ok, true);

  const statusMetrics = asRecord(status.metrics);
  const summaryRecord = asRecord(summary.summary);
  const summaryMetrics = asRecord(summaryRecord.metrics);
  const taskMetrics = asRecord(summaryMetrics.tasks);

  const events = Array.isArray(replay.events)
    ? replay.events.filter((event) => event && typeof event === 'object').map((event) => event as Record<string, unknown>)
    : [];

  const failureCount = events.filter((event) => {
    const eventType = String(event.event_type ?? '');
    if (/failed|error|blocked/.test(eventType)) return true;
    const payload = asRecord(event.payload);
    return payload.ok === false;
  }).length;

  const queueDepth = Number(taskMetrics.todo ?? 0)
    + Number(taskMetrics.in_progress ?? 0)
    + Number(taskMetrics.blocked ?? 0);

  const timeline = buildForensicTimeline(events);
  const digest = computeReplayDigest(timeline);

  return {
    queueDepth,
    failureCount,
    digest,
    status: String(summaryRecord.status ?? 'unknown'),
    summaryAgents: Number(summaryMetrics.agents ?? 0),
    statusAgents: Number(statusMetrics.agents ?? 0)
  };
}

afterEach(cleanup);

test('V3-110 unit: ui-state snapshot remains coherent across status, summary, and replay surfaces', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'ui state coherence',
      max_threads: 4
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
    assert.equal(implementer.ok, true);

    const reviewTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'review gate',
      priority: 1,
      required_role: 'reviewer'
    }).task;

    const failedClaim = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: reviewTask.task_id,
      agent_id: implementer.agent.agent_id,
      expected_lock_version: reviewTask.lock_version
    });
    assert.equal(failedClaim.ok, false);

    const doneTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'done-task',
      priority: 2
    }).task;
    const claimed = server.callTool('team_task_claim', {
      team_id: teamId,
      task_id: doneTask.task_id,
      agent_id: implementer.agent.agent_id,
      expected_lock_version: doneTask.lock_version
    });
    assert.equal(claimed.ok, true);
    const updated = server.callTool('team_task_update', {
      team_id: teamId,
      task_id: doneTask.task_id,
      status: 'done',
      expected_lock_version: claimed.task.lock_version,
      quality_checks_passed: true,
      artifact_refs_count: 1
    });
    assert.equal(updated.ok, true);

    const blockedBase = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-base',
      priority: 3
    }).task;
    const blocked = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'blocked-child',
      priority: 4,
      depends_on_task_ids: [blockedBase.task_id]
    }).task;
    assert.equal(blocked.status, 'blocked');

    const snapshot = readUiStateSnapshot(server, teamId);
    assert.equal(snapshot.status, 'active');
    assert.equal(snapshot.summaryAgents, 1);
    assert.equal(snapshot.statusAgents, 1);
    assert.equal(snapshot.queueDepth, 3);
    assert.equal(snapshot.failureCount >= 1, true);
    assert.equal(typeof snapshot.digest, 'string');
    assert.equal(snapshot.digest.length, 64);
  } finally {
    server.store.close();
  }
});

test('V3-110 unit: ui-state replay snapshot remains coherent across repeated reads', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'ui digest stability',
      max_threads: 3
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
    assert.equal(reviewer.ok, true);

    for (let i = 0; i < 2; i += 1) {
      const task = server.callTool('team_task_create', {
        team_id: teamId,
        title: `digest-task-${i}`,
        priority: i + 1,
        required_role: 'reviewer'
      }).task;
      const claimed = server.callTool('team_task_claim', {
        team_id: teamId,
        task_id: task.task_id,
        agent_id: reviewer.agent.agent_id,
        expected_lock_version: task.lock_version
      });
      assert.equal(claimed.ok, true);
      const completed = server.callTool('team_task_update', {
        team_id: teamId,
        task_id: task.task_id,
        status: 'done',
        expected_lock_version: claimed.task.lock_version,
        quality_checks_passed: true,
        artifact_refs_count: 1
      });
      assert.equal(completed.ok, true);
    }

    const first = readUiStateSnapshot(server, teamId);
    const second = readUiStateSnapshot(server, teamId);

    assert.equal(first.queueDepth, second.queueDepth);
    assert.equal(first.failureCount, second.failureCount);
    assert.equal(first.summaryAgents, second.summaryAgents);
    assert.equal(first.statusAgents, second.statusAgents);
    assert.equal(typeof first.digest, 'string');
    assert.equal(first.digest.length, 64);
    assert.equal(typeof second.digest, 'string');
    assert.equal(second.digest.length, 64);
  } finally {
    server.store.close();
  }
});

test('V3-110 unit: ui-state surfaces latest recent/evidence/failure entries after replay window is exceeded', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'ui-state latest slices',
      max_threads: 2
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    for (let i = 0; i < 140; i += 1) {
      server.store.logEvent({
        team_id: teamId,
        event_type: 'synthetic_filler',
        payload: { ok: true, seq: i }
      });
    }

    const latestEvidenceTaskId = 'latest-evidence-task';
    const latestFailureSummary = 'latest-failure-highlight';

    server.store.logEvent({
      team_id: teamId,
      event_type: 'tool_call:team_task_update',
      payload: {
        ok: true,
        input: {
          task_id: latestEvidenceTaskId,
          status: 'done'
        }
      }
    });
    server.store.logEvent({
      team_id: teamId,
      event_type: 'synthetic_recent_latest',
      payload: {
        ok: true
      }
    });
    server.store.logEvent({
      team_id: teamId,
      event_type: 'synthetic_error_latest',
      payload: {
        ok: false,
        error: latestFailureSummary
      }
    });

    const uiState = server.callTool('team_ui_state', {
      team_id: teamId,
      recent_event_limit: 20,
      evidence_limit: 6,
      failure_limit: 6
    });
    assert.equal(uiState.ok, true);

    const recentEvents = Array.isArray(uiState.recent_events)
      ? uiState.recent_events.filter((event) => event && typeof event === 'object').map((event) => event as Record<string, unknown>)
      : [];
    const evidenceLinks = Array.isArray(uiState.evidence_links)
      ? uiState.evidence_links.filter((link) => link && typeof link === 'object').map((link) => link as Record<string, unknown>)
      : [];
    const failureHighlights = Array.isArray(uiState.failure_highlights)
      ? uiState.failure_highlights.filter((event) => event && typeof event === 'object').map((event) => event as Record<string, unknown>)
      : [];

    assert.equal(
      recentEvents.some((event) => String(event.event_type ?? '') === 'synthetic_recent_latest'),
      true
    );
    assert.equal(
      evidenceLinks.some((link) => String(link.task_id ?? '') === latestEvidenceTaskId),
      true
    );
    assert.equal(
      failureHighlights.some((event) => String(event.summary ?? '') === latestFailureSummary),
      true
    );
  } finally {
    server.store.close();
  }
});

test('V3-110 unit: ui-state spawn controls stay enabled when offline agents exist below max thread capacity', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);
    registerObservabilityTools(server);

    const started = server.callTool('team_start', {
      objective: 'offline worker spawn capacity',
      max_threads: 3
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const lead = server.callTool('team_spawn', { team_id: teamId, role: 'lead' });
    const implementer = server.callTool('team_spawn', { team_id: teamId, role: 'implementer' });
    const reviewer = server.callTool('team_spawn', { team_id: teamId, role: 'reviewer' });
    assert.equal(lead.ok, true);
    assert.equal(implementer.ok, true);
    assert.equal(reviewer.ok, true);

    const openTask = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'open-ui-task',
      priority: 1,
      required_role: 'tester'
    });
    assert.equal(openTask.ok, true);

    const offlineLead = server.store.updateAgentStatus(lead.agent.agent_id as string, 'offline');
    const offlineReviewer = server.store.updateAgentStatus(reviewer.agent.agent_id as string, 'offline');
    assert.equal(offlineLead?.status, 'offline');
    assert.equal(offlineReviewer?.status, 'offline');

    const uiState = server.callTool('team_ui_state', { team_id: teamId });
    assert.equal(uiState.ok, true);

    const workerSummary = asRecord(asRecord(uiState.workers).summary);
    const enabledControls = asRecord(asRecord(uiState.controls).enabled);

    assert.equal(Number(workerSummary.active ?? -1), 1);
    assert.equal(Number(workerSummary.offline ?? -1), 2);
    assert.equal(enabledControls.team_spawn, true);
    assert.equal(enabledControls.team_spawn_ready_roles, true);
  } finally {
    server.store.close();
  }
});
