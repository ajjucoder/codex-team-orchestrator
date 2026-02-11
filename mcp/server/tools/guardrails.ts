import type { ToolServerLike } from './types.js';
import { evaluateCommandPolicy, evaluateEarlyStop, evaluateIdleTeams } from '../guardrails.js';
import { evaluateGuardrailMergeGate } from '../../runtime/merge-coordinator.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const numeric = Number(input[key]);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function registerGuardrailTools(server: ToolServerLike): void {
  server.registerTool('team_guardrail_check', 'team_guardrail_check.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    const earlyStop = evaluateEarlyStop({
      policy,
      consensus_reached: readBoolean(input, 'consensus_reached', false),
      open_tasks: readNumber(input, 'open_tasks', 0)
    });

    const guardrails = policy.guardrails;
    const compactMessages = (
      guardrails &&
      typeof guardrails === 'object' &&
      typeof (guardrails as Record<string, unknown>).compact_messages === 'boolean'
    )
      ? Boolean((guardrails as Record<string, unknown>).compact_messages)
      : true;
    const mergeGate = evaluateGuardrailMergeGate({
      team_id: teamId,
      consensus_reached: readBoolean(input, 'consensus_reached', false),
      open_tasks: readNumber(input, 'open_tasks', 0),
      early_stop_should_stop: earlyStop.should_stop,
      early_stop_reason: earlyStop.reason
    });

    server.store.logEvent({
      team_id: teamId,
      event_type: 'guardrail_gate_decision',
      payload: mergeGate.event_payload
    });

    const proposedCommand = readOptionalString(input, 'proposed_command');
    const actorRole = readOptionalString(input, 'actor_role') ?? 'unknown';
    const mode = readOptionalString(input, 'mode') ?? String(team.mode ?? 'default');
    const commandDecision = proposedCommand
      ? evaluateCommandPolicy({
        policy,
        role: actorRole,
        mode,
        command: proposedCommand
      })
      : null;

    if (commandDecision && !commandDecision.allowed) {
      server.store.logEvent({
        team_id: teamId,
        event_type: 'security_policy_block',
        payload: {
          actor_role: actorRole,
          mode,
          command_rule: commandDecision.matched_rule,
          deny_reason: commandDecision.deny_reason,
          escalation_policy: commandDecision.escalation_policy
        }
      });
    }

    return {
      ok: true,
      compact_messages: compactMessages,
      early_stop: earlyStop,
      merge_gate: mergeGate.gate,
      command_policy: commandDecision
    };
  });

  server.registerTool('team_idle_sweep', 'team_idle_sweep.schema.json', (input) => {
    const nowIso = readString(input, 'now_iso');
    const parsedNow = nowIso ? Date.parse(nowIso) : Date.now();
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
    const activeTeams = server.store.listActiveTeams();

    const stale = evaluateIdleTeams({
      teams: activeTeams,
      policyByProfile: (profile) => server.policyEngine?.loadProfile(profile),
      nowMs
    });

    for (const team of stale) {
      server.store.updateTeamStatus(team.team_id, 'finalized');
      server.store.logEvent({
        team_id: team.team_id,
        event_type: 'idle_shutdown',
        payload: {
          idle_ms: team.idle_ms,
          idle_threshold_ms: team.idle_threshold_ms
        }
      });
    }

    return {
      ok: true,
      finalized_count: stale.length,
      finalized_teams: stale
    };
  });
}
