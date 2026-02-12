import type { ToolServerLike } from './types.js';
import {
  hasAgentTeamsTrigger,
  extractObjectiveFromPrompt,
  inferTaskSizeFromPrompt,
  REQUIRED_TRIGGER_PHRASE
} from '../trigger.js';
import { buildStaffingPlan, type SpecialistMetadata, type TaskSize } from '../staffing-planner.js';
import {
  DEFAULT_PARALLEL_GATE_THRESHOLDS,
  evaluateParallelGate,
  type ParallelGateThresholds
} from '../parallel-gate.js';

const HARD_MAX_THREADS = 6;

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

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

function toBoundedThreads(value: number): number {
  return clamp(Math.floor(Number(value)), 1, HARD_MAX_THREADS);
}

function readTokenSoftLimit(policy: Record<string, unknown>): number {
  const budgets = policy.budgets;
  if (!budgets || typeof budgets !== 'object') return 12000;
  const tokenSoftLimit = Number((budgets as Record<string, unknown>).token_soft_limit);
  return Number.isFinite(tokenSoftLimit) ? tokenSoftLimit : 12000;
}

function readProfileLimits(policy: Record<string, unknown>): { default_max_threads: number; hard_max_threads: number } {
  const limits = readRecord(policy.limits);
  const defaultMaxThreads = Number(limits.default_max_threads);
  const hardMaxThreads = Number(limits.hard_max_threads);
  return {
    default_max_threads: Number.isFinite(defaultMaxThreads) ? defaultMaxThreads : 4,
    hard_max_threads: Number.isFinite(hardMaxThreads) ? hardMaxThreads : HARD_MAX_THREADS
  };
}

function readParallelGateThresholds(policy: Record<string, unknown>): ParallelGateThresholds {
  const triggerPolicy = readRecord(policy.trigger);
  const strictParallelGate = typeof triggerPolicy.strict_parallel_gate === 'boolean'
    ? triggerPolicy.strict_parallel_gate
    : DEFAULT_PARALLEL_GATE_THRESHOLDS.strict_parallel_gate;
  const minThreadsForTeam = Number(triggerPolicy.min_threads_for_team);
  const minParallelSignals = Number(triggerPolicy.min_parallel_signals);
  const maxSequentialSignals = Number(triggerPolicy.max_sequential_signals);
  return {
    strict_parallel_gate: strictParallelGate,
    min_threads_for_team: clamp(
      Number.isFinite(minThreadsForTeam) ? Math.floor(minThreadsForTeam) : DEFAULT_PARALLEL_GATE_THRESHOLDS.min_threads_for_team,
      1,
      HARD_MAX_THREADS
    ),
    min_parallel_signals: Math.max(
      0,
      Number.isFinite(minParallelSignals)
        ? Math.floor(minParallelSignals)
        : DEFAULT_PARALLEL_GATE_THRESHOLDS.min_parallel_signals
    ),
    max_sequential_signals: Math.max(
      0,
      Number.isFinite(maxSequentialSignals)
        ? Math.floor(maxSequentialSignals)
        : DEFAULT_PARALLEL_GATE_THRESHOLDS.max_sequential_signals
    )
  };
}

function readProfilePolicy(server: ToolServerLike, profileName: string): Record<string, unknown> {
  try {
    return server.policyEngine?.loadProfile(profileName) ?? {};
  } catch {
    return {};
  }
}

function readTeamMaxThreadsFromProfile(
  requestedMaxThreads: number | null,
  policy: Record<string, unknown>
): number {
  const limits = readProfileLimits(policy);
  return toBoundedThreads(
    Math.min(
      requestedMaxThreads ?? limits.default_max_threads,
      limits.hard_max_threads,
      HARD_MAX_THREADS
    )
  );
}

function buildFallbackMessage(reasonCode: string): string {
  if (reasonCode === 'not_parallelizable_sequential_signals') {
    return 'Agent teams is not suitable here because the task looks sequential. Continue in normal mode for better output quality.';
  }
  return 'Agent teams is not suitable here because parallel work is insufficient. Continue in normal mode for better output quality.';
}

