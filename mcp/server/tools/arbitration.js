import { arbitrateMerge } from '../arbitration.js';

function teamHasAgent(server, teamId, agentId) {
  const agent = server.store.getAgent(agentId);
  return Boolean(agent && agent.team_id === teamId);
}

export function registerArbitrationTools(server) {
  server.registerTool('team_merge_decide', 'team_merge_decide.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    for (const vote of input.votes) {
      if (!teamHasAgent(server, input.team_id, vote.agent_id)) {
        return {
          ok: false,
          error: `vote agent not in team: ${vote.agent_id}`
        };
      }
    }

    if (input.lead_agent_id && !teamHasAgent(server, input.team_id, input.lead_agent_id)) {
      return {
        ok: false,
        error: `lead agent not in team: ${input.lead_agent_id}`
      };
    }

    const arbitration = arbitrateMerge({
      strategy: input.strategy,
      votes: input.votes,
      lead_agent_id: input.lead_agent_id ?? null
    });

    server.store.logEvent({
      team_id: input.team_id,
      event_type: 'merge_decision',
      payload: {
        proposal_id: input.proposal_id,
        strategy: input.strategy,
        decision: arbitration.decision,
        stats: arbitration.stats,
        reason: arbitration.reason
      }
    });

    return {
      ok: true,
      proposal_id: input.proposal_id,
      strategy: input.strategy,
      decision: arbitration.decision,
      reason: arbitration.reason,
      stats: arbitration.stats
    };
  });
}
