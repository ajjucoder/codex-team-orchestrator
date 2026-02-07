interface GuardrailPolicy {
  guardrails?: {
    early_stop_on_consensus?: boolean;
  };
  budgets?: {
    idle_shutdown_ms?: unknown;
  };
}

interface TeamLifecycleRecord {
  team_id: string;
  profile: string;
  last_active_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

interface IdleFinalizationRecord {
  team_id: string;
  profile: string;
  idle_ms: number;
  idle_threshold_ms: number;
}

interface EarlyStopInput {
  policy?: GuardrailPolicy;
  consensus_reached: boolean;
  open_tasks: number;
}

interface IdleSweepInput {
  teams: TeamLifecycleRecord[];
  policyByProfile: (profile: string) => GuardrailPolicy | undefined;
  nowMs?: number;
}

function toMs(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function compactPayload(summary: string, artifactRefs: unknown[] | null | undefined): { summary: string; artifact_refs: unknown[] } {
  return {
    summary,
    artifact_refs: artifactRefs ?? []
  };
}

export function evaluateEarlyStop({ policy, consensus_reached, open_tasks }: EarlyStopInput): { should_stop: boolean; reason: string } {
  const enabled = Boolean(policy?.guardrails?.early_stop_on_consensus ?? true);
  if (enabled && consensus_reached && open_tasks === 0) {
    return {
      should_stop: true,
      reason: 'consensus reached with no open tasks'
    };
  }
  return {
    should_stop: false,
    reason: 'continue execution'
  };
}

export function evaluateIdleTeams({ teams, policyByProfile, nowMs = Date.now() }: IdleSweepInput): IdleFinalizationRecord[] {
  const referenceNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const finalized: IdleFinalizationRecord[] = [];
  for (const team of teams) {
    const policy = policyByProfile(team.profile);
    const idleMs = toMs(policy?.budgets?.idle_shutdown_ms, 180000);
    const timestamp = team.last_active_at ?? team.updated_at ?? team.created_at ?? '';
    const lastActive = Date.parse(timestamp);
    if (!Number.isFinite(lastActive)) continue;
    if (referenceNow - lastActive >= idleMs) {
      finalized.push({
        team_id: team.team_id,
        profile: team.profile,
        idle_ms: referenceNow - lastActive,
        idle_threshold_ms: idleMs
      });
    }
  }
  return finalized;
}
