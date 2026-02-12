#!/usr/bin/env node

import process from 'node:process';
import { createServer } from '../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../mcp/server/tools/task-board.js';
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

type OperatorCommand = 'pause' | 'resume' | 'drain' | 'retry' | 'none' | 'quit';

interface Args {
  dbPath: string;
  teamId: string;
  intervalMs: number;
  once: boolean;
  noInput: boolean;
  command: Exclude<OperatorCommand, 'quit'>;
  taskId: string | null;
  recentEventLimit: number;
  evidenceLimit: number;
  failureLimit: number;
  replayLimit: number;
  feedLimit: number;
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
    noInput: false,
    command: 'none',
    taskId: null,
    recentEventLimit: 40,
    evidenceLimit: 12,
    failureLimit: 12,
    replayLimit: 360,
    feedLimit: 14
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
    if (arg === '--no-input') {
      args.noInput = true;
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

    throw new Error(`unknown arg: ${arg}`);
  }

  if (!args.teamId) {
    throw new Error('--team is required');
  }

  if (args.once) {
    args.noInput = true;
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
  command: Exclude<OperatorCommand, 'none' | 'quit'>,
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

function renderTaskList(tasks: TeamSnapshotTask[], emptyMessage: string): string[] {
  if (tasks.length === 0) return [`  (no ${emptyMessage})`];

  return tasks.map((task) => {
    const owner = task.claimed_by ? ` owner=${renderTaskOwner(task.claimed_by)}` : '';
    const role = task.required_role ? ` role=${renderTaskRole(task.required_role)}` : '';
    return `  - ${renderShortId(task.task_id)} p${task.priority} status=${task.status}${owner}${role} ${task.title}`;
  });
}

function renderFeed(feed: TeamSnapshotFeedItem[]): string[] {
  if (feed.length === 0) return ['  (no events yet)'];

  return feed.map((item) => {
    const mark = item.kind === 'failure' ? 'F' : (item.kind === 'evidence' ? 'E' : 'I');
    const task = item.task_id ? ` task=${renderShortId(item.task_id)}` : '';
    const agent = item.agent_id ? ` agent=${renderShortId(item.agent_id)}` : '';
    const link = item.replay_link ? ` ${item.replay_link}` : '';
    return `  [${mark}] ${formatIsoTime(item.created_at)}${task}${agent} ${item.summary}${link}`;
  });
}

function render(snapshot: TeamUiSnapshot, notices: RuntimeNotice): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  const running = snapshot.tasks.in_progress
    + snapshot.tasks.queued
    + snapshot.tasks.dispatching
    + snapshot.tasks.executing
    + snapshot.tasks.validating
    + snapshot.tasks.integrating;

  console.log(`team-tui team=${snapshot.team.team_id} status=${snapshot.team.status} updated=${formatIsoTime(snapshot.team.updated_at)}`);
  console.log('controls: p=pause r=resume d=drain t=retry q=quit');
  console.log(`profile=${snapshot.team.profile} mode=${snapshot.team.mode}`);
  if (snapshot.team.objective) {
    console.log(`objective: ${snapshot.team.objective}`);
  }
  if (notices.lastAction) {
    console.log(`last-action: ${notices.lastAction}`);
  }
  if (notices.lastError) {
    console.log(`last-error: ${notices.lastError}`);
  }

  console.log('');
  console.log(
    `workers total=${snapshot.workers.total} idle=${snapshot.workers.idle} busy=${snapshot.workers.busy} offline=${snapshot.workers.offline} util=${snapshot.workers.utilization_pct}%`
  );
  console.log(
    `tasks running=${running} todo=${snapshot.tasks.todo} blocked=${snapshot.tasks.blocked} done=${snapshot.tasks.done} failed=${snapshot.tasks.failed_terminal} cancelled=${snapshot.tasks.cancelled} total=${snapshot.tasks.total}`
  );
  console.log(
    `queue depth=${snapshot.progress.queue_depth} ready=${snapshot.progress.ready_tasks} in_progress=${snapshot.progress.in_progress_tasks} blocked=${snapshot.progress.blocked_tasks} pending_inbox=${snapshot.progress.pending_inbox}`
  );

  console.log('');
  console.log('worker-tree:');
  for (const line of snapshot.worker_tree) {
    console.log(`  ${line}`);
  }

  console.log('');
  console.log('active-tasks:');
  for (const line of renderTaskList(snapshot.active_tasks.slice(0, 10), 'active tasks')) {
    console.log(line);
  }

  console.log('');
  console.log('blockers:');
  for (const line of renderTaskList(snapshot.blockers.map((task) => ({
    ...task,
    status: 'blocked',
    claimed_by: null
  })).slice(0, 10), 'blockers')) {
    console.log(line);
  }

  console.log('');
  console.log('recent-feed:');
  for (const line of renderFeed(snapshot.feed.slice(0, 12))) {
    console.log(line);
  }
}

function handleKey(chunk: Buffer | string, queue: OperatorCommand[]): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const char of text) {
    if (char === 'p') {
      queue.push('pause');
      continue;
    }
    if (char === 'r') {
      queue.push('resume');
      continue;
    }
    if (char === 'd') {
      queue.push('drain');
      continue;
    }
    if (char === 't') {
      queue.push('retry');
      continue;
    }
    if (char === 'q' || char === '\u0003') {
      queue.push('quit');
      continue;
    }
  }
}

