import type { AgentRecord } from '../mcp/store/entities.js';
import type { SqliteStore } from '../mcp/store/sqlite-store.js';
import { buildTeamUiState } from '../mcp/server/team-ui-state.js';

const ACTIVE_TASK_STATUSES = new Set([
  'in_progress',
  'queued',
  'dispatching',
  'executing',
  'validating',
  'integrating'
]);

const FAILURE_TASK_STATUSES = new Set(['failed_terminal']);

type FeedKind = 'evidence' | 'failure' | 'event';

export interface TeamSnapshotTask {
  task_id: string;
  title: string;
  status: string;
  required_role: string | null;
  priority: number;
  claimed_by: string | null;
  updated_at: string;
}

export interface TeamSnapshotBlocker {
  task_id: string;
  title: string;
  required_role: string | null;
  priority: number;
  updated_at: string;
}

export interface TeamSnapshotEvidenceLink {
  label: string;
  href: string;
  event_id: number;
  event_type: string;
  task_id: string | null;
  artifact_id: string | null;
  created_at: string;
}

export interface TeamSnapshotFailureHighlight {
  event_id: number;
  event_type: string;
  created_at: string;
  summary: string;
  severity: string;
  replay_link: string | null;
}

export interface TeamSnapshotFeedItem {
  event_id: number;
  event_type: string;
  created_at: string;
  task_id: string | null;
  agent_id: string | null;
  ok: boolean | null;
  summary: string;
  replay_link: string | null;
  kind: FeedKind;
}

export interface TeamSnapshotWorker {
  agent_id: string;
  role: string;
  status: string;
  model: string | null;
  last_heartbeat_at: string | null;
  specialist_handle: string | null;
  specialist_domain: string | null;
}

export interface TeamUiSnapshot {
  team: {
    team_id: string;
    status: string;
    mode: string;
    profile: string;
    objective: string | null;
    max_threads: number;
    created_at: string;
    updated_at: string;
    last_active_at: string | null;
  };
  workers: {
    total: number;
    idle: number;
    busy: number;
    offline: number;
    active: number;
    utilization_pct: number;
  };
  tasks: {
    total: number;
    open: number;
    done: number;
    cancelled: number;
    todo: number;
    in_progress: number;
    blocked: number;
    queued: number;
    dispatching: number;
    executing: number;
    validating: number;
    integrating: number;
    failed_terminal: number;
  };
  progress: {
    completion_pct: number;
    done_tasks: number;
    total_tasks: number;
    queue_depth: number;
    ready_tasks: number;
    in_progress_tasks: number;
    blocked_tasks: number;
    pending_inbox: number;
  };
  workers_roster: TeamSnapshotWorker[];
  worker_tree: string[];
  spotlight_tasks: TeamSnapshotTask[];
  active_tasks: TeamSnapshotTask[];
  blockers: TeamSnapshotBlocker[];
  failed_terminal_tasks: TeamSnapshotBlocker[];
  evidence_links: TeamSnapshotEvidenceLink[];
  failure_highlights: TeamSnapshotFailureHighlight[];
  feed: TeamSnapshotFeedItem[];
}

interface LoadOptions {
  recent_event_limit?: number;
  evidence_limit?: number;
  failure_limit?: number;
  replay_limit?: number;
  feed_limit?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareIso(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return compareText(left, right);
  if (!Number.isFinite(leftTime)) return 1;
  if (!Number.isFinite(rightTime)) return -1;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return compareText(left, right);
}

function compareSpotlightTasks(left: TeamSnapshotTask, right: TeamSnapshotTask): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  const updatedDiff = compareIso(left.updated_at, right.updated_at);
  if (updatedDiff !== 0) return updatedDiff;
  return compareText(left.task_id, right.task_id);
}

function compareBlockers(left: TeamSnapshotBlocker, right: TeamSnapshotBlocker): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  const updatedDiff = compareIso(left.updated_at, right.updated_at);
  if (updatedDiff !== 0) return updatedDiff;
  return compareText(left.task_id, right.task_id);
}

function roleWeight(role: string): number {
  if (role === 'lead') return 0;
  if (role === 'orchestrator') return 1;
  return 2;
}

function toSlugToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function roleHandleSuffix(role: string): string {
  if (role === 'implementer') return 'dev';
  if (role === 'tester') return 'qa';
  if (role === 'reviewer') return 'review';
  return toSlugToken(role) || 'worker';
}

function workerHandle(worker: TeamSnapshotWorker): string {
  if (worker.specialist_handle) return worker.specialist_handle;
  const domain = toSlugToken(worker.specialist_domain ?? '') || 'general';
  return `@${domain}-${roleHandleSuffix(worker.role)}`;
}

