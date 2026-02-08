import type { ToolContext, ToolServerLike } from './types.js';
import { newId } from '../ids.js';
import { validatePermissionConfig } from '../permission-profiles.js';

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

function readOptionalTeamId(input: Record<string, unknown>, key: string): string | null {
  const value = readOptionalString(input, key);
  if (!value) return null;
  return value.startsWith('team_') ? value : null;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readContextModel(context: ToolContext): string | null {
  const value = context.active_session_model;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readCount(server: ToolServerLike, sql: string, teamId: string): number {
  const row = server.store.db.prepare(sql).get(teamId);
  if (!row) return 0;
  const value = Number(row.n ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function registerTeamLifecycleTools(server: ToolServerLike): void {
  server.registerTool('team_start', 'team_start.schema.json', (input, context = {}) => {
    const ts = nowIso();
    const profileName = readOptionalString(input, 'profile') ?? 'default';
    const parentTeamId = readOptionalTeamId(input, 'parent_team_id');
    if (input.parent_team_id !== undefined && !parentTeamId) {
      return { ok: false, error: 'invalid parent_team_id' };
    }
    if (parentTeamId) {
      const parentTeam = server.store.getTeam(parentTeamId);
      if (!parentTeam) {
        return { ok: false, error: `parent team not found: ${parentTeamId}` };
      }
    }
    const policy = server.policyEngine?.loadProfile(profileName) ?? {};
    const permissionValidation = validatePermissionConfig(policy);
    if (!permissionValidation.ok) {
      return {
        ok: false,
        error: `invalid permissions config for profile ${profileName}: ${permissionValidation.errors.join('; ')}`
      };
    }
    const limits = (
      policy.limits && typeof policy.limits === 'object'
        ? policy.limits as Record<string, unknown>
        : {}
    );
    const profileDefaultThreads = Number(limits.default_max_threads ?? 4);
    const profileHardLimit = Number(limits.hard_max_threads ?? 6);
    const requestedMaxThreads = readOptionalNumber(input, 'max_threads');
    const maxThreads = Math.min(
      requestedMaxThreads ?? profileDefaultThreads,
      profileHardLimit,
      6
    );
    const activeSessionModel = readContextModel(context);
    const explicitSessionModel = readOptionalString(input, 'session_model');
    const team = server.store.createTeam({
      team_id: newId('team'),
      parent_team_id: parentTeamId,
      status: 'active',
      mode: 'default',
      profile: profileName,
      objective: readOptionalString(input, 'objective'),
      max_threads: maxThreads,
      session_model: explicitSessionModel ?? activeSessionModel ?? null,
      created_at: ts,
      updated_at: ts,
      metadata: {
        active_session_model: activeSessionModel,
        inherited_model: explicitSessionModel ? false : Boolean(activeSessionModel)
      }
    });
    if (!team) {
      return { ok: false, error: 'failed to create team' };
    }

    return {
      ok: true,
      team
    };
  });

  server.registerTool('team_status', 'team_status.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return {
        ok: false,
        error: `team not found: ${teamId}`
      };
    }

    const agentCount = readCount(
      server,
      'SELECT COUNT(*) as n FROM agents WHERE team_id = ?',
      teamId
    );
    const messageCount = readCount(
      server,
      'SELECT COUNT(*) as n FROM messages WHERE team_id = ?',
      teamId
    );
    const pendingInbox = readCount(
      server,
      'SELECT COUNT(*) as n FROM inbox WHERE team_id = ? AND ack_at IS NULL',
      teamId
    );

    return {
      ok: true,
      team: {
        team_id: team.team_id,
        parent_team_id: team.parent_team_id,
        root_team_id: team.root_team_id,
        hierarchy_depth: team.hierarchy_depth,
        status: team.status,
        mode: team.mode,
        profile: team.profile,
        objective: team.objective,
        max_threads: team.max_threads,
        session_model: team.session_model,
        created_at: team.created_at,
        updated_at: team.updated_at
      },
      metrics: {
        agents: agentCount,
        messages: messageCount,
        pending_inbox: pendingInbox
      }
    };
  });

  server.registerTool('team_finalize', 'team_finalize.schema.json', (input, context = {}) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return {
        ok: false,
        error: `team not found: ${teamId}`
      };
    }

    const updated = server.store.updateTeamStatus(teamId, 'finalized');
    if (!updated) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    const contextAgentId = typeof context.agent_id === 'string' ? context.agent_id : null;
    server.store.logEvent({
      team_id: teamId,
      agent_id: contextAgentId,
      event_type: 'team_finalized',
      payload: {
        reason: readOptionalString(input, 'reason') ?? 'not_provided'
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
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return {
        ok: false,
        error: `team not found: ${teamId}`
      };
    }

    const resumedTeam = team.status === 'active'
      ? team
      : server.store.updateTeamStatus(teamId, 'active');
    if (!resumedTeam) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const openTasks = readCount(
      server,
      "SELECT COUNT(*) as n FROM tasks WHERE team_id = ? AND status != 'done'",
      teamId
    );
    const pendingInbox = readCount(
      server,
      'SELECT COUNT(*) as n FROM inbox WHERE team_id = ? AND ack_at IS NULL',
      teamId
    );
    const contextAgentId = typeof context.agent_id === 'string' ? context.agent_id : null;
    const checkpoint = readRecord(resumedTeam.metadata?.context_checkpoint);
    const reset = readRecord(resumedTeam.metadata?.context_reset);
    const checkpointSnapshot = checkpoint.artifact_id
      ? {
        artifact_id: String(checkpoint.artifact_id),
        version: Number(checkpoint.version ?? 0),
        checksum: String(checkpoint.checksum ?? ''),
        created_at: String(checkpoint.created_at ?? '')
      }
      : null;
    const resetSnapshot = reset.checkpoint_artifact_id
      ? {
        reset_at: String(reset.reset_at ?? ''),
        checkpoint_artifact_id: String(reset.checkpoint_artifact_id),
        checkpoint_version: Number(reset.checkpoint_version ?? 0),
        checkpoint_checksum: String(reset.checkpoint_checksum ?? '')
      }
      : null;

    server.store.logEvent({
      team_id: teamId,
      agent_id: contextAgentId,
      event_type: 'team_resumed',
      payload: {
        open_tasks: openTasks,
        pending_inbox: pendingInbox
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
        open_tasks: openTasks,
        pending_inbox: pendingInbox,
        checkpoint: checkpointSnapshot,
        context_reset: resetSnapshot
      }
    };
  });
}
