#!/usr/bin/env node

import { createServer } from '../mcp/server/index.js';
import { registerTeamLifecycleTools } from '../mcp/server/tools/team-lifecycle.js';
import { registerTaskBoardTools } from '../mcp/server/tools/task-board.js';
import { registerObservabilityTools } from '../mcp/server/tools/observability.js';
import type { ToolServerLike } from '../mcp/server/tools/types.js';

type ConsoleCommand = 'pause' | 'resume' | 'drain' | 'retry' | 'none';

interface Args {
  dbPath: string;
  teamId: string;
  command: ConsoleCommand;
  taskId: string | null;
  once: boolean;
  watchCycles: number;
  intervalMs: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    dbPath: '.tmp/team-orchestrator.sqlite',
    teamId: '',
    command: 'none',
    taskId: null,
    once: false,
    watchCycles: 1,
    intervalMs: 1500
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') {
      out.dbPath = argv[i + 1] ?? out.dbPath;
      i += 1;
      continue;
    }
    if (arg === '--team') {
      out.teamId = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--command') {
      const command = String(argv[i + 1] ?? 'none');
      if (command === 'pause' || command === 'resume' || command === 'drain' || command === 'retry') {
        out.command = command;
      } else {
        throw new Error(`unknown command: ${command}`);
      }
      i += 1;
      continue;
    }
    if (arg === '--task') {
      out.taskId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--once') {
      out.once = true;
      continue;
    }
    if (arg === '--watch-cycles') {
      const parsed = Number(argv[i + 1] ?? out.watchCycles);
      out.watchCycles = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : out.watchCycles;
      i += 1;
      continue;
    }
    if (arg === '--interval-ms') {
      const parsed = Number(argv[i + 1] ?? out.intervalMs);
      out.intervalMs = Number.isFinite(parsed) ? Math.max(100, Math.floor(parsed)) : out.intervalMs;
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.teamId) {
    throw new Error('--team is required');
  }
  if (out.once) {
    out.watchCycles = 1;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function listTaskRows(server: ToolServerLike, teamId: string): Array<Record<string, unknown>> {
  const statuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
  const rows: Array<Record<string, unknown>> = [];
  for (const status of statuses) {
    const listed = server.callTool('team_task_list', {
      team_id: teamId,
      status
    });
    if (listed.ok !== true) continue;
    if (!Array.isArray(listed.tasks)) continue;
    for (const task of listed.tasks) {
      if (task && typeof task === 'object') {
        rows.push(task as Record<string, unknown>);
      }
    }
  }
  return rows;
}

function runCommand(server: ToolServerLike, args: Args): Record<string, unknown> {
  if (args.command === 'pause') {
    return asRecord(server.callTool('team_finalize', {
      team_id: args.teamId,
      reason: 'operator_pause'
    }));
  }
  if (args.command === 'resume') {
    return asRecord(server.callTool('team_resume', {
      team_id: args.teamId
    }));
  }
  if (args.command === 'drain') {
    const tasks = listTaskRows(server, args.teamId)
      .filter((task) => {
        const status = String(task.status ?? '');
        return status === 'todo' || status === 'blocked';
      });
    let drained = 0;
    for (const task of tasks) {
      const updated = server.callTool('team_task_update', {
        team_id: args.teamId,
        task_id: String(task.task_id ?? ''),
        status: 'cancelled',
        expected_lock_version: Number(task.lock_version ?? 0)
      });
      if (updated.ok === true) drained += 1;
    }
    return {
      ok: true,
      drained_count: drained
    };
  }
  if (args.command === 'retry') {
    const tasks = listTaskRows(server, args.teamId)
      .filter((task) => String(task.status ?? '') === 'blocked')
      .filter((task) => args.taskId === null || String(task.task_id ?? '') === args.taskId);
    let retried = 0;
    for (const task of tasks) {
      const updated = server.callTool('team_task_update', {
        team_id: args.teamId,
        task_id: String(task.task_id ?? ''),
        status: 'todo',
        expected_lock_version: Number(task.lock_version ?? 0)
      });
      if (updated.ok === true) retried += 1;
    }
    return {
      ok: true,
      retried_count: retried
    };
  }
  return { ok: true };
}

function eventLooksLikeFailure(event: Record<string, unknown>): boolean {
  const eventType = String(event.event_type ?? '');
  if (/failed|error|blocked/.test(eventType)) return true;
  const payload = asRecord(event.payload);
  return payload.ok === false;
}

function printSnapshot(server: ToolServerLike, teamId: string): void {
  const status = asRecord(server.callTool('team_status', { team_id: teamId }));
  if (status.ok !== true) {
    throw new Error(String(status.error ?? `team not found: ${teamId}`));
  }
  const summaryResult = asRecord(server.callTool('team_run_summary', { team_id: teamId }));
  const replayResult = asRecord(server.callTool('team_replay', { team_id: teamId, limit: 300 }));

  const agents = server.store.listAgentsByTeam(teamId);
  const tasks = listTaskRows(server, teamId);
  const todo = tasks.filter((task) => task.status === 'todo').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const idle = agents.filter((agent) => agent.status === 'idle').length;
  const busy = agents.filter((agent) => agent.status === 'busy').length;
  const offline = agents.filter((agent) => agent.status === 'offline').length;

  const events = Array.isArray(replayResult.events)
    ? replayResult.events.filter((event) => event && typeof event === 'object').map((event) => event as Record<string, unknown>)
    : [];
  const failures = events.filter(eventLooksLikeFailure);
  const doneTaskEvents = events.filter((event) => {
    if (String(event.event_type ?? '') !== 'tool_call:team_task_update') return false;
    const payload = asRecord(event.payload);
    const input = asRecord(payload.input);
    return payload.ok === true && input.status === 'done';
  });

  const blockedTasks = tasks
    .filter((task) => task.status === 'blocked')
    .slice(0, 8)
    .map((task) => String(task.task_id ?? ''))
    .filter(Boolean);

  console.log(`console:team=${teamId}`);
  console.log(`console:workers total=${agents.length} idle=${idle} busy=${busy} offline=${offline}`);
  console.log(`console:tasks todo=${todo} in_progress=${inProgress} blocked=${blocked} done=${done} queue_depth=${todo + inProgress + blocked}`);
  console.log(`console:failures count=${failures.length}`);
  if (blockedTasks.length > 0) {
    console.log(`console:blockers=${blockedTasks.join(',')}`);
  } else {
    console.log('console:blockers=none');
  }
  const summary = asRecord(summaryResult.summary);
  if (summaryResult.ok === true && Object.keys(summary).length > 0) {
    console.log(`console:status=${String(summary.status ?? 'unknown')}`);
  }
  for (const event of doneTaskEvents.slice(-10)) {
    const eventId = Number(event.id ?? 0);
    const payload = asRecord(event.payload);
    const input = asRecord(payload.input);
    const taskId = String(input.task_id ?? '');
    if (!taskId || !Number.isFinite(eventId) || eventId <= 0) continue;
    console.log(`console:evidence task=${taskId} link=replay://${teamId}/event/${eventId}`);
  }
  console.log('console:snapshot=ok');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer({ dbPath: args.dbPath, logPath: '.tmp/team-console.log' });
  server.start();
  const toolServer = server as unknown as ToolServerLike;
  registerTeamLifecycleTools(toolServer);
  registerTaskBoardTools(toolServer);
  registerObservabilityTools(toolServer);

  const commandResult = runCommand(toolServer, args);
  if (args.command !== 'none') {
    if (commandResult.ok !== true) {
      throw new Error(String(commandResult.error ?? `command failed: ${args.command}`));
    }
    console.log(`console:command=${args.command}`);
    if (args.command === 'drain') {
      console.log(`console:drained=${Number(commandResult.drained_count ?? 0)}`);
    }
    if (args.command === 'retry') {
      console.log(`console:retried=${Number(commandResult.retried_count ?? 0)}`);
    }
  }

  for (let i = 0; i < args.watchCycles; i += 1) {
    printSnapshot(toolServer, args.teamId);
    if (i < args.watchCycles - 1) {
      await sleep(args.intervalMs);
    }
  }

  server.store.close();
  console.log('console:ok');
}

await main();
