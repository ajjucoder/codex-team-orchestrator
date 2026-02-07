import {
  hasAgentTeamsTrigger,
  extractObjectiveFromPrompt,
  inferTaskSizeFromPrompt,
  REQUIRED_TRIGGER_PHRASE
} from '../trigger.js';

const HARD_MAX_THREADS = 6;
const ROLE_SEQUENCE = ['implementer', 'reviewer', 'planner', 'tester', 'researcher', 'lead'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function defaultEstimatedParallelTasks(taskSize) {
  if (taskSize === 'small') return 2;
  if (taskSize === 'medium') return 4;
  return 6;
}

function fallbackRecommendedThreads(taskSize, teamMaxThreads) {
  const base = defaultEstimatedParallelTasks(taskSize);
  return clamp(base, 1, Math.min(Number(teamMaxThreads ?? HARD_MAX_THREADS), HARD_MAX_THREADS));
}

function rolesForThreadCount(count) {
  const bounded = clamp(Number(count || 1), 1, HARD_MAX_THREADS);
  return ROLE_SEQUENCE.slice(0, bounded);
}

export function registerTriggerTools(server) {
  server.registerTool('team_trigger', 'team_trigger.schema.json', (input) => {
    const triggered = hasAgentTeamsTrigger(input.prompt);
    if (!triggered) {
      return {
        ok: true,
        triggered: false,
        reason: `missing trigger phrase: ${REQUIRED_TRIGGER_PHRASE}`
      };
    }

    if (!server.tools.has('team_start')) {
      return {
        ok: false,
        triggered: true,
        error: 'team_start must be registered before team_trigger'
      };
    }

    const objective = extractObjectiveFromPrompt(input.prompt);
    const startInput = {
      objective,
      profile: input.profile ?? 'default'
    };
    if (input.max_threads !== undefined) {
      startInput.max_threads = input.max_threads;
    }

    const started = server.callTool('team_start', startInput, {
      active_session_model: input.active_session_model ?? null
    });
    if (!started.ok) {
      return {
        ok: false,
        triggered: true,
        error: started.error ?? 'team_start failed'
      };
    }

    const taskSize = input.task_size ?? inferTaskSizeFromPrompt(input.prompt);
    const autoSpawnEnabled = input.auto_spawn ?? true;
    const team = started.team;
    const policy = server.policyEngine?.resolveTeamPolicy(team);
    const estimatedParallelTasks = input.estimated_parallel_tasks ?? defaultEstimatedParallelTasks(taskSize);
    const budgetTokensRemaining = input.budget_tokens_remaining ??
      Number(policy?.budgets?.token_soft_limit ?? 12000);
    const plannedRoles = rolesForThreadCount(
      Math.min(estimatedParallelTasks, Number(team.max_threads ?? HARD_MAX_THREADS))
    );

    let recommendedThreads = fallbackRecommendedThreads(taskSize, team.max_threads);
    const spawnErrors = [];
    const spawnedAgents = [];
    let budgetController = null;

    if (server.tools.has('team_plan_fanout')) {
      const fanoutInput = {
        team_id: team.team_id,
        task_size: taskSize,
        estimated_parallel_tasks: estimatedParallelTasks,
        budget_tokens_remaining: budgetTokensRemaining,
        planned_roles: plannedRoles
      };
      if (Number.isFinite(input.token_cost_per_agent) && input.token_cost_per_agent > 0) {
        fanoutInput.token_cost_per_agent = Number(input.token_cost_per_agent);
      }

      const plan = server.callTool('team_plan_fanout', fanoutInput);
      if (plan.ok) {
        budgetController = plan.budget_controller ?? null;
        recommendedThreads = clamp(
          Number(plan.recommendation?.recommended_threads ?? recommendedThreads),
          1,
          Math.min(Number(team.max_threads ?? HARD_MAX_THREADS), HARD_MAX_THREADS)
        );
      } else {
        spawnErrors.push(plan.error ?? 'team_plan_fanout failed');
      }
    }

    if (autoSpawnEnabled) {
      if (!server.tools.has('team_spawn')) {
        spawnErrors.push('team_spawn not registered; auto-spawn skipped');
      } else {
        for (const role of rolesForThreadCount(recommendedThreads)) {
          const spawned = server.callTool('team_spawn', { team_id: team.team_id, role });
          if (spawned.ok && spawned.agent) {
            spawnedAgents.push(spawned.agent);
          } else {
            spawnErrors.push(spawned.error ?? `failed to spawn role: ${role}`);
          }
        }
      }
    }

    return {
      ok: true,
      triggered: true,
      trigger_phrase: REQUIRED_TRIGGER_PHRASE,
      team,
      orchestration: {
        task_size: taskSize,
        auto_spawn_enabled: autoSpawnEnabled,
        estimated_parallel_tasks: estimatedParallelTasks,
        recommended_threads: recommendedThreads,
        hard_cap: HARD_MAX_THREADS,
        budget_controller: budgetController,
        spawned_count: spawnedAgents.length,
        spawned_agents: spawnedAgents.map((agent) => ({
          agent_id: agent.agent_id,
          role: agent.role,
          model: agent.model
        })),
        errors: spawnErrors
      }
    };
  });
}
