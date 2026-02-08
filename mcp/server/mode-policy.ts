import type { TeamMode } from '../store/entities.js';

export interface ModeDecision {
  allowed: boolean;
  mode: TeamMode;
  matched_rule: string;
  deny_reason: string | null;
}

const PLAN_BLOCKED_TOOLS = new Set([
  'team_spawn',
  'team_spawn_ready_roles',
  'team_send',
  'team_broadcast',
  'team_task_claim',
  'team_task_update',
  'team_artifact_publish'
]);

function normalizeMode(value: string | null | undefined): TeamMode {
  if (value === 'delegate' || value === 'plan') return value;
  return 'default';
}

export function evaluateModeDecision({
  mode,
  tool_name,
  actor_role = null
}: {
  mode: string | null | undefined;
  tool_name: string;
  actor_role?: string | null;
}): ModeDecision {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === 'default') {
    return {
      allowed: true,
      mode: normalizedMode,
      matched_rule: 'default_allow',
      deny_reason: null
    };
  }

  if (normalizedMode === 'plan') {
    if (PLAN_BLOCKED_TOOLS.has(tool_name)) {
      return {
        allowed: false,
        mode: normalizedMode,
        matched_rule: `plan_block:${tool_name}`,
        deny_reason: `plan mode blocks execution tool ${tool_name}`
      };
    }
    return {
      allowed: true,
      mode: normalizedMode,
      matched_rule: 'plan_non_execution_allow',
      deny_reason: null
    };
  }

  if (normalizedMode === 'delegate') {
    if ((tool_name === 'team_task_claim' || tool_name === 'team_task_update') && actor_role === 'lead') {
      return {
        allowed: false,
        mode: normalizedMode,
        matched_rule: `delegate_lead_execution_block:${tool_name}`,
        deny_reason: `delegate mode blocks lead from direct execution via ${tool_name}`
      };
    }
    return {
      allowed: true,
      mode: normalizedMode,
      matched_rule: 'delegate_guardrail_allow',
      deny_reason: null
    };
  }

  return {
    allowed: true,
    mode: 'default',
    matched_rule: 'fallback_allow',
    deny_reason: null
  };
}
