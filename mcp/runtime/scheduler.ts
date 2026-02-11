import type { AgentRecord, TaskRecord, TeamRecord } from '../store/entities.js';
import type { SqliteStore } from '../store/sqlite-store.js';
import { createFairTaskQueue } from './queue.js';

const DEFAULT_TICK_INTERVAL_MS = 250;
const DEFAULT_READY_TASK_LIMIT = 200;
const UNBOUNDED_READY_TASK_LIMIT = 2147483647;

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

export interface SchedulerOptions {
  store: SqliteStore;
  tickIntervalMs?: number;
  readyTaskLimit?: number;
}

export interface SchedulerDispatch {
  team_id: string;
  task_id: string;
  agent_id: string;
  required_role: string | null;
  priority: number;
}

export interface SchedulerTeamTick {
  team_id: string;
  recovered_tasks: number;
  dispatched_count: number;
  dispatches: SchedulerDispatch[];
}

export interface SchedulerTickResult {
  scanned_teams: number;
  recovered_count: number;
  dispatched_count: number;
  teams: SchedulerTeamTick[];
  dispatches: SchedulerDispatch[];
}

export class RuntimeScheduler {
  readonly store: SqliteStore;
  readonly tickIntervalMs: number;
  readonly readyTaskLimit: number;

  private timer: NodeJS.Timeout | null;
  private readonly queueCursorByTeam: Map<string, number>;
  private readonly agentCursorByTeam: Map<string, number>;
  private ticking: boolean;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.tickIntervalMs = toPositiveInt(options.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS);
    this.readyTaskLimit = toPositiveInt(options.readyTaskLimit, DEFAULT_READY_TASK_LIMIT);
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
        dispatched_count: 0,
        teams: [],
        dispatches: []
      };
    }

    this.ticking = true;
    try {
      const teams = this.store.listActiveTeams();
      const teamTicks = teams.map((team) => this.dispatchTeam(team));
      const dispatches = teamTicks.flatMap((teamTick) => teamTick.dispatches);
      const recoveredCount = teamTicks
        .reduce((acc, teamTick) => acc + teamTick.recovered_tasks, 0);

      if (dispatches.length > 0 || recoveredCount > 0) {
        this.store.logEvent({
          event_type: 'scheduler_tick',
          payload: {
            scanned_teams: teams.length,
            recovered_tasks: recoveredCount,
            dispatched_count: dispatches.length
          },
          created_at: nowIso()
        });
      }

      return {
        scanned_teams: teams.length,
        recovered_count: recoveredCount,
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

    // Always build fairness input from the full ready set, not a top-priority SQL slice.
    const readyTasks = this.store.listReadyTasks(team.team_id, UNBOUNDED_READY_TASK_LIMIT);
    const idleAgents = this.store
      .listAgentsByTeam(team.team_id)
      .filter((agent) => agent.status === 'idle');

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
          continue;
        }

        const claimed = this.tryClaim(team.team_id, agent.agent_id, selected);
        if (!claimed) {
          this.releaseReservedAgent(team.team_id, agent.agent_id);
          continue;
        }

        dispatches.push({
          team_id: team.team_id,
          task_id: selected.task_id,
          agent_id: agent.agent_id,
          required_role: selected.required_role,
          priority: selected.priority
        });
      }

      this.queueCursorByTeam.set(team.team_id, queue.getCursor());
      this.agentCursorByTeam.set(
        team.team_id,
        (normalizeCursor(agentCursor, idleAgents.length) + 1) % idleAgents.length
      );
    }

    return {
      team_id: team.team_id,
      recovered_tasks: recovered.recovered,
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
