#!/usr/bin/env node

import process from 'node:process';
import { createServer } from '../mcp/server/index.js';
import {
  formatIsoTime,
  loadTeamUiSnapshot,
  renderShortId,
  renderTaskOwner,
  renderTaskRole,
  type TeamSnapshotBlocker,
  type TeamSnapshotEvidenceLink,
  type TeamSnapshotFailureHighlight,
  type TeamSnapshotFeedItem,
  type TeamSnapshotTask,
  type TeamUiSnapshot
} from './team-ui-view.js';

type CardMode = 'launch' | 'progress' | 'timeout' | 'complete';

interface Args {
  mode: CardMode;
  dbPath: string;
  teamId: string;
  recentEventLimit: number;
  evidenceLimit: number;
  failureLimit: number;
  replayLimit: number;
}

function readPositiveInt(value: string | undefined, fallback: number, min = 1, max = 500): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'progress',
    dbPath: '.tmp/team-orchestrator.sqlite',
    teamId: '',
    recentEventLimit: 40,
    evidenceLimit: 12,
    failureLimit: 12,
    replayLimit: 360
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      const mode = String(argv[index + 1] ?? 'progress');
      if (mode !== 'launch' && mode !== 'progress' && mode !== 'timeout' && mode !== 'complete') {
        throw new Error(`invalid mode: ${mode}`);
      }
      args.mode = mode;
      index += 1;
      continue;
    }
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

    throw new Error(`unknown arg: ${arg}`);
  }

  if (!args.teamId) {
    throw new Error('--team is required');
  }

  return args;
}

function renderWorkerTree(snapshot: TeamUiSnapshot): string {
  if (snapshot.worker_tree.length === 0) {
    return '- (worker tree unavailable)';
  }
  return snapshot.worker_tree.map((line) => `- ${line}`).join('\n');
}

function renderTasks(tasks: TeamSnapshotTask[], emptyMessage: string): string {
  if (tasks.length === 0) {
    return `- ${emptyMessage}`;
  }

  return tasks
    .map((task) => {
      const owner = task.claimed_by ? ` owner=${renderTaskOwner(task.claimed_by)}` : '';
      const role = task.required_role ? ` role=${renderTaskRole(task.required_role)}` : '';
      return `- \`${renderShortId(task.task_id)}\` p${task.priority} status=${task.status}${owner}${role} updated=${formatIsoTime(task.updated_at)} - ${task.title}`;
    })
    .join('\n');
}

function renderBlockers(tasks: TeamSnapshotBlocker[], emptyMessage: string): string {
  if (tasks.length === 0) {
    return `- ${emptyMessage}`;
  }

  return tasks
    .map((task) => {
      const role = task.required_role ? ` role=${task.required_role}` : '';
      return `- \`${renderShortId(task.task_id)}\` p${task.priority}${role} updated=${formatIsoTime(task.updated_at)} - ${task.title}`;
    })
    .join('\n');
}

