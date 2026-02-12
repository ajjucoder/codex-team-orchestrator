import type { TaskSize } from './staffing-planner.js';

export interface ParallelGateThresholds {
  strict_parallel_gate: boolean;
  min_threads_for_team: number;
  min_parallel_signals: number;
  max_sequential_signals: number;
}

export interface ParallelGateInput {
  objective: string;
  task_size: TaskSize;
  estimated_parallel_tasks: number;
  recommended_threads: number;
}

export interface ParallelGateDecision {
  passed: boolean;
  reason_code:
    | 'parallelizable'
    | 'parallelizable_policy_disabled'
    | 'not_parallelizable_low_parallelism'
    | 'not_parallelizable_sequential_signals';
  estimated_parallel_tasks: number;
  recommended_threads: number;
  parallel_signal_count: number;
  sequential_signal_count: number;
  thresholds: ParallelGateThresholds;
}

const PARALLEL_SIGNALS = [
  'parallel',
  'independent',
  'across',
  'multi-file',
  'multiple',
  'workstream',
  'streams',
  'modules',
  'services',
  'migration'
];

const SEQUENTIAL_SIGNALS = [
  'small',
  'quick',
  'typo',
  'single file',
  'one file',
  'rename',
  'minor',
  'simple fix'
];

export const DEFAULT_PARALLEL_GATE_THRESHOLDS: ParallelGateThresholds = {
  strict_parallel_gate: true,
  min_threads_for_team: 2,
  min_parallel_signals: 1,
  max_sequential_signals: 0
};

function countSignalHits(text: string, signals: string[]): number {
  const normalized = text.toLowerCase();
  let count = 0;
  for (const signal of signals) {
    if (normalized.includes(signal)) {
      count += 1;
    }
  }
  return count;
}

export function evaluateParallelGate(
  input: ParallelGateInput,
  thresholds: ParallelGateThresholds = DEFAULT_PARALLEL_GATE_THRESHOLDS
): ParallelGateDecision {
  const parallelSignalCount = countSignalHits(input.objective, PARALLEL_SIGNALS);
  const sequentialSignalCount = countSignalHits(input.objective, SEQUENTIAL_SIGNALS);

  if (!thresholds.strict_parallel_gate) {
    return {
      passed: true,
      reason_code: 'parallelizable_policy_disabled',
      estimated_parallel_tasks: input.estimated_parallel_tasks,
      recommended_threads: input.recommended_threads,
      parallel_signal_count: parallelSignalCount,
      sequential_signal_count: sequentialSignalCount,
      thresholds
    };
  }

  const lowParallelism = (
    input.estimated_parallel_tasks < thresholds.min_threads_for_team
    || input.recommended_threads < thresholds.min_threads_for_team
    || parallelSignalCount < thresholds.min_parallel_signals
  );
  if (lowParallelism) {
    return {
      passed: false,
      reason_code: 'not_parallelizable_low_parallelism',
      estimated_parallel_tasks: input.estimated_parallel_tasks,
      recommended_threads: input.recommended_threads,
      parallel_signal_count: parallelSignalCount,
      sequential_signal_count: sequentialSignalCount,
      thresholds
    };
  }

  const allowSequentialOverride = input.estimated_parallel_tasks >= 3;
  if (
    sequentialSignalCount > thresholds.max_sequential_signals
    && !allowSequentialOverride
  ) {
    return {
      passed: false,
      reason_code: 'not_parallelizable_sequential_signals',
      estimated_parallel_tasks: input.estimated_parallel_tasks,
      recommended_threads: input.recommended_threads,
      parallel_signal_count: parallelSignalCount,
      sequential_signal_count: sequentialSignalCount,
      thresholds
    };
  }

  return {
    passed: true,
    reason_code: 'parallelizable',
    estimated_parallel_tasks: input.estimated_parallel_tasks,
    recommended_threads: input.recommended_threads,
    parallel_signal_count: parallelSignalCount,
    sequential_signal_count: sequentialSignalCount,
    thresholds
  };
}
