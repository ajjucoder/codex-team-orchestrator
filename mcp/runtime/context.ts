import {
  estimateBudgetPressure,
  type BudgetPressureSignal
} from '../server/usage-estimator.js';

const TEAM_STREAM_ID = 'team';
const DEFAULT_SOFT_LIMIT_TOKENS = 12000;
const DEFAULT_HARD_LIMIT_TOKENS = 16000;
const MAX_CHECKPOINT_HISTORY = 20;

export interface RuntimeContextIdentity {
  team_id: string;
  worker_id?: string | null;
}

export interface RuntimeContextCheckpoint {
  artifact_id: string;
  version: number;
  checksum: string;
  created_at: string;
}

export interface RuntimeContextBudgetState {
  consumed_tokens: number;
  soft_limit_tokens: number;
  hard_limit_tokens: number;
  compact_count: number;
  reset_count: number;
  last_compacted_at: string | null;
  last_reset_at: string | null;
}

export interface RuntimeContextStreamSnapshot {
  key: string;
  team_id: string;
  worker_id: string | null;
  stream_id: string;
  budget: RuntimeContextBudgetState;
  checkpoint: RuntimeContextCheckpoint | null;
  checkpoint_history: RuntimeContextCheckpoint[];
  pressure: BudgetPressureSignal;
}

export interface RuntimeContextUsageInput extends RuntimeContextIdentity {
  estimated_tokens: number;
  projected_additional_tokens?: number;
  soft_limit_tokens?: number;
  hard_limit_tokens?: number;
}

export interface RuntimeContextSetBudgetInput extends RuntimeContextIdentity {
  consumed_tokens: number;
  projected_additional_tokens?: number;
  soft_limit_tokens?: number;
  hard_limit_tokens?: number;
}

export interface RuntimeContextCheckpointInput extends RuntimeContextIdentity {
  checkpoint: RuntimeContextCheckpoint;
}

export interface RuntimeContextCompactionInput extends RuntimeContextIdentity {
  consumed_tokens_after: number;
  compacted_at?: string;
}

export interface RuntimeContextResetInput extends RuntimeContextIdentity {
  reset_at?: string;
  checkpoint?: RuntimeContextCheckpoint;
}

export interface RuntimeContextManagerOptions {
  default_soft_limit_tokens?: number;
  default_hard_limit_tokens?: number;
}

export interface RuntimeContextHydrateInput extends RuntimeContextIdentity {
  stream_metadata: Record<string, unknown>;
}

interface RuntimeContextStreamState {
  key: string;
  team_id: string;
  worker_id: string | null;
  stream_id: string;
  budget: RuntimeContextBudgetState;
  checkpoint: RuntimeContextCheckpoint | null;
  checkpoint_history: RuntimeContextCheckpoint[];
}

