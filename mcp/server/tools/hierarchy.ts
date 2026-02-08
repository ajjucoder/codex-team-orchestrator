import type { ToolServerLike } from './types.js';
import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';

function nowIso(): string {
  return new Date().toISOString();
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : null;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readTaskMetrics(summary: Record<string, unknown>): Record<string, number> {
  const metrics = (summary.metrics && typeof summary.metrics === 'object')
    ? summary.metrics as Record<string, unknown>
    : {};
  const tasks = (metrics.tasks && typeof metrics.tasks === 'object')
    ? metrics.tasks as Record<string, unknown>
    : {};
  return {
    todo: toNumber(tasks.todo),
    in_progress: toNumber(tasks.in_progress),
    blocked: toNumber(tasks.blocked),
    done: toNumber(tasks.done),
    cancelled: toNumber(tasks.cancelled)
  };
}

export function registerHierarchyTools(server: ToolServerLike): void {
  server.registerTool('team_child_start', 'team_child_start.schema.json', (input, context = {}) => {
    const parentTeamId = readString(input, 'team_id');
    const parent = server.store.getTeam(parentTeamId);
    if (!parent) {
      return { ok: false, error: `team not found: ${parentTeamId}` };
    }
    if (!server.tools?.has('team_start')) {
      return { ok: false, error: 'team_start not registered' };
    }

    const startInput: Record<string, unknown> = {
      objective: readString(input, 'objective'),
      profile: readOptionalString(input, 'profile') ?? parent.profile,
      max_threads: Math.min(readOptionalNumber(input, 'max_threads') ?? parent.max_threads, 6),
      parent_team_id: parentTeamId
    };
    const sessionModel = readOptionalString(input, 'session_model') ?? parent.session_model;
    if (sessionModel) {
      startInput.session_model = sessionModel;
    }

    const started = server.callTool('team_start', startInput, context);
    if (!started.ok) {
      return {
        ok: false,
        error: String(started.error ?? 'failed to create child team')
      };
    }

    server.store.logEvent({
      team_id: parentTeamId,
      event_type: 'team_child_started',
      payload: {
        child_team_id: started.team?.team_id ?? null,
        objective: startInput.objective
      }
    });

    return {
      ok: true,
      parent_team_id: parentTeamId,
      child_team: started.team
    };
  });

  server.registerTool('team_child_list', 'team_child_list.schema.json', (input) => {
    const parentTeamId = readString(input, 'team_id');
    const parent = server.store.getTeam(parentTeamId);
    if (!parent) {
      return { ok: false, error: `team not found: ${parentTeamId}` };
    }

    const recursive = readBoolean(input, 'recursive', false);
    const includeMetrics = readBoolean(input, 'include_metrics', false);
    const children = server.store.listChildTeams(parentTeamId, recursive);

    return {
      ok: true,
      parent_team_id: parentTeamId,
      recursive,
      child_count: children.length,
      teams: children.map((child) => ({
        team_id: child.team_id,
        parent_team_id: child.parent_team_id,
        root_team_id: child.root_team_id,
        hierarchy_depth: child.hierarchy_depth,
        status: child.status,
        mode: child.mode,
        profile: child.profile,
        max_threads: child.max_threads,
        metrics: includeMetrics ? server.store.summarizeTeam(child.team_id)?.metrics ?? null : undefined
      }))
    };
  });

  server.registerTool('team_delegate_task', 'team_delegate_task.schema.json', (input) => {
    const parentTeamId = readString(input, 'team_id');
    const childTeamId = readString(input, 'child_team_id');
    const parent = server.store.getTeam(parentTeamId);
    if (!parent) {
      return { ok: false, error: `team not found: ${parentTeamId}` };
    }
    const child = server.store.getTeam(childTeamId);
    if (!child) {
      return { ok: false, error: `child team not found: ${childTeamId}` };
    }
    if (!server.store.isDescendantTeam(parentTeamId, childTeamId, false)) {
      return {
        ok: false,
        error: `child team ${childTeamId} is not delegated under parent ${parentTeamId}`
      };
    }

    const requiredRole = readOptionalString(input, 'required_role');
    if (requiredRole && !isKnownRole(requiredRole)) {
      return { ok: false, error: `unknown required_role: ${requiredRole}` };
    }

    const ts = nowIso();
    const task = server.store.createTask({
      task_id: newId('task'),
      team_id: childTeamId,
      title: readString(input, 'title'),
      description: readOptionalString(input, 'description') ?? '',
      required_role: requiredRole,
      status: 'todo',
      priority: Math.max(1, Math.min(9, Math.floor(readOptionalNumber(input, 'priority') ?? 3))),
      created_at: ts,
      updated_at: ts
    });
    if (!task) {
      return { ok: false, error: 'failed to create delegated task' };
    }

    server.store.logEvent({
      team_id: parentTeamId,
      task_id: task.task_id,
      event_type: 'team_delegate_task',
      payload: {
        child_team_id: childTeamId,
        task_id: task.task_id,
        title: task.title,
        required_role: task.required_role
      }
    });
    server.store.logEvent({
      team_id: childTeamId,
      task_id: task.task_id,
      event_type: 'delegated_task_received',
      payload: {
        parent_team_id: parentTeamId,
        task_id: task.task_id
      }
    });

    return {
      ok: true,
      parent_team_id: parentTeamId,
      child_team_id: childTeamId,
      task
    };
  });

  server.registerTool('team_hierarchy_rollup', 'team_hierarchy_rollup.schema.json', (input) => {
    const parentTeamId = readString(input, 'team_id');
    const parent = server.store.getTeam(parentTeamId);
    if (!parent) {
      return { ok: false, error: `team not found: ${parentTeamId}` };
    }

    const includeParent = readBoolean(input, 'include_parent', true);
    const descendants = server.store.listChildTeams(parentTeamId, true);
    const teams = includeParent
      ? [parent, ...descendants]
      : descendants;

    const totals = {
      teams: teams.length,
      agents: 0,
      messages: 0,
      artifacts: 0,
      tasks: {
        todo: 0,
        in_progress: 0,
        blocked: 0,
        done: 0,
        cancelled: 0
      }
    };

    const teamSummaries = teams.map((team) => {
      const summary = (server.store.summarizeTeam(team.team_id) ?? {}) as Record<string, unknown>;
      const metrics = (summary.metrics && typeof summary.metrics === 'object')
        ? summary.metrics as Record<string, unknown>
        : {};
      const taskMetrics = readTaskMetrics(summary);
      totals.agents += toNumber(metrics.agents);
      totals.messages += toNumber(metrics.messages);
      totals.artifacts += toNumber(metrics.artifacts);
      totals.tasks.todo += taskMetrics.todo;
      totals.tasks.in_progress += taskMetrics.in_progress;
      totals.tasks.blocked += taskMetrics.blocked;
      totals.tasks.done += taskMetrics.done;
      totals.tasks.cancelled += taskMetrics.cancelled;

      return {
        team_id: team.team_id,
        parent_team_id: team.parent_team_id,
        hierarchy_depth: team.hierarchy_depth,
        status: team.status,
        mode: team.mode,
        profile: team.profile,
        metrics
      };
    });

    return {
      ok: true,
      team_id: parentTeamId,
      include_parent: includeParent,
      descendant_count: descendants.length,
      totals,
      teams: teamSummaries
    };
  });
}
