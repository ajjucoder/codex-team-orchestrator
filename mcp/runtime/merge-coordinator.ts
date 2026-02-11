export type MergeDecision = 'approve' | 'reject';
export type MergeAction = 'merge' | 'block' | 'retry' | 'escalate';
export type MergeType = 'integration' | 'standard';

export interface MergeVoteEvidence {
  agent_id: string;
  role: string;
  decision: MergeDecision;
  reason?: string | null;
}

export interface MergeVoteStats {
  approve: number;
  reject: number;
  total: number;
}

export interface MergeArbitrationSnapshot {
  strategy: string;
  decision: MergeDecision;
  reason: string;
  stats: MergeVoteStats;
}

export interface MergeGateEvaluation {
  gate_id: 'reviewer_pass_evidence' | 'tester_pass_evidence' | 'arbitration_approval';
  required: boolean;
  passed: boolean;
  reason: string;
  evidence: Record<string, unknown>;
}

export interface MergeConflictResolution {
  detected: boolean;
  reviewer_conflict: boolean;
  tester_conflict: boolean;
  key: string;
  retry_attempt: number;
  retry_limit: number;
  next_action: 'none' | 'retry' | 'escalate';
  reason: string;
}

export interface MergeCoordinatorInput {
  proposal_id: string;
  votes: MergeVoteEvidence[];
  arbitration: MergeArbitrationSnapshot;
  prior_events?: Array<Record<string, unknown>>;
  conflict_retry_limit?: number;
}

export interface MergeCoordinatorResult {
  merge_type: MergeType;
  decision: MergeDecision;
  action: MergeAction;
  blocked: boolean;
  reason: string;
  gates: MergeGateEvaluation[];
  failed_gates: string[];
  conflict: MergeConflictResolution;
  event_payload: Record<string, unknown>;
}

export interface GuardrailGateInput {
  team_id: string;
  consensus_reached: boolean;
  open_tasks: number;
  early_stop_should_stop: boolean;
  early_stop_reason: string;
}

export interface GuardrailGateResult {
  gate: {
    gate_id: 'merge_readiness_consensus';
    passed: boolean;
    reason: string;
    evidence: Record<string, unknown>;
  };
  event_payload: Record<string, unknown>;
}

const INTEGRATION_PROPOSAL_PATTERN = /^(integration|int)([:/_-]).+/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function countVotesByRole(
  votes: MergeVoteEvidence[],
  role: string,
  decision: MergeDecision
): number {
  return votes.filter((vote) => vote.role === role && vote.decision === decision).length;
}

function countPriorConflictAttempts(
  proposalId: string,
  events: Array<Record<string, unknown>>
): number {
  let attempts = 0;
  for (const event of events) {
    if (readString(event.event_type) !== 'merge_gate_decision') continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (readString(payload.proposal_id) !== proposalId) continue;
    const conflict = isRecord(payload.conflict) ? payload.conflict : {};
    if (conflict.detected !== true) continue;
    const outcome = isRecord(payload.outcome) ? payload.outcome : {};
    const action = readString(outcome.action);
    if (action === 'retry' || action === 'escalate') attempts += 1;
  }
  return attempts;
}

export function isIntegrationMergeProposal(proposalId: string): boolean {
  return INTEGRATION_PROPOSAL_PATTERN.test(readString(proposalId));
}

