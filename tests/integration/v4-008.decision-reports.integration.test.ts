import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';

const dbPath = '.tmp/v4-008-decision-reports-int.sqlite';
const logPath = '.tmp/v4-008-decision-reports-int.log';

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
      'complete'
    ],
    { encoding: 'utf8' }
  );
}

afterEach(cleanup);

test('V4-008 integration: decision reports persist across restart with monotonic revisions and card visibility', () => {
  cleanup();

  const serverA = createServer({ dbPath, logPath });
  serverA.start();
  registerTeamLifecycleTools(serverA);
  registerTaskBoardTools(serverA);
  registerAgentLifecycleTools(serverA);

  const started = serverA.callTool('team_start', {
    objective: 'decision report integration',
    max_threads: 3
  });
  assert.equal(started.ok, true);
  const teamId = String(started.team.team_id);

  const reviewer = serverA.callTool('team_spawn', {
    team_id: teamId,
    role: 'reviewer'
  });
  assert.equal(reviewer.ok, true);
  const reviewerId = String(reviewer.agent.agent_id);

  const task = serverA.callTool('team_task_create', {
    team_id: teamId,
    title: 'decision-report-task-int',
    priority: 1,
    required_role: 'reviewer'
  });
  assert.equal(task.ok, true);
  const taskId = String(task.task.task_id);

  const first = serverA.callTool('team_agent_report', {
    team_id: teamId,
    agent_id: reviewerId,
    task_id: taskId,
    decision: 'review',
    summary: 'pass one'
  });
  const second = serverA.callTool('team_agent_report', {
    team_id: teamId,
    agent_id: reviewerId,
    task_id: taskId,
    decision: 'revise',
    summary: 'pass two'
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.report.revision, 1);
  assert.equal(second.report.revision, 2);
  serverA.store.close();

  const serverB = createServer({ dbPath, logPath });
  try {
    serverB.start();
    registerTeamLifecycleTools(serverB);
    registerTaskBoardTools(serverB);
    registerAgentLifecycleTools(serverB);

    const third = serverB.callTool('team_agent_report', {
      team_id: teamId,
      agent_id: reviewerId,
      task_id: taskId,
      decision: 'approve',
      summary: 'pass three'
    });
    assert.equal(third.ok, true);
    assert.equal(third.report.revision, 3);

    const history = serverB.store.listAgentDecisionReports(teamId, {
      agent_id: reviewerId,
      task_id: taskId,
      limit: 10
    });
    assert.equal(history.length, 3);
    assert.deepEqual(history.map((entry) => entry.revision), [3, 2, 1]);

    const events = serverB.store.listEvents(teamId, 200);
    const decisionEvents = events.filter((event) => String(event.event_type) === 'agent_decision_report_recorded');
    assert.equal(decisionEvents.length, 3);

    const card = runCard(teamId);
    assert.match(card, /## Decision Reports \(Latest\)/);
    assert.match(card, /## Decision Report History/);
    assert.match(card, /rev=3 decision=approve/);
    assert.match(card, /rev=1 decision=review/);
  } finally {
    serverB.store.close();
  }
});
