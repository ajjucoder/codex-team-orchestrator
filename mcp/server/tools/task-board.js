import { newId } from '../ids.js';

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

export function registerTaskBoardTools(server) {
  server.registerTool('team_task_create', 'team_task_create.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    const task = server.store.createTask({
      task_id: newId('task'),
      team_id: input.team_id,
      title: input.title,
      description: input.description ?? '',
      status: 'todo',
      priority: input.priority,
      claimed_by: null,
      lock_version: 0,
      created_at: nowIso(),
      updated_at: nowIso()
    });

    return { ok: true, task };
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
      task: claimed.task
    };
  });

  server.registerTool('team_task_update', 'team_task_update.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    const updated = server.store.updateTask({
      team_id: input.team_id,
      task_id: input.task_id,
      expected_lock_version: input.expected_lock_version,
      patch: {
        status: input.status,
        description: input.description,
        priority: input.priority
      }
    });

    if (!updated.ok) {
      return updated;
    }

    return {
      ok: true,
      task: updated.task
    };
  });

  server.registerTool('team_task_list', 'team_task_list.schema.json', (input) => {
    const guard = ensureTeamAndAgent(server, input.team_id);
    if (!guard.ok) return guard;

    const tasks = server.store.listTasks(input.team_id, input.status ?? null);
    return { ok: true, tasks };
  });
}
