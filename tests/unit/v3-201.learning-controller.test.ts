import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLearningRecommendations } from '../../mcp/server/learning-controller.js';

test('V3-201 unit: learning controller emits confidence-scored reversible recommendations', () => {
  const samples = [
    { ticket_id: 'CTO-P0-001', risk_tier: 'P0', recommended_threads: 3, actual_threads: 4, latency_ms: 180000, quality_score: 0.93, success: true },
    { ticket_id: 'CTO-P0-002', risk_tier: 'P0', recommended_threads: 3, actual_threads: 4, latency_ms: 175000, quality_score: 0.92, success: true },
    { ticket_id: 'CTO-P1-010', risk_tier: 'P1', recommended_threads: 2, actual_threads: 3, latency_ms: 120000, quality_score: 0.9, success: true },
    { ticket_id: 'CTO-P1-011', risk_tier: 'P1', recommended_threads: 2, actual_threads: 3, latency_ms: 110000, quality_score: 0.89, success: true }
  ] as const;

  const output = deriveLearningRecommendations(samples as any, {
    confidence_threshold: 0.7,
    allow_auto_apply: true,
    approval_required_for_high_risk: true
  });

  assert.equal(output.recommendation_count > 0, true);
  assert.equal(output.recommendations.every((rec) => typeof rec.confidence === 'number'), true);
  assert.equal(output.recommendations.every((rec) => typeof rec.reversible_patch === 'object'), true);
  assert.equal(output.auto_apply_allowed, false);
  assert.match(output.blocked_auto_apply_reasons.join(','), /high_risk_recommendations_require_approval/);
});
