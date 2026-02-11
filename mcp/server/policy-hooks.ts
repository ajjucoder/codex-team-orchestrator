import type { HookContext } from './hooks.js';
import type { ToolServerLike } from './tools/types.js';

type RiskTier = 'P0' | 'P1' | 'P2';

interface QualityGateConfig {
  require_tests_before_complete: boolean;
  require_compliance_ack: boolean;
  min_artifact_refs: number;
}

interface QualityGateFailure {
  code: string;
  detail: string;
}

interface ApprovalEntry {
  agent_id: string;
  decision: 'approve' | 'reject';
  reason: string | null;
  decided_at: string | null;
}

interface ApprovalGateConfig {
  required_approvals: number;
  timeout_ms: number;
  escalation_policy: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readTeamId(hookContext: HookContext): string | null {
  const inputTeamId = typeof hookContext.input.team_id === 'string' ? hookContext.input.team_id : null;
  if (inputTeamId && inputTeamId.trim().length > 0) return inputTeamId;
  const ctxTeamId = typeof hookContext.context.team_id === 'string' ? hookContext.context.team_id : null;
  if (ctxTeamId && ctxTeamId.trim().length > 0) return ctxTeamId;
  return null;
}

function normalizeRiskTier(value: unknown): RiskTier | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'P0' || normalized === 'P1' || normalized === 'P2') {
    return normalized;
  }
  return null;
}

function detectRiskTierFromText(value: unknown): RiskTier | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/\bP([012])(?:-[0-9]+)?\b/i);
  if (!match) return null;
  return normalizeRiskTier(`P${match[1]}`);
}

function readTaskId(hookContext: HookContext): string | null {
  const taskId = typeof hookContext.input.task_id === 'string'
    ? hookContext.input.task_id
    : (typeof hookContext.context.task_id === 'string' ? hookContext.context.task_id : null);
  if (!taskId) return null;
  return taskId.trim().length > 0 ? taskId : null;
}

function hasTierGateConfig(quality: Record<string, unknown>, riskTier: RiskTier): boolean {
  const byRiskTier = asRecord(quality.by_risk_tier);
  if (!byRiskTier) return false;
  return asRecord(byRiskTier[riskTier]) !== null;
}

function resolveRiskTier(
  server: ToolServerLike,
  hookContext: HookContext,
  quality: Record<string, unknown>
): RiskTier {
  const explicitRiskTier = normalizeRiskTier(hookContext.input.risk_tier)
    ?? normalizeRiskTier(hookContext.input.ticket_risk_tier)
    ?? normalizeRiskTier(hookContext.context.risk_tier);
  if (explicitRiskTier) return explicitRiskTier;

  const taskId = readTaskId(hookContext);
  if (taskId) {
    const task = server.store.getTask(taskId);
    if (task) {
      const fromTask = detectRiskTierFromText(task.title) ?? detectRiskTierFromText(task.description);
      if (fromTask) return fromTask;
    }
  }

  const fromInputText = detectRiskTierFromText(hookContext.input.title)
    ?? detectRiskTierFromText(hookContext.input.description);
  if (fromInputText) return fromInputText;

  return normalizeRiskTier(quality.default_risk_tier) ?? 'P2';
}

function resolveGateConfig(quality: Record<string, unknown>, riskTier: RiskTier): QualityGateConfig {
  const tierConfig = asRecord(asRecord(quality.by_risk_tier)?.[riskTier]) ?? {};
  return {
    require_tests_before_complete: readBool(
      tierConfig.require_tests_before_complete,
      readBool(quality.require_tests_before_complete, false)
    ),
    require_compliance_ack: readBool(
      tierConfig.require_compliance_ack,
      readBool(quality.require_compliance_ack, false)
    ),
    min_artifact_refs: Math.max(
      0,
      readNumber(
        tierConfig.min_artifact_refs,
        Math.max(0, readNumber(quality.min_artifact_refs, 0))
      )
    )
  };
}

