import type { HookContext } from './hooks.js';
import type { ToolServerLike } from './tools/types.js';

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

export function registerBuiltInPolicyHooks(server: ToolServerLike): void {
  if (!server.hookEngine) return;
  const alreadyRegistered = server.hookEngine.hooks.some((hook) => hook.name === 'builtin_quality_task_complete_gate');
  if (alreadyRegistered) return;

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
      const failures: string[] = [];

      const requireTests = readBool(quality.require_tests_before_complete, false);
      if (requireTests && hookContext.input.quality_checks_passed !== true) {
        failures.push('quality gate failed: tests must pass before completion');
      }

      const requireComplianceAck = readBool(quality.require_compliance_ack, false);
      if (requireComplianceAck && hookContext.input.compliance_ack !== true) {
        failures.push('quality gate failed: compliance acknowledgment required');
      }

      const minArtifactRefs = Math.max(0, readNumber(quality.min_artifact_refs, 0));
      const artifactRefsCount = Math.max(0, readNumber(hookContext.input.artifact_refs_count, 0));
      if (minArtifactRefs > 0 && artifactRefsCount < minArtifactRefs) {
        failures.push(`quality gate failed: artifact_refs_count ${artifactRefsCount} < required ${minArtifactRefs}`);
      }

      if (failures.length > 0) {
        return {
          allow: false,
          reason: failures.join('; '),
          metadata: {
            gate: 'builtin_quality_task_complete_gate',
            failures
          }
        };
      }

      return {
        allow: true,
        metadata: {
          gate: 'builtin_quality_task_complete_gate'
        }
      };
    }
  });
}