function clampToInt(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeWorkerId(workerId: string | null | undefined): string | null {
  if (typeof workerId !== 'string') return null;
  const trimmed = workerId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLimitPair(softLimit: number, hardLimit: number): { soft: number; hard: number } {
  const hard = Math.max(1, clampToInt(hardLimit, DEFAULT_HARD_LIMIT_TOKENS));
  const softCandidate = clampToInt(softLimit, DEFAULT_SOFT_LIMIT_TOKENS);
  return {
    soft: Math.max(1, Math.min(softCandidate, hard)),
    hard
  };
}

function cloneCheckpoint(checkpoint: RuntimeContextCheckpoint): RuntimeContextCheckpoint {
  return {
    artifact_id: String(checkpoint.artifact_id),
    version: clampToInt(checkpoint.version, 1),
    checksum: String(checkpoint.checksum),
    created_at: String(checkpoint.created_at)
  };
}

function parseCheckpoint(value: unknown): RuntimeContextCheckpoint | null {
  const record = asRecord(value);
  const artifactId = String(record.artifact_id ?? '').trim();
  const checksum = String(record.checksum ?? '').trim();
  const createdAt = String(record.created_at ?? '').trim();
  const version = clampToInt(Number(record.version), 0);
  if (!artifactId || !checksum || !createdAt || version < 1) {
    return null;
  }
  return {
    artifact_id: artifactId,
    version,
    checksum,
    created_at: createdAt
  };
}

function readTeamId(teamId: string): string {
  const trimmed = String(teamId ?? '').trim();
  if (!trimmed) {
    throw new Error('team_id is required for runtime context');
  }
  return trimmed;
}

export function toContextStreamId(workerId?: string | null): string {
  const normalizedWorker = normalizeWorkerId(workerId);
  return normalizedWorker ? `worker:${normalizedWorker}` : TEAM_STREAM_ID;
}

export function toRuntimeContextKey(teamId: string, workerId?: string | null): string {
  const streamId = toContextStreamId(workerId);
  return `${readTeamId(teamId)}::${streamId}`;
}

export class RuntimeContextManager {
  private readonly streams = new Map<string, RuntimeContextStreamState>();
  private readonly defaultSoftLimitTokens: number;
  private readonly defaultHardLimitTokens: number;

  constructor(options: RuntimeContextManagerOptions = {}) {
    const { soft, hard } = normalizeLimitPair(
      clampToInt(options.default_soft_limit_tokens ?? DEFAULT_SOFT_LIMIT_TOKENS, DEFAULT_SOFT_LIMIT_TOKENS),
      clampToInt(options.default_hard_limit_tokens ?? DEFAULT_HARD_LIMIT_TOKENS, DEFAULT_HARD_LIMIT_TOKENS)
    );
    this.defaultSoftLimitTokens = soft;
    this.defaultHardLimitTokens = hard;
  }

  recordUsage(input: RuntimeContextUsageInput): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(input);
    this.applyLimitOverrides(stream, input.soft_limit_tokens, input.hard_limit_tokens);
    stream.budget.consumed_tokens += clampToInt(input.estimated_tokens, 0);
    return this.snapshot(stream, clampToInt(input.projected_additional_tokens ?? 0, 0));
  }

  setConsumedTokens(input: RuntimeContextSetBudgetInput): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(input);
    this.applyLimitOverrides(stream, input.soft_limit_tokens, input.hard_limit_tokens);
    stream.budget.consumed_tokens = clampToInt(input.consumed_tokens, stream.budget.consumed_tokens);
    return this.snapshot(stream, clampToInt(input.projected_additional_tokens ?? 0, 0));
  }

  registerCheckpoint(input: RuntimeContextCheckpointInput): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(input);
    const checkpoint = cloneCheckpoint(input.checkpoint);
    const last = stream.checkpoint_history[stream.checkpoint_history.length - 1];
    if (!last || last.artifact_id !== checkpoint.artifact_id || last.version !== checkpoint.version) {
      stream.checkpoint_history.push(checkpoint);
      if (stream.checkpoint_history.length > MAX_CHECKPOINT_HISTORY) {
        stream.checkpoint_history = stream.checkpoint_history.slice(
          stream.checkpoint_history.length - MAX_CHECKPOINT_HISTORY
        );
      }
    } else {
      stream.checkpoint_history[stream.checkpoint_history.length - 1] = checkpoint;
    }
    stream.checkpoint = checkpoint;
    return this.snapshot(stream);
  }

  markCompacted(input: RuntimeContextCompactionInput): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(input);
    stream.budget.consumed_tokens = clampToInt(input.consumed_tokens_after, stream.budget.consumed_tokens);
    stream.budget.compact_count += 1;
    stream.budget.last_compacted_at = input.compacted_at ?? new Date().toISOString();
    return this.snapshot(stream);
  }

  markReset(input: RuntimeContextResetInput): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(input);
    stream.budget.reset_count += 1;
    stream.budget.last_reset_at = input.reset_at ?? new Date().toISOString();
    if (input.checkpoint) {
      stream.checkpoint = cloneCheckpoint(input.checkpoint);
    }
    return this.snapshot(stream);
  }

  getSnapshot(identity: RuntimeContextIdentity): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(identity);
    return this.snapshot(stream);
  }

  listTeamSnapshots(teamId: string): RuntimeContextStreamSnapshot[] {
    const targetTeamId = readTeamId(teamId);
    return Array.from(this.streams.values())
      .filter((stream) => stream.team_id === targetTeamId)
      .map((stream) => this.snapshot(stream));
  }

  hydrateStream(input: RuntimeContextHydrateInput): RuntimeContextStreamSnapshot {
    const stream = this.ensureStream(input);
    const metadata = asRecord(input.stream_metadata);
    const budget = asRecord(metadata.budget);
    if (Object.keys(budget).length > 0) {
      stream.budget.consumed_tokens = clampToInt(
        Number(budget.consumed_tokens),
        stream.budget.consumed_tokens
      );
      const currentSoft = stream.budget.soft_limit_tokens;
      const currentHard = stream.budget.hard_limit_tokens;
      const nextSoftCandidate = clampToInt(
        Number(budget.soft_limit_tokens),
        currentSoft
      );
      const nextHardCandidate = clampToInt(
        Number(budget.hard_limit_tokens),
        currentHard
      );
      const normalized = normalizeLimitPair(nextSoftCandidate, nextHardCandidate);
      stream.budget.soft_limit_tokens = normalized.soft;
      stream.budget.hard_limit_tokens = normalized.hard;
      stream.budget.compact_count = clampToInt(
        Number(budget.compact_count),
        stream.budget.compact_count
      );
      stream.budget.reset_count = clampToInt(
        Number(budget.reset_count),
        stream.budget.reset_count
      );

      const compactedAt = String(budget.last_compacted_at ?? '').trim();
      if (compactedAt.length > 0) {
        stream.budget.last_compacted_at = compactedAt;
      }
      const resetAt = String(budget.last_reset_at ?? '').trim();
      if (resetAt.length > 0) {
        stream.budget.last_reset_at = resetAt;
      }
    }

    const checkpoint = parseCheckpoint(metadata.context_checkpoint);
    if (checkpoint) {
      stream.checkpoint = checkpoint;
      const historyCheckpoint = stream.checkpoint_history.find((entry) => (
        entry.artifact_id === checkpoint.artifact_id
        && entry.version === checkpoint.version
      ));
      if (!historyCheckpoint) {
        stream.checkpoint_history.push(checkpoint);
        if (stream.checkpoint_history.length > MAX_CHECKPOINT_HISTORY) {
          stream.checkpoint_history = stream.checkpoint_history.slice(
            stream.checkpoint_history.length - MAX_CHECKPOINT_HISTORY
          );
        }
      }
    }

    return this.snapshot(stream);
  }

  private ensureStream(identity: RuntimeContextIdentity): RuntimeContextStreamState {
    const teamId = readTeamId(identity.team_id);
    const workerId = normalizeWorkerId(identity.worker_id);
    const streamId = toContextStreamId(workerId);
    const key = `${teamId}::${streamId}`;
    const existing = this.streams.get(key);
    if (existing) {
      return existing;
    }

    const created: RuntimeContextStreamState = {
      key,
      team_id: teamId,
      worker_id: workerId,
      stream_id: streamId,
      budget: {
        consumed_tokens: 0,
        soft_limit_tokens: this.defaultSoftLimitTokens,
        hard_limit_tokens: this.defaultHardLimitTokens,
        compact_count: 0,
        reset_count: 0,
        last_compacted_at: null,
        last_reset_at: null
      },
      checkpoint: null,
      checkpoint_history: []
    };
    this.streams.set(key, created);
    return created;
  }

  private applyLimitOverrides(
    stream: RuntimeContextStreamState,
    softLimit?: number,
    hardLimit?: number
  ): void {
    if (!Number.isFinite(softLimit ?? NaN) && !Number.isFinite(hardLimit ?? NaN)) {
      return;
    }
    const nextSoftCandidate = Number.isFinite(softLimit ?? NaN)
      ? clampToInt(softLimit as number, stream.budget.soft_limit_tokens)
      : stream.budget.soft_limit_tokens;
    const nextHardCandidate = Number.isFinite(hardLimit ?? NaN)
      ? clampToInt(hardLimit as number, stream.budget.hard_limit_tokens)
      : stream.budget.hard_limit_tokens;
    const normalized = normalizeLimitPair(nextSoftCandidate, nextHardCandidate);
    stream.budget.soft_limit_tokens = normalized.soft;
    stream.budget.hard_limit_tokens = normalized.hard;
  }

  private snapshot(stream: RuntimeContextStreamState, projectedAdditionalTokens = 0): RuntimeContextStreamSnapshot {
    const pressure = estimateBudgetPressure({
      consumed_tokens: stream.budget.consumed_tokens,
      projected_additional_tokens: projectedAdditionalTokens,
      soft_limit_tokens: stream.budget.soft_limit_tokens,
      hard_limit_tokens: stream.budget.hard_limit_tokens
    });

    return {
      key: stream.key,
      team_id: stream.team_id,
      worker_id: stream.worker_id,
      stream_id: stream.stream_id,
      budget: {
        consumed_tokens: stream.budget.consumed_tokens,
        soft_limit_tokens: stream.budget.soft_limit_tokens,
        hard_limit_tokens: stream.budget.hard_limit_tokens,
        compact_count: stream.budget.compact_count,
        reset_count: stream.budget.reset_count,
        last_compacted_at: stream.budget.last_compacted_at,
        last_reset_at: stream.budget.last_reset_at
      },
      checkpoint: stream.checkpoint ? cloneCheckpoint(stream.checkpoint) : null,
      checkpoint_history: stream.checkpoint_history.map(cloneCheckpoint),
      pressure
    };
  }
}
