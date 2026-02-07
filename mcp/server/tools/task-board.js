import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';

function nowIso() {
  return new Date().toISOString();
}

function ensureTeamAndAgent(server, teamId, agentId) {
  const team = server.store.getTeam(teamId);
  if (!team) return { ok: false, error: `team not found: ${teamId}` };
  if (agentId) {
    const agent = server.store.getAgent(agentId);
    if (!agent) return { ok: false, error: `agent not found: ${agentId}` };
    if (agent.team_id !== teamId) return { ok: false, error: `agent ${agentId} not in team ${teamId}` };
  }
  return { ok: true };
}

function normalizeDependencyIds(dependsOnTaskIds = []) {
  return [...new Set(dependsOnTaskIds)];
}

function buildDependencyMap(edges) {
  const map = new Map();
  for (const edge of edges) {
    if (!map.has(edge.task_id)) map.set(edge.task_id, new Set());
    map.get(edge.task_id).add(edge.depends_on_task_id);
  }
  return map;
}

function hasPath(depMap, start, target, visited = new Set()) {
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

function validateDependencies(server, teamId, taskId, dependencyIds) {
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

function hydrateTask(server, task) {
  if (!task) return task;
  return {
    ...task,
    depends_on_task_ids: server.store.getTaskDependencies(task.team_id, task.task_id),
    unresolved_dependency_count: server.store.countUnresolvedDependencies(task.team_id, task.task_id)
  };
}

export function registerTaskBoardTools(server) {
  server.registerTool('team_task_create', 'team_task_create.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;
    if (input.required_role !== undefined && !isKnownRole(input.required_role)) {
      return { ok: false, error: `unknown required_role: ${input.required_role}` };
    }

    const taskId = newId('task');
    const dependencyIds = normalizeDependencyIds(input.depends_on_task_ids ?? []);
    const validation = validateDependencies(server, input.team_id, taskId, dependencyIds);
    if (!validation.ok) return validation;

    const task = server.store.createTask({
      task_id: taskId,
      team_id: input.team_id,
      title: input.title,
      description: input.description ?? '',
      required_role: input.required_role ?? null,
      status: dependencyIds.length > 0 ? 'blocked' : 'todo',
      priority: input.priority,
      claimed_by: null,
      lock_version: 0,
      created_at: nowIso(),
      updated_at: nowIso()
    });
    if (dependencyIds.length > 0) {
      server.store.setTaskDependencies({
        team_id: input.team_id,
        task_id: task.task_id,
        depends_on_task_ids: dependencyIds
      });
      server.store.refreshTaskReadiness(input.team_id, task.task_id);
    }

    return { ok: true, task: hydrateTask(server, server.store.getTask(task.task_id)) };
  });

  server.registerTool('team_task_claim', 'team_task_claim.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id, input.agent_id);
    if (!guard.ok) return guard;

    const claimed = server.store.claimTask({
      team_id: input.team_id,
      task_id: input.task_id,
      agent_id: input.agent_id,
      expected_lock_version: input.expected_lock_version
    });

    if (!claimed.ok) {
      return claimed;
    }

    return {
      ok: true,
      task: hydrateTask(server, claimed.task)
    };
  });

  server.registerTool('team_task_update', 'team_task_update.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    const existing = server.store.getTask(input.task_id);
    if (!existing || existing.team_id !== input.team_id) {
      return { ok: false, error: `task not found: ${input.task_id}` };
    }
    if (input.required_role !== undefined && !isKnownRole(input.required_role)) {
      return { ok: false, error: `unknown required_role: ${input.required_role}` };
    }

    const dependencyIds = input.depends_on_task_ids !== undefined
      ? normalizeDependencyIds(input.depends_on_task_ids)
      : null;
    if (dependencyIds !== null) {
      const dependencyValidation = validateDependencies(
        server,
        input.team_id,
        input.task_id,
        dependencyIds
      );
      if (!dependencyValidation.ok) return dependencyValidation;
    }

    const updated = server.store.updateTask({
      team_id: input.team_id,
      task_id: input.task_id,
      expected_lock_version: input.expected_lock_version,
      patch: {
        status: input.status,
        description: input.description,
        required_role: input.required_role,
        priority: input.priority
      }
    });

    if (!updated.ok) {
      return updated;
    }

    if (dependencyIds !== null) {
      server.store.setTaskDependencies({
        team_id: input.team_id,
        task_id: input.task_id,
        depends_on_task_ids: dependencyIds
      });
      server.store.refreshTaskReadiness(input.team_id, input.task_id);
    }

    let promoted_tasks = [];
    if (existing.status !== 'done' && updated.task.status === 'done') {
      promoted_tasks = server
        .store
        .refreshDependentTasks(input.team_id, input.task_id)
        .map((task) => hydrateTask(server, task));
      if (promoted_tasks.length > 0) {
        server.store.logEvent({
          team_id: input.team_id,
          task_id: input.task_id,
          event_type: 'task_dependencies_released',
          payload: {
            promoted_task_ids: promoted_tasks.map((task) => task.task_id)
          }
        });
      }
    }

    return {
      ok: true,
      task: hydrateTask(server, server.store.getTask(input.task_id)),
      promoted_tasks
    };
  });

  server.registerTool('team_task_list', 'team_task_list.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    server.store.refreshAllTaskReadiness(input.team_id);
    const tasks = server
      .store
      .listTasks(input.team_id, input.status ?? null)
      .map((task) => hydrateTask(server, task));
    return { ok: true, tasks };
  });

  server.registerTool('team_task_next', 'team_task_next.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    server.store.refreshAllTaskReadiness(input.team_id);
    const readyTasks = server
      .store
      .listReadyTasks(input.team_id, input.limit ?? 20)
      .map((task) => hydrateTask(server, task));

    return {
      ok: true,
      team_id: input.team_id,
      ready_count: readyTasks.length,
      tasks: readyTasks
    };
  });

  server.registerTool('team_task_cancel_others', 'team_task_cancel_others.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    const winner = server.store.getTask(input.winner_task_id);
    if (!winner || winner.team_id !== input.team_id) {
      return { ok: false, error: `winner task not found in team: ${input.winner_task_id}` };
    }

    const uniqueLosers = [...new Set(input.loser_task_ids)];
    if (uniqueLosers.includes(input.winner_task_id)) {
      return { ok: false, error: 'winner_task_id cannot appear in loser_task_ids' };
    }
    for (const loserTaskId of uniqueLosers) {
      const loser = server.store.getTask(loserTaskId);
      if (!loser || loser.team_id !== input.team_id) {
        return { ok: false, error: `loser task not found in team: ${loserTaskId}` };
      }
    }

    const cancellation = server.store.cancelTasks({
      team_id: input.team_id,
      loser_task_ids: uniqueLosers,
      reason: input.reason ?? `cancelled after winner ${input.winner_task_id}`
    });

    server.store.logEvent({
      team_id: input.team_id,
      task_id: input.winner_task_id,
      event_type: 'speculative_loser_cancelled',
      payload: {
        winner_task_id: input.winner_task_id,
        loser_task_ids: uniqueLosers,
        cancelled: cancellation.cancelled
      }
    });

    return {
      ok: true,
      team_id: input.team_id,
      winner_task_id: input.winner_task_id,
      cancelled_count: cancellation.cancelled,
      cancelled_tasks: cancellation.tasks.map((task) => hydrateTask(server, task))
    };
  });
}