function specialistByRole(specialists: SpecialistMetadata[]): Map<string, SpecialistMetadata> {
  const map = new Map<string, SpecialistMetadata>();
  for (const specialist of specialists) {
    if (!map.has(specialist.role)) {
      map.set(specialist.role, specialist);
    }
  }
  return map;
}

function toHandleToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fallbackSpecialistHandle(domain: string, role: string): string {
  const domainToken = toHandleToken(domain) || 'general';
  const roleToken = toHandleToken(role) || 'worker';
  return `@${domainToken}-${roleToken}`;
}

function fallbackSpecialistForRole(
  role: string,
  domain: SpecialistMetadata['domain'],
  templateId: string,
  priority: number
): SpecialistMetadata {
  return {
    role,
    domain,
    specialist_handle: fallbackSpecialistHandle(domain, role),
    specialist_domain: domain,
    spawn_reason: `fallback specialist mapping for role ${role} in ${domain}`,
    template_id: templateId,
    specialization: `${domain}_${role}`,
    focus: `Execute ${role} responsibilities for ${domain} scope.`,
    priority
  };
}

function specialistForRole(
  role: string,
  priority: number,
  roleMap: Map<string, SpecialistMetadata>,
  plan: ReturnType<typeof buildStaffingPlan>
): SpecialistMetadata {
  const specialist = roleMap.get(role);
  if (!specialist) {
    return fallbackSpecialistForRole(role, plan.domain, plan.template_id, priority);
  }
  return {
    ...specialist,
    priority
  };
}

