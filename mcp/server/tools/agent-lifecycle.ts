import type { ToolResult, ToolServerLike } from './types.js';
import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';
import type { AgentRecord, ArtifactRef, MessageRecord, TeamRecord } from '../../store/entities.js';

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_SUMMARY_LENGTH = 5000;
const MAX_ARTIFACT_REFS = 50;
const DUPLICATE_SUPPRESS_WINDOW_MS = 120000;

interface TeamLookup {
  team?: TeamRecord;
  error?: string;
}

interface AgentLookup {
  agent?: AgentRecord;
  error?: string;
}

interface AgentMembershipResult extends ToolResult {
  ok: boolean;
  error?: string;
}

interface PayloadValidationResult extends ToolResult {
  ok: boolean;
  error?: string;
}

interface SpawnModelResolution {
  model: string | null;
  model_source: string;
  model_routing_applied: boolean;
  inherited_model: boolean;
}

interface DuplicateResponse extends ToolResult {
  ok: true;
  inserted: false;
  duplicate_suppressed: true;
  message: {
    message_id: string;
    team_id: string;
    from_agent_id: string;
    to_agent_id: string | null;
    delivery_mode: 'direct' | 'broadcast';
    idempotency_key: string;
    payload: Record<string, unknown>;
  };
  recipient_count?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function readArtifactRefs(input: Record<string, unknown>): ArtifactRef[] {
  if (!Array.isArray(input.artifact_refs)) return [];
  return normalizeArtifactRefs(input.artifact_refs);
}

function getTeamOrError(server: ToolServerLike, teamId: string): TeamLookup {
  const team = server.store.getTeam(teamId);
  if (!team) {
    return { error: `team not found: ${teamId}` };
  }
  return { team };
}

function getAgentOrError(server: ToolServerLike, agentId: string): AgentLookup {
  const agent = server.store.getAgent(agentId);
  if (!agent) {
    return { error: `agent not found: ${agentId}` };
  }
  return { agent };
}

function ensureAgentInTeam(agent: AgentRecord, teamId: string, label: string): AgentMembershipResult {
  if (agent.team_id !== teamId) {
    return { ok: false, error: `${label} not in team ${teamId}: ${agent.agent_id}` };
  }
  return { ok: true };
}

function validateMessagePayload(summary: string, artifactRefs: ArtifactRef[]): PayloadValidationResult {
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `summary too long: max ${MAX_SUMMARY_LENGTH}` };
  }
  if (artifactRefs.length > MAX_ARTIFACT_REFS) {
    return { ok: false, error: `too many artifact refs: max ${MAX_ARTIFACT_REFS}` };
  }
  return { ok: true };
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSpawnModel({
  inputModel,
  team,
  role,
  policy
}: {
  inputModel: unknown;
  team: TeamRecord;
  role: string;
  policy: Record<string, unknown>;
}): SpawnModelResolution {
  const explicit = pickString(inputModel);
  if (explicit) {
    return {
      model: explicit,
      model_source: 'explicit_input',
      model_routing_applied: false,
      inherited_model: false
    };
  }

  const modelRouting = (
    policy.model_routing && typeof policy.model_routing === 'object'
      ? policy.model_routing as Record<string, unknown>
      : {}
  );
  if (modelRouting.enabled === true) {
    const roleModels = (
      modelRouting.role_models && typeof modelRouting.role_models === 'object'
        ? modelRouting.role_models as Record<string, unknown>
        : {}
    );
    const roleModel = pickString(roleModels[role]);
    const defaultModel = pickString(modelRouting.default_model);
    const routedModel = roleModel ?? defaultModel;
    if (routedModel) {
      return {
        model: routedModel,
        model_source: roleModel ? 'policy_role_route' : 'policy_default_route',
        model_routing_applied: true,
        inherited_model: false
      };
    }
  }

  return {
    model: team.session_model ?? null,
    model_source: 'session_inherited',
    model_routing_applied: false,
    inherited_model: true
  };
}