export function evaluateMergeCoordinatorDecision(input: MergeCoordinatorInput): MergeCoordinatorResult {
  const proposalId = readString(input.proposal_id);
  const mergeType: MergeType = isIntegrationMergeProposal(proposalId) ? 'integration' : 'standard';
  const integrationRequired = mergeType === 'integration';
  const retryLimit = Math.max(1, toNonNegativeInt(input.conflict_retry_limit, 1));

  const reviewerApprovals = countVotesByRole(input.votes, 'reviewer', 'approve');
  const reviewerRejects = countVotesByRole(input.votes, 'reviewer', 'reject');
  const testerApprovals = countVotesByRole(input.votes, 'tester', 'approve');
  const testerRejects = countVotesByRole(input.votes, 'tester', 'reject');

  const gates: MergeGateEvaluation[] = [
    {
      gate_id: 'reviewer_pass_evidence',
      required: integrationRequired,
      passed: !integrationRequired || reviewerApprovals > 0,
      reason: integrationRequired
        ? (reviewerApprovals > 0
            ? 'reviewer approval evidence present'
            : 'missing reviewer approval evidence')
        : 'reviewer gate not required for standard merge',
      evidence: {
        reviewer_approvals: reviewerApprovals,
        reviewer_rejects: reviewerRejects
      }
    },
    {
      gate_id: 'tester_pass_evidence',
      required: integrationRequired,
      passed: !integrationRequired || testerApprovals > 0,
      reason: integrationRequired
        ? (testerApprovals > 0
            ? 'tester approval evidence present'
            : 'missing tester approval evidence')
        : 'tester gate not required for standard merge',
      evidence: {
        tester_approvals: testerApprovals,
        tester_rejects: testerRejects
      }
    },
    {
      gate_id: 'arbitration_approval',
      required: true,
      passed: input.arbitration.decision === 'approve',
      reason: input.arbitration.decision === 'approve'
        ? 'arbitration approved merge'
        : `arbitration rejected merge: ${input.arbitration.reason}`,
      evidence: {
        strategy: input.arbitration.strategy,
        stats: input.arbitration.stats
      }
    }
  ];

  const failedRequiredGates = gates.filter((gate) => gate.required && !gate.passed);

  const reviewerConflict = integrationRequired && reviewerApprovals > 0 && reviewerRejects > 0;
  const testerConflict = integrationRequired && testerApprovals > 0 && testerRejects > 0;
  const conflictDetected = reviewerConflict || testerConflict;
  const priorConflictAttempts = countPriorConflictAttempts(proposalId, input.prior_events ?? []);
  const retryAttempt = conflictDetected ? priorConflictAttempts + 1 : 0;
  const nextConflictAction: MergeConflictResolution['next_action'] = !conflictDetected
    ? 'none'
    : (retryAttempt <= retryLimit ? 'retry' : 'escalate');

  const conflict: MergeConflictResolution = {
    detected: conflictDetected,
    reviewer_conflict: reviewerConflict,
    tester_conflict: testerConflict,
    key: `${proposalId}:merge_conflict`,
    retry_attempt: retryAttempt,
    retry_limit: retryLimit,
    next_action: nextConflictAction,
    reason: !conflictDetected
      ? 'no reviewer/tester conflict detected'
      : (nextConflictAction === 'retry'
          ? `conflict detected for proposal ${proposalId}; deterministic retry ${retryAttempt}/${retryLimit}`
          : `conflict detected for proposal ${proposalId}; retry budget exhausted (${retryLimit}), escalating`)
  };

  let action: MergeAction = 'merge';
  let decision: MergeDecision = 'approve';
  let reason = 'all required merge gates passed';

  if (failedRequiredGates.length > 0) {
    action = 'block';
    decision = 'reject';
    reason = failedRequiredGates.map((gate) => `${gate.gate_id}: ${gate.reason}`).join('; ');
  } else if (conflictDetected) {
    action = nextConflictAction === 'retry' ? 'retry' : 'escalate';
    decision = 'reject';
    reason = conflict.reason;
  }

  const blocked = action !== 'merge';
  const failedGateIds = failedRequiredGates.map((gate) => gate.gate_id);

  return {
    merge_type: mergeType,
    decision,
    action,
    blocked,
    reason,
    gates,
    failed_gates: failedGateIds,
    conflict,
    event_payload: {
      proposal_id: proposalId,
      merge_type: mergeType,
      arbitration: input.arbitration,
      gates,
      failed_gates: failedGateIds,
      conflict,
      outcome: {
        action,
        decision,
        blocked,
        reason
      }
    }
  };
}

export function evaluateGuardrailMergeGate(input: GuardrailGateInput): GuardrailGateResult {
  const mergeReady = input.consensus_reached && input.open_tasks === 0 && input.early_stop_should_stop;
  const gate = {
    gate_id: 'merge_readiness_consensus' as const,
    passed: mergeReady,
    reason: mergeReady
      ? 'consensus reached and no open tasks; merge readiness confirmed'
      : 'merge readiness blocked: consensus/open task guardrail not satisfied',
    evidence: {
      consensus_reached: input.consensus_reached,
      open_tasks: input.open_tasks,
      early_stop_should_stop: input.early_stop_should_stop,
      early_stop_reason: input.early_stop_reason
    }
  };
  return {
    gate,
    event_payload: {
      team_id: input.team_id,
      gate,
      outcome: {
        pass: gate.passed,
        reason: gate.reason
      }
    }
  };
}
