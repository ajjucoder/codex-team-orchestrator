import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from '../../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../../mcp/server/tools/agent-lifecycle.js';

const dbPath = '.tmp/v4-011-team-tmux-ui-int.sqlite';
const logPath = '.tmp/v4-011-team-tmux-ui-int.log';

function cleanup(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
}

function runTmuxUi(teamId: string, extraArgs: string[] = []): string {
  return execFileSync(
    'node',
    [
      '--import',
      'tsx',
      'scripts/team-tmux-ui.ts',
      '--db',
      dbPath,
      '--team',
      teamId,
      '--once',
      ...extraArgs
    ],
    { encoding: 'utf8' }
  );
}

afterEach(cleanup);

test('V4-011 integration: tmux sidecar renders live snapshot output without changing team-tui contract', () => {
  cleanup();

  const server = createServer({ dbPath, logPath });
  try {
    server.start();
    registerTeamLifecycleTools(server);
    registerTaskBoardTools(server);
    registerAgentLifecycleTools(server);

    const started = server.callTool('team_start', {
      objective: 'team tmux sidecar integration',
      max_threads: 4
    });
    assert.equal(started.ok, true);
    const teamId = started.team.team_id as string;

    const worker = server.callTool('team_spawn', {
      team_id: teamId,
      role: 'implementer'
    });
    assert.equal(worker.ok, true);

    const created = server.callTool('team_task_create', {
      team_id: teamId,
      title: 'tmux-visible-task',
      priority: 1
    });
    assert.equal(created.ok, true);

    const output = runTmuxUi(teamId, ['--show-wave']);
    assert.match(output, new RegExp(`team-tmux-ui team=${teamId} status=active`));
    assert.match(output, /panes:/);
    assert.match(output, /active-tasks:/);
    assert.match(output, /recent-feed:/);
    assert.match(output, /controls: --command pause\|resume\|drain\|retry \[--task task_id\]/);
    assert.match(output, /team-tmux-ui:ok/);

    const pauseOutput = runTmuxUi(teamId, ['--command', 'pause']);
    assert.match(pauseOutput, /team-tmux-ui:command=pause/);
    const paused = server.callTool('team_status', { team_id: teamId });
    assert.equal(paused.ok, true);
    assert.equal(paused.team.status, 'finalized');

    const resumeOutput = runTmuxUi(teamId, ['--command', 'resume']);
    assert.match(resumeOutput, /team-tmux-ui:command=resume/);
    const resumed = server.callTool('team_status', { team_id: teamId });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.team.status, 'active');
  } finally {
    server.store.close();
  }
});