function bindKeyboard(queue: OperatorCommand[]): () => void {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onData = (chunk: Buffer | string): void => {
    handleKey(chunk, queue);
  };

  process.stdin.on('data', onData);

  return () => {
    process.stdin.off('data', onData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer({ dbPath: args.dbPath, logPath: '.tmp/team-tui.log' });
  server.start();

  const toolServer = server as unknown as ToolServerLike;
  registerTeamLifecycleTools(toolServer);
  registerTaskBoardTools(toolServer);

  const notices: RuntimeNotice = {
    lastAction: '',
    lastError: ''
  };

  const commandQueue: OperatorCommand[] = [];
  if (args.command !== 'none') {
    commandQueue.push(args.command);
  }

  const interactive = !args.once && !args.noInput;
  const unbindKeyboard = interactive ? bindKeyboard(commandQueue) : () => {};

  let shouldQuit = false;
  const onSigInt = (): void => {
    shouldQuit = true;
  };
  process.on('SIGINT', onSigInt);

  if (interactive && process.stdout.isTTY) {
    process.stdout.write('\x1b[?25l');
  }

  try {
    do {
      while (commandQueue.length > 0) {
        const command = commandQueue.shift() ?? 'quit';

        if (command === 'quit') {
          shouldQuit = true;
          break;
        }

        if (command === 'none') {
          continue;
        }

        const outcome = runOperatorCommand(toolServer, args.teamId, command, args.taskId);
        console.log(`team-tui:command=${command}`);
        if (outcome.ok) {
          console.log(`team-tui:command_result=${outcome.message}`);
          if (typeof outcome.drained === 'number') {
            console.log(`team-tui:drained=${outcome.drained}`);
          }
          if (typeof outcome.retried === 'number') {
            console.log(`team-tui:retried=${outcome.retried}`);
          }
          notices.lastAction = `${formatIsoTime(new Date().toISOString())} ${outcome.message}`;
          notices.lastError = '';
        } else {
          console.log(`team-tui:command_result=error ${outcome.message}`);
          notices.lastError = `${formatIsoTime(new Date().toISOString())} ${outcome.message}`;
        }
      }

      if (shouldQuit) {
        break;
      }

      const snapshot = loadTeamUiSnapshot(server.store, args.teamId, {
        recent_event_limit: args.recentEventLimit,
        evidence_limit: args.evidenceLimit,
        failure_limit: args.failureLimit,
        replay_limit: args.replayLimit,
        feed_limit: args.feedLimit
      });

      render(snapshot, notices);

      if (args.once) {
        break;
      }

      await sleep(args.intervalMs);
    } while (!shouldQuit);
  } finally {
    process.off('SIGINT', onSigInt);
    unbindKeyboard();
    if (interactive && process.stdout.isTTY) {
      process.stdout.write('\x1b[?25h');
    }
    server.store.close();
  }

  console.log('team-tui:ok');
}

await main();
