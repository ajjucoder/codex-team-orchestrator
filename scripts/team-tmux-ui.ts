#!/usr/bin/env node

import process from 'node:process';
import { createServer } from '../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../mcp/server/tools/task-board.js';
import { registerAgentLifecycleTools } from '../mcp/server/tools/agent-lifecycle.js';
import type { ToolServerLike } from '../mcp/server/tools/types.js';
import {
  formatIsoTime,
  loadTeamUiSnapshot,
  renderShortId,
  renderTaskOwner,
  renderTaskRole,
  type TeamSnapshotFeedItem,
  type TeamSnapshotTask,
  type TeamUiSnapshot
} from './team-ui-view.js';

type OperatorCommand = 'pause' | 'resume' | 'drain' | 'retry' | 'none';

interface Args {
  dbPath: string;
  teamId: string;
  intervalMs: number;
  once: boolean;
  command: OperatorCommand;
  taskId: string | null;
  recentEventLimit: number;
  evidenceLimit: number;
  failureLimit: number;
  replayLimit: number;
  feedLimit: number;
  showWave: boolean;
}

interface TaskCommandRow {
  task_id: string;
  status: string;
  lock_version: number;
}

interface CommandOutcome {
  ok: boolean;
  message: string;
  drained?: number;
  retried?: number;
}

interface RuntimeNotice {
  lastAction: string;
  lastError: string;
}

function readPositiveInt(value: string | undefined, fallback: number, min = 1, max = 60000): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dbPath: '.tmp/team-orchestrator.sqlite',
    teamId: '',
    intervalMs: 1200,
    once: false,
    command: 'none',
    taskId: null,
    recentEventLimit: 40,
    evidenceLimit: 12,
    failureLimit: 12,
    replayLimit: 360,
    feedLimit: 12,
    showWave: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--db') {
      args.dbPath = argv[index + 1] ?? args.dbPath;
      index += 1;
      continue;
    }
    if (arg === '--team') {
      args.teamId = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--interval-ms') {
      args.intervalMs = readPositiveInt(argv[index + 1], args.intervalMs, 100, 60000);
      index += 1;
      continue;
    }
    if (arg === '--once') {
      args.once = true;
      continue;
    }
    if (arg === '--command') {
      const command = String(argv[index + 1] ?? 'none');
      if (
        command !== 'pause'
        && command !== 'resume'
        && command !== 'drain'
        && command !== 'retry'
        && command !== 'none'
      ) {
        throw new Error(`invalid command: ${command}`);
      }
      args.command = command;
      index += 1;
      continue;
    }
    if (arg === '--task') {
      args.taskId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--recent-event-limit') {
      args.recentEventLimit = readPositiveInt(argv[index + 1], args.recentEventLimit, 1, 300);
      index += 1;
      continue;
    }
    if (arg === '--evidence-limit') {
      args.evidenceLimit = readPositiveInt(argv[index + 1], args.evidenceLimit, 1, 80);
      index += 1;
      continue;
    }
    if (arg === '--failure-limit') {
      args.failureLimit = readPositiveInt(argv[index + 1], args.failureLimit, 1, 80);
      index += 1;
      continue;
    }
    if (arg === '--replay-limit') {
      args.replayLimit = readPositiveInt(argv[index + 1], args.replayLimit, 120, 2000);
      index += 1;
      continue;
    }
    if (arg === '--feed-limit') {
      args.feedLimit = readPositiveInt(argv[index + 1], args.feedLimit, 1, 60);
      index += 1;
      continue;
    }
    if (arg === '--show-wave') {
      args.showWave = true;
      continue;
    }

    throw new Error(`unknown arg: ${arg}`);
  }

  if (!args.teamId) {
    throw new Error('--team is required');
  }

  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function listTasksForCommand(server: ToolServerLike, teamId: string): TaskCommandRow[] {
  const listed = asRecord(server.callTool('team_task_list', { team_id: teamId }));
  if (listed.ok !== true || !Array.isArray(listed.tasks)) {
    return [];
  }

  return listed.tasks
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        task_id: String(row.task_id ?? ''),
        status: String(row.status ?? ''),
        lock_version: Number(row.lock_version ?? 0)
      };
    })
    .filter((task) => task.task_id.length > 0)
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
}

function runOperatorCommand(
  server: ToolServerLike,
  teamId: string,
  command: Exclude<OperatorCommand, 'none'>,
  taskId: string | null
): CommandOutcome {
  if (command === 'pause') {
    const result = asRecord(server.callTool('team_finalize', {
      team_id: teamId,
      reason: 'operator_pause'
    }));
    if (result.ok !== true) {
      return { ok: false, message: String(result.error ?? 'pause failed') };
    }
    return { ok: true, message: 'team paused' };
  }

  if (command === 'resume') {
    const result = asRecord(server.callTool('team_resume', { team_id: teamId }));
    if (result.ok !== true) {
      return { ok: false, message: String(result.error ?? 'resume failed') };
    }
    return { ok: true, message: 'team resumed' };
  }

  if (command === 'drain') {
    const candidates = listTasksForCommand(server, teamId)
      .filter((task) => task.status === 'todo' || task.status === 'blocked');

    let drained = 0;
    for (const task of candidates) {
      const updated = asRecord(server.callTool('team_task_update', {
        team_id: teamId,
        task_id: task.task_id,
        status: 'cancelled',
        expected_lock_version: task.lock_version
      }));
      if (updated.ok === true) {
        drained += 1;
      }
    }

    return { ok: true, message: `drained ${drained} task(s)`, drained };
  }

  const candidates = listTasksForCommand(server, teamId)
    .filter((task) => task.status === 'blocked')
    .filter((task) => !taskId || task.task_id === taskId);

  let retried = 0;
  for (const task of candidates) {
    const updated = asRecord(server.callTool('team_task_update', {
      team_id: teamId,
      task_id: task.task_id,
      status: 'todo',
      expected_lock_version: task.lock_version
    }));
    if (updated.ok === true) {
      retried += 1;
    }
  }

  return { ok: true, message: `retried ${retried} blocked task(s)`, retried };
}