function persistSpecialistMetadata(
  server: ToolServerLike,
  agentId: string,
  specialist: SpecialistMetadata,
  errors: string[]
): void {
  const updated = server.store.updateAgentMetadata(agentId, {
    specialist_handle: specialist.specialist_handle,
    specialist_domain: specialist.specialist_domain,
    spawn_reason: specialist.spawn_reason
  });
  if (!updated) {
    errors.push(`failed to persist specialist metadata for agent: ${agentId}`);
  }
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

    const profileName = readOptionalString(input, 'profile') ?? 'default';
    const objective = extractObjectiveFromPrompt(prompt);
    const taskSize = readTaskSize(input, prompt);
    const autoSpawnEnabled = readBoolean(input, 'auto_spawn', true);
    const profilePolicy = readProfilePolicy(server, profileName);
    const requestedMaxThreads = readOptionalNumber(input, 'max_threads');
    const teamMaxThreadsPreflight = readTeamMaxThreadsFromProfile(requestedMaxThreads, profilePolicy);
    const estimatedParallelTasks = toBoundedThreads(
      readOptionalNumber(input, 'estimated_parallel_tasks') ?? defaultEstimatedParallelTasks(taskSize)
    );
    const preflightStaffingPlan = buildStaffingPlan({
      objective,
      task_size: taskSize,
      max_threads: teamMaxThreadsPreflight,
      estimated_parallel_tasks: estimatedParallelTasks
    });
    const parallelGate = evaluateParallelGate(
      {
        objective,
        task_size: taskSize,
        estimated_parallel_tasks: estimatedParallelTasks,
        recommended_threads: preflightStaffingPlan.recommended_threads
      },
      readParallelGateThresholds(profilePolicy)
    );
    server.store.logEvent({
      event_type: 'team_trigger_parallel_gate',
      payload: {
        profile: profileName,
        objective,
        task_size: taskSize,
        ...parallelGate
      }
    });
    if (!parallelGate.passed) {
      const message = buildFallbackMessage(parallelGate.reason_code);
      server.store.logEvent({
        event_type: 'team_trigger_routed_normal_mode',
        payload: {
          profile: profileName,
          reason_code: parallelGate.reason_code,
          objective,
          task_size: taskSize
        }
      });
      return {
        ok: true,
        triggered: true,
        accepted: false,
        route: 'normal_mode',
        trigger_phrase: REQUIRED_TRIGGER_PHRASE,
        parallel_gate: parallelGate,
        recommendation: {
          message,
          suggested_mode: 'default',
          objective
        },
        orchestration: {
          task_size: taskSize,
          auto_spawn_enabled: false,
          estimated_parallel_tasks: estimatedParallelTasks,
          recommended_threads: preflightStaffingPlan.recommended_threads,
          hard_cap: HARD_MAX_THREADS,
          spawn_strategy: 'none',
          planned_roles: [],
          staffing_planner: {
            template_id: preflightStaffingPlan.template_id,
            domain: preflightStaffingPlan.domain,
            recommended_threads: preflightStaffingPlan.recommended_threads,
            planned_roles: preflightStaffingPlan.planned_roles,
            specialists: preflightStaffingPlan.specialists,
            dynamic_expansion: preflightStaffingPlan.dynamic_expansion,
            reasons: preflightStaffingPlan.reasons
          },
          budget_controller: null,
          spawned_count: 0,
          spawned_agents: [],
          errors: [message]
        }
      };
    }

    const startInput: Record<string, unknown> = {
      objective,
      profile: profileName
    };
    if (requestedMaxThreads !== null) {
      startInput.max_threads = requestedMaxThreads;
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
    let canonicalTeam = teamId ? server.store.getTeam(teamId) : null;
    const policy = canonicalTeam ? (server.policyEngine?.resolveTeamPolicy(canonicalTeam) ?? {}) : {};
    const teamMaxThreads = toBoundedThreads(
      Number(canonicalTeam?.max_threads ?? teamRecord.max_threads ?? HARD_MAX_THREADS)
    );
    const budgetTokensRemaining = readOptionalNumber(input, 'budget_tokens_remaining') ?? readTokenSoftLimit(policy);
    let staffingPlan = buildStaffingPlan({
      objective,
      task_size: taskSize,
      max_threads: teamMaxThreads,
      estimated_parallel_tasks: estimatedParallelTasks
    });
    let roleSpecialistMap = specialistByRole(staffingPlan.specialists);
    let recommendedThreads = staffingPlan.recommended_threads;
    let plannerPlannedRoles = [...staffingPlan.planned_roles];
    const spawnErrors: string[] = [];
    const spawnedAgents: Array<Record<string, unknown>> = [];
    let budgetController: Record<string, unknown> | null = null;
    let spawnStrategy = 'static_sequence';
    let plannedRoles = [...plannerPlannedRoles];
    const spawnedSpecialistAssignments: Record<string, SpecialistMetadata> = {};

    if (server.tools?.has('team_plan_fanout')) {
      const fanoutInput: Record<string, unknown> = {
        team_id: teamId,
        task_size: taskSize,
        estimated_parallel_tasks: estimatedParallelTasks,
        budget_tokens_remaining: budgetTokensRemaining,
        planned_roles: plannerPlannedRoles
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
          Math.min(teamMaxThreads, HARD_MAX_THREADS)
        );
        staffingPlan = buildStaffingPlan({
          objective,
          task_size: taskSize,
          max_threads: teamMaxThreads,
          estimated_parallel_tasks: estimatedParallelTasks,
          preferred_threads: recommendedThreads
        });
        roleSpecialistMap = specialistByRole(staffingPlan.specialists);
        plannerPlannedRoles = [...staffingPlan.planned_roles];
        plannedRoles = [...plannerPlannedRoles];
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
              plannedRoles = roleCandidates.slice(0, HARD_MAX_THREADS);
              const spawnedFromReady = Array.isArray(roleShaped.spawned_agents)
                ? roleShaped.spawned_agents
                : [];
              let spawnedPriority = 1;
              for (const spawned of spawnedFromReady) {
                if (spawned && typeof spawned === 'object') {
                  const spawnedRecord = spawned as Record<string, unknown>;
                  const role = typeof spawnedRecord.role === 'string'
                    ? spawnedRecord.role
                    : plannedRoles[Math.max(0, spawnedPriority - 1)] ?? 'implementer';
                  const specialist = specialistForRole(
                    role,
                    spawnedPriority,
                    roleSpecialistMap,
                    staffingPlan
                  );
                  spawnedPriority += 1;
                  const annotated = {
                    ...spawnedRecord,
                    specialist
                  };
                  spawnedAgents.push(annotated);
                  const agentId = typeof spawnedRecord.agent_id === 'string' ? spawnedRecord.agent_id : '';
                  if (agentId) {
                    spawnedSpecialistAssignments[agentId] = specialist;
                    persistSpecialistMetadata(server, agentId, specialist, spawnErrors);
                  }
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
          plannedRoles = plannerPlannedRoles.slice(0, recommendedThreads);
          spawnStrategy = 'static_sequence';
          let spawnedPriority = 1;
          for (const role of plannedRoles) {
            const spawned = server.callTool('team_spawn', { team_id: teamId, role });
            if (spawned.ok && spawned.agent && typeof spawned.agent === 'object') {
              const specialist = specialistForRole(
                role,
                spawnedPriority,
                roleSpecialistMap,
                staffingPlan
              );
              spawnedPriority += 1;
              const agentRecord = spawned.agent as Record<string, unknown>;
              const annotatedAgent = {
                ...agentRecord,
                specialist
              };
              spawnedAgents.push(annotatedAgent);
              const agentId = typeof agentRecord.agent_id === 'string' ? agentRecord.agent_id : '';
              if (agentId) {
                spawnedSpecialistAssignments[agentId] = specialist;
                persistSpecialistMetadata(server, agentId, specialist, spawnErrors);
              }
            } else {
              spawnErrors.push(String(spawned.error ?? `failed to spawn role: ${role}`));
            }
          }
        }
      }
    }

    if (teamId) {
      const existingAssignments = readRecord(canonicalTeam?.metadata?.specialist_assignments);
      const mergedAssignments = {
        ...existingAssignments,
        ...spawnedSpecialistAssignments
      };
      const metadataPatch: Record<string, unknown> = {
        staffing_plan: {
          template_id: staffingPlan.template_id,
          domain: staffingPlan.domain,
          task_size: taskSize,
          recommended_threads: recommendedThreads,
          planned_roles: plannerPlannedRoles,
          reasons: staffingPlan.reasons,
          dynamic_expansion: staffingPlan.dynamic_expansion,
          updated_at: new Date().toISOString()
        }
      };
      if (Object.keys(mergedAssignments).length > 0) {
        metadataPatch.specialist_assignments = mergedAssignments;
      }
      const updated = server.store.updateTeamMetadata(teamId, metadataPatch);
      if (updated) {
        canonicalTeam = updated;
      }
    }

    return {
      ok: true,
      triggered: true,
      accepted: true,
      route: 'agent_teams',
      trigger_phrase: REQUIRED_TRIGGER_PHRASE,
      parallel_gate: parallelGate,
      team,
      orchestration: {
        task_size: taskSize,
        auto_spawn_enabled: autoSpawnEnabled,
        estimated_parallel_tasks: estimatedParallelTasks,
        recommended_threads: recommendedThreads,
        hard_cap: HARD_MAX_THREADS,
        spawn_strategy: spawnStrategy,
        planned_roles: plannedRoles,
        staffing_planner: {
          template_id: staffingPlan.template_id,
          domain: staffingPlan.domain,
          recommended_threads: staffingPlan.recommended_threads,
          planned_roles: plannerPlannedRoles,
          specialists: staffingPlan.specialists,
          dynamic_expansion: staffingPlan.dynamic_expansion,
          reasons: staffingPlan.reasons
        },
        budget_controller: budgetController,
        spawned_count: spawnedAgents.length,
        spawned_agents: spawnedAgents.map((agent) => ({
          agent_id: agent.agent_id,
          role: agent.role,
          model: agent.model,
          specialist: readRecord(agent.specialist)
        })),
        errors: spawnErrors
      }
    };
  });
}
