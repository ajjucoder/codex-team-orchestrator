import type { ToolServerLike } from './types.js';
import {
  hasAgentTeamsTrigger,
  extractObjectiveFromPrompt,
  inferTaskSizeFromPrompt,
  REQUIRED_TRIGGER_PHRASE
} from '../trigger.js';

const HARD_MAX_THREADS = 6;
const ROLE_SEQUENCE = ['implementer', 'reviewer', 'planner', 'tester', 'researcher', 'lead'] as const;

type TaskSize = 'small' | 'medium' | 'high';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readOptionalNumber(input: Record<string, unknown>, key: string): number | null {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : null;
}

function readTaskSize(input: Record<string, unknown>, prompt: string): TaskSize {
  const value = readString(input, 'task_size');
  if (value === 'small' || value === 'medium' || value === 'high') {
    return value;
  }
  return inferTaskSizeFromPrompt(prompt);
}

function defaultEstimatedParallelTasks(taskSize: TaskSize): number {
  if (taskSize === 'small') return 2;
  if (taskSize === 'medium') return 4;
  return 6;
}

function fallbackRecommendedThreads(taskSize: TaskSize, teamMaxThreads: number): number {
  const base = defaultEstimatedParallelTasks(taskSize);
  return clamp(base, 1, Math.min(Number(teamMaxThreads ?? HARD_MAX_THREADS), HARD_MAX_THREADS));
}

function rolesForThreadCount(count: number): string[] {
  const bounded = clamp(Number(count || 1), 1, HARD_MAX_THREADS);
  return ROLE_SEQUENCE.slice(0, bounded);
}

function readTokenSoftLimit(policy: Record<string, unknown>): number {
  const budgets = policy.budgets;
  if (!budgets || typeof budgets !== 'object') return 12000;
  const tokenSoftLimit = Number((budgets as Record<string, unknown>).token_soft_limit);
  return Number.isFinite(tokenSoftLimit) ? tokenSoftLimit : 12000;
}

