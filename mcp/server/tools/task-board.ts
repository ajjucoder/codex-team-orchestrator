import type { ToolServerLike } from './types.js';
import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';
import type { TaskRecord, TaskStatus } from '../../store/entities.js';

function nowIso(): string {
  return new Date().toISOString();
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : undefined;
}

function readTaskStatus(input: Record<string, unknown>, key: string): TaskStatus | undefined {
  const value = readOptionalString(input, key);
  if (!value) return undefined;
  if (
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'cancelled'
  ) {
    return value;
  }
  return undefined;
}

function ensureTeamAndAgent(server: ToolServerLike, teamId: string, agentId?: string): { ok: true } | { ok: false; error: string } {
  const team = server.store.getTeam(teamId);
  if (!team) return { ok: false, error: `team not found: ${teamId}` };
  if (agentId) {
    const agent = server.store.getAgent(agentId);
    if (!agent) return { ok: false, error: `agent not found: ${agentId}` };
    if (agent.team_id !== teamId) return { ok: false, error: `agent ${agentId} not in team ${teamId}` };
  }
  return { ok: true };
}

function normalizeDependencyIds(dependsOnTaskIds: unknown = []): string[] {
  const ids = Array.isArray(dependsOnTaskIds) ? dependsOnTaskIds : [];
  return [...new Set(ids.map((id) => String(id)).filter(Boolean))];
}

function buildDependencyMap(edges: Array<Record<string, unknown>>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of edges) {
    const taskId = typeof edge.task_id === 'string' ? edge.task_id : '';
    const dependsOnTaskId = typeof edge.depends_on_task_id === 'string' ? edge.depends_on_task_id : '';
    if (!taskId || !dependsOnTaskId) continue;
    if (!map.has(taskId)) map.set(taskId, new Set());
    map.get(taskId)?.add(dependsOnTaskId);
  }
  return map;
}

function hasPath(depMap: Map<string, Set<string>>, start: string, target: string, visited = new Set<string>()): boolean {
  if (start === target) return true;
  if (visited.has(start)) return false;
  visited.add(start);

  const next = depMap.get(start);
  if (!next || next.size === 0) return false;
  for (const dep of next) {
    if (hasPath(depMap, dep, target, visited)) {
      return true;
    }
  }
  return false;
}

function validateDependencies(
  server: ToolServerLike,
  teamId: string,
  taskId: string,
  dependencyIds: string[]
): { ok: true } | { ok: false; error: string } {
  for (const dependencyId of dependencyIds) {
    if (dependencyId === taskId) {
      return { ok: false, error: `task ${taskId} cannot depend on itself` };
    }
    const depTask = server.store.getTask(dependencyId);
    if (!depTask || depTask.team_id !== teamId) {
      return { ok: false, error: `dependency task not found in team: ${dependencyId}` };
    }
  }

  const depMap = buildDependencyMap(server.store.listTaskDependencyEdges(teamId));
  depMap.set(taskId, new Set(dependencyIds));
  for (const dependencyId of dependencyIds) {
    if (hasPath(depMap, dependencyId, taskId)) {
      return {
        ok: false,
        error: `dependency cycle detected for task ${taskId} via ${dependencyId}`
      };
    }
  }
  return { ok: true };
}

type HydratedTask = TaskRecord & {
  depends_on_task_ids: string[];
  unresolved_dependency_count: number;
};

function hydrateTask(server: ToolServerLike, task: TaskRecord | null): HydratedTask | null {
  if (!task) return task;
  return {
    ...task,
    depends_on_task_ids: server.store.getTaskDependencies(task.team_id, task.task_id),
    unresolved_dependency_count: server.store.countUnresolvedDependencies(task.team_id, task.task_id)
  };
}

