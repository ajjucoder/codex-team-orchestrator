export interface VoteRecord {
  agent_id: string;
  decision: string;
}

interface VoteCounts {
  approve: number;
  reject: number;
  total: number;
}

type ArbitrationDecision = 'approve' | 'reject';

interface ArbitrationResult {
  decision: ArbitrationDecision;
  reason: string;
  stats: VoteCounts;
}

interface ArbitrationInput {
  strategy: string;
  votes: VoteRecord[];
  lead_agent_id?: string | null;
}

function countVotes(votes: VoteRecord[]): VoteCounts {
  let approve = 0;
  let reject = 0;
  for (const vote of votes) {
    if (vote.decision === 'approve') approve += 1;
    if (vote.decision === 'reject') reject += 1;
  }
  return { approve, reject, total: votes.length };
}

function majorityDecision(votes: VoteRecord[]): ArbitrationDecision {
  const counts = countVotes(votes);
  if (counts.approve > counts.reject) return 'approve';
  if (counts.reject > counts.approve) return 'reject';
  return 'reject';
}

function toDecision(value: string): ArbitrationDecision {
  return value === 'approve' ? 'approve' : 'reject';
}

export function arbitrateMerge({ strategy, votes, lead_agent_id = null }: ArbitrationInput): ArbitrationResult {
  const counts = countVotes(votes);

  if (votes.length === 0) {
    return {
      decision: 'reject',
      reason: 'no votes submitted',
      stats: counts
    };
  }

  if (strategy === 'consensus') {
    const allApprove = counts.approve === counts.total;
    return {
      decision: allApprove ? 'approve' : 'reject',
      reason: allApprove ? 'all votes approved' : 'consensus requires unanimous approval',
      stats: counts
    };
  }

  if (strategy === 'lead') {
    if (lead_agent_id) {
      const leadVote = votes.find((vote) => vote.agent_id === lead_agent_id);
      if (leadVote) {
        return {
          decision: toDecision(leadVote.decision),
          reason: `lead decision applied from ${lead_agent_id}`,
          stats: counts
        };
      }
    }
    return {
      decision: majorityDecision(votes),
      reason: 'lead vote unavailable; majority fallback applied',
      stats: counts
    };
  }

  if (strategy === 'strict_vote') {
    const approvalRatio = counts.approve / counts.total;
    const approved = counts.total >= 3 && approvalRatio >= 2 / 3;
    return {
      decision: approved ? 'approve' : 'reject',
      reason: approved
        ? 'strict vote threshold met (>= 2/3 approvals with >= 3 votes)'
        : 'strict vote threshold not met',
      stats: counts
    };
  }

  return {
    decision: 'reject',
    reason: `unknown strategy: ${strategy}`,
    stats: counts
  };
}
