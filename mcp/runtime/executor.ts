import type { TaskRecord } from '../store/entities.js';
import type { ToolServerLike, ToolResult } from '../server/tools/types.js';
import { RuntimeScheduler, type SchedulerTickResult } from './scheduler.js';

function nowIso(): string {
  return new Date().toISOString();
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

type WorkerStatusClassification = 'terminal_success' | 'terminal_failure' | 'non_terminal';

const TERMINAL_SUCCESS_STATUSES = new Set([
  'completed',
  'succeeded',
  'done',
  'finished',
  'success'
]);

const TERMINAL_FAILURE_STATUSES = new Set([
  'failed',
  'error',
  'cancelled',
  'interrupted',
  'rejected',
  'timed_out',
  'timeout'
]);

function classifyWorkerStatus(status: unknown): WorkerStatusClassification {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (TERMINAL_SUCCESS_STATUSES.has(normalized)) return 'terminal_success';
  if (TERMINAL_FAILURE_STATUSES.has(normalized)) return 'terminal_failure';
  return 'non_terminal';
}

function hasWorkerEvidenceSignals(
  workerPoll: Record<string, unknown> | null,
  workerArtifacts: Record<string, unknown>[]
): boolean {
  const pollEvents = Array.isArray(workerPoll?.events) ? workerPoll.events : [];
  const hasEvents = pollEvents.length > 0;
  const pollOutput = workerPoll?.output;
  const hasOutput = isRecord(pollOutput)
    ? Object.keys(pollOutput).length > 0
    : Boolean(pollOutput);
  const hasArtifacts = workerArtifacts.length > 0;
  return hasEvents || hasOutput || hasArtifacts;
}

function readErrorText(result: ToolResult | null | undefined, fallback: string): string {
  if (!result) return fallback;
  if (typeof result.error === 'string' && result.error.trim().length > 0) return result.error;
  if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.map((item) => String(item)).join('; ');
  return fallback;
}

function appendDescription(existing: string, extra: string): string {
  const base = existing.trim();
  const suffix = extra.trim();
  if (!suffix) return base;
  if (!base) return suffix;
  return `${base}\n${suffix}`;
}

export type ExecutorStage =
  | 'pick_task'
  | 'assign_worker'
  | 'execute'
  | 'validate'
  | 'publish_artifact'
  | 'update_status';

export interface ExecutorStageEvent {
  team_id: string;
  task_id?: string;
  agent_id?: string;
  stage: ExecutorStage;
  status: 'started' | 'succeeded' | 'failed' | 'skipped';
  evidence_ref?: {
    artifact_id: string;
    version: number;
  } | null;
  detail?: string;
  created_at: string;
}

export interface ExecutorTaskResult {
  ok: boolean;
  team_id: string;
  task_id: string;
  agent_id: string;
  final_status: 'done' | 'blocked' | 'skipped';
  evidence_ref: {
    artifact_id: string;
    version: number;
  } | null;
  events: ExecutorStageEvent[];
  error?: string;
}

export interface ExecutorRunResult {
  ok: boolean;
  scheduler: SchedulerTickResult;
  teams_processed: number;
  tasks_completed: number;
  tasks_blocked: number;
  tasks_skipped: number;
  task_results: ExecutorTaskResult[];
  events: ExecutorStageEvent[];
}

export interface RuntimeExecutorOptions {
  server: ToolServerLike;
  scheduler: RuntimeScheduler;
  instructionPrefix?: string;
  executeAllInProgress?: boolean;
}

export class RuntimeExecutor {
  readonly server: ToolServerLike;
  readonly scheduler: RuntimeScheduler;
  readonly instructionPrefix: string;
  readonly executeAllInProgress: boolean;

  constructor(options: RuntimeExecutorOptions) {
    this.server = options.server;
    this.scheduler = options.scheduler;
    this.instructionPrefix = options.instructionPrefix ?? 'Autonomous execution loop';
    this.executeAllInProgress = options.executeAllInProgress ?? false;
  }

  runOnce(teamId?: string): ExecutorRunResult {
    const scheduler = this.scheduler.tick();
    const events: ExecutorStageEvent[] = [];

    const dispatchedByTeam = new Map<string, TaskRecord[]>();
    for (const dispatch of scheduler.dispatches) {
      if (teamId && dispatch.team_id !== teamId) continue;
      const task = this.server.store.getTask(dispatch.task_id);
      if (!task || task.status !== 'in_progress') continue;
      const list = dispatchedByTeam.get(dispatch.team_id) ?? [];
      list.push(task);
      dispatchedByTeam.set(dispatch.team_id, list);
    }

    if (this.executeAllInProgress) {
      const targetTeams = teamId
        ? [this.server.store.getTeam(teamId)].filter((item): item is NonNullable<typeof item> => Boolean(item))
        : this.server.store.listActiveTeams();
      for (const team of targetTeams) {
        const current = dispatchedByTeam.get(team.team_id) ?? [];
        const currentTaskIds = new Set(current.map((task) => task.task_id));
        const inProgress = this
          .server
          .store
          .listTasks(team.team_id, 'in_progress')
          .filter((task) => !currentTaskIds.has(task.task_id));
        if (inProgress.length > 0) {
          dispatchedByTeam.set(team.team_id, [...current, ...inProgress]);
        }
      }
    }

    const taskResults: ExecutorTaskResult[] = [];
    const teamIds = [...dispatchedByTeam.keys()].sort();
    for (const candidateTeamId of teamIds) {
      const queue = (dispatchedByTeam.get(candidateTeamId) ?? [])
        .slice()
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
          return a.task_id.localeCompare(b.task_id);
        });
      for (const task of queue) {
        const result = this.executeTask(candidateTeamId, task);
        taskResults.push(result);
        events.push(...result.events);
      }
    }

    return {
      ok: true,
      scheduler,
      teams_processed: teamIds.length,
      tasks_completed: taskResults.filter((result) => result.final_status === 'done').length,
      tasks_blocked: taskResults.filter((result) => result.final_status === 'blocked').length,
      tasks_skipped: taskResults.filter((result) => result.final_status === 'skipped').length,
      task_results: taskResults,
      events
    };
  }

  private executeTask(teamId: string, task: TaskRecord): ExecutorTaskResult {
    const events: ExecutorStageEvent[] = [];
    const taskRecord = this.server.store.getTask(task.task_id);
    if (!taskRecord || taskRecord.status !== 'in_progress' || !taskRecord.claimed_by) {
      const skipped = this.stageEvent({
        team_id: teamId,
        task_id: task.task_id,
        stage: 'pick_task',
        status: 'skipped',
        detail: 'task no longer in executable state'
      });
      events.push(skipped);
      return {
        ok: true,
        team_id: teamId,
        task_id: task.task_id,
        agent_id: readString(taskRecord?.claimed_by),
        final_status: 'skipped',
        evidence_ref: null,
        events
      };
    }

    const workerId = taskRecord.claimed_by;
    events.push(this.stageEvent({
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      stage: 'pick_task',
      status: 'succeeded',
      detail: `picked ${taskRecord.task_id}`
    }));

    const workerAgent = this.server.store.getAgent(workerId);
    if (!workerAgent || workerAgent.team_id !== teamId) {
      events.push(this.stageEvent({
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        stage: 'assign_worker',
        status: 'failed',
        detail: 'claimed worker missing from team'
      }));
      return this.blockTask({
        teamId,
        task: taskRecord,
        workerId,
        events,
        reason: 'executor failed: claimed worker missing from team',
        evidenceRef: null,
        qualityChecksPassed: false,
        complianceAck: false,
        artifactRefsCount: 0
      });
    }

    events.push(this.stageEvent({
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      stage: 'assign_worker',
      status: 'succeeded',
      detail: `worker ${workerId} assigned`
    }));

    const leadAgent = this
      .server
      .store
      .listAgentsByTeam(teamId)
      .find((agent) => agent.role === 'lead' && agent.status !== 'offline');

    if (!leadAgent) {
      events.push(this.stageEvent({
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        stage: 'execute',
        status: 'failed',
        detail: 'lead supervisor unavailable'
      }));
      return this.blockTask({
        teamId,
        task: taskRecord,
        workerId,
        events,
        reason: 'executor failed: lead supervisor unavailable',
        evidenceRef: null,
        qualityChecksPassed: false,
        complianceAck: false,
        artifactRefsCount: 0
      });
    }

    const instruction = `${this.instructionPrefix}: ${taskRecord.title}\n${taskRecord.description}`.trim();
    const executeResult = this.server.callTool('team_send', {
      team_id: teamId,
      from_agent_id: leadAgent.agent_id,
      to_agent_id: workerId,
      summary: instruction,
      artifact_refs: [],
      idempotency_key: `executor-${teamId}-${taskRecord.task_id}-${taskRecord.lock_version}`
    });

    if (!executeResult.ok) {
      const error = readErrorText(executeResult, 'failed to deliver worker instruction');
      events.push(this.stageEvent({
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        stage: 'execute',
        status: 'failed',
        detail: error
      }));
      return this.blockTask({
        teamId,
        task: taskRecord,
        workerId,
        events,
        reason: `executor failed: ${error}`,
        evidenceRef: null,
        qualityChecksPassed: false,
        complianceAck: false,
        artifactRefsCount: 0
      });
    }

    events.push(this.stageEvent({
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      stage: 'execute',
      status: 'succeeded',
      detail: 'instruction sent by lead supervisor'
    }));

    const inbox = this.server.callTool('team_pull_inbox', {
      team_id: teamId,
      agent_id: workerId,
      limit: 20,
      ack: true
    });

    const workerErrors = Array.isArray(inbox.worker_errors)
      ? inbox.worker_errors
      : [];
    const workerAdapterActive = inbox.worker_adapter_active === true;
    const workerPoll = isRecord(inbox.worker_poll)
      ? inbox.worker_poll
      : null;
    const workerArtifacts = Array.isArray(inbox.worker_artifacts)
      ? inbox.worker_artifacts.filter(isRecord)
      : [];

    let validationOutcome: 'passed' | 'blocked' | 'skipped' = 'passed';
    let validationDetail = 'worker output validated';
    let qualityChecksPassed = true;
    let complianceAck = true;

    if (workerErrors.length > 0) {
      validationOutcome = 'blocked';
      validationDetail = `worker reported ${workerErrors.length} error(s)`;
      qualityChecksPassed = false;
      complianceAck = false;
    } else if (!workerPoll) {
      if (!workerAdapterActive) {
        // Legacy non-adapter flow has no poll channel; preserve terminal progress semantics.
        validationOutcome = 'passed';
        validationDetail = 'worker poll unavailable; no adapter active (legacy inbox path)';
      } else {
        validationOutcome = 'blocked';
        validationDetail = 'worker poll unavailable from active adapter';
        qualityChecksPassed = false;
        complianceAck = false;
      }
    } else {
      const statusClass = classifyWorkerStatus(workerPoll.status);
      if (statusClass === 'non_terminal') {
        validationOutcome = 'skipped';
        validationDetail = `worker status non-terminal: ${String(workerPoll.status ?? 'unknown')}`;
        qualityChecksPassed = false;
        complianceAck = false;
      } else if (statusClass === 'terminal_failure') {
        validationOutcome = 'blocked';
        validationDetail = `worker terminal failure status: ${String(workerPoll.status ?? 'failed')}`;
        qualityChecksPassed = false;
        complianceAck = false;
      } else if (!hasWorkerEvidenceSignals(workerPoll, workerArtifacts)) {
        validationOutcome = 'blocked';
        validationDetail = 'worker terminal success missing evidence signals';
        qualityChecksPassed = false;
        complianceAck = false;
      }
    }

    events.push(this.stageEvent({
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      stage: 'validate',
      status: validationOutcome === 'passed'
        ? 'succeeded'
        : (validationOutcome === 'blocked' ? 'failed' : 'skipped'),
      detail: validationDetail
    }));

    if (validationOutcome === 'skipped') {
      return {
        ok: true,
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        final_status: 'skipped',
        evidence_ref: null,
        events
      };
    }

    if (validationOutcome === 'blocked') {
      return this.blockTask({
        teamId,
        task: taskRecord,
        workerId,
        events,
        reason: `executor validation failed: ${validationDetail}`,
        evidenceRef: null,
        qualityChecksPassed: false,
        complianceAck: false,
        artifactRefsCount: 0
      });
    }

    const artifactPayload = {
      task_id: taskRecord.task_id,
      agent_id: workerId,
      lead_agent_id: leadAgent.agent_id,
      validation: {
        quality_checks_passed: qualityChecksPassed,
        compliance_ack: complianceAck,
        worker_error_count: workerErrors.length
      },
      worker_artifacts: workerArtifacts,
      worker_errors: workerErrors,
      captured_at: nowIso()
    };

    const publishResult = this.server.callTool('team_artifact_publish', {
      team_id: teamId,
      artifact_id: `artifact_task_${taskRecord.task_id}`,
      name: `executor-evidence-${taskRecord.task_id}`,
      content: JSON.stringify(artifactPayload),
      published_by: leadAgent.agent_id,
      metadata: {
        source: 'runtime_executor',
        task_id: taskRecord.task_id,
        agent_id: workerId
      }
    });

    if (!publishResult.ok || !isRecord(publishResult.artifact)) {
      const error = readErrorText(publishResult, 'failed to publish artifact evidence');
      events.push(this.stageEvent({
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        stage: 'publish_artifact',
        status: 'failed',
        detail: error
      }));
      return this.blockTask({
        teamId,
        task: taskRecord,
        workerId,
        events,
        reason: `executor failed: ${error}`,
        evidenceRef: null,
        qualityChecksPassed,
        complianceAck,
        artifactRefsCount: 0
      });
    }

    const artifactId = readString(publishResult.artifact.artifact_id);
    const artifactVersion = Number(publishResult.artifact.version);
    const evidenceRef = {
      artifact_id: artifactId,
      version: Number.isFinite(artifactVersion) ? artifactVersion : 1
    };

    events.push(this.stageEvent({
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      stage: 'publish_artifact',
      status: 'succeeded',
      evidence_ref: evidenceRef,
      detail: `published ${artifactId}@${evidenceRef.version}`
    }));

    const finalStatus = 'done';
    const latestTask = this.server.store.getTask(taskRecord.task_id);
    if (!latestTask) {
      events.push(this.stageEvent({
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        stage: 'update_status',
        status: 'failed',
        evidence_ref: evidenceRef,
        detail: 'task disappeared before final status update'
      }));
      return {
        ok: false,
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        final_status: 'blocked',
        evidence_ref: evidenceRef,
        events,
        error: 'task disappeared before final status update'
      };
    }

    const statusResult = this.server.callTool('team_task_update', {
      team_id: teamId,
      task_id: taskRecord.task_id,
      status: finalStatus,
      description: appendDescription(
        latestTask.description,
        `executor evidence: ${artifactId}@${evidenceRef.version}`
      ),
      quality_checks_passed: qualityChecksPassed,
      artifact_refs_count: 1,
      compliance_ack: complianceAck,
      expected_lock_version: latestTask.lock_version
    });

    if (!statusResult.ok) {
      const error = readErrorText(statusResult, `failed to set task status ${finalStatus}`);
      events.push(this.stageEvent({
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        stage: 'update_status',
        status: 'failed',
        evidence_ref: evidenceRef,
        detail: error
      }));
      return {
        ok: false,
        team_id: teamId,
        task_id: taskRecord.task_id,
        agent_id: workerId,
        final_status: 'blocked',
        evidence_ref: evidenceRef,
        events,
        error
      };
    }

    events.push(this.stageEvent({
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      stage: 'update_status',
      status: 'succeeded',
      evidence_ref: evidenceRef,
      detail: `task transitioned to ${finalStatus}`
    }));

    return {
      ok: true,
      team_id: teamId,
      task_id: taskRecord.task_id,
      agent_id: workerId,
      final_status: finalStatus,
      evidence_ref: evidenceRef,
      events
    };
  }

  private blockTask(input: {
    teamId: string;
    task: TaskRecord;
    workerId: string;
    events: ExecutorStageEvent[];
    reason: string;
    evidenceRef: { artifact_id: string; version: number } | null;
    qualityChecksPassed: boolean;
    complianceAck: boolean;
    artifactRefsCount: number;
  }): ExecutorTaskResult {
    const latest = this.server.store.getTask(input.task.task_id);
    const lockVersion = latest?.lock_version ?? input.task.lock_version;
    const statusResult = this.server.callTool('team_task_update', {
      team_id: input.teamId,
      task_id: input.task.task_id,
      status: 'blocked',
      description: appendDescription(latest?.description ?? input.task.description, `[blocked] ${input.reason}`),
      quality_checks_passed: input.qualityChecksPassed,
      artifact_refs_count: input.artifactRefsCount,
      compliance_ack: input.complianceAck,
      expected_lock_version: lockVersion
    });

    input.events.push(this.stageEvent({
      team_id: input.teamId,
      task_id: input.task.task_id,
      agent_id: input.workerId,
      stage: 'update_status',
      status: statusResult.ok ? 'succeeded' : 'failed',
      evidence_ref: input.evidenceRef,
      detail: statusResult.ok
        ? 'task transitioned to blocked'
        : readErrorText(statusResult, 'failed to transition task to blocked')
    }));

    return {
      ok: statusResult.ok === true,
      team_id: input.teamId,
      task_id: input.task.task_id,
      agent_id: input.workerId,
      final_status: 'blocked',
      evidence_ref: input.evidenceRef,
      events: input.events,
      error: statusResult.ok ? undefined : readErrorText(statusResult, 'failed to transition task to blocked')
    };
  }

  private stageEvent(event: {
    team_id: string;
    task_id?: string;
    agent_id?: string;
    stage: ExecutorStage;
    status: 'started' | 'succeeded' | 'failed' | 'skipped';
    evidence_ref?: { artifact_id: string; version: number } | null;
    detail?: string;
  }): ExecutorStageEvent {
    const stageEvent: ExecutorStageEvent = {
      team_id: event.team_id,
      task_id: event.task_id,
      agent_id: event.agent_id,
      stage: event.stage,
      status: event.status,
      evidence_ref: event.evidence_ref ?? null,
      detail: event.detail,
      created_at: nowIso()
    };

    this.server.store.logEvent({
      team_id: stageEvent.team_id,
      task_id: stageEvent.task_id,
      agent_id: stageEvent.agent_id,
      artifact_id: stageEvent.evidence_ref?.artifact_id,
      event_type: `executor_stage:${stageEvent.stage}`,
      payload: {
        stage: stageEvent.stage,
        status: stageEvent.status,
        detail: stageEvent.detail,
        evidence_ref: stageEvent.evidence_ref
      },
      created_at: stageEvent.created_at
    });

    return stageEvent;
  }
}

export function createRuntimeExecutor(options: RuntimeExecutorOptions): RuntimeExecutor {
  return new RuntimeExecutor(options);
}
