import {
  WorkerAdapter,
  WorkerProviderError,
  type WorkerArtifactEnvelope,
  type WorkerCollectArtifactsInput,
  type WorkerCollectArtifactsResult,
  type WorkerInterruptInput,
  type WorkerInterruptResult,
  type WorkerPollInput,
  type WorkerPollResult,
  type WorkerProvider,
  type WorkerSendInstructionInput,
  type WorkerSendInstructionResult,
  type WorkerSpawnInput,
  type WorkerSpawnResult
} from '../worker-adapter.js';

export interface CodexTransport {
  spawn(input: WorkerSpawnInput): unknown;
  sendInstruction(input: WorkerSendInstructionInput): unknown;
  poll(input: WorkerPollInput): unknown;
  interrupt(input: WorkerInterruptInput): unknown;
  collectArtifacts(input: WorkerCollectArtifactsInput): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireBoolean(value: unknown, field: string, operation: string): boolean {
  if (typeof value !== 'boolean') {
    throw new WorkerProviderError(`codex ${operation} response missing boolean ${field}`, {
      code: 'PROVIDER_BAD_RESPONSE',
      retryable: false
    });
  }
  return value;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseWorkerId(value: unknown, operation: string): string {
  const workerId = readString(value);
  if (!workerId) {
    throw new WorkerProviderError(`codex ${operation} response missing worker_id`, {
      code: 'PROVIDER_BAD_RESPONSE',
      retryable: false
    });
  }
  return workerId;
}

function parseArtifacts(input: unknown): WorkerArtifactEnvelope[] {
  if (!Array.isArray(input)) return [];
  const artifacts: WorkerArtifactEnvelope[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    const artifactId = readString(entry.artifact_id);
    if (!artifactId) continue;
    artifacts.push({
      artifact_id: artifactId,
      name: readOptionalString(entry.name),
      version: Number.isFinite(Number(entry.version)) ? Number(entry.version) : undefined,
      uri: typeof entry.uri === 'string' ? entry.uri : null,
      metadata: isRecord(entry.metadata) ? entry.metadata : {}
    });
  }
  return artifacts;
}

export class CodexWorkerProvider implements WorkerProvider {
  readonly name = 'codex';
  readonly transport: CodexTransport;

  constructor(transport: CodexTransport) {
    this.transport = transport;
  }

  spawn(input: WorkerSpawnInput): WorkerSpawnResult {
    const raw = this.transport.spawn(input);
    if (!isRecord(raw)) {
      throw new WorkerProviderError('codex spawn response must be an object', {
        code: 'PROVIDER_BAD_RESPONSE',
        retryable: false
      });
    }

    const workerId = parseWorkerId(raw.worker_id, 'spawn');
    return {
      worker_id: workerId,
      status: readString(raw.status, 'spawned'),
      metadata: isRecord(raw.metadata) ? raw.metadata : {}
    };
  }

  sendInstruction(input: WorkerSendInstructionInput): WorkerSendInstructionResult {
    const raw = this.transport.sendInstruction(input);
    if (!isRecord(raw)) {
      throw new WorkerProviderError('codex sendInstruction response must be an object', {
        code: 'PROVIDER_BAD_RESPONSE',
        retryable: false
      });
    }

    return {
      accepted: requireBoolean(raw.accepted, 'accepted', 'sendInstruction'),
      instruction_id: readOptionalString(raw.instruction_id),
      status: readString(raw.status, 'queued'),
      metadata: isRecord(raw.metadata) ? raw.metadata : {}
    };
  }

  poll(input: WorkerPollInput): WorkerPollResult {
    const raw = this.transport.poll(input);
    if (!isRecord(raw)) {
      throw new WorkerProviderError('codex poll response must be an object', {
        code: 'PROVIDER_BAD_RESPONSE',
        retryable: false
      });
    }

    const workerId = parseWorkerId(raw.worker_id ?? input.worker_id, 'poll');
    return {
      worker_id: workerId,
      status: readString(raw.status, 'running'),
      cursor: typeof raw.cursor === 'string' ? raw.cursor : input.cursor ?? null,
      events: Array.isArray(raw.events)
        ? raw.events.filter((event): event is Record<string, unknown> => isRecord(event))
        : [],
      output: isRecord(raw.output) ? raw.output : {}
    };
  }

  interrupt(input: WorkerInterruptInput): WorkerInterruptResult {
    const raw = this.transport.interrupt(input);
    if (!isRecord(raw)) {
      throw new WorkerProviderError('codex interrupt response must be an object', {
        code: 'PROVIDER_BAD_RESPONSE',
        retryable: false
      });
    }

    return {
      interrupted: requireBoolean(raw.interrupted, 'interrupted', 'interrupt'),
      status: readString(raw.status, 'interrupted')
    };
  }

  collectArtifacts(input: WorkerCollectArtifactsInput): WorkerCollectArtifactsResult {
    const raw = this.transport.collectArtifacts(input);
    if (!isRecord(raw)) {
      throw new WorkerProviderError('codex collectArtifacts response must be an object', {
        code: 'PROVIDER_BAD_RESPONSE',
        retryable: false
      });
    }

    const workerId = parseWorkerId(raw.worker_id ?? input.worker_id, 'collectArtifacts');
    const limit = Math.max(0, Math.floor(readNumber(input.limit, 0)));
    const artifacts = parseArtifacts(raw.artifacts);

    return {
      worker_id: workerId,
      artifacts: limit > 0 ? artifacts.slice(0, limit) : artifacts
    };
  }
}

export function createCodexWorkerAdapter(transport: CodexTransport): WorkerAdapter {
  return new WorkerAdapter(new CodexWorkerProvider(transport));
}
