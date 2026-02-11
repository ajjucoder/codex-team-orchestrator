import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeExecutionPlan } from '../../mcp/server/budget-controller.js';

test('V3-105 unit: optimizer preserves quality floor when selecting thread count', () => {
  const plan = optimizeExecutionPlan({
    task_size: 'high',
    recommended_threads: 3,
    estimated_parallel_tasks: 5,
    token_cost_per_agent: 900,
    budget_tokens_remaining: 3500,
    policy: {
      budgets: { token_soft_limit: 3500 },
      optimizer: { latency_slo_ms: 220000, quality_floor: 0.85 }
    }
  });

  assert.equal(plan.optimized_threads >= 1 && plan.optimized_threads <= 6, true);
  assert.equal(plan.constraints.token_budget, 3500);
  assert.equal(plan.constraints.quality_floor, 0.85);
  assert.equal(plan.estimates.quality_score >= 0.85, true);
  assert.equal(typeof plan.meets_slo.cost, 'boolean');
});

test('V3-105 unit: optimizer returns deterministic best tradeoff under tight budgets', () => {
  const plan = optimizeExecutionPlan({
    task_size: 'medium',
    recommended_threads: 6,
    estimated_parallel_tasks: 6,
    token_cost_per_agent: 1500,
    budget_tokens_remaining: 3000,
    policy: {
      budgets: { token_soft_limit: 3000 },
      optimizer: { latency_slo_ms: 100000, quality_floor: 0.7 }
    }
  });

  assert.equal(plan.optimized_threads > 0, true);
  assert.equal(plan.optimized_threads <= 6, true);
  assert.equal(['meets_all_slo', 'best_tradeoff_under_constraints'].includes(plan.reason), true);
});

test('V3-105 unit: optimizer uses runtime budget as upper bound for token budget and thread scoring', () => {
  const constrained = optimizeExecutionPlan({
    task_size: 'medium',
    recommended_threads: 6,
    estimated_parallel_tasks: 6,
    token_cost_per_agent: 1000,
    budget_tokens_remaining: 2500,
    policy: {
      budgets: { token_soft_limit: 5000 },
      optimizer: { latency_slo_ms: 300000, quality_floor: 0.6 }
    }
  });
  const unconstrained = optimizeExecutionPlan({
    task_size: 'medium',
    recommended_threads: 6,
    estimated_parallel_tasks: 6,
    token_cost_per_agent: 1000,
    budget_tokens_remaining: 5000,
    policy: {
      budgets: { token_soft_limit: 5000 },
      optimizer: { latency_slo_ms: 300000, quality_floor: 0.6 }
    }
  });

  assert.equal(constrained.constraints.token_budget, 2500);
  assert.equal(unconstrained.constraints.token_budget, 5000);
  assert.equal(constrained.meets_slo.cost, false);
  assert.equal(unconstrained.meets_slo.cost, true);
  assert.equal(constrained.reason, 'best_tradeoff_under_constraints');
  assert.equal(unconstrained.reason, 'meets_all_slo');
});