function resolvePermissionProfile({
  policy,
  role
}: {
  policy: Record<string, unknown>;
  role: string;
}): string | null {
  const permissions = (
    policy.permissions && typeof policy.permissions === 'object'
      ? policy.permissions as Record<string, unknown>
      : {}
  );
  const roleScoped = pickString(permissions[role]);
  if (roleScoped) return roleScoped;
  return pickString(permissions.default);
}

function normalizeArtifactRefs(artifactRefs: unknown[] = []): ArtifactRef[] {
  return artifactRefs
    .filter(isRecord)
    .map((ref) => ({
      artifact_id: String(ref.artifact_id ?? ''),
      version: Number(ref.version)
    }))
    .filter((ref) => ref.artifact_id.length > 0 && Number.isFinite(ref.version))
    .sort((a, b) => {
      const aid = a.artifact_id.localeCompare(b.artifact_id);
      if (aid !== 0) return aid;
      return a.version - b.version;
    });
}

function artifactRefKey(ref: ArtifactRef): string {
  return `${ref.artifact_id}@${ref.version}`;
}

function diffArtifactRefs(currentRefs: ArtifactRef[] = [], previousRefs: ArtifactRef[] = []): ArtifactRef[] {
  const previousKeys = new Set(previousRefs.map(artifactRefKey));
  return currentRefs.filter((ref) => !previousKeys.has(artifactRefKey(ref)));
}

function duplicateResponse(existingMessage: MessageRecord, mode: 'direct' | 'broadcast'): DuplicateResponse {
  const base: DuplicateResponse = {
    ok: true,
    inserted: false,
    duplicate_suppressed: true,
    message: {
      message_id: existingMessage.message_id,
      team_id: existingMessage.team_id,
      from_agent_id: existingMessage.from_agent_id,
      to_agent_id: existingMessage.to_agent_id,
      delivery_mode: existingMessage.delivery_mode,
      idempotency_key: existingMessage.idempotency_key,
      payload: existingMessage.payload as unknown as Record<string, unknown>
    }
  };
  if (mode === 'broadcast') {
    base.recipient_count = null;
  }
  return base;
}

function recipientCountExcludingSender(server: ToolServerLike, teamId: string, senderAgentId: string): number {
  return server
    .store
    .listAgentsByTeam(teamId)
    .filter((agent) => agent.agent_id !== senderAgentId)
    .length;
}

