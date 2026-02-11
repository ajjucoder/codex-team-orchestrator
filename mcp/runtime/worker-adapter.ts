export type WorkerOperation =
  | 'spawn'
  | 'send_instruction'
  | 'poll'
  | 'interrupt'
  | 'collect_artifacts';

export interface WorkerArtifactEnvelope {
  artifact_id: string;
  name?: string;
  version?: number;
  uri?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WorkerSpawnInput {
  team_id: string;
  agent_id: string;
  role: string;
  model: string | null;
  instruction?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerSpawnResult {
  worker_id: string;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerSendInstructionInput {
  worker_id: string;
  instruction: string;
  idempotency_key?: string;
  artifact_refs?: Array<{ artifact_id: string; version: number }>;
  metadata?: Record<string, unknown>;
}

export interface WorkerSendInstructionResult {
  accepted: boolean;
  instruction_id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerPollInput {
  worker_id: string;
  cursor?: string | null;
  limit?: number;
}

export interface WorkerPollResult {
  worker_id: string;
  status: string;
  cursor?: string | null;
  events?: Record<string, unknown>[];
  output?: Record<string, unknown>;
}

export interface WorkerInterruptInput {
  worker_id: string;
  reason?: string;
}

export interface WorkerInterruptResult {
  interrupted: boolean;
  status: string;
}

export interface WorkerCollectArtifactsInput {
  worker_id: string;
  limit?: number;
}

export interface WorkerCollectArtifactsResult {
  worker_id: string;
  artifacts: WorkerArtifactEnvelope[];
}

export interface WorkerProviderErrorLike {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface WorkerProvider {
  readonly name: string;
  spawn(input: WorkerSpawnInput): WorkerSpawnResult;
  sendInstruction(input: WorkerSendInstructionInput): WorkerSendInstructionResult;
  poll(input: WorkerPollInput): WorkerPollResult;
  interrupt(input: WorkerInterruptInput): WorkerInterruptResult;
  collectArtifacts(input: WorkerCollectArtifactsInput): WorkerCollectArtifactsResult;
}

export interface WorkerSuccessEnvelope<TData> {
  ok: true;
  provider: string;
  operation: WorkerOperation;
  data: TData;
}

export interface WorkerErrorDetails {
  domain: 'worker_adapter';
  provider: string;
  operation: WorkerOperation;
  code: string;
  message: string;
  retryable: boolean;
  worker_id: string | null;
  details: Record<string, unknown>;
}

export interface WorkerErrorEnvelope {
  ok: false;
  provider: string;
  operation: WorkerOperation;
  error: WorkerErrorDetails;
}

export type WorkerEnvelope<TData> = WorkerSuccessEnvelope<TData> | WorkerErrorEnvelope;

export interface NormalizeWorkerErrorInput {
  provider: string;
  operation: WorkerOperation;
  worker_id?: string | null;
  error: unknown;
}

export class WorkerProviderError extends Error implements WorkerProviderErrorLike {
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;

  constructor(message: string, options: WorkerProviderErrorLike = {}) {
    super(message);
    this.name = 'WorkerProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toErrorDetails(error: unknown): WorkerProviderErrorLike {
  if (error instanceof WorkerProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message
    };
  }
  if (isRecord(error)) {
    const details: WorkerProviderErrorLike = {};
    if (typeof error.code === 'string') details.code = error.code;
    if (typeof error.message === 'string') details.message = error.message;
    if (typeof error.retryable === 'boolean') details.retryable = error.retryable;
    if (isRecord(error.details)) details.details = error.details;
    return details;
  }
  return {
    message: String(error)
  };
}

export function normalizeWorkerError(input: NormalizeWorkerErrorInput): WorkerErrorEnvelope {
  const details = toErrorDetails(input.error);
  const code = readString(details.code, 'WORKER_PROVIDER_ERROR');
  const message = readString(details.message, 'worker provider failed');
  return {
    ok: false,
    provider: input.provider,
    operation: input.operation,
    error: {
      domain: 'worker_adapter',
      provider: input.provider,
      operation: input.operation,
      code,
      message,
      retryable: details.retryable === true,
      worker_id: input.worker_id ?? null,
      details: details.details ?? {}
    }
  };
}

export class WorkerAdapter {
  readonly provider: WorkerProvider;

  constructor(provider: WorkerProvider) {
    this.provider = provider;
  }

  spawn(input: WorkerSpawnInput): WorkerEnvelope<WorkerSpawnResult> {
    return this.invoke('spawn', null, () => this.provider.spawn(input));
  }

  sendInstruction(input: WorkerSendInstructionInput): WorkerEnvelope<WorkerSendInstructionResult> {
    return this.invoke('send_instruction', input.worker_id, () => this.provider.sendInstruction(input));
  }

  poll(input: WorkerPollInput): WorkerEnvelope<WorkerPollResult> {
    return this.invoke('poll', input.worker_id, () => this.provider.poll(input));
  }

  interrupt(input: WorkerInterruptInput): WorkerEnvelope<WorkerInterruptResult> {
    return this.invoke('interrupt', input.worker_id, () => this.provider.interrupt(input));
  }

  collectArtifacts(input: WorkerCollectArtifactsInput): WorkerEnvelope<WorkerCollectArtifactsResult> {
    return this.invoke('collect_artifacts', input.worker_id, () => this.provider.collectArtifacts(input));
  }

  private invoke<TData>(
    operation: WorkerOperation,
    workerId: string | null,
    handler: () => TData
  ): WorkerEnvelope<TData> {
    try {
      return {
        ok: true,
        provider: this.provider.name,
        operation,
        data: handler()
      };
    } catch (error) {
      return normalizeWorkerError({
        provider: this.provider.name,
        operation,
        worker_id: workerId,
        error
      });
    }
  }
}
