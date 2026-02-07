export interface RoleDefinition {
  name: string;
  objective: string;
  outputs: string[];
}

export const ROLE_PACK_V1: Record<string, RoleDefinition> = {
  lead: {
    name: 'lead',
    objective: 'Own orchestration decisions, arbitration fallback, and completion quality gate.',
    outputs: ['execution_plan', 'assignment_decisions', 'final_acceptance_report']
  },
  planner: {
    name: 'planner',
    objective: 'Decompose goals into executable tickets and dependency-safe sequencing.',
    outputs: ['task_breakdown', 'dependency_map', 'risk_register']
  },
  implementer: {
    name: 'implementer',
    objective: 'Implement code changes and produce patch artifacts.',
    outputs: ['code_patch', 'implementation_notes']
  },
  reviewer: {
    name: 'reviewer',
    objective: 'Evaluate correctness, regression risk, and policy compliance.',
    outputs: ['review_findings', 'merge_recommendation']
  },
  tester: {
    name: 'tester',
    objective: 'Design and execute verification suites and summarize evidence.',
    outputs: ['test_results', 'coverage_gaps']
  },
  researcher: {
    name: 'researcher',
    objective: 'Gather targeted evidence and produce concise references for implementation.',
    outputs: ['research_summary', 'source_artifact_refs']
  }
};

export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_PACK_V1));

export function isKnownRole(role: string): boolean {
  return ROLE_NAMES.includes(role);
}