export function registerTaskBoardTools(server: ToolServerLike): void {
  server.registerTool('team_task_create', 'team_task_create.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const guard = ensureTeamAndAgent(server, teamId);
    if (!guard.ok) return { ok: false, error: guard.error };

    const requiredRole = readOptionalString(input, 'required_role');
    if (requiredRole !== undefined && !isKnownRole(requiredRole)) {
      return { ok: false, error: `unknown required_role: ${requiredRole}` };
    }

    const taskId = newId('task');
    const dependencyIds = normalizeDependencyIds(input.depends_on_task_ids);
    const validation = validateDependencies(server, teamId, taskId, dependencyIds);
    if (!validation.ok) return validation;

    const task = server.store.createTask({
      task_id: taskId,
      team_id: teamId,
      title: readString(input, 'title'),
      description: readOptionalString(input, 'description') ?? '',
      required_role: requiredRole ?? null,
      status: dependencyIds.length > 0 ? 'blocked' : 'todo',
      priority: readOptionalNumber(input, 'priority') ?? 3,
      claimed_by: null,
      lock_version: 0,
      created_at: nowIso(),
      updated_at: nowIso()
    });
    if (!task) {
      return { ok: false, error: 'failed to create task' };
    }
    if (dependencyIds.length > 0) {
      server.store.setTaskDependencies({
        team_id: teamId,
        task_id: task.task_id,
        depends_on_task_ids: dependencyIds
      });
      server.store.refreshTaskReadiness(teamId, task.task_id);
    }

    return { ok: true, task: hydrateTask(server, server.store.getTask(task.task_id)) };
  });

  server.registerTool('team_task_claim', 'team_task_claim.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const agentId = readString(input, 'agent_id');
    const guard = ensureTeamAndAgent(server, teamId, agentId);
    if (!guard.ok) return { ok: false, error: guard.error };

    const claimed = server.store.claimTask({
      team_id: teamId,
      task_id: readString(input, 'task_id'),
      agent_id: agentId,
      expected_lock_version: readOptionalNumber(input, 'expected_lock_version') ?? 0
    });

    if (!claimed.ok) {
      return { ok: false, error: claimed.error ?? 'task claim failed' };
    }

    return {
      ok: true,
      task: hydrateTask(server, claimed.task ?? null)
    };
  });

  server.registerTool('team_task_update', 'team_task_update.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const taskId = readString(input, 'task_id');
    const guard = ensureTeamAndAgent(server, teamId);
    if (!guard.ok) return { ok: false, error: guard.error };

    const existing = server.store.getTask(taskId);
    if (!existing || existing.team_id !== teamId) {
      return { ok: false, error: `task not found: ${taskId}` };
    }

    const requiredRole = readOptionalString(input, 'required_role');
    if (requiredRole !== undefined && !isKnownRole(requiredRole)) {
      return { ok: false, error: `unknown required_role: ${requiredRole}` };
    }

    const dependencyIds = input.depends_on_task_ids !== undefined
      ? normalizeDependencyIds(input.depends_on_task_ids)
      : null;
    if (dependencyIds !== null) {
      const dependencyValidation = validateDependencies(server, teamId, taskId, dependencyIds);
      if (!dependencyValidation.ok) return dependencyValidation;
    }

    const updated = server.store.updateTask({
      team_id: teamId,
      task_id: taskId,
      expected_lock_version: readOptionalNumber(input, 'expected_lock_version') ?? 0,
      patch: {
        status: readTaskStatus(input, 'status'),
        description: readOptionalString(input, 'description'),
        required_role: requiredRole,
        priority: readOptionalNumber(input, 'priority')
      }
    });

    if (!updated.ok) {
      return { ok: false, error: updated.error ?? 'task update failed' };
    }

    if (dependencyIds !== null) {
      server.store.setTaskDependencies({
        team_id: teamId,
        task_id: taskId,
        depends_on_task_ids: dependencyIds
      });
      server.store.refreshTaskReadiness(teamId, taskId);
    }

    let promotedTasks: Array<HydratedTask | null> = [];
    if (existing.status !== 'done' && updated.task?.status === 'done') {
      promotedTasks = server
        .store
        .refreshDependentTasks(teamId, taskId)
        .map((task) => hydrateTask(server, task));
      if (promotedTasks.length > 0) {
        server.store.logEvent({
          team_id: teamId,
          task_id: taskId,
          event_type: 'task_dependencies_released',
          payload: {
            promoted_task_ids: promotedTasks.map((task) => task?.task_id)
          }
        });
      }
    }

    return {
      ok: true,
      task: hydrateTask(server, server.store.getTask(taskId)),
      promoted_tasks: promotedTasks
    };
  });

  server.registerTool('team_task_list', 'team_task_list.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const guard = ensureTeamAndAgent(server, teamId);
    if (!guard.ok) return { ok: false, error: guard.error };

    server.store.refreshAllTaskReadiness(teamId);
    const tasks = server
      .store
      .listTasks(teamId, readTaskStatus(input, 'status') ?? null)
      .map((task) => hydrateTask(server, task));
    return { ok: true, tasks };
  });

  server.registerTool('team_task_next', 'team_task_next.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const guard = ensureTeamAndAgent(server, teamId);
    if (!guard.ok) return { ok: false, error: guard.error };

    server.store.refreshAllTaskReadiness(teamId);
    const readyTasks = server
      .store
      .listReadyTasks(teamId, readOptionalNumber(input, 'limit') ?? 20)
      .map((task) => hydrateTask(server, task));

    return {
      ok: true,
      team_id: teamId,
      ready_count: readyTasks.length,
      tasks: readyTasks
    };
  });

  server.registerTool('team_task_cancel_others', 'team_task_cancel_others.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const winnerTaskId = readString(input, 'winner_task_id');
    const guard = ensureTeamAndAgent(server, teamId);
    if (!guard.ok) return { ok: false, error: guard.error };

    const winner = server.store.getTask(winnerTaskId);
    if (!winner || winner.team_id !== teamId) {
      return { ok: false, error: `winner task not found in team: ${winnerTaskId}` };
    }

    const uniqueLosers = normalizeDependencyIds(input.loser_task_ids);
    if (uniqueLosers.includes(winnerTaskId)) {
      return { ok: false, error: 'winner_task_id cannot appear in loser_task_ids' };
    }
    for (const loserTaskId of uniqueLosers) {
      const loser = server.store.getTask(loserTaskId);
      if (!loser || loser.team_id !== teamId) {
        return { ok: false, error: `loser task not found in team: ${loserTaskId}` };
      }
    }

    const cancellation = server.store.cancelTasks({
      team_id: teamId,
      loser_task_ids: uniqueLosers,
      reason: readOptionalString(input, 'reason') ?? `cancelled after winner ${winnerTaskId}`
    });

    server.store.logEvent({
      team_id: teamId,
      task_id: winnerTaskId,
      event_type: 'speculative_loser_cancelled',
      payload: {
        winner_task_id: winnerTaskId,
        loser_task_ids: uniqueLosers,
        cancelled: cancellation.cancelled
      }
    });

    return {
      ok: true,
      team_id: teamId,
      winner_task_id: winnerTaskId,
      cancelled_count: cancellation.cancelled,
      cancelled_tasks: cancellation.tasks.map((task) => hydrateTask(server, task))
    };
  });
}
