import { recommendFanout } from '../fanout-controller.js';

export function registerFanoutTools(server) {
  server.registerTool('team_plan_fanout', 'team_plan_fanout.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    const policy = server.policyEngine.resolveTeamPolicy(team);
    const recommendation = recommendFanout({
      policy,
      task_size: input.task_size,
      estimated_parallel_tasks: input.estimated_parallel_tasks,
      budget_tokens_remaining: input.budget_tokens_remaining,
      token_cost_per_agent: input.token_cost_per_agent,
      team_max_threads: team.max_threads
    });

    return {
      ok: true,
      team_id: team.team_id,
      profile: team.profile,
      task_size: input.task_size,
      recommendation
    };
  });
}
