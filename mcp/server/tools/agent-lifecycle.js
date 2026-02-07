import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';

function nowIso() {
  return new Date().toISOString();
}

const MAX_SUMMARY_LENGTH = 5000;
const MAX_ARTIFACT_REFS = 50;
const DUPLICATE_SUPPRESS_WINDOW_MS = 120000;

function getTeamOrError(server, teamId) {
  const team = server.store.getTeam(teamId);
  if (!team) {
    return { error: `team not found: ${teamId}` };
  }
  return { team };
}

function getAgentOrError(server, agentId) {
  const agent = server.store.getAgent(agentId);
  if (!agent) {
    return { error: `agent not found: ${agentId}` };
  }
  return { agent };
}

function ensureAgentInTeam(agent, teamId, label) {
  if (agent.team_id !== teamId) {
    return { ok: false, error: `${label} not in team ${teamId}: ${agent.agent_id}` };
  }
  return { ok: true };
}

function validateMessagePayload(summary, artifactRefs) {
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `summary too long: max ${MAX_SUMMARY_LENGTH}` };
  }
  if ((artifactRefs ?? []).length > MAX_ARTIFACT_REFS) {
    return { ok: false, error: `too many artifact refs: max ${MAX_ARTIFACT_REFS}` };
  }
  return { ok: true };
}

