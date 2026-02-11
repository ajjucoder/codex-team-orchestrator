import type { ToolServerLike } from './types.js';
import { arbitrateMerge, type VoteRecord } from '../arbitration.js';
import {
  evaluateMergeCoordinatorDecision,
  type MergeTargetMetadata,
  type MergeVoteEvidence
} from '../../runtime/merge-coordinator.js';

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

function readMergeTarget(input: Record<string, unknown>): MergeTargetMetadata | undefined {
  const rawTarget = input.merge_target;
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) return undefined;
  const target = rawTarget as Record<string, unknown>;
  const targetType = readString(target, 'target_type');
  if (targetType !== 'integration' && targetType !== 'standard') return undefined;
  const targetRef = readString(target, 'target_ref');
  const metadataSource = readString(target, 'metadata_source');

  return {
    target_type: targetType,
    target_ref: targetRef.length > 0 ? targetRef : null,
    metadata_source: metadataSource.length > 0 ? metadataSource : null
  };
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

function readApprovalChain(input: Record<string, unknown>): Array<Record<string, string>> {
  if (!Array.isArray(input.approval_chain)) return [];
  return input.approval_chain
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      agent_id: typeof entry.agent_id === 'string' ? entry.agent_id : '',
      decision: typeof entry.decision === 'string' ? entry.decision : '',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      decided_at: typeof entry.decided_at === 'string' ? entry.decided_at : ''
    }))
    .filter((entry) => entry.agent_id.length > 0);
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

    const proposalId = readString(input, 'proposal_id');
    const strategy = readString(input, 'strategy');
    const riskTier = readString(input, 'risk_tier') || null;
    const approvalRequestedAt = readString(input, 'approval_requested_at') || null;
    const approvalChain = readApprovalChain(input);

    const arbitration = arbitrateMerge({
      strategy,
      votes,
      lead_agent_id: leadAgentId || null
    });

    const mergeTarget = readMergeTarget(input);
    const mergeEvidence = readMergeEvidence(server, input);
    const priorEvents = server.store.listEvents(teamId, 500);
    const coordinator = evaluateMergeCoordinatorDecision({
      proposal_id: proposalId,
      merge_target: mergeTarget,
      votes: mergeEvidence,
      arbitration: {
        strategy,
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
        strategy,
        risk_tier: riskTier,
        approval_requested_at: approvalRequestedAt,
        approval_chain: approvalChain,
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
      strategy,
      risk_tier: riskTier,
      approval_requested_at: approvalRequestedAt,
      approval_chain: approvalChain,
      decision: coordinator.decision,
      reason: coordinator.reason,
      stats: arbitration.stats,
      action: coordinator.action,
      blocked: coordinator.blocked,
      merge_type: coordinator.merge_type,
      merge_target: coordinator.merge_target,
      failed_gates: coordinator.failed_gates,
      gates: coordinator.gates,
      conflict: coordinator.conflict
    };
  });
}
