import type { AgentRecord, TaskRecord, TeamRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import { createFairTaskQueue } from './queue.js';
import { RuntimeGitIsolationManager } from './git-manager.js';

const DEFAULT_TICK_INTERVAL_MS = 250;
const DEFAULT_READY_TASK_LIMIT = 200;
const UNBOUNDED_READY_TASK_LIMIT = 2147483647;
const IN_PROGRESS_STATUSES = new Set<TaskRecord['status']>([
  'in_progress',
  'queued',
  'dispatching',
  'executing',
  'validating',
  'integrating'
]);

function nowIso(): string {
  return new Date().toISOString();
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeCursor(cursor: number, size: number): number {
  if (size <= 0) return 0;
  const rounded = Number.isFinite(cursor) ? Math.floor(cursor) : 0;
  const normalized = rounded % size;
  return normalized < 0 ? normalized + size : normalized;
}

function rotateAgents(agents: AgentRecord[], cursor: number): AgentRecord[] {
  if (agents.length <= 1) return [...agents];
  const start = normalizeCursor(cursor, agents.length);
  return [
    ...agents.slice(start),
    ...agents.slice(0, start)
  ];
}

function summarizeTaskProgress(tasks: TaskRecord[]): {
  total_tasks: number;
  in_progress_tasks: number;
  blocked_tasks: number;
  done_tasks: number;
  cancelled_tasks: number;
  completion_pct: number;
} {
  let inProgressTasks = 0;
  let blockedTasks = 0;
  let doneTasks = 0;
  let cancelledTasks = 0;

  for (const task of tasks) {
    if (IN_PROGRESS_STATUSES.has(task.status)) {
      inProgressTasks += 1;
      continue;
    }
    if (task.status === 'blocked' || task.status === 'failed_terminal') {
      blockedTasks += 1;
      continue;
    }
    if (task.status === 'done') {
      doneTasks += 1;
      continue;
    }
    if (task.status === 'cancelled') {
      cancelledTasks += 1;
    }
  }

  const totalTasks = tasks.length;
  const completionPct = totalTasks > 0
    ? Math.round((doneTasks / totalTasks) * 100)
    : 0;

  return {
    total_tasks: totalTasks,
    in_progress_tasks: inProgressTasks,
    blocked_tasks: blockedTasks,
    done_tasks: doneTasks,
    cancelled_tasks: cancelledTasks,
    completion_pct: completionPct
  };
}

export interface SchedulerOptions {
  store: SqliteStore;
  tickIntervalMs?: number;
  readyTaskLimit?: number;
  gitManager?: RuntimeGitIsolationManager;
}

export interface SchedulerDispatch {
  team_id: string;
  task_id: string;
  agent_id: string;
  required_role: string | null;
  priority: number;
  git_branch: string;
  git_worktree_path: string;
}

export interface SchedulerTeamTick {
  team_id: string;
  recovered_tasks: number;
  cleaned_assignments: number;
  dispatched_count: number;
  dispatches: SchedulerDispatch[];
}

export interface SchedulerTickResult {
  scanned_teams: number;
  recovered_count: number;
  cleaned_count: number;
  dispatched_count: number;
  teams: SchedulerTeamTick[];
  dispatches: SchedulerDispatch[];
}

export class RuntimeScheduler {
  readonly store: SqliteStore;
  readonly tickIntervalMs: number;
  readonly readyTaskLimit: number;
  readonly gitManager: RuntimeGitIsolationManager;

  private timer: NodeJS.Timeout | null;
  private readonly queueCursorByTeam: Map<string, number>;
  private readonly agentCursorByTeam: Map<string, number>;
  private ticking: boolean;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.tickIntervalMs = toPositiveInt(options.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS);
    this.readyTaskLimit = toPositiveInt(options.readyTaskLimit, DEFAULT_READY_TASK_LIMIT);
    this.gitManager = options.gitManager ?? new RuntimeGitIsolationManager({
      store: this.store
    });
    this.timer = null;
    this.queueCursorByTeam = new Map();
    this.agentCursorByTeam = new Map();
    this.ticking = false;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.runTickSafely();
    this.timer = setInterval(() => {
      this.runTickSafely();
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(): SchedulerTickResult {
    if (this.ticking) {
      return {
        scanned_teams: 0,
        recovered_count: 0,
        cleaned_count: 0,
        dispatched_count: 0,
        teams: [],
        dispatches: []
      };
    }

    this.ticking = true;
    try {
      const teams = this.store.listActiveTeams();
      const inactiveTeams = this
        .store
        .listTeams()
        .filter((team) => team.status !== 'active');
      const teamTicks = teams.map((team) => this.dispatchTeam(team));
      const dispatches = teamTicks.flatMap((teamTick) => teamTick.dispatches);
      const recoveredCount = teamTicks
        .reduce((acc, teamTick) => acc + teamTick.recovered_tasks, 0);
      const cleanedFromActive = teamTicks
        .reduce((acc, teamTick) => acc + teamTick.cleaned_assignments, 0);
      const cleanedFromInactive = inactiveTeams.reduce((acc, team) => {
        const cleanup = this.gitManager.cleanupInactiveTeam(team, this.store.listTasks(team.team_id));
        return acc + cleanup.released_count;
      }, 0);
      const cleanedCount = cleanedFromActive + cleanedFromInactive;

      if (dispatches.length > 0 || recoveredCount > 0 || cleanedCount > 0) {
        this.store.logEvent({
          event_type: 'scheduler_tick',
          payload: {
            scanned_teams: teams.length,
            recovered_tasks: recoveredCount,
            dispatched_count: dispatches.length,
            cleaned_assignments: cleanedCount
          },
          created_at: nowIso()
        });
      }

      return {
        scanned_teams: teams.length,
        recovered_count: recoveredCount,
        cleaned_count: cleanedCount,
        dispatched_count: dispatches.length,
        teams: teamTicks,
        dispatches
      };
    } finally {
      this.ticking = false;
    }
  }

  private runTickSafely(): void {
    try {
      this.tick();
    } catch (error) {
      this.store.logEvent({
        event_type: 'scheduler_tick_error',
        payload: {
          error: String((error as { message?: unknown })?.message ?? error)
        },
        created_at: nowIso()
      });
    }
  }

  private dispatchTeam(team: TeamRecord): SchedulerTeamTick {
    const recovered = this.store.recoverExpiredTaskLeases(team.team_id, nowIso());
    const dispatches: SchedulerDispatch[] = [];
    const agents = this.store.listAgentsByTeam(team.team_id);
    const cleanup = this.gitManager.cleanupForTeam(team, agents, this.store.listTasks(team.team_id));

    // Always build fairness input from the full ready set, not a top-priority SQL slice.
    const readyTasks = this.store.listReadyTasks(team.team_id, UNBOUNDED_READY_TASK_LIMIT);
    const idleAgents = agents.filter((agent) => agent.status === 'idle');

    if (readyTasks.length > 0 && idleAgents.length > 0) {
      const queueCursor = this.queueCursorByTeam.get(team.team_id) ?? 0;
      const queue = createFairTaskQueue(readyTasks, queueCursor);
      const agentCursor = this.agentCursorByTeam.get(team.team_id) ?? 0;
      const rotatedAgents = rotateAgents(idleAgents, agentCursor);

      for (const agent of rotatedAgents) {
        const reserved = this.reserveIdleAgent(team.team_id, agent.agent_id);
        if (!reserved) continue;

        const selected = queue.takeForRole(agent.role);
        if (!selected) {
          this.releaseReservedAgent(team.team_id, agent.agent_id);
          this.gitManager.releaseAgentAssignment(team.team_id, agent.agent_id, 'reserve_released_no_task');
          continue;
        }

        const allocation = this.gitManager.allocateForAgent({
          team_id: team.team_id,
          agent_id: agent.agent_id,
          role: agent.role
        });
        if (!allocation.ok || !allocation.assignment) {
          this.releaseReservedAgent(team.team_id, agent.agent_id);
          this.store.logEvent({
            team_id: team.team_id,
            agent_id: agent.agent_id,
            task_id: selected.task_id,
            event_type: 'scheduler_git_isolation_error',
            payload: {
              error: allocation.error ?? 'failed to allocate git isolation assignment'
            },
            created_at: nowIso()
          });
          continue;
        }

        const claimed = this.tryClaim(team.team_id, agent.agent_id, selected);
        if (!claimed) {
          this.releaseReservedAgent(team.team_id, agent.agent_id);
          this.gitManager.releaseAgentAssignment(team.team_id, agent.agent_id, 'claim_failed');
          continue;
        }

        dispatches.push({
          team_id: team.team_id,
          task_id: selected.task_id,
          agent_id: agent.agent_id,
          required_role: selected.required_role,
          priority: selected.priority,
          git_branch: allocation.assignment.branch,
          git_worktree_path: allocation.assignment.worktree_path
        });
      }

      this.queueCursorByTeam.set(team.team_id, queue.getCursor());
      this.agentCursorByTeam.set(
        team.team_id,
        (normalizeCursor(agentCursor, idleAgents.length) + 1) % idleAgents.length
      );
    }

    const previousWave = this.store.getTeamWaveState(team.team_id);
    const allTasks = this.store.listTasks(team.team_id);
    const taskSummary = summarizeTaskProgress(allTasks);
    const readyTasksCount = this.store.listReadyTasks(team.team_id, UNBOUNDED_READY_TASK_LIMIT).length;
    const shouldAdvanceWave = dispatches.length > 0 || recovered.recovered > 0 || cleanup.released_count > 0;
    const nextWaveId = (previousWave?.wave_id ?? 0) + (shouldAdvanceWave ? 1 : 0);
    const nextTickCount = (previousWave?.tick_count ?? 0) + 1;

    this.store.upsertTeamWaveState({
      team_id: team.team_id,
      wave_id: nextWaveId,
      tick_count: nextTickCount,
      dispatched_count: dispatches.length,
      recovered_tasks: recovered.recovered,
      cleaned_assignments: cleanup.released_count,
      dispatched_total: (previousWave?.dispatched_total ?? 0) + dispatches.length,
      recovered_total: (previousWave?.recovered_total ?? 0) + recovered.recovered,
      cleaned_total: (previousWave?.cleaned_total ?? 0) + cleanup.released_count,
      ready_tasks: readyTasksCount,
      in_progress_tasks: taskSummary.in_progress_tasks,
      blocked_tasks: taskSummary.blocked_tasks,
      done_tasks: taskSummary.done_tasks,
      cancelled_tasks: taskSummary.cancelled_tasks,
      total_tasks: taskSummary.total_tasks,
      completion_pct: taskSummary.completion_pct,
      metadata: {
        queue_cursor: this.queueCursorByTeam.get(team.team_id) ?? 0,
        agent_cursor: this.agentCursorByTeam.get(team.team_id) ?? 0,
        dispatch_task_ids: dispatches.map((dispatch) => dispatch.task_id)
      }
    });

    return {
      team_id: team.team_id,
      recovered_tasks: recovered.recovered,
      cleaned_assignments: cleanup.released_count,
      dispatched_count: dispatches.length,
      dispatches
    };
  }

  private tryClaim(teamId: string, agentId: string, task: TaskRecord): boolean {
    const claim = this.store.claimTask({
      team_id: teamId,
      task_id: task.task_id,
      agent_id: agentId,
      expected_lock_version: task.lock_version
    });
    return claim.ok === true;
  }

  private reserveIdleAgent(teamId: string, agentId: string): boolean {
    let updated = 0;
    this.store.runWithRetry(() => {
      const result = this.store.db
        .prepare(
          `UPDATE agents
           SET status = 'busy',
               updated_at = ?
           WHERE team_id = ?
             AND agent_id = ?
             AND status = 'idle'`
        )
        .run(nowIso(), teamId, agentId);
      updated = Number(result.changes ?? 0);
    });
    return updated === 1;
  }

  private releaseReservedAgent(teamId: string, agentId: string): void {
    this.store.runWithRetry(() => {
      this.store.db
        .prepare(
          `UPDATE agents
           SET status = 'idle',
               updated_at = ?
           WHERE team_id = ?
             AND agent_id = ?
             AND status = 'busy'`
        )
        .run(nowIso(), teamId, agentId);
    });
  }
}
