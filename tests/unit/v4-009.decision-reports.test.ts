import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-009-decision-reports-unit.sqlite';
const logPath = '.tmp/v4-009-decision-reports-unit.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function runCard(teamId: string): string {
  return execFileSync(
    'node',
    [
      '--import',
      'tsx',
      'scripts/team-card.ts',
      '--db',
      dbPath,
      '--team',
      teamId,
      '--mode',
      'progress'
    ],
    { encoding: 'utf8' }
  );
}

afterEach(cleanup);

test('V4-009 unit: team_agent_report persists revisioned history and team-card renders latest/history views', () => {
  cleanup();
  const server = createServer({ dbPath, logPath });

  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);

    const started = server.callTool('team_start', {
      objective: 'decision report unit',
      max_threads: 3
    });
    assert.equal(started.ok, true);
    const teamId = String(started.team.team_id);

    const reviewer = server.callTool('team_spawn', {
      team_id: teamId,
      role: 'reviewer'
    });
    assert.equal(reviewer.ok, true);
    const reviewerId = String(reviewer.agent.agent_id);

    const task = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'decision-report-task',
      priority: 1,
      required_role: 'reviewer'
    });
    assert.equal(task.ok, true);
    const taskId = String(task.task.task_id);

    const first = server.callTool('team_agent_report', {
      team_id: teamId,
      agent_id: reviewerId,
      task_id: taskId,
      decision: 'review',
      summary: 'initial findings',
      confidence: 0.62
    });
    const second = server.callTool('team_agent_report', {
      team_id: teamId,
      agent_id: reviewerId,
      task_id: taskId,
      decision: 'approve',
      summary: 'final recommendation',
      confidence: 0.91
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.report.revision, 1);
    assert.equal(second.report.revision, 2);
    assert.notEqual(first.report.report_id, second.report.report_id);

    const duplicateRevision = server.callTool('team_agent_report', {
      team_id: teamId,
      agent_id: reviewerId,
      task_id: taskId,
      decision: 'reject',
      summary: 'should fail',
      revision: 2
    });
    assert.equal(duplicateRevision.ok, false);
    assert.match(String(duplicateRevision.error ?? ''), /revision must be greater than 2/);

    const history = server.store.listAgentDecisionReports(teamId, {
      task_id: taskId,
      agent_id: reviewerId,
      limit: 10
    });
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((entry) => entry.revision), [2, 1]);

    const latest = server.store.getLatestAgentDecisionReport(teamId, reviewerId, taskId);
    assert.notEqual(latest, null);
    assert.equal(latest?.revision, 2);

    const latestList = server.store.listLatestAgentDecisionReports(teamId, 10);
    assert.equal(latestList.length, 1);
    assert.equal(latestList[0].revision, 2);

    const card = runCard(teamId);
    assert.match(card, /## Decision Reports \(Latest\)/);
    assert.match(card, /## Decision Report History/);
    assert.match(card, /rev=2 decision=approve/);
    assert.match(card, /rev=1 decision=review/);
  } finally {
    server.store.close();
  }
});
