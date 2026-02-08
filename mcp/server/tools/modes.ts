import type { TeamMode } from '../../store/entities.js';
import type { ToolContext, ToolServerLike } from './types.js';

interface ModeTransitionState {
  from_mode: TeamMode;
  to_mode: TeamMode;
  set_by_agent_id: string;
  reason: string;
  set_at: string;
  expires_at: string | null;
  ttl_ms: number | null;
}

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

function readMode(value: unknown): TeamMode | null {
  if (value === 'default' || value === 'delegate' || value === 'plan') return value;
  return null;
}

function allowedTransition(fromMode: TeamMode, toMode: TeamMode): boolean {
  if (fromMode === 'plan' && toMode === 'delegate') return false;
  return true;
}

function parseModeTransition(teamMetadata: Record<string, unknown>): ModeTransitionState | null {
  const modeTransition = teamMetadata.mode_transition;
  if (!modeTransition || typeof modeTransition !== 'object' || Array.isArray(modeTransition)) return null;
  const transition = modeTransition as Record<string, unknown>;
  const fromMode = readMode(transition.from_mode);
  const toMode = readMode(transition.to_mode);
  const setBy = typeof transition.set_by_agent_id === 'string' ? transition.set_by_agent_id : '';
  const reason = typeof transition.reason === 'string' ? transition.reason : '';
  const setAt = typeof transition.set_at === 'string' ? transition.set_at : '';
  if (!fromMode || !toMode || !setBy || !reason || !setAt) return null;
  return {
    from_mode: fromMode,
    to_mode: toMode,
    set_by_agent_id: setBy,
    reason,
    set_at: setAt,
    expires_at: typeof transition.expires_at === 'string' ? transition.expires_at : null,
    ttl_ms: Number.isFinite(Number(transition.ttl_ms)) ? Number(transition.ttl_ms) : null
  };
}

function resolveActorAgentId(input: Record<string, unknown>, context: ToolContext): string | null {
  const fromContext = typeof context.auth_agent_id === 'string' ? context.auth_agent_id : null;
  if (fromContext && fromContext.trim().length > 0) return fromContext;
  const fromInput = readOptionalString(input, 'requested_by_agent_id');
  if (fromInput) return fromInput;
  return null;
}

function applyTtlResetIfExpired(server: ToolServerLike, teamId: string): { mode: TeamMode; transition: ModeTransitionState | null; ttl_reset: boolean } {
  const team = server.store.getTeam(teamId);
  if (!team) {
    return {
      mode: 'default',
      transition: null,
      ttl_reset: false
    };
  }

  const transition = parseModeTransition(team.metadata);
  if (!transition?.expires_at || team.mode === 'default') {
    return {
      mode: team.mode,
      transition,
      ttl_reset: false
    };
  }

  const expiresAtMs = Date.parse(transition.expires_at);
  if (!Number.isFinite(expiresAtMs) || Date.now() < expiresAtMs) {
    return {
      mode: team.mode,
      transition,
      ttl_reset: false
    };
  }

  server.store.updateTeamMode(teamId, 'default');
  server.store.updateTeamMetadata(teamId, {
    mode_transition: {
      ...transition,
      to_mode: 'default',
      reason: 'ttl_expired_auto_reset',
      expired_at: nowIso(),
      expires_at: null,
      ttl_ms: null
    }
  });
  return {
    mode: 'default',
    transition: {
      ...transition,
      to_mode: 'default',
      reason: 'ttl_expired_auto_reset',
      expires_at: null,
      ttl_ms: null
    },
    ttl_reset: true
  };
}

export function registerModeTools(server: ToolServerLike): void {
  server.registerTool('team_mode_get', 'team_mode_get.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const state = applyTtlResetIfExpired(server, teamId);
    const refreshed = server.store.getTeam(teamId);
    return {
      ok: true,
      team_id: teamId,
      mode: state.mode,
      ttl_reset: state.ttl_reset,
      transition: state.transition,
      updated_at: refreshed?.updated_at ?? team.updated_at
    };
  });

  server.registerTool('team_mode_set', 'team_mode_set.schema.json', (input, context = {}) => {
    const teamId = readString(input, 'team_id');
    const targetMode = readMode(input.mode);
    if (!targetMode) {
      return { ok: false, error: `invalid mode: ${String(input.mode)}` };
    }

    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const actorAgentId = resolveActorAgentId(input, context);
    if (!actorAgentId) {
      return { ok: false, error: 'requested_by_agent_id or auth_agent_id is required' };
    }
    const actor = server.store.getAgent(actorAgentId);
    if (!actor || actor.team_id !== teamId) {
      return { ok: false, error: `actor not in team ${teamId}: ${actorAgentId}` };
    }
    if (actor.role !== 'lead') {
      return { ok: false, error: `mode transition requires lead role (actor role: ${actor.role})` };
    }

    const fromMode = team.mode;
    if (!allowedTransition(fromMode, targetMode)) {
      return {
        ok: false,
        error: `invalid mode transition ${fromMode} -> ${targetMode}`
      };
    }

    const ttlMs = readOptionalNumber(input, 'ttl_ms');
    const expiresAt = ttlMs && ttlMs > 0
      ? new Date(Date.now() + ttlMs).toISOString()
      : null;
    const reason = readOptionalString(input, 'reason') ?? 'not_provided';
    const transition: ModeTransitionState = {
      from_mode: fromMode,
      to_mode: targetMode,
      set_by_agent_id: actorAgentId,
      reason,
      set_at: nowIso(),
      expires_at: expiresAt,
      ttl_ms: ttlMs && ttlMs > 0 ? ttlMs : null
    };

    const modeUpdated = server.store.updateTeamMode(teamId, targetMode);
    if (!modeUpdated) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    const metadataUpdated = server.store.updateTeamMetadata(teamId, {
      mode_transition: transition
    });
    if (!metadataUpdated) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    server.store.logEvent({
      team_id: teamId,
      agent_id: actorAgentId,
      event_type: 'team_mode_transition',
      payload: {
        from_mode: fromMode,
        to_mode: targetMode,
        reason,
        ttl_ms: transition.ttl_ms,
        expires_at: transition.expires_at
      }
    });

    return {
      ok: true,
      team_id: teamId,
      mode: metadataUpdated.mode,
      transition
    };
  });
}
