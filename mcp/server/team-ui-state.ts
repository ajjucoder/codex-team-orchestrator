import type { AgentRecord, TaskRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';

interface TeamUiStateOptions {
  recent_event_limit?: number;
  evidence_limit?: number;
  failure_limit?: number;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function readLimit(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? clamp(Math.floor(numeric), 1, max)
    : fallback;
}

function completionPct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

function eventLooksLikeFailure(event: Record<string, unknown>): boolean {
  const eventType = readString(event.event_type).toLowerCase();
  if (eventType.includes('failed') || eventType.includes('error') || eventType.includes('blocked') || eventType.includes('deny')) {
    return true;
  }
  const payload = readRecord(event.payload);
  if (payload.ok === false) return true;
  if (typeof payload.error === 'string' && payload.error.trim().length > 0) return true;
  return false;
}

function summarizeEvent(event: Record<string, unknown>): string {
  const payload = readRecord(event.payload);
  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return payload.error;
  }
  if (typeof payload.deny_reason === 'string' && payload.deny_reason.trim().length > 0) {
    return payload.deny_reason;
  }

  const input = readRecord(payload.input);
  if (typeof input.status === 'string' && input.status.trim().length > 0) {
    const taskId = readString(input.task_id);
    return taskId ? `task ${taskId} -> ${input.status}` : `status -> ${input.status}`;
  }

  const eventType = readString(event.event_type);
  return eventType || 'event';
}

function toRecentEvent(teamId: string, event: Record<string, unknown>): Record<string, unknown> {
  const eventId = Number(event.id ?? 0);
  const payload = readRecord(event.payload);
  const input = readRecord(payload.input);
  return {
    event_id: eventId,
    event_type: readString(event.event_type),
    created_at: readString(event.created_at),
    agent_id: event.agent_id ?? null,
    task_id: event.task_id ?? input.task_id ?? null,
    ok: payload.ok ?? null,
    summary: summarizeEvent(event),
    replay_link: eventId > 0 ? `replay://${teamId}/event/${eventId}` : null
  };
}

function buildEvidenceLinks(
  teamId: string,
  eventsDescending: Array<Record<string, unknown>>,
  limit: number
): Array<Record<string, unknown>> {
  const links: Array<Record<string, unknown>> = [];
  const dedupe = new Set<string>();

  for (const event of eventsDescending) {
    if (links.length >= limit) break;
    const eventType = readString(event.event_type);
    const eventId = Number(event.id ?? 0);
    if (!Number.isFinite(eventId) || eventId <= 0) continue;

    const payload = readRecord(event.payload);
    if (payload.ok !== true) continue;

    if (eventType === 'tool_call:team_task_update') {
      const input = readRecord(payload.input);
      if (input.status !== 'done') continue;
      const taskId = readString(input.task_id);
      const href = `replay://${teamId}/event/${eventId}`;
      if (dedupe.has(href)) continue;
      dedupe.add(href);
      links.push({
        label: taskId ? `task done: ${taskId}` : 'task done',
        href,
        event_id: eventId,
        event_type: eventType,
        task_id: taskId || null,
        created_at: readString(event.created_at)
      });
      continue;
    }

    if (eventType === 'tool_call:team_artifact_publish') {
      const artifact = readRecord(payload.artifact);
      const artifactId = readString(artifact.artifact_id);
      const href = `replay://${teamId}/event/${eventId}`;
      if (dedupe.has(href)) continue;
      dedupe.add(href);
      links.push({
        label: artifactId ? `artifact published: ${artifactId}` : 'artifact published',
        href,
        event_id: eventId,
        event_type: eventType,
        artifact_id: artifactId || null,
        created_at: readString(event.created_at)
      });
      continue;
    }

    if (eventType === 'tool_call:team_merge_decide') {
      const href = `replay://${teamId}/event/${eventId}`;
      if (dedupe.has(href)) continue;
      dedupe.add(href);
      links.push({
        label: 'merge decision',
        href,
        event_id: eventId,
        event_type: eventType,
        created_at: readString(event.created_at)
      });
    }
  }

  return links;
}

function buildFailureHighlights(
  teamId: string,
  eventsDescending: Array<Record<string, unknown>>,
  limit: number
): Array<Record<string, unknown>> {
  const highlights: Array<Record<string, unknown>> = [];
  for (const event of eventsDescending) {
    if (highlights.length >= limit) break;
    if (!eventLooksLikeFailure(event)) continue;
    const eventType = readString(event.event_type);
    const eventId = Number(event.id ?? 0);
    highlights.push({
      event_id: eventId,
      event_type: eventType,
      created_at: readString(event.created_at),
      summary: summarizeEvent(event),
      severity: eventType.includes('failed') || eventType.includes('error') ? 'high' : 'medium',
      replay_link: eventId > 0 ? `replay://${teamId}/event/${eventId}` : null
    });
  }
  return highlights;
}

function summarizeWorkers(agents: AgentRecord[]): Record<string, unknown> {
  const idle = agents.filter((agent) => agent.status === 'idle').length;
  const busy = agents.filter((agent) => agent.status === 'busy').length;
  const offline = agents.filter((agent) => agent.status === 'offline').length;
  const active = idle + busy;
  const utilizationPct = active > 0 ? Math.round((busy / active) * 100) : 0;

  return {
    total: agents.length,
    idle,
    busy,
    offline,
    active,
    utilization_pct: utilizationPct
  };
}

function countTasks(tasks: TaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    queued: 0,
    dispatching: 0,
    executing: 0,
    validating: 0,
    integrating: 0,
    failed_terminal: 0
  };

  for (const task of tasks) {
    counts[task.status] = Number(counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function readAgentSpecialist(agent: AgentRecord): Record<string, unknown> {
  const metadata = readRecord(agent.metadata);
  const specialist = readRecord(metadata.specialist);
  const specialistHandle = readString(metadata.specialist_handle);
  const specialistDomain = readString(metadata.specialist_domain);
  const spawnReason = readString(metadata.spawn_reason);

  const fromMetadata: Record<string, unknown> = {};
  if (specialistHandle) {
    fromMetadata.specialist_handle = specialistHandle;
  }
  if (specialistDomain) {
    fromMetadata.specialist_domain = specialistDomain;
  }
  if (spawnReason) {
    fromMetadata.spawn_reason = spawnReason;
  }

  return {
    ...specialist,
    ...fromMetadata
  };
}

function buildControls(
  teamStatus: string,
  maxThreads: number,
  workerCount: number,
  nonOfflineWorkerCount: number,
  taskCounts: Record<string, number>,
  recoverySnapshot: ReturnType<SqliteStore['buildRecoverySnapshot']>
): Record<string, unknown> {
  const isFinalized = teamStatus === 'finalized';
  const isArchived = teamStatus === 'archived';
  const isTerminal = isFinalized || isArchived;
  const isActive = teamStatus === 'active';
  const hasCapacity = nonOfflineWorkerCount < Math.max(1, maxThreads);
  const hasOpenTasks = Math.max(
    0,
    taskCounts.todo
      + taskCounts.in_progress
      + taskCounts.blocked
      + taskCounts.queued
      + taskCounts.dispatching
      + taskCounts.executing
      + taskCounts.validating
      + taskCounts.integrating
      + taskCounts.failed_terminal
  ) > 0;
  const hasRecoverableIssues = recoverySnapshot.workers.stale_agent_count > 0
    || recoverySnapshot.leases.expired_count > 0
    || recoverySnapshot.inbox.dead_letter_count > 0
    || taskCounts.blocked > 0
    || taskCounts.failed_terminal > 0;

  const enabled: Record<string, boolean> = {
    team_resume: isFinalized,
    team_finalize: !isTerminal,
    team_spawn: isActive && hasCapacity,
    team_spawn_ready_roles: isActive && hasCapacity && hasOpenTasks,
    team_task_create: !isTerminal,
    team_task_next: isActive && hasOpenTasks && workerCount > 0,
    team_task_update: !isTerminal && hasOpenTasks,
    team_runtime_rebalance: isActive && hasOpenTasks,
    team_orphan_recover: hasRecoverableIssues
  };

  return {
    allowed_commands: Object.keys(enabled),
    enabled
  };
}

export function buildTeamUiState(
  store: SqliteStore,
  teamId: string,
  options: TeamUiStateOptions = {}
): Record<string, unknown> | null {
  const team = store.getTeam(teamId);
  if (!team) return null;

  const summary = store.summarizeTeam(teamId);
  if (!summary) return null;

  const recentEventLimit = readLimit(options.recent_event_limit, 25, 300);
  const evidenceLimit = readLimit(options.evidence_limit, 12, 80);
  const failureLimit = readLimit(options.failure_limit, 8, 80);

  const agents = store.listAgentsByTeam(teamId);
  const tasks = store.listTasks(teamId, null);
  const taskCounts = countTasks(tasks);
  const workerSummary = summarizeWorkers(agents);
  const recoverySnapshot = store.buildRecoverySnapshot(teamId, {
    limit: 20
  });

  const replayWindow = Math.max(120, recentEventLimit * 4, evidenceLimit * 4, failureLimit * 4);
  const events = store.replayEventsTail(teamId, replayWindow);
  const eventsDescending = [...events].reverse();

  const recentEvents = eventsDescending
    .slice(0, recentEventLimit)
    .map((event) => toRecentEvent(teamId, event));

  const evidenceLinks = buildEvidenceLinks(teamId, eventsDescending, evidenceLimit);
  const failureHighlights = buildFailureHighlights(teamId, eventsDescending, failureLimit);

  const specialistAssignments = readRecord(team.metadata?.specialist_assignments);
  const roster = agents.map((agent) => ({
    agent_id: agent.agent_id,
    role: agent.role,
    status: agent.status,
    model: agent.model,
    last_heartbeat_at: agent.last_heartbeat_at,
    specialist: (() => {
      const fromAgent = readAgentSpecialist(agent);
      if (Object.keys(fromAgent).length > 0) {
        return fromAgent;
      }
      return readRecord(specialistAssignments[agent.agent_id]);
    })()
  }));

  const blockedTasks = tasks
    .filter((task) => task.status === 'blocked')
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 12)
    .map((task) => ({
      task_id: task.task_id,
      title: task.title,
      required_role: task.required_role,
      priority: task.priority,
      updated_at: task.updated_at
    }));

  const failedTasks = tasks
    .filter((task) => task.status === 'failed_terminal')
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 12)
    .map((task) => ({
      task_id: task.task_id,
      title: task.title,
      required_role: task.required_role,
      priority: task.priority,
      updated_at: task.updated_at
    }));

  const totalTasks = tasks.length;
  const doneTasks = taskCounts.done;
  const openTasks = totalTasks - doneTasks - taskCounts.cancelled;
  const completion = completionPct(doneTasks, totalTasks);
  const waveState = store.getTeamWaveState(teamId);
  const waveMetrics = {
    source: waveState ? 'persisted' : 'derived',
    wave_id: Number(waveState?.wave_id ?? 0),
    tick_count: Number(waveState?.tick_count ?? 0),
    dispatched_count: Number(waveState?.dispatched_count ?? 0),
    recovered_tasks: Number(waveState?.recovered_tasks ?? 0),
    cleaned_assignments: Number(waveState?.cleaned_assignments ?? 0),
    dispatched_total: Number(waveState?.dispatched_total ?? 0),
    recovered_total: Number(waveState?.recovered_total ?? 0),
    cleaned_total: Number(waveState?.cleaned_total ?? 0),
    ready_tasks: Number(recoverySnapshot.queue.ready_tasks ?? waveState?.ready_tasks ?? 0),
    in_progress_tasks: Number(recoverySnapshot.queue.in_progress_tasks ?? waveState?.in_progress_tasks ?? 0),
    blocked_tasks: Number(recoverySnapshot.queue.blocked_tasks ?? waveState?.blocked_tasks ?? 0),
    done_tasks: doneTasks,
    cancelled_tasks: taskCounts.cancelled,
    total_tasks: totalTasks,
    completion_pct: completion,
    updated_at: waveState?.updated_at ?? team.updated_at,
    metadata: waveState?.metadata ?? {}
  };

  return {
    team: {
      team_id: team.team_id,
      status: team.status,
      mode: team.mode,
      profile: team.profile,
      objective: team.objective,
      max_threads: team.max_threads,
      created_at: team.created_at,
      updated_at: team.updated_at,
      last_active_at: team.last_active_at
    },
    workers: {
      summary: workerSummary,
      roster
    },
    tasks: {
      total: totalTasks,
      open: Math.max(0, openTasks),
      counts: taskCounts,
      spotlight: tasks
        .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
        .sort((left, right) => left.priority - right.priority)
        .slice(0, 15)
        .map((task) => ({
          task_id: task.task_id,
          title: task.title,
          status: task.status,
          required_role: task.required_role,
          priority: task.priority,
          claimed_by: task.claimed_by,
          updated_at: task.updated_at
        }))
    },
    progress: {
      completion_pct: completion,
      done_tasks: doneTasks,
      total_tasks: totalTasks,
      queue_depth: recoverySnapshot.queue.open_tasks,
      ready_tasks: recoverySnapshot.queue.ready_tasks,
      in_progress_tasks: recoverySnapshot.queue.in_progress_tasks,
      blocked_tasks: recoverySnapshot.queue.blocked_tasks,
      pending_inbox: recoverySnapshot.inbox.pending_count,
      usage: summary.usage,
      wave: waveMetrics
    },
    blockers: {
      blocked_tasks: blockedTasks,
      failed_terminal_tasks: failedTasks,
      stale_agents: recoverySnapshot.workers.stale_agent_ids,
      expired_leases: recoverySnapshot.leases.expired_task_ids,
      dead_letter_inbox: recoverySnapshot.inbox.dead_letter_count
    },
    recent_events: recentEvents,
    evidence_links: evidenceLinks,
    failure_highlights: failureHighlights,
    controls: buildControls(
      team.status,
      team.max_threads,
      agents.length,
      agents.filter((agent) => agent.status !== 'offline').length,
      taskCounts,
      recoverySnapshot
    )
  };
}
