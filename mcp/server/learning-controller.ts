type RiskTier = 'P0' | 'P1' | 'P2';

export interface LearningSample {
  ticket_id: string;
  risk_tier: RiskTier;
  recommended_threads: number;
  actual_threads: number;
  latency_ms: number;
  quality_score: number;
  success: boolean;
}

export interface LearningConfig {
  confidence_threshold?: number;
  allow_auto_apply?: boolean;
  approval_required_for_high_risk?: boolean;
}

export interface LearningRecommendation {
  recommendation_id: string;
  target: string;
  rationale: string;
  confidence: number;
  reversible_patch: Record<string, unknown>;
  requires_approval: boolean;
}

export interface LearningOutput {
  recommendation_count: number;
  recommendations: LearningRecommendation[];
  auto_apply_allowed: boolean;
  blocked_auto_apply_reasons: string[];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function confidenceFromSpread(values: number[]): number {
  if (values.length <= 1) return 0.55;
  const mean = average(values);
  if (mean <= 0) return 0.5;
  const variance = average(values.map((value) => (value - mean) ** 2));
  const stddev = Math.sqrt(variance);
  return clamp(1 - (stddev / mean), 0.45, 0.99);
}

function groupByRisk(samples: LearningSample[]): Record<RiskTier, LearningSample[]> {
  return {
    P0: samples.filter((sample) => sample.risk_tier === 'P0'),
    P1: samples.filter((sample) => sample.risk_tier === 'P1'),
    P2: samples.filter((sample) => sample.risk_tier === 'P2')
  };
}

export function deriveLearningRecommendations(samples: LearningSample[], config: LearningConfig = {}): LearningOutput {
  const confidenceThreshold = clamp(Number(config.confidence_threshold ?? 0.72), 0.5, 0.99);
  const grouped = groupByRisk(samples);
  const recommendations: LearningRecommendation[] = [];

  for (const riskTier of ['P0', 'P1', 'P2'] as const) {
    const bucket = grouped[riskTier];
    if (bucket.length === 0) continue;

    const successRate = average(bucket.map((sample) => (sample.success ? 1 : 0)));
    const quality = average(bucket.map((sample) => sample.quality_score));
    const threadDelta = average(bucket.map((sample) => sample.actual_threads - sample.recommended_threads));
    const confidence = confidenceFromSpread(bucket.map((sample) => sample.latency_ms));

    const boundedConfidence = Number(confidence.toFixed(3));
    const suggestedThreadAdjustment = threadDelta >= 0.75 ? 1 : (threadDelta <= -0.75 ? -1 : 0);
    if (suggestedThreadAdjustment !== 0 && boundedConfidence >= confidenceThreshold) {
      recommendations.push({
        recommendation_id: `learn.${riskTier}.threads`,
        target: `fanout.by_risk_tier.${riskTier}`,
        rationale: `observed thread delta ${threadDelta.toFixed(2)} across ${bucket.length} samples`,
        confidence: boundedConfidence,
        reversible_patch: {
          op: 'adjust_threads',
          risk_tier: riskTier,
          delta: suggestedThreadAdjustment
        },
        requires_approval: riskTier === 'P0'
      });
    }

    if (quality < 0.92 && boundedConfidence >= confidenceThreshold) {
      recommendations.push({
        recommendation_id: `learn.${riskTier}.quality_floor`,
        target: `optimizer.quality_floor.${riskTier}`,
        rationale: `quality floor drift detected (avg=${quality.toFixed(3)}, success_rate=${successRate.toFixed(3)})`,
        confidence: boundedConfidence,
        reversible_patch: {
          op: 'raise_quality_floor',
          risk_tier: riskTier,
          min_floor: Number(Math.min(0.98, Math.max(0.75, quality + 0.04)).toFixed(2))
        },
        requires_approval: riskTier !== 'P2'
      });
    }
  }

  const blockedAutoApplyReasons: string[] = [];
  const allowAutoApply = config.allow_auto_apply === true;
  const requireApprovalForHighRisk = config.approval_required_for_high_risk !== false;
  if (!allowAutoApply) {
    blockedAutoApplyReasons.push('auto_apply_disabled');
  }
  if (requireApprovalForHighRisk && recommendations.some((rec) => rec.requires_approval)) {
    blockedAutoApplyReasons.push('high_risk_recommendations_require_approval');
  }

  return {
    recommendation_count: recommendations.length,
    recommendations,
    auto_apply_allowed: blockedAutoApplyReasons.length === 0,
    blocked_auto_apply_reasons: blockedAutoApplyReasons
  };
}
