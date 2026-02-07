import type { ToolServerLike } from './types.js';
import { arbitrateMerge, type VoteRecord } from '../arbitration.js';

function teamHasAgent(server: ToolServerLike, teamId: string, agentId: string): boolean {
  const agent = server.store.getAgent(agentId);
  return Boolean(agent && agent.team_id === teamId);
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readVotes(input: Record<string, unknown>): VoteRecord[] {
  if (!Array.isArray(input.votes)) return [];
  return input.votes
    .filter((vote): vote is Record<string, unknown> => Boolean(vote) && typeof vote === 'object')
    .map((vote) => ({
      agent_id: typeof vote.agent_id === 'string' ? vote.agent_id : '',
      decision: typeof vote.decision === 'string' ? vote.decision : ''
    }));
}

export function registerArbitrationTools(server: ToolServerLike): void {
  server.registerTool('team_merge_decide', 'team_merge_decide.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const votes = readVotes(input);
    for (const vote of votes) {
      if (!vote.agent_id || !teamHasAgent(server, teamId, vote.agent_id)) {
        return {
          ok: false,
          error: `vote agent not in team: ${vote.agent_id}`
        };
      }
    }

    const leadAgentId = readString(input, 'lead_agent_id');
    if (leadAgentId && !teamHasAgent(server, teamId, leadAgentId)) {
      return {
        ok: false,
        error: `lead agent not in team: ${leadAgentId}`
      };
    }

    const arbitration = arbitrateMerge({
      strategy: readString(input, 'strategy'),
      votes,
      lead_agent_id: leadAgentId || null
    });

    server.store.logEvent({
      team_id: teamId,
      event_type: 'merge_decision',
      payload: {
        proposal_id: readString(input, 'proposal_id'),
        strategy: readString(input, 'strategy'),
        decision: arbitration.decision,
        stats: arbitration.stats,
        reason: arbitration.reason
      }
    });

    return {
      ok: true,
      proposal_id: readString(input, 'proposal_id'),
      strategy: readString(input, 'strategy'),
      decision: arbitration.decision,
      reason: arbitration.reason,
      stats: arbitration.stats
    };
  });
}
