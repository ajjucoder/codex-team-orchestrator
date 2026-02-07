import { newId } from '../ids.js';

function nowIso() {
  return new Date().toISOString();
}

export function registerTeamLifecycleTools(server) {
  server.registerTool('team_start', 'team_start.schema.json', (input, context = {}) => {
    const ts = nowIso();
    const profileName = input.profile ?? 'default';
    const policy = server.policyEngine?.loadProfile(profileName);
    const profileDefaultThreads = Number(policy?.limits?.default_max_threads ?? 4);
    const profileHardLimit = Number(policy?.limits?.hard_max_threads ?? 6);
    const maxThreads = Math.min(input.max_threads ?? profileDefaultThreads, profileHardLimit, 6);
    const team = server.store.createTeam({
      team_id: newId('team'),
      status: 'active',
      profile: profileName,
      objective: input.objective,
      max_threads: maxThreads,
      session_model: input.session_model ?? context.active_session_model ?? null,
      created_at: ts,
      updated_at: ts,
      metadata: {
        active_session_model: context.active_session_model ?? null,
        inherited_model: input.session_model ? false : Boolean(context.active_session_model)
      }
    });

    return {
      ok: true,
      team
    };
  });

  server.registerTool('team_status', 'team_status.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return {
        ok: false,
        error: `team not found: ${input.team_id}`
      };
    }

    const agentCount = server.store.db.prepare('SELECT COUNT(*) as n FROM agents WHERE team_id = ?').get(input.team_id).n;
    const messageCount = server.store.db.prepare('SELECT COUNT(*) as n FROM messages WHERE team_id = ?').get(input.team_id).n;
    const pendingInbox = server.store.db.prepare('SELECT COUNT(*) as n FROM inbox WHERE team_id = ? AND ack_at IS NULL').get(input.team_id).n;

    return {
      ok: true,
      team: {
        team_id: team.team_id,
        status: team.status,
        profile: team.profile,
        objective: team.objective,
        max_threads: team.max_threads,
        session_model: team.session_model,
        created_at: team.created_at,
        updated_at: team.updated_at
      },
      metrics: {
        agents: Number(agentCount),
        messages: Number(messageCount),
        pending_inbox: Number(pendingInbox)
      }
    };
  });

  server.registerTool('team_finalize', 'team_finalize.schema.json', (input, context = {}) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return {
        ok: false,
        error: `team not found: ${input.team_id}`
      };
    }

    const updated = server.store.updateTeamStatus(input.team_id, 'finalized');
    server.store.logEvent({
      team_id: input.team_id,
      agent_id: context.agent_id ?? null,
      event_type: 'team_finalized',
      payload: {
        reason: input.reason ?? 'not_provided'
      }
    });

    return {
      ok: true,
      team: {
        team_id: updated.team_id,
        status: updated.status,
        updated_at: updated.updated_at
      }
    };
  });

  server.registerTool('team_resume', 'team_resume.schema.json', (input, context = {}) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return {
        ok: false,
        error: `team not found: ${input.team_id}`
      };
    }

    const resumedTeam = team.status === 'active'
      ? team
      : server.store.updateTeamStatus(input.team_id, 'active');

    const openTasks = server.store.db
      .prepare("SELECT COUNT(*) as n FROM tasks WHERE team_id = ? AND status != 'done'")
      .get(input.team_id).n;
    const pendingInbox = server.store.db
      .prepare('SELECT COUNT(*) as n FROM inbox WHERE team_id = ? AND ack_at IS NULL')
      .get(input.team_id).n;

    server.store.logEvent({
      team_id: input.team_id,
      agent_id: context.agent_id ?? null,
      event_type: 'team_resumed',
      payload: {
        open_tasks: Number(openTasks),
        pending_inbox: Number(pendingInbox)
      }
    });

    return {
      ok: true,
      team: {
        team_id: resumedTeam.team_id,
        status: resumedTeam.status,
        updated_at: resumedTeam.updated_at
      },
      recovery_snapshot: {
        open_tasks: Number(openTasks),
        pending_inbox: Number(pendingInbox)
      }
    };
  });
}