function renderEvidence(items: TeamSnapshotEvidenceLink[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items
    .map((item) => {
      const task = item.task_id ? ` task=${renderShortId(item.task_id)}` : '';
      return `- ${formatIsoTime(item.created_at)}${task} ${item.label} ([replay](${item.href}))`;
    })
    .join('\n');
}

function renderFailures(items: TeamSnapshotFailureHighlight[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items
    .map((item) => {
      const link = item.replay_link ? ` ([replay](${item.replay_link}))` : '';
      return `- ${formatIsoTime(item.created_at)} severity=${item.severity} ${item.summary}${link}`;
    })
    .join('\n');
}

function renderRecentFeed(items: TeamSnapshotFeedItem[]): string {
  if (items.length === 0) {
    return '- (no recent events)';
  }

  return items
    .map((item) => {
      const marker = item.kind === 'failure' ? 'F' : (item.kind === 'evidence' ? 'E' : 'I');
      const task = item.task_id ? ` task=${renderShortId(item.task_id)}` : '';
      const agent = item.agent_id ? ` agent=${renderShortId(item.agent_id)}` : '';
      const link = item.replay_link ? ` ([replay](${item.replay_link}))` : '';
      return `- [${marker}] ${formatIsoTime(item.created_at)}${task}${agent} ${item.summary}${link}`;
    })
    .join('\n');
}

function renderHeader(mode: CardMode, snapshot: TeamUiSnapshot): string[] {
  const title = mode === 'launch'
    ? '# Team Launch'
    : mode === 'progress'
      ? '# Team Progress'
      : mode === 'timeout'
        ? '# Team Timeout'
        : '# Team Complete';

  return [
    title,
    '',
    `- Team: \`${snapshot.team.team_id}\``,
    `- Status: \`${snapshot.team.status}\``,
    `- Profile: \`${snapshot.team.profile}\``,
    `- Mode: \`${snapshot.team.mode}\``,
    `- Max Threads: ${snapshot.team.max_threads}`,
    `- Updated: ${formatIsoTime(snapshot.team.updated_at)}`,
    snapshot.team.objective ? `- Objective: ${snapshot.team.objective}` : '- Objective: (none)',
    ''
  ];
}

function renderCounters(snapshot: TeamUiSnapshot): string[] {
  const running = snapshot.tasks.in_progress
    + snapshot.tasks.queued
    + snapshot.tasks.dispatching
    + snapshot.tasks.executing
    + snapshot.tasks.validating
    + snapshot.tasks.integrating;

  return [
    '## Counters',
    `- Workers: total=${snapshot.workers.total} busy=${snapshot.workers.busy} idle=${snapshot.workers.idle} offline=${snapshot.workers.offline} utilization=${snapshot.workers.utilization_pct}%`,
    `- Tasks: running=${running} todo=${snapshot.tasks.todo} blocked=${snapshot.tasks.blocked} done=${snapshot.tasks.done} failed=${snapshot.tasks.failed_terminal} cancelled=${snapshot.tasks.cancelled} total=${snapshot.tasks.total}`,
    `- Queue: depth=${snapshot.progress.queue_depth} ready=${snapshot.progress.ready_tasks} in_progress=${snapshot.progress.in_progress_tasks} blocked=${snapshot.progress.blocked_tasks} pending_inbox=${snapshot.progress.pending_inbox}`,
    `- Completion: ${snapshot.progress.done_tasks}/${snapshot.progress.total_tasks} (${snapshot.progress.completion_pct}%)`,
    ''
  ];
}

function renderLaunchCard(snapshot: TeamUiSnapshot): string {
  return [
    ...renderHeader('launch', snapshot),
    ...renderCounters(snapshot),
    '## Worker Tree',
    renderWorkerTree(snapshot),
    '',
    '## Initial Queue Spotlight',
    renderTasks(snapshot.spotlight_tasks.slice(0, 8), '(no queued work)'),
    '',
    '## Early Evidence',
    renderEvidence(snapshot.evidence_links.slice(0, 6), '(no evidence yet)')
  ].join('\n');
}

function renderProgressCard(snapshot: TeamUiSnapshot): string {
  return [
    ...renderHeader('progress', snapshot),
    ...renderCounters(snapshot),
    '## Worker Tree',
    renderWorkerTree(snapshot),
    '',
    '## Active Tasks',
    renderTasks(snapshot.active_tasks.slice(0, 10), '(no active tasks)'),
    '',
    '## Blockers',
    renderBlockers(snapshot.blockers.slice(0, 10), '(no blockers)'),
    '',
    '## Recent Feed',
    renderRecentFeed(snapshot.feed.slice(0, 10)),
    '',
    '## Evidence Links',
    renderEvidence(snapshot.evidence_links.slice(0, 8), '(no evidence yet)'),
    '',
    '## Failure Highlights',
    renderFailures(snapshot.failure_highlights.slice(0, 8), '(no failure signals)')
  ].join('\n');
}

function renderTimeoutCard(snapshot: TeamUiSnapshot): string {
  return [
    ...renderHeader('timeout', snapshot),
    ...renderCounters(snapshot),
    '## Blockers Requiring Operator Action',
    renderBlockers(snapshot.blockers.slice(0, 12), '(no blocked tasks)'),
    '',
    '## Failed Terminal Tasks',
    renderBlockers(snapshot.failed_terminal_tasks.slice(0, 12), '(none)'),
    '',
    '## Failure Highlights',
    renderFailures(snapshot.failure_highlights.slice(0, 12), '(no failure signals)'),
    '',
    '## Operator Actions',
    '- `p`: pause team',
    '- `r`: resume team',
    '- `d`: drain todo/blocked queue',
    '- `t`: retry blocked tasks',
    '- `q`: quit monitor'
  ].join('\n');
}

function renderCompleteCard(snapshot: TeamUiSnapshot): string {
  return [
    ...renderHeader('complete', snapshot),
    ...renderCounters(snapshot),
    '## Completion Evidence',
    renderEvidence(snapshot.evidence_links.slice(0, 12), '(no completion evidence)'),
    '',
    '## Residual Risk Signals',
    renderFailures(snapshot.failure_highlights.slice(0, 12), '(no residual failure signals)'),
    '',
    '## Remaining Blockers',
    renderBlockers(snapshot.blockers.slice(0, 10), '(none)')
  ].join('\n');
}

function renderCard(mode: CardMode, snapshot: TeamUiSnapshot): string {
  if (mode === 'launch') return renderLaunchCard(snapshot);
  if (mode === 'progress') return renderProgressCard(snapshot);
  if (mode === 'timeout') return renderTimeoutCard(snapshot);
  return renderCompleteCard(snapshot);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer({ dbPath: args.dbPath, logPath: '.tmp/team-card.log' });
  server.start();

  try {
    const snapshot = loadTeamUiSnapshot(server.store, args.teamId, {
      recent_event_limit: args.recentEventLimit,
      evidence_limit: args.evidenceLimit,
      failure_limit: args.failureLimit,
      replay_limit: args.replayLimit,
      feed_limit: Math.max(args.recentEventLimit, 10)
    });

    process.stdout.write(`${renderCard(args.mode, snapshot)}\n`);
  } finally {
    server.store.close();
  }
}

main();