function renderTaskLine(task: TeamSnapshotTask): string {
  return `- ${renderShortId(task.task_id)} ${task.status.padEnd(12)} ${renderTaskRole(task.required_role).padEnd(12)} owner=${renderTaskOwner(task.claimed_by)} title=${task.title}`;
}

function renderFeedLine(item: TeamSnapshotFeedItem): string {
  const id = item.event_id.toString().padStart(6, ' ');
  const when = formatIsoTime(item.created_at).padEnd(19);
  const type = item.event_type.padEnd(28);
  const task = item.task_id ? renderShortId(item.task_id) : '-';
  const agent = item.agent_id ? renderShortId(item.agent_id) : '-';
  const ok = item.ok === null ? '?' : item.ok ? 'ok' : 'err';
  return `${id} ${when} ${type} task=${task} agent=${agent} ${ok} ${item.summary}`;
}

function renderTmuxView(snapshot: TeamUiSnapshot, notice: RuntimeNotice, showWave: boolean): string {
  const lines: string[] = [];
  const workers = snapshot.workers;
  const tasks = snapshot.tasks;
  const progress = snapshot.progress;
  const objective = snapshot.team.objective ?? '(none)';

  lines.push(`team-tmux-ui team=${snapshot.team.team_id} status=${snapshot.team.status} mode=${snapshot.team.mode} profile=${snapshot.team.profile}`);
  lines.push(`objective: ${objective}`);
  lines.push(`workers total=${workers.total} idle=${workers.idle} busy=${workers.busy} offline=${workers.offline} util=${workers.utilization_pct}%`);
  lines.push(`tasks running=${progress.in_progress_tasks} todo=${tasks.todo} blocked=${tasks.blocked} done=${tasks.done} failed=${tasks.failed_terminal} cancelled=${tasks.cancelled} total=${tasks.total}`);
  lines.push(`queue depth=${progress.queue_depth} ready=${progress.ready_tasks} in_progress=${progress.in_progress_tasks} blocked=${progress.blocked_tasks} pending_inbox=${progress.pending_inbox}`);

  if (showWave) {
    const wave = progress.wave;
    if (wave) {
      lines.push(`wave source=${wave.source} id=${wave.wave_id} tick=${wave.tick_count} dispatched=${wave.dispatched_count} ready=${wave.ready_tasks} done=${wave.done_tasks}/${wave.total_tasks} completion=${wave.completion_pct}%`);
    } else {
      lines.push('wave source=none');
    }
  }

  lines.push('panes:');
  lines.push(`- team: ${snapshot.team.status} | workers: ${workers.active} active`);
  lines.push(`- backlog: todo=${tasks.todo} blocked=${tasks.blocked} in_progress=${tasks.in_progress}`);
  lines.push(`- feed: ${snapshot.feed.length} recent events`);
  lines.push('active-tasks:');
  if (snapshot.active_tasks.length === 0) {
    lines.push('- (none)');
  } else {
    for (const task of snapshot.active_tasks.slice(0, 8)) {
      lines.push(renderTaskLine(task));
    }
  }
  lines.push('recent-feed:');
  if (snapshot.feed.length === 0) {
    lines.push('- (none)');
  } else {
    for (const item of snapshot.feed.slice(0, 8)) {
      lines.push(renderFeedLine(item));
    }
  }
  lines.push('controls: --command pause|resume|drain|retry [--task task_id]');
  if (notice.lastAction) lines.push(`team-tmux-ui:command=${notice.lastAction}`);
  if (notice.lastError) lines.push(`team-tmux-ui:error=${notice.lastError}`);
  lines.push('team-tmux-ui:ok');
  return `${lines.join('\n')}\n`;
}

function readSnapshot(server: ToolServerLike, args: Args): TeamUiSnapshot {
  return loadTeamUiSnapshot(server.store, args.teamId, {
    recent_event_limit: args.recentEventLimit,
    evidence_limit: args.evidenceLimit,
    failure_limit: args.failureLimit,
    replay_limit: args.replayLimit,
    feed_limit: args.feedLimit
  });
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer({ dbPath: args.dbPath });
  const notice: RuntimeNotice = { lastAction: '', lastError: '' };
  let shouldExit = false;

  try {
    server.start();
    const toolServer = server as unknown as ToolServerLike;
    registerTeamLifecycleTools(toolServer);
    registerTaskBoardTools(toolServer);
    registerAgentLifecycleTools(toolServer);

    if (args.command !== 'none') {
      const outcome = runOperatorCommand(toolServer, args.teamId, args.command, args.taskId);
      notice.lastAction = args.command;
      if (!outcome.ok) {
        notice.lastError = outcome.message;
      }
    }

    process.on('SIGINT', () => {
      shouldExit = true;
    });
    process.on('SIGTERM', () => {
      shouldExit = true;
    });

    do {
      const snapshot = readSnapshot(toolServer, args);
      if (!args.once && process.stdout.isTTY) {
        process.stdout.write('\u001bc');
      }
      process.stdout.write(renderTmuxView(snapshot, notice, args.showWave));
      if (args.once || shouldExit) {
        break;
      }
      await sleep(args.intervalMs);
    } while (!shouldExit);
  } finally {
    server.store.close();
  }

  return notice.lastError ? 1 : 0;
}

run()
  .then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  })
  .catch((error: unknown) => {
    process.stderr.write(`team-tmux-ui:error=${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
