function toMs(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function compactPayload(summary, artifactRefs) {
  return {
    summary,
    artifact_refs: artifactRefs ?? []
  };
}

export function evaluateEarlyStop({ policy, consensus_reached, open_tasks }) {
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

export function evaluateIdleTeams({ teams, policyByProfile, nowMs = Date.now() }) {
  const finalized = [];
  for (const team of teams) {
    const policy = policyByProfile(team.profile);
    const idleMs = toMs(policy?.budgets?.idle_shutdown_ms, 180000);
    const lastActive = Date.parse(team.last_active_at ?? team.updated_at ?? team.created_at);
    if (!Number.isFinite(lastActive)) continue;
    if (nowMs - lastActive >= idleMs) {
      finalized.push({
        team_id: team.team_id,
        profile: team.profile,
        idle_ms: nowMs - lastActive,
        idle_threshold_ms: idleMs
      });
    }
  }
  return finalized;
}