export function registerAgentLifecycleTools(server: ToolServerLike): void {
  server.registerTool('team_spawn', 'team_spawn.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const role = readString(input, 'role');
    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error || !teamLookup.team) {
      return { ok: false, error: teamLookup.error };
    }
    if (!isKnownRole(role)) {
      return { ok: false, error: `unknown role: ${role}` };
    }

    const team = teamLookup.team;
    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const agentCount = server.store.listAgentsByTeam(teamId).length;
    if (agentCount >= team.max_threads) {
      return {
        ok: false,
        error: `max_threads exceeded for team ${team.team_id}`
      };
    }

    const ts = nowIso();
    const modelAssignment = resolveSpawnModel({
      inputModel: input.model,
      team,
      role,
      policy
    });
    const permissionProfile = resolvePermissionProfile({ policy, role });
    const agent = server.store.createAgent({
      agent_id: newId('agent'),
      team_id: teamId,
      role,
      status: 'idle',
      model: modelAssignment.model,
      created_at: ts,
      updated_at: ts,
      metadata: {
        inherited_model: modelAssignment.inherited_model,
        model_source: modelAssignment.model_source,
        model_routing_applied: modelAssignment.model_routing_applied,
        permission_profile: permissionProfile
      }
    });
    if (!agent) {
      return { ok: false, error: 'failed to create agent' };
    }

    return {
      ok: true,
      agent
    };
  });

  server.registerTool('team_spawn_ready_roles', 'team_spawn_ready_roles.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error || !teamLookup.team) {
      return { ok: false, error: teamLookup.error };
    }
    if (!server.tools?.has('team_task_next')) {
      return { ok: false, error: 'team_task_next not registered' };
    }

    const team = teamLookup.team;
    const existingAgents = server.store.listAgentsByTeam(teamId);
    const capacity = Math.max(0, Number(team.max_threads ?? 0) - existingAgents.length);
    if (capacity === 0) {
      return {
        ok: true,
        team_id: teamId,
        budget: 0,
        ready_task_count: 0,
        role_candidates: [],
        spawned_count: 0,
        spawned_agents: [],
        errors: []
      };
    }

    const budget = Math.min(readOptionalNumber(input, 'max_new_agents') ?? capacity, capacity, 6);
    const readyTaskLimit = readOptionalNumber(input, 'ready_task_limit') ?? Math.min(100, Math.max(20, budget * 4));
    const ready = server.callTool('team_task_next', {
      team_id: teamId,
      limit: readyTaskLimit
    });
    if (!ready.ok) {
      return { ok: false, error: String(ready.error ?? 'team_task_next failed') };
    }

    const existingRoles = new Set(existingAgents.map((agent) => agent.role));
    const roleCandidates: string[] = [];
    const readyTasks = Array.isArray(ready.tasks)
      ? ready.tasks.filter(isRecord)
      : [];
    for (const task of readyTasks) {
      const role = String(task.required_role ?? '');
      if (!role || !isKnownRole(role)) continue;
      if (existingRoles.has(role) || roleCandidates.includes(role)) continue;
      roleCandidates.push(role);
      if (roleCandidates.length >= budget) break;
    }

    const spawnedAgents: AgentRecord[] = [];
    const errors: string[] = [];
    for (const role of roleCandidates) {
      const spawned = server.callTool('team_spawn', { team_id: teamId, role });
      if (spawned.ok && isRecord(spawned.agent)) {
        spawnedAgents.push(spawned.agent as unknown as AgentRecord);
      } else {
        errors.push(String(spawned.error ?? `failed to spawn role: ${role}`));
      }
    }

    return {
      ok: true,
      team_id: teamId,
      budget,
      ready_task_count: Number(ready.ready_count ?? readyTasks.length),
      role_candidates: roleCandidates,
      spawned_count: spawnedAgents.length,
      spawned_agents: spawnedAgents.map((agent) => ({
        agent_id: agent.agent_id,
        role: agent.role,
        model: agent.model
      })),
      errors
    };
  });

  server.registerTool('team_send', 'team_send.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const fromAgentId = readString(input, 'from_agent_id');
    const toAgentId = readString(input, 'to_agent_id');
    const idempotencyKey = readString(input, 'idempotency_key');
    const summary = String(input.summary ?? '');
    const artifactRefs = readArtifactRefs(input);

    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    const fromLookup = getAgentOrError(server, fromAgentId);
    if (fromLookup.error || !fromLookup.agent) {
      return { ok: false, error: fromLookup.error };
    }
    const toLookup = getAgentOrError(server, toAgentId);
    if (toLookup.error || !toLookup.agent) {
      return { ok: false, error: toLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, teamId, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }
    const toMembership = ensureAgentInTeam(toLookup.agent, teamId, 'to_agent');
    if (!toMembership.ok) {
      return toMembership;
    }

    const payloadValidation = validateMessagePayload(summary, artifactRefs);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    let effectiveArtifactRefs = artifactRefs;
    let deltaApplied = false;

    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_mode: 'direct'
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        effectiveArtifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: teamId,
          agent_id: fromAgentId,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'direct' }
        });
        return duplicateResponse(previousRouteMessage, 'direct');
      }
      if (deltaRefs.length < effectiveArtifactRefs.length) {
        effectiveArtifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_mode: 'direct',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'direct' }
      });
      return duplicateResponse(duplicate, 'direct');
    }

    const createdAt = nowIso();
    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      delivery_mode: 'direct',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      idempotency_key: idempotencyKey,
      created_at: createdAt,
      recipient_agent_ids: [toAgentId]
    });
    if (deltaApplied) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'direct',
          artifact_refs_reduced_to: effectiveArtifactRefs.length
        }
      });
    }

    return {
      ok: true,
      inserted: result.inserted,
      duplicate_suppressed: false,
      delta_applied: deltaApplied,
      message: {
        message_id: result.message.message_id,
        team_id: result.message.team_id,
        from_agent_id: result.message.from_agent_id,
        to_agent_id: result.message.to_agent_id,
        delivery_mode: result.message.delivery_mode,
        idempotency_key: result.message.idempotency_key,
        payload: result.message.payload
      }
    };
  });

  server.registerTool('team_broadcast', 'team_broadcast.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const fromAgentId = readString(input, 'from_agent_id');
    const idempotencyKey = readString(input, 'idempotency_key');
    const summary = String(input.summary ?? '');
    const artifactRefs = readArtifactRefs(input);

    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }

    const fromLookup = getAgentOrError(server, fromAgentId);
    if (fromLookup.error || !fromLookup.agent) {
      return { ok: false, error: fromLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, teamId, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }

    const payloadValidation = validateMessagePayload(summary, artifactRefs);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    let effectiveArtifactRefs = artifactRefs;
    let deltaApplied = false;

    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      delivery_mode: 'broadcast'
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        effectiveArtifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: teamId,
          agent_id: fromAgentId,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'broadcast' }
        });
        const response = duplicateResponse(previousRouteMessage, 'broadcast');
        response.recipient_count = recipientCountExcludingSender(server, teamId, fromAgentId);
        return response;
      }
      if (deltaRefs.length < effectiveArtifactRefs.length) {
        effectiveArtifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: teamId,
      from_agent_id: fromAgentId,
      delivery_mode: 'broadcast',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'broadcast' }
      });
      const response = duplicateResponse(duplicate, 'broadcast');
      response.recipient_count = recipientCountExcludingSender(server, teamId, fromAgentId);
      return response;
    }

    const recipients = server
      .store
      .listAgentsByTeam(teamId)
      .filter((agent) => agent.agent_id !== fromAgentId)
      .map((agent) => agent.agent_id);

    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: teamId,
      from_agent_id: fromAgentId,
      to_agent_id: null,
      delivery_mode: 'broadcast',
      payload: {
        summary,
        artifact_refs: effectiveArtifactRefs
      },
      idempotency_key: idempotencyKey,
      created_at: nowIso(),
      recipient_agent_ids: recipients
    });
    if (deltaApplied) {
      server.store.logEvent({
        team_id: teamId,
        agent_id: fromAgentId,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'broadcast',
          artifact_refs_reduced_to: effectiveArtifactRefs.length
        }
      });
    }

    return {
      ok: true,
      inserted: result.inserted,
      duplicate_suppressed: false,
      delta_applied: deltaApplied,
      recipient_count: recipients.length,
      message: {
        message_id: result.message.message_id,
        delivery_mode: result.message.delivery_mode,
        payload: result.message.payload,
        idempotency_key: result.message.idempotency_key
      }
    };
  });

  server.registerTool('team_pull_inbox', 'team_pull_inbox.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const agentId = readString(input, 'agent_id');
    const teamLookup = getTeamOrError(server, teamId);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    const agentLookup = getAgentOrError(server, agentId);
    if (agentLookup.error || !agentLookup.agent) {
      return { ok: false, error: agentLookup.error };
    }
    const agentMembership = ensureAgentInTeam(agentLookup.agent, teamId, 'agent');
    if (!agentMembership.ok) {
      return agentMembership;
    }

    const limit = readOptionalNumber(input, 'limit') ?? 20;
    const messages = server.store.pullInbox(teamId, agentId, limit);
    let acked = 0;
    if (readBoolean(input, 'ack', true)) {
      acked = server.store.ackInbox(messages.map((message) => message.inbox_id));
    }

    return {
      ok: true,
      messages: messages.map((msg) => ({
        message_id: msg.message_id,
        from_agent_id: msg.from_agent_id,
        to_agent_id: msg.to_agent_id,
        delivery_mode: msg.delivery_mode,
        idempotency_key: msg.idempotency_key,
        payload: msg.payload,
        delivered_at: msg.delivered_at
      })),
      acked
    };
  });
}