function compareWorkers(left: TeamSnapshotWorker, right: TeamSnapshotWorker): number {
  const roleDiff = roleWeight(left.role) - roleWeight(right.role);
  if (roleDiff !== 0) return roleDiff;
  const handleDiff = compareText(workerHandle(left), workerHandle(right));
  if (handleDiff !== 0) return handleDiff;
  const statusDiff = compareText(left.status, right.status);
  if (statusDiff !== 0) return statusDiff;
  return compareText(left.agent_id, right.agent_id);
}

function shortId(value: string, tail = 8): string {
  if (value.length <= tail) return value;
  return value.slice(-tail);
}

function parseWorker(entry: unknown): TeamSnapshotWorker {
  const row = asRecord(entry);
  const specialist = asRecord(row.specialist);
  return {
    agent_id: readString(row.agent_id),
    role: readString(row.role),
    status: readString(row.status),
    model: readOptionalString(row.model),
    last_heartbeat_at: readOptionalString(row.last_heartbeat_at),
    specialist_handle: readOptionalString(specialist.specialist_handle),
    specialist_domain: readOptionalString(specialist.specialist_domain)
  };
}

function parseSpotlightTask(entry: unknown): TeamSnapshotTask {
  const row = asRecord(entry);
  return {
    task_id: readString(row.task_id),
    title: readString(row.title),
    status: readString(row.status),
    required_role: readOptionalString(row.required_role),
    priority: readNumber(row.priority),
    claimed_by: readOptionalString(row.claimed_by),
    updated_at: readString(row.updated_at)
  };
}

function parseBlocker(entry: unknown): TeamSnapshotBlocker {
  const row = asRecord(entry);
  return {
    task_id: readString(row.task_id),
    title: readString(row.title),
    required_role: readOptionalString(row.required_role),
    priority: readNumber(row.priority),
    updated_at: readString(row.updated_at)
  };
}

function parseEvidenceLink(entry: unknown): TeamSnapshotEvidenceLink {
  const row = asRecord(entry);
  return {
    label: readString(row.label),
    href: readString(row.href),
    event_id: readNumber(row.event_id),
    event_type: readString(row.event_type),
    task_id: readOptionalString(row.task_id),
    artifact_id: readOptionalString(row.artifact_id),
    created_at: readString(row.created_at)
  };
}

function parseFailureHighlight(entry: unknown): TeamSnapshotFailureHighlight {
  const row = asRecord(entry);
  return {
    event_id: readNumber(row.event_id),
    event_type: readString(row.event_type),
    created_at: readString(row.created_at),
    summary: readString(row.summary),
    severity: readString(row.severity),
    replay_link: readOptionalString(row.replay_link)
  };
}

function parseFeedItem(entry: unknown): Omit<TeamSnapshotFeedItem, 'kind'> {
  const row = asRecord(entry);
  return {
    event_id: readNumber(row.event_id),
    event_type: readString(row.event_type),
    created_at: readString(row.created_at),
    task_id: readOptionalString(row.task_id),
    agent_id: readOptionalString(row.agent_id),
    ok: readBooleanOrNull(row.ok),
    summary: readString(row.summary),
    replay_link: readOptionalString(row.replay_link)
  };
}

function classifyFeed(event: Omit<TeamSnapshotFeedItem, 'kind'>): FeedKind {
  const type = event.event_type.toLowerCase();
  if (
    event.ok === false
    || type.includes('failed')
    || type.includes('error')
    || type.includes('blocked')
    || type.includes('deny')
    || type.includes('timeout')
  ) {
    return 'failure';
  }

  if (type === 'task_terminal_evidence' || type.includes('artifact_publish')) {
    return 'evidence';
  }

  if (type === 'tool_call:team_task_update') {
    const summary = event.summary.toLowerCase();
    if (summary.includes('-> done') || summary.includes('status -> done')) {
      return 'evidence';
    }
  }

  return 'event';
}

function extractCommunicationEdges(events: Array<Record<string, unknown>>): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const event of events) {
    const eventType = readString(event.event_type);
    const payload = asRecord(event.payload);

    let fromAgentId = '';
    let toAgentId = '';

    if (eventType === 'worker_instruction_dispatched') {
      fromAgentId = readString(payload.from_agent_id);
      toAgentId = readString(payload.to_agent_id);
    } else if (eventType === 'tool_call:team_send') {
      const input = asRecord(payload.input);
      fromAgentId = readString(input.from_agent_id);
      toAgentId = readString(input.to_agent_id);
    }

    if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) {
      continue;
    }

    edges.push({ from: fromAgentId, to: toAgentId });
  }

  return edges;
}