function buildFailureReason(riskTier: RiskTier, failures: QualityGateFailure[]): string {
  const codes = failures.map((failure) => failure.code).join(',');
  const details = failures.map((failure) => failure.detail).join('|');
  return `quality_gate_failed tier=${riskTier} failed=${codes} detail=${details}`;
}

function normalizeDecision(value: unknown): 'approve' | 'reject' | null {
  if (value === 'approve' || value === 'reject') return value;
  return null;
}

function readApprovals(hookContext: HookContext): ApprovalEntry[] {
  const chain = Array.isArray(hookContext.input.approval_chain)
    ? hookContext.input.approval_chain
    : (Array.isArray(hookContext.input.votes) ? hookContext.input.votes : []);
  return chain
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => {
      const decision = normalizeDecision(entry.decision);
      return {
        agent_id: typeof entry.agent_id === 'string' ? entry.agent_id : '',
        decision: decision ?? 'reject',
        reason: typeof entry.reason === 'string' ? entry.reason : null,
        decided_at: typeof entry.decided_at === 'string' ? entry.decided_at : null
      };
    })
    .filter((entry) => entry.agent_id.length > 0);
}

function readRequestedAt(hookContext: HookContext): number | null {
  const value = typeof hookContext.input.approval_requested_at === 'string'
    ? hookContext.input.approval_requested_at
    : (typeof hookContext.context.approval_requested_at === 'string' ? hookContext.context.approval_requested_at : null);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveApprovalGateConfig(policy: Record<string, unknown>, riskTier: RiskTier): ApprovalGateConfig {
  const approvals = asRecord(policy.approvals) ?? {};
  const byRiskTier = asRecord(approvals.by_risk_tier) ?? {};
  const tier = asRecord(byRiskTier[riskTier]) ?? {};

  const fallbackRequired = riskTier === 'P0' ? 2 : (riskTier === 'P1' ? 1 : 0);
  const requiredApprovals = Math.max(
    0,
    Math.floor(readNumber(tier.required_approvals, readNumber(approvals.required_approvals, fallbackRequired)))
  );
  const timeoutMs = Math.max(
    0,
    Math.floor(readNumber(tier.timeout_ms, readNumber(approvals.timeout_ms, 900000)))
  );
  const escalationPolicy = typeof tier.escalation_policy === 'string'
    ? tier.escalation_policy
    : (typeof approvals.escalation_policy === 'string' ? approvals.escalation_policy : 'lead_manual_review');
  return {
    required_approvals: requiredApprovals,
    timeout_ms: timeoutMs,
    escalation_policy: escalationPolicy
  };
}

function buildApprovalFailureReason({
  riskTier,
  requiredApprovals,
  approved,
  reasonCode,
  escalationPolicy
}: {
  riskTier: RiskTier;
  requiredApprovals: number;
  approved: number;
  reasonCode: 'insufficient_approvals' | 'approval_timeout';
  escalationPolicy: string;
}): string {
  return `approval_gate_failed tier=${riskTier} code=${reasonCode} required=${requiredApprovals} approved=${approved} escalation=${escalationPolicy}`;
}

export function registerBuiltInPolicyHooks(server: ToolServerLike): void {
  if (!server.hookEngine) return;
  const qualityRegistered = server.hookEngine.hooks.some((hook) => hook.name === 'builtin_quality_task_complete_gate');
  if (!qualityRegistered) {
    server.hookEngine.register({
      name: 'builtin_quality_task_complete_gate',
      event: 'task_complete',
      phase: 'pre',
      order: 40,
      timeout_ms: 100,
      fail_closed: true,
      handler: (hookContext) => {
        const teamId = readTeamId(hookContext);
        if (!teamId) {
          return { allow: true };
        }

        const team = server.store.getTeam(teamId);
        if (!team) {
          return { allow: true };
        }
        const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
        const quality = asRecord(policy.quality) ?? {};
        const riskTier = resolveRiskTier(server, hookContext, quality);
        const gateConfig = resolveGateConfig(quality, riskTier);
        const failures: QualityGateFailure[] = [];

        if (gateConfig.require_tests_before_complete && hookContext.input.quality_checks_passed !== true) {
          failures.push({
            code: 'tests_missing',
            detail: 'tests must pass before completion'
          });
        }

        if (gateConfig.require_compliance_ack && hookContext.input.compliance_ack !== true) {
          failures.push({
            code: 'compliance_missing',
            detail: 'compliance acknowledgment required'
          });
        }

        const artifactRefsCount = Math.max(0, readNumber(hookContext.input.artifact_refs_count, 0));
        if (gateConfig.min_artifact_refs > 0 && artifactRefsCount < gateConfig.min_artifact_refs) {
          failures.push({
            code: 'artifact_refs_low',
            detail: `artifact_refs_count ${artifactRefsCount} < required ${gateConfig.min_artifact_refs}`
          });
        }

        if (failures.length > 0) {
          return {
            allow: false,
            reason: buildFailureReason(riskTier, failures),
            metadata: {
              gate: 'builtin_quality_task_complete_gate',
              risk_tier: riskTier,
              gate_source: hasTierGateConfig(quality, riskTier) ? 'by_risk_tier' : 'flat',
              requirements: gateConfig,
              failure_count: failures.length,
              failure_codes: failures.map((failure) => failure.code),
              failures
            }
          };
        }

        return {
          allow: true,
          metadata: {
            gate: 'builtin_quality_task_complete_gate',
            risk_tier: riskTier,
            gate_source: hasTierGateConfig(quality, riskTier) ? 'by_risk_tier' : 'flat',
            requirements: gateConfig
          }
        };
      }
    });
  }

  const approvalsRegistered = server.hookEngine.hooks.some((hook) => hook.name === 'builtin_merge_approval_gate');
  if (!approvalsRegistered) {
    server.hookEngine.register({
      name: 'builtin_merge_approval_gate',
      event: 'merge_decide',
      phase: 'pre',
      order: 45,
      timeout_ms: 100,
      fail_closed: true,
      handler: (hookContext) => {
        const teamId = readTeamId(hookContext);
        if (!teamId) return { allow: true };

        const team = server.store.getTeam(teamId);
        if (!team) return { allow: true };

        const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
        const quality = asRecord(policy.quality) ?? {};
        const riskTier = resolveRiskTier(server, hookContext, quality);
        const gateConfig = resolveApprovalGateConfig(policy, riskTier);
        const approvals = readApprovals(hookContext);
        const approved = approvals.filter((entry) => entry.decision === 'approve').length;

        if (gateConfig.required_approvals > 0) {
          const requestedAt = readRequestedAt(hookContext);
          const timeoutExceeded = requestedAt !== null
            ? (Date.now() - requestedAt) > gateConfig.timeout_ms
            : false;
          if (timeoutExceeded) {
            return {
              allow: false,
              reason: buildApprovalFailureReason({
                riskTier,
                requiredApprovals: gateConfig.required_approvals,
                approved,
                reasonCode: 'approval_timeout',
                escalationPolicy: gateConfig.escalation_policy
              }),
              metadata: {
                gate: 'builtin_merge_approval_gate',
                risk_tier: riskTier,
                approval_timeout_ms: gateConfig.timeout_ms,
                escalation_policy: gateConfig.escalation_policy,
                approval_chain: approvals
              }
            };
          }

          if (approved < gateConfig.required_approvals) {
            return {
              allow: false,
              reason: buildApprovalFailureReason({
                riskTier,
                requiredApprovals: gateConfig.required_approvals,
                approved,
                reasonCode: 'insufficient_approvals',
                escalationPolicy: gateConfig.escalation_policy
              }),
              metadata: {
                gate: 'builtin_merge_approval_gate',
                risk_tier: riskTier,
                required_approvals: gateConfig.required_approvals,
                approved,
                escalation_policy: gateConfig.escalation_policy,
                approval_chain: approvals
              }
            };
          }
        }

        return {
          allow: true,
          metadata: {
            gate: 'builtin_merge_approval_gate',
            risk_tier: riskTier,
            required_approvals: gateConfig.required_approvals,
            approved,
            escalation_policy: gateConfig.escalation_policy,
            approval_chain: approvals
          }
        };
      }
    });
  }
}
