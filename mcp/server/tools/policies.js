export function registerPolicyTools(server) {
  server.registerTool('team_policy_get', 'team_policy_get.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    const policy = server.policyEngine.resolveTeamPolicy(team);
    return {
      ok: true,
      profile: team.profile,
      policy
    };
  });

  server.registerTool('team_policy_set_profile', 'team_policy_set_profile.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    const profile = server.policyEngine.loadProfile(input.profile);
    const maxThreads = Math.min(
      Number(profile?.limits?.default_max_threads ?? team.max_threads),
      Number(profile?.limits?.hard_max_threads ?? 6),
      6
    );

    const updated = server.store.updateTeamProfile(input.team_id, input.profile, maxThreads);
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