function buildWorkerTree(
  roster: TeamSnapshotWorker[],
  replayEvents: Array<Record<string, unknown>>
): string[] {
  if (roster.length === 0) return ['(no workers)'];

  const sortedRoster = [...roster].sort(compareWorkers);
  const workerById = new Map(sortedRoster.map((worker) => [worker.agent_id, worker]));
  const parentByChild = new Map<string, string>();

  for (const edge of extractCommunicationEdges(replayEvents)) {
    if (!workerById.has(edge.from) || !workerById.has(edge.to)) continue;
    if (!parentByChild.has(edge.to)) {
      parentByChild.set(edge.to, edge.from);
    }
  }

  const childrenByParent = new Map<string, string[]>();
  for (const [child, parent] of parentByChild.entries()) {
    const children = childrenByParent.get(parent) ?? [];
    children.push(child);
    childrenByParent.set(parent, children);
  }

  for (const [parent, children] of childrenByParent.entries()) {
    children.sort((left, right) => {
      const leftWorker = workerById.get(left);
      const rightWorker = workerById.get(right);
      if (!leftWorker || !rightWorker) return compareText(left, right);
      return compareWorkers(leftWorker, rightWorker);
    });
    childrenByParent.set(parent, children);
  }

  const roots = sortedRoster
    .filter((worker) => !parentByChild.has(worker.agent_id))
    .map((worker) => worker.agent_id);

  const visited = new Set<string>();
  const lines: string[] = [];

  const renderNode = (agentId: string, prefix: string, isLast: boolean, depth: number): void => {
    if (visited.has(agentId)) return;
    visited.add(agentId);

    const worker = workerById.get(agentId);
    if (!worker) return;

    const marker = depth === 0 ? '-' : (isLast ? '\\-' : '|-');
    const model = worker.model ? ` model=${worker.model}` : '';
    const handle = workerHandle(worker);
    lines.push(`${prefix}${marker} ${handle} ${shortId(worker.agent_id)} role=${worker.role} status=${worker.status}${model}`);

    const children = childrenByParent.get(agentId) ?? [];
    const nextPrefix = depth === 0
      ? ''
      : `${prefix}${isLast ? '  ' : '| '}`;

    for (let index = 0; index < children.length; index += 1) {
      renderNode(children[index], nextPrefix, index === children.length - 1, depth + 1);
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    renderNode(roots[index], '', index === roots.length - 1, 0);
  }

  const stragglers = sortedRoster
    .map((worker) => worker.agent_id)
    .filter((agentId) => !visited.has(agentId));

  for (const agentId of stragglers) {
    renderNode(agentId, '', true, 0);
  }

  return lines.length > 0 ? lines : ['(no workers)'];
}

function normalizeAgentFromRoster(worker: TeamSnapshotWorker): AgentRecord {
  return {
    agent_id: worker.agent_id,
    team_id: '',
    role: worker.role,
    status: worker.status as AgentRecord['status'],
    model: worker.model,
    last_heartbeat_at: worker.last_heartbeat_at,
    created_at: '',
    updated_at: '',
    metadata: {}
  };
}

function fallbackWorkerSummary(roster: TeamSnapshotWorker[]): TeamUiSnapshot['workers'] {
  const normalized = roster.map((worker) => normalizeAgentFromRoster(worker));
  const idle = normalized.filter((worker) => worker.status === 'idle').length;
  const busy = normalized.filter((worker) => worker.status === 'busy').length;
  const offline = normalized.filter((worker) => worker.status === 'offline').length;
  const active = idle + busy;
  return {
    total: normalized.length,
    idle,
    busy,
    offline,
    active,
    utilization_pct: active > 0 ? Math.round((busy / active) * 100) : 0
  };
}

export function loadTeamUiSnapshot(store: SqliteStore, teamId: string, options: LoadOptions = {}): TeamUiSnapshot {
  const state = buildTeamUiState(store, teamId, {
    recent_event_limit: options.recent_event_limit,
    evidence_limit: options.evidence_limit,
    failure_limit: options.failure_limit
  });

  if (!state) {
    throw new Error(`team not found: ${teamId}`);
  }

  const teamRecord = asRecord(state.team);
  const workersRecord = asRecord(state.workers);
  const workerSummary = asRecord(workersRecord.summary);
  const roster = asArray(workersRecord.roster)
    .map((entry) => parseWorker(entry))
    .filter((worker) => worker.agent_id.length > 0)
    .sort(compareWorkers);

  const tasksRecord = asRecord(state.tasks);
  const counts = asRecord(tasksRecord.counts);
  const spotlight = asArray(tasksRecord.spotlight)
    .map((entry) => parseSpotlightTask(entry))
    .filter((task) => task.task_id.length > 0)
    .sort(compareSpotlightTasks);

  const blockersRecord = asRecord(state.blockers);
  const blockedTasks = asArray(blockersRecord.blocked_tasks)
    .map((entry) => parseBlocker(entry))
    .filter((task) => task.task_id.length > 0)
    .sort(compareBlockers);

  const failedTasks = asArray(blockersRecord.failed_terminal_tasks)
    .map((entry) => parseBlocker(entry))
    .filter((task) => task.task_id.length > 0)
    .sort(compareBlockers);

  const evidenceLinks = asArray(state.evidence_links)
    .map((entry) => parseEvidenceLink(entry))
    .filter((item) => item.href.length > 0)
    .sort((left, right) => {
      if (left.event_id !== right.event_id) return right.event_id - left.event_id;
      return compareText(left.href, right.href);
    });

  const failureHighlights = asArray(state.failure_highlights)
    .map((entry) => parseFailureHighlight(entry))
    .sort((left, right) => {
      if (left.event_id !== right.event_id) return right.event_id - left.event_id;
      return compareText(left.summary, right.summary);
    });

  const feedLimit = Math.max(1, Math.floor(options.feed_limit ?? 20));
  const feed = asArray(state.recent_events)
    .map((entry) => parseFeedItem(entry))
    .filter((event) => event.event_id > 0)
    .sort((left, right) => {
      if (left.event_id !== right.event_id) return right.event_id - left.event_id;
      return compareText(left.event_type, right.event_type);
    })
    .slice(0, feedLimit)
    .map((event) => ({
      ...event,
      kind: classifyFeed(event)
    }));

  const replayLimit = Math.max(120, Math.floor(options.replay_limit ?? 300));
  const replayEvents = store.replayEvents(teamId, replayLimit);
  const workerTree = buildWorkerTree(roster, replayEvents);

  const workers = Object.keys(workerSummary).length > 0
    ? {
      total: readNumber(workerSummary.total),
      idle: readNumber(workerSummary.idle),
      busy: readNumber(workerSummary.busy),
      offline: readNumber(workerSummary.offline),
      active: readNumber(workerSummary.active),
      utilization_pct: readNumber(workerSummary.utilization_pct)
    }
    : fallbackWorkerSummary(roster);

  const done = readNumber(counts.done);
  const cancelled = readNumber(counts.cancelled);
  const total = readNumber(tasksRecord.total);

  const activeTasks = spotlight
    .filter((task) => ACTIVE_TASK_STATUSES.has(task.status))
    .sort(compareSpotlightTasks);

  return {
    team: {
      team_id: readString(teamRecord.team_id, teamId),
      status: readString(teamRecord.status, 'unknown'),
      mode: readString(teamRecord.mode, 'default'),
      profile: readString(teamRecord.profile, 'default'),
      objective: readOptionalString(teamRecord.objective),
      max_threads: readNumber(teamRecord.max_threads),
      created_at: readString(teamRecord.created_at),
      updated_at: readString(teamRecord.updated_at),
      last_active_at: readOptionalString(teamRecord.last_active_at)
    },
    workers,
    tasks: {
      total,
      open: readNumber(tasksRecord.open),
      done,
      cancelled,
      todo: readNumber(counts.todo),
      in_progress: readNumber(counts.in_progress),
      blocked: readNumber(counts.blocked),
      queued: readNumber(counts.queued),
      dispatching: readNumber(counts.dispatching),
      executing: readNumber(counts.executing),
      validating: readNumber(counts.validating),
      integrating: readNumber(counts.integrating),
      failed_terminal: readNumber(counts.failed_terminal)
    },
    progress: {
      completion_pct: readNumber(asRecord(state.progress).completion_pct),
      done_tasks: readNumber(asRecord(state.progress).done_tasks, done),
      total_tasks: readNumber(asRecord(state.progress).total_tasks, total),
      queue_depth: readNumber(asRecord(state.progress).queue_depth),
      ready_tasks: readNumber(asRecord(state.progress).ready_tasks),
      in_progress_tasks: readNumber(asRecord(state.progress).in_progress_tasks),
      blocked_tasks: readNumber(asRecord(state.progress).blocked_tasks),
      pending_inbox: readNumber(asRecord(state.progress).pending_inbox)
    },
    workers_roster: roster,
    worker_tree: workerTree,
    spotlight_tasks: spotlight,
    active_tasks: activeTasks,
    blockers: blockedTasks,
    failed_terminal_tasks: failedTasks,
    evidence_links: evidenceLinks,
    failure_highlights: failureHighlights,
    feed
  };
}

export function formatIsoTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString().replace('T', ' ').replace('Z', '');
}

export function renderTaskOwner(value: string | null): string {
  if (!value) return '';
  return shortId(value);
}

export function renderTaskRole(value: string | null): string {
  return value ?? '';
}

export function renderShortId(value: string): string {
  return shortId(value);
}

export function isActiveTaskStatus(status: string): boolean {
  return ACTIVE_TASK_STATUSES.has(status);
}

export function isFailureTaskStatus(status: string): boolean {
  return FAILURE_TASK_STATUSES.has(status);
}
