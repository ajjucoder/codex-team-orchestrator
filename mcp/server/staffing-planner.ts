const HARD_MAX_THREADS = 6;

export type TaskSize = 'small' | 'medium' | 'high';
export type StaffingDomain =
  | 'general'
  | 'frontend'
  | 'backend'
  | 'data'
  | 'infra'
  | 'security';

export interface SpecialistMetadata {
  role: string;
  domain: StaffingDomain;
  specialist_handle: string;
  specialist_domain: StaffingDomain;
  spawn_reason: string;
  specialization: string;
  focus: string;
  template_id: string;
  priority: number;
}

export interface StaffingPlanInput {
  objective: string;
  task_size: TaskSize;
  max_threads: number;
  estimated_parallel_tasks?: number;
  preferred_threads?: number;
}

export interface StaffingPlan {
  template_id: string;
  domain: StaffingDomain;
  recommended_threads: number;
  hard_cap: 6;
  planned_roles: string[];
  specialists: SpecialistMetadata[];
  dynamic_expansion: {
    base_threads: number;
    estimated_parallel_tasks: number;
    signal_boost: number;
    bounded_max: number;
  };
  model_routing: {
    default_backend: string;
    role_backends: Record<string, string>;
  };
  reasons: string[];
}

interface DomainTemplate {
  domain: StaffingDomain;
  template_id: string;
  keywords: string[];
  role_sequence: string[];
  specialists: Record<string, Omit<
    SpecialistMetadata,
    'role' | 'domain' | 'template_id' | 'priority' | 'specialist_handle' | 'specialist_domain' | 'spawn_reason'
  >>;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function countKeywordHits(text: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

function baseThreadsForTaskSize(taskSize: TaskSize): number {
  if (taskSize === 'high') return 6;
  if (taskSize === 'medium') return 4;
  return 2;
}

const DOMAIN_TEMPLATES: DomainTemplate[] = [
  {
    domain: 'frontend',
    template_id: 'tpl_frontend_v1',
    keywords: ['frontend', 'ui', 'ux', 'react', 'component', 'css', 'tailwind', 'accessibility'],
    role_sequence: ['implementer', 'reviewer', 'tester', 'planner', 'researcher', 'lead'],
    specialists: {
      implementer: {
        specialization: 'frontend_implementer',
        focus: 'Ship user-facing components and interaction polish.'
      },
      reviewer: {
        specialization: 'ui_quality_reviewer',
        focus: 'Catch regressions in layout, usability, and code quality.'
      },
      tester: {
        specialization: 'ui_test_engineer',
        focus: 'Validate interaction, accessibility, and responsive behavior.'
      },
      planner: {
        specialization: 'frontlog_planner',
        focus: 'Sequence frontend tickets and integration dependencies.'
      },
      researcher: {
        specialization: 'design_researcher',
        focus: 'Collect framework and implementation references.'
      },
      lead: {
        specialization: 'frontend_orchestration_lead',
        focus: 'Coordinate execution checkpoints and release readiness.'
      }
    }
  },
  {
    domain: 'backend',
    template_id: 'tpl_backend_v1',
    keywords: ['backend', 'api', 'service', 'endpoint', 'database', 'orm', 'cache', 'queue'],
    role_sequence: ['implementer', 'reviewer', 'planner', 'tester', 'researcher', 'lead'],
    specialists: {
      implementer: {
        specialization: 'service_implementer',
        focus: 'Implement service logic and integration-safe changes.'
      },
      reviewer: {
        specialization: 'api_reviewer',
        focus: 'Review correctness, compatibility, and failure handling.'
      },
      planner: {
        specialization: 'backend_planner',
        focus: 'Coordinate migrations, contracts, and dependency order.'
      },
      tester: {
        specialization: 'backend_test_engineer',
        focus: 'Run unit/integration validation for service boundaries.'
      },
      researcher: {
        specialization: 'system_researcher',
        focus: 'Gather protocol, data, and integration references.'
      },
      lead: {
        specialization: 'backend_orchestration_lead',
        focus: 'Drive sequencing and acceptance for backend delivery.'
      }
    }
  },
  {
    domain: 'data',
    template_id: 'tpl_data_v1',
    keywords: ['data', 'pipeline', 'etl', 'warehouse', 'analytics', 'batch', 'schema', 'sql'],
    role_sequence: ['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'lead'],
    specialists: {
      planner: {
        specialization: 'data_planner',
        focus: 'Define lineage-safe rollout and dependency constraints.'
      },
      implementer: {
        specialization: 'pipeline_implementer',
        focus: 'Implement transformations, checks, and data contracts.'
      },
      reviewer: {
        specialization: 'data_quality_reviewer',
        focus: 'Review correctness of schema and transformation semantics.'
      },
      tester: {
        specialization: 'data_validation_tester',
        focus: 'Validate sample outputs, integrity, and drift checks.'
      },
      researcher: {
        specialization: 'data_researcher',
        focus: 'Collect reference specs and migration guardrails.'
      },
      lead: {
        specialization: 'data_orchestration_lead',
        focus: 'Coordinate cross-stream dependencies and cutover readiness.'
      }
    }
  },
  {
    domain: 'infra',
    template_id: 'tpl_infra_v1',
    keywords: ['infra', 'infrastructure', 'kubernetes', 'terraform', 'deploy', 'ci', 'cd', 'ops', 'sre'],
    role_sequence: ['implementer', 'tester', 'reviewer', 'planner', 'researcher', 'lead'],
    specialists: {
      implementer: {
        specialization: 'platform_implementer',
        focus: 'Apply infra changes with rollout safety.'
      },
      tester: {
        specialization: 'ops_validation_tester',
        focus: 'Validate rollout health checks and recovery paths.'
      },
      reviewer: {
        specialization: 'infra_reviewer',
        focus: 'Review reliability, blast radius, and rollback readiness.'
      },
      planner: {
        specialization: 'rollout_planner',
        focus: 'Sequence deployment phases and environment gates.'
      },
      researcher: {
        specialization: 'infra_researcher',
        focus: 'Gather provider-specific constraints and best practices.'
      },
      lead: {
        specialization: 'infra_orchestration_lead',
        focus: 'Coordinate release windows and cross-team handoffs.'
      }
    }
  },
  {
    domain: 'security',
    template_id: 'tpl_security_v1',
    keywords: ['security', 'auth', 'permission', 'vulnerability', 'threat', 'secret', 'compliance', 'hardening'],
    role_sequence: ['reviewer', 'tester', 'implementer', 'planner', 'researcher', 'lead'],
    specialists: {
      reviewer: {
        specialization: 'security_reviewer',
        focus: 'Evaluate risks, policies, and exploitability.'
      },
      tester: {
        specialization: 'security_tester',
        focus: 'Execute adversarial and regression checks.'
      },
      implementer: {
        specialization: 'hardening_implementer',
        focus: 'Implement secure defaults and remediations.'
      },
      planner: {
        specialization: 'security_planner',
        focus: 'Prioritize fixes by blast radius and compliance impact.'
      },
      researcher: {
        specialization: 'threat_researcher',
        focus: 'Collect threat intel and mitigation references.'
      },
      lead: {
        specialization: 'security_orchestration_lead',
        focus: 'Own security sign-off and remediation tracking.'
      }
    }
  },
  {
    domain: 'general',
    template_id: 'tpl_general_v1',
    keywords: [],
    role_sequence: ['implementer', 'reviewer', 'planner', 'tester', 'researcher', 'lead'],
    specialists: {
      implementer: {
        specialization: 'general_implementer',
        focus: 'Implement scoped changes across owned files.'
      },
      reviewer: {
        specialization: 'general_reviewer',
        focus: 'Review quality, regressions, and policy compliance.'
      },
      planner: {
        specialization: 'general_planner',
        focus: 'Sequence tickets and dependency-safe execution steps.'
      },
      tester: {
        specialization: 'general_tester',
        focus: 'Validate behavior with targeted tests and checks.'
      },
      researcher: {
        specialization: 'general_researcher',
        focus: 'Gather concise references and implementation evidence.'
      },
      lead: {
        specialization: 'general_orchestration_lead',
        focus: 'Coordinate delivery and acceptance quality gates.'
      }
    }
  }
];

const DYNAMIC_EXPANSION_SIGNALS = [
  'migration',
  'refactor',
  'parallel',
  'across',
  'multi-file',
  'end-to-end',
  'e2e',
  'incident',
  'hotfix',
  'rollout'
];

const ROLE_HANDLE_SUFFIX: Record<string, string> = {
  implementer: 'dev',
  reviewer: 'review',
  tester: 'qa',
  planner: 'planner',
  researcher: 'research',
  lead: 'lead'
};

function toSlugToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSpecialistHandle(domain: StaffingDomain, role: string): string {
  const domainToken = toSlugToken(domain) || 'general';
  const roleToken = toSlugToken(ROLE_HANDLE_SUFFIX[role] ?? role) || 'worker';
  return `@${domainToken}-${roleToken}`;
}

function buildSpawnReason(role: string, domain: StaffingDomain, templateId: string): string {
  return `role ${role} selected by ${templateId} template for ${domain} objective`;
}

function pickTemplate(objective: string): { template: DomainTemplate; score: number } {
  const normalized = normalizedText(objective);
  let selected = DOMAIN_TEMPLATES[0];
  let selectedScore = -1;

  for (const template of DOMAIN_TEMPLATES) {
    const score = countKeywordHits(normalized, template.keywords);
    if (score > selectedScore) {
      selected = template;
      selectedScore = score;
      continue;
    }
    if (score === selectedScore && selected.template_id !== 'tpl_general_v1' && template.template_id === 'tpl_general_v1') {
      continue;
    }
  }

  if (selectedScore <= 0) {
    const fallback = DOMAIN_TEMPLATES.find((template) => template.domain === 'general') ?? DOMAIN_TEMPLATES[DOMAIN_TEMPLATES.length - 1];
    return {
      template: fallback,
      score: 0
    };
  }

  return {
    template: selected,
    score: selectedScore
  };
}

function dynamicSignalBoost(objective: string): number {
  const normalized = normalizedText(objective);
  const hits = countKeywordHits(normalized, DYNAMIC_EXPANSION_SIGNALS);
  if (hits >= 5) return 2;
  if (hits >= 2) return 1;
  return 0;
}

function toThreadBound(maxThreads: number): number {
  const candidate = Math.floor(Number(maxThreads));
  if (!Number.isFinite(candidate)) return HARD_MAX_THREADS;
  return clamp(candidate, 1, HARD_MAX_THREADS);
}

function fallbackSpecialist(role: string, domain: StaffingDomain, templateId: string, priority: number): SpecialistMetadata {
  return {
    role,
    domain,
    specialist_handle: buildSpecialistHandle(domain, role),
    specialist_domain: domain,
    spawn_reason: buildSpawnReason(role, domain, templateId),
    template_id: templateId,
    specialization: `${domain}_${role}`,
    focus: `Execute ${role} responsibilities for ${domain} domain scope.`,
    priority
  };
}

function defaultBackendForDomain(domain: StaffingDomain): string {
  if (domain === 'frontend') return 'opencode';
  if (domain === 'security') return 'claude';
  return 'codex';
}

function backendForRole(role: string, domain: StaffingDomain, defaultBackend: string): string {
  if (role === 'reviewer' || role === 'researcher') {
    return domain === 'frontend' ? 'opencode' : 'claude';
  }
  if (domain === 'frontend' && role === 'implementer') {
    return 'opencode';
  }
  return defaultBackend;
}

export function buildStaffingPlan(input: StaffingPlanInput): StaffingPlan {
  const boundedMax = toThreadBound(input.max_threads);
  const baseThreads = clamp(baseThreadsForTaskSize(input.task_size), 1, boundedMax);
  const estimatedParallelTasks = clamp(
    Math.floor(Number(input.estimated_parallel_tasks ?? baseThreads)),
    1,
    HARD_MAX_THREADS
  );
  const signalBoost = dynamicSignalBoost(input.objective);
  const dynamicTarget = clamp(
    Math.max(baseThreads, estimatedParallelTasks + signalBoost),
    1,
    boundedMax
  );

  const preferredThreads = Number(input.preferred_threads);
  const recommendedThreads = Number.isFinite(preferredThreads)
    ? clamp(Math.floor(preferredThreads), 1, boundedMax)
    : dynamicTarget;

  const picked = pickTemplate(input.objective);
  const plannedRoles = picked.template.role_sequence.slice(0, recommendedThreads);
  const specialists = plannedRoles.map((role, index) => {
    const specialist = picked.template.specialists[role];
    if (!specialist) {
      return fallbackSpecialist(role, picked.template.domain, picked.template.template_id, index + 1);
    }

    return {
      role,
      domain: picked.template.domain,
      specialist_handle: buildSpecialistHandle(picked.template.domain, role),
      specialist_domain: picked.template.domain,
      spawn_reason: buildSpawnReason(role, picked.template.domain, picked.template.template_id),
      template_id: picked.template.template_id,
      specialization: specialist.specialization,
      focus: specialist.focus,
      priority: index + 1
    } satisfies SpecialistMetadata;
  });
  const defaultBackend = defaultBackendForDomain(picked.template.domain);
  const roleBackends: Record<string, string> = {};
  for (const role of plannedRoles) {
    if (!roleBackends[role]) {
      roleBackends[role] = backendForRole(role, picked.template.domain, defaultBackend);
    }
  }

  const reasons = [`domain template selected: ${picked.template.domain}`];
  if (picked.score > 0) {
    reasons.push(`template keyword hits: ${picked.score}`);
  }
  if (signalBoost > 0) {
    reasons.push(`dynamic expansion boost: +${signalBoost}`);
  }
  if (Number.isFinite(preferredThreads)) {
    reasons.push('preferred thread count enforced');
  }
  reasons.push(`routing backend default: ${defaultBackend}`);

  return {
    template_id: picked.template.template_id,
    domain: picked.template.domain,
    recommended_threads: recommendedThreads,
    hard_cap: HARD_MAX_THREADS,
    planned_roles: plannedRoles,
    specialists,
    dynamic_expansion: {
      base_threads: baseThreads,
      estimated_parallel_tasks: estimatedParallelTasks,
      signal_boost: signalBoost,
      bounded_max: boundedMax
    },
    model_routing: {
      default_backend: defaultBackend,
      role_backends: roleBackends
    },
    reasons
  };
}