export function registerTriggerTools(server: ToolServerLike): void {
  server.registerTool('team_trigger', 'team_trigger.schema.json', (input) => {
    const prompt = readString(input, 'prompt');
    const triggered = hasAgentTeamsTrigger(prompt);
    if (!triggered) {
      return {
        ok: true,
        triggered: false,
        reason: `missing trigger phrase: ${REQUIRED_TRIGGER_PHRASE}`
      };
    }

    if (!server.tools?.has('team_start')) {
      return {
        ok: false,
        triggered: true,
        error: 'team_start must be registered before team_trigger'
      };
    }

    const objective = extractObjectiveFromPrompt(prompt);
    const startInput: Record<string, unknown> = {
      objective,
      profile: readOptionalString(input, 'profile') ?? 'default'
    };
    const maxThreads = readOptionalNumber(input, 'max_threads');
    if (maxThreads !== null) {
      startInput.max_threads = maxThreads;
    }

    const started = server.callTool('team_start', startInput, {
      active_session_model: readOptionalString(input, 'active_session_model')
    });
    if (!started.ok) {
      return {
        ok: false,
        triggered: true,
        error: String(started.error ?? 'team_start failed')
      };
    }

    const team = started.team;
    if (!team || typeof team !== 'object') {
      return { ok: false, triggered: true, error: 'team_start returned invalid team payload' };
    }

    const teamRecord = team as Record<string, unknown>;
    const teamId = typeof teamRecord.team_id === 'string' ? teamRecord.team_id : '';
    const canonicalTeam = teamId ? server.store.getTeam(teamId) : null;
    const taskSize = readTaskSize(input, prompt);
    const autoSpawnEnabled = readBoolean(input, 'auto_spawn', true);
    const policy = canonicalTeam ? (server.policyEngine?.resolveTeamPolicy(canonicalTeam) ?? {}) : {};
    const teamMaxThreads = Number(canonicalTeam?.max_threads ?? teamRecord.max_threads ?? HARD_MAX_THREADS);
    const estimatedParallelTasks = readOptionalNumber(input, 'estimated_parallel_tasks') ?? defaultEstimatedParallelTasks(taskSize);
    const budgetTokensRemaining = readOptionalNumber(input, 'budget_tokens_remaining') ?? readTokenSoftLimit(policy);
    const plannedRoleHints = rolesForThreadCount(
      Math.min(estimatedParallelTasks, Number(teamMaxThreads ?? HARD_MAX_THREADS))
    );

    let recommendedThreads = fallbackRecommendedThreads(taskSize, teamMaxThreads);
    const spawnErrors: string[] = [];
    const spawnedAgents: Array<Record<string, unknown>> = [];
    let budgetController: Record<string, unknown> | null = null;
    let spawnStrategy = 'static_sequence';
    let plannedRoles = rolesForThreadCount(recommendedThreads);

    if (server.tools?.has('team_plan_fanout')) {
      const fanoutInput: Record<string, unknown> = {
        team_id: teamId,
        task_size: taskSize,
        estimated_parallel_tasks: estimatedParallelTasks,
        budget_tokens_remaining: budgetTokensRemaining,
        planned_roles: plannedRoleHints
      };
      const tokenCost = readOptionalNumber(input, 'token_cost_per_agent');
      if (tokenCost !== null && tokenCost > 0) {
        fanoutInput.token_cost_per_agent = tokenCost;
      }

      const plan = server.callTool('team_plan_fanout', fanoutInput);
      if (plan.ok) {
        budgetController = (plan.budget_controller && typeof plan.budget_controller === 'object')
          ? plan.budget_controller as Record<string, unknown>
          : null;
        const recommendation = (
          plan.recommendation && typeof plan.recommendation === 'object'
            ? plan.recommendation as Record<string, unknown>
            : {}
        );
        recommendedThreads = clamp(
          Number(recommendation.recommended_threads ?? recommendedThreads),
          1,
          Math.min(Number(teamMaxThreads ?? HARD_MAX_THREADS), HARD_MAX_THREADS)
        );
        plannedRoles = rolesForThreadCount(recommendedThreads);
      } else {
        spawnErrors.push(String(plan.error ?? 'team_plan_fanout failed'));
      }
    }

    if (autoSpawnEnabled) {
      if (!server.tools?.has('team_spawn')) {
        spawnErrors.push('team_spawn not registered; auto-spawn skipped');
      } else {
        let usedReadyRoleSpawn = false;
        if (server.tools.has('team_spawn_ready_roles') && server.tools.has('team_task_next')) {
          const roleShaped = server.callTool('team_spawn_ready_roles', {
            team_id: teamId,
            max_new_agents: recommendedThreads
          });
          if (roleShaped.ok) {
            const roleCandidates = Array.isArray(roleShaped.role_candidates)
              ? roleShaped.role_candidates.map((role: unknown) => String(role))
              : [];
            if (roleCandidates.length > 0) {
              usedReadyRoleSpawn = true;
              spawnStrategy = 'dag_ready_roles';
              plannedRoles = roleCandidates;
              const spawnedFromReady = Array.isArray(roleShaped.spawned_agents)
                ? roleShaped.spawned_agents
                : [];
              for (const spawned of spawnedFromReady) {
                if (spawned && typeof spawned === 'object') {
                  spawnedAgents.push(spawned as Record<string, unknown>);
                }
              }
              const readyErrors = Array.isArray(roleShaped.errors)
                ? roleShaped.errors.map((error: unknown) => String(error))
                : [];
              for (const error of readyErrors) {
                spawnErrors.push(error);
              }
            }
          } else {
            spawnErrors.push(String(roleShaped.error ?? 'team_spawn_ready_roles failed'));
          }
        }

        if (!usedReadyRoleSpawn) {
          plannedRoles = rolesForThreadCount(recommendedThreads);
          spawnStrategy = 'static_sequence';
          for (const role of plannedRoles) {
            const spawned = server.callTool('team_spawn', { team_id: teamId, role });
            if (spawned.ok && spawned.agent && typeof spawned.agent === 'object') {
              spawnedAgents.push(spawned.agent as Record<string, unknown>);
            } else {
              spawnErrors.push(String(spawned.error ?? `failed to spawn role: ${role}`));
            }
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
        spawn_strategy: spawnStrategy,
        planned_roles: plannedRoles,
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
