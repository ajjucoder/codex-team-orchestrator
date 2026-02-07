import { newId } from '../ids.js';
import { isKnownRole } from '../role-pack.js';

function nowIso() {
  return new Date().toISOString();
}

const MAX_SUMMARY_LENGTH = 5000;
const MAX_ARTIFACT_REFS = 50;

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
    const agentCount = server.store.listAgentsByTeam(input.team_id).length;
    if (agentCount >= team.max_threads) {
      return {
        ok: false,
        error: `max_threads exceeded for team ${team.team_id}`
      };
    }

    const ts = nowIso();
    const agent = server.store.createAgent({
      agent_id: newId('agent'),
      team_id: input.team_id,
      role: input.role,
      status: 'idle',
      model: input.model ?? team.session_model ?? null,
      created_at: ts,
      updated_at: ts,
      metadata: {
        inherited_model: !input.model
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

    const createdAt = nowIso();
    const result = server.store.appendMessage({
      message_id: newId('msg'),
      team_id: input.team_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id,
      delivery_mode: 'direct',
      payload: {
        summary: input.summary,
        artifact_refs: input.artifact_refs ?? []
      },
      idempotency_key: input.idempotency_key,
      created_at: createdAt,
      recipient_agent_ids: [input.to_agent_id]
    });

    return {
      ok: true,
      inserted: result.inserted,
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
        summary: input.summary,
        artifact_refs: input.artifact_refs ?? []
      },
      idempotency_key: input.idempotency_key,
      created_at: nowIso(),
      recipient_agent_ids: recipients
    });

    return {
      ok: true,
      inserted: result.inserted,
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
