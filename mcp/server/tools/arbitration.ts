import type { ToolServerLike } from './types.js';
import { arbitrateMerge, type VoteRecord } from '../arbitration.js';
import { evaluateMergeCoordinatorDecision, type MergeVoteEvidence } from '../../runtime/merge-coordinator.js';

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

function readVoteReason(vote: Record<string, unknown>): string | null {
  return typeof vote.reason === 'string' ? vote.reason : null;
}

function toMergeEvidence(server: ToolServerLike, votes: VoteRecord[]): MergeVoteEvidence[] {
  return votes.map((vote) => {
    const agent = server.store.getAgent(vote.agent_id);
    return {
      agent_id: vote.agent_id,
      role: typeof agent?.role === 'string' ? agent.role : 'unknown',
      decision: vote.decision === 'approve' ? 'approve' : 'reject',
      reason: null
    };
  });
}

function readMergeEvidence(server: ToolServerLike, input: Record<string, unknown>): MergeVoteEvidence[] {
  if (!Array.isArray(input.votes)) return [];
  const votes = input.votes
    .filter((vote): vote is Record<string, unknown> => Boolean(vote) && typeof vote === 'object')
    .map((vote) => ({
      agent_id: typeof vote.agent_id === 'string' ? vote.agent_id : '',
      decision: typeof vote.decision === 'string' ? vote.decision : '',
      reason: readVoteReason(vote)
    }));

  return toMergeEvidence(server, votes).map((evidence) => {
    const source = votes.find((vote) => vote.agent_id === evidence.agent_id);
    return {
      ...evidence,
      reason: source?.reason ?? null
    };
  });
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
    const proposalId = readString(input, 'proposal_id');
    const mergeEvidence = readMergeEvidence(server, input);
    const priorEvents = server.store.listEvents(teamId, 500);
    const coordinator = evaluateMergeCoordinatorDecision({
      proposal_id: proposalId,
      votes: mergeEvidence,
      arbitration: {
        strategy: readString(input, 'strategy'),
        decision: arbitration.decision,
        reason: arbitration.reason,
        stats: arbitration.stats
      },
      prior_events: priorEvents
    });

    server.store.logEvent({
      team_id: teamId,
      event_type: 'merge_gate_decision',
      payload: coordinator.event_payload
    });

    server.store.logEvent({
      team_id: teamId,
      event_type: 'merge_decision',
      payload: {
        proposal_id: proposalId,
        strategy: readString(input, 'strategy'),
        arbitration_decision: arbitration.decision,
        arbitration_reason: arbitration.reason,
        decision: coordinator.decision,
        action: coordinator.action,
        blocked: coordinator.blocked,
        stats: arbitration.stats,
        reason: coordinator.reason,
        failed_gates: coordinator.failed_gates,
        conflict: coordinator.conflict
      }
    });

    return {
      ok: true,
      proposal_id: proposalId,
      strategy: readString(input, 'strategy'),
      decision: coordinator.decision,
      reason: coordinator.reason,
      stats: arbitration.stats,
      action: coordinator.action,
      blocked: coordinator.blocked,
      merge_type: coordinator.merge_type,
      failed_gates: coordinator.failed_gates,
      gates: coordinator.gates,
      conflict: coordinator.conflict
    };
  });
}
