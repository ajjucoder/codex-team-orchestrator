import type { ToolServerLike } from './types.js';

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readPolicyLimit(policy: Record<string, unknown>, key: string, fallback: number): number {
  const limits = policy.limits;
  if (!limits || typeof limits !== 'object') return fallback;
  const value = (limits as Record<string, unknown>)[key];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function registerPolicyTools(server: ToolServerLike): void {
  server.registerTool('team_policy_get', 'team_policy_get.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    const policy = server.policyEngine?.resolveTeamPolicy(team) ?? {};
    return {
      ok: true,
      profile: team.profile,
      policy
    };
  });

  server.registerTool('team_policy_set_profile', 'team_policy_set_profile.schema.json', (input) => {
    const teamId = readString(input, 'team_id');
    const profileName = readString(input, 'profile');
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    if (!profileName) {
      return { ok: false, error: 'profile is required' };
    }

    const profile = server.policyEngine?.loadProfile(profileName) ?? {};
    const maxThreads = Math.min(
      readPolicyLimit(profile, 'default_max_threads', team.max_threads),
      readPolicyLimit(profile, 'hard_max_threads', 6),
      6
    );

    const updated = server.store.updateTeamProfile(teamId, profileName, maxThreads);
    if (!updated) {
      return { ok: false, error: `team not found: ${teamId}` };
    }
    return {
      ok: true,
      team: {
        team_id: updated.team_id,
        profile: updated.profile,
        max_threads: updated.max_threads
      },
      policy: profile
    };
  });
}