function pickString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function resolveSpawnModel({ inputModel, team, role, policy }) {
  const explicit = pickString(inputModel);
  if (explicit) {
    return {
      model: explicit,
      model_source: 'explicit_input',
      model_routing_applied: false,
      inherited_model: false
    };
  }

  const modelRouting = policy?.model_routing ?? {};
  if (modelRouting.enabled === true) {
    const roleModel = pickString(modelRouting?.role_models?.[role]);
    const defaultModel = pickString(modelRouting?.default_model);
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

function resolvePermissionProfile({ policy, role }) {
  const roleScoped = pickString(policy?.permissions?.[role]);
  if (roleScoped) return roleScoped;
  return pickString(policy?.permissions?.default);
}

function normalizeArtifactRefs(artifactRefs = []) {
  return [...artifactRefs]
    .map((ref) => ({
      artifact_id: String(ref.artifact_id),
      version: Number(ref.version)
    }))
    .sort((a, b) => {
      const aid = a.artifact_id.localeCompare(b.artifact_id);
      if (aid !== 0) return aid;
      return a.version - b.version;
    });
}

function artifactRefKey(ref) {
  return `${ref.artifact_id}@${ref.version}`;
}

function diffArtifactRefs(currentRefs = [], previousRefs = []) {
  const previousKeys = new Set(previousRefs.map(artifactRefKey));
  return currentRefs.filter((ref) => !previousKeys.has(artifactRefKey(ref)));
}

function duplicateResponse(existingMessage, mode) {
  const base = {
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
      payload: existingMessage.payload
    }
  };
  if (mode === 'broadcast') {
    base.recipient_count = null;
  }
  return base;
}

export function registerAgentLifecycleTools(server) {
  server.registerTool('team_spawn', 'team_spawn.schema.json', (input) => {
    const teamLookup = getTeamOrError(server, input.team_id);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    if (!isKnownRole(input.role)) {
      return { ok: false, error: `unknown role: ${input.role}` };
    }

    const team = teamLookup.team;
    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const agentCount = server.store.listAgentsByTeam(input.team_id).length;
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
      role: input.role,
      policy
    });
    const permissionProfile = resolvePermissionProfile({ policy, role: input.role });
    const agent = server.store.createAgent({
      agent_id: newId('agent'),
      team_id: input.team_id,
      role: input.role,
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

    return {
      ok: true,
      agent
    };
  });

  server.registerTool('team_send', 'team_send.schema.json', (input) => {
    const teamLookup = getTeamOrError(server, input.team_id);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    const fromLookup = getAgentOrError(server, input.from_agent_id);
    if (fromLookup.error) {
      return { ok: false, error: fromLookup.error };
    }
    const toLookup = getAgentOrError(server, input.to_agent_id);
    if (toLookup.error) {
      return { ok: false, error: toLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, input.team_id, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }
    const toMembership = ensureAgentInTeam(toLookup.agent, input.team_id, 'to_agent');
    if (!toMembership.ok) {
      return toMembership;
    }

    const payloadValidation = validateMessagePayload(input.summary, input.artifact_refs);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    const summary = input.summary;
    let artifactRefs = normalizeArtifactRefs(input.artifact_refs ?? []);
    let deltaApplied = false;

    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      delivery_mode: 'direct'
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        artifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: input.team_id,
          agent_id: input.from_agent_id,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'direct' }
        });
        return duplicateResponse(previousRouteMessage, 'direct');
      }
      if (deltaRefs.length < artifactRefs.length) {
        artifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      delivery_mode: 'direct',
      payload: {
        summary,
        artifact_refs: artifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: input.team_id,
        agent_id: input.from_agent_id,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'direct' }
      });
      return duplicateResponse(duplicate, 'direct');
    }

    const createdAt = nowIso();
    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      delivery_mode: 'direct',
      payload: {
        summary,
        artifact_refs: artifactRefs
      },
      idempotency_key: input.idempotency_key,
      created_at: createdAt,
      recipient_agent_ids: [input.to_agent_id]
    });
    if (deltaApplied) {
      server.store.logEvent({
        team_id: input.team_id,
        agent_id: input.from_agent_id,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'direct',
          artifact_refs_reduced_to: artifactRefs.length
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
    const teamLookup = getTeamOrError(server, input.team_id);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }

    const fromLookup = getAgentOrError(server, input.from_agent_id);
    if (fromLookup.error) {
      return { ok: false, error: fromLookup.error };
    }
    const fromMembership = ensureAgentInTeam(fromLookup.agent, input.team_id, 'from_agent');
    if (!fromMembership.ok) {
      return fromMembership;
    }

    const payloadValidation = validateMessagePayload(input.summary, input.artifact_refs);
    if (!payloadValidation.ok) {
      return payloadValidation;
    }

    const summary = input.summary;
    let artifactRefs = normalizeArtifactRefs(input.artifact_refs ?? []);
    let deltaApplied = false;

    const previousRouteMessage = server.store.getLatestRouteMessage({
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      delivery_mode: 'broadcast'
    });
    if (previousRouteMessage?.payload?.summary === summary) {
      const deltaRefs = diffArtifactRefs(
        artifactRefs,
        normalizeArtifactRefs(previousRouteMessage.payload.artifact_refs ?? [])
      );
      if (deltaRefs.length === 0) {
        server.store.logEvent({
          team_id: input.team_id,
          agent_id: input.from_agent_id,
          message_id: previousRouteMessage.message_id,
          event_type: 'message_duplicate_suppressed',
          payload: { delivery_mode: 'broadcast' }
        });
        const response = duplicateResponse(previousRouteMessage, 'broadcast');
        response.recipient_count = server
          .store
          .listAgentsByTeam(input.team_id)
          .filter((agent) => agent.agent_id !== input.from_agent_id).length;
        return response;
      }
      if (deltaRefs.length < artifactRefs.length) {
        artifactRefs = deltaRefs;
        deltaApplied = true;
      }
    }

    const duplicate = server.store.findRecentDuplicateMessage({
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      delivery_mode: 'broadcast',
      payload: {
        summary,
        artifact_refs: artifactRefs
      },
      within_ms: DUPLICATE_SUPPRESS_WINDOW_MS
    });
    if (duplicate) {
      server.store.logEvent({
        team_id: input.team_id,
        agent_id: input.from_agent_id,
        message_id: duplicate.message_id,
        event_type: 'message_duplicate_suppressed',
        payload: { delivery_mode: 'broadcast' }
      });
      const response = duplicateResponse(duplicate, 'broadcast');
      response.recipient_count = server
        .store
        .listAgentsByTeam(input.team_id)
        .filter((agent) => agent.agent_id !== input.from_agent_id).length;
      return response;
    }

    const recipients = server
      .store
      .listAgentsByTeam(input.team_id)
      .filter((agent) => agent.agent_id !== input.from_agent_id)
      .map((agent) => agent.agent_id);

    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      delivery_mode: 'broadcast',
      payload: {
        summary,
        artifact_refs: artifactRefs
      },
      idempotency_key: input.idempotency_key,
      created_at: nowIso(),
      recipient_agent_ids: recipients
    });
    if (deltaApplied) {
      server.store.logEvent({
        team_id: input.team_id,
        agent_id: input.from_agent_id,
        message_id: result.message.message_id,
        event_type: 'message_delta_applied',
        payload: {
          delivery_mode: 'broadcast',
          artifact_refs_reduced_to: artifactRefs.length
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
    const teamLookup = getTeamOrError(server, input.team_id);
    if (teamLookup.error) {
      return { ok: false, error: teamLookup.error };
    }
    const agentLookup = getAgentOrError(server, input.agent_id);
    if (agentLookup.error) {
      return { ok: false, error: agentLookup.error };
    }
    const agentMembership = ensureAgentInTeam(agentLookup.agent, input.team_id, 'agent');
    if (!agentMembership.ok) {
      return agentMembership;
    }

    const messages = server.store.pullInbox(input.team_id, input.agent_id, input.limit ?? 20);
    let acked = 0;
    if (input.ack ?? true) {
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
