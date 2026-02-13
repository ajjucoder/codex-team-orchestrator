import { randomUUID } from 'node:crypto';
import { WorkerProviderError, type WorkerArtifactEnvelope, type WorkerCollectArtifactsInput, type WorkerInterruptInput, type WorkerPollInput, type WorkerSendInstructionInput, type WorkerSpawnInput } from '../worker-adapter.js';
import { decodeInstructionFrame, encodeInstructionFrame } from './tmux-transport.js';

const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;

interface HeadlessSessionState {
  worker_id: string;
  status: 'spawned' | 'running' | 'interrupted';
  events: Record<string, unknown>[];
}

export interface HeadlessTransportOptions {
  maxInstructionBytes?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeCursor(value: string | null | undefined): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function safeLimit(value: number | undefined, fallback = 20): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(200, Math.floor(numeric)));
}

export class HeadlessTransport {
  readonly maxInstructionBytes: number;
  private readonly sessionsByWorkerId: Map<string, HeadlessSessionState>;

  constructor(options: HeadlessTransportOptions = {}) {
    this.maxInstructionBytes = Math.max(1024, Number(options.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES));
    this.sessionsByWorkerId = new Map();
  }

  spawn(_input: WorkerSpawnInput): unknown {
    const workerId = `headless_${randomUUID().replace(/-/g, '')}`;
    this.sessionsByWorkerId.set(workerId, {
      worker_id: workerId,
      status: 'running',
      events: []
    });

    return {
      worker_id: workerId,
      status: 'spawned',
      metadata: {
        transport_backend: 'headless'
      }
    };
  }

  sendInstruction(input: WorkerSendInstructionInput): unknown {
    const session = this.sessionsByWorkerId.get(input.worker_id);
    if (!session) {
      throw new WorkerProviderError(`headless worker not found: ${input.worker_id}`, {
        code: 'WORKER_NOT_FOUND',
        retryable: false
      });
    }

    const encoded = encodeInstructionFrame({
      instruction: input.instruction,
      cwd: input.cwd,
      idempotency_key: input.idempotency_key,
      artifact_refs: input.artifact_refs,
      metadata: input.metadata
    }, this.maxInstructionBytes);
    const decoded = decodeInstructionFrame(encoded.frame);

    const instructionId = `headless_inst_${session.events.length + 1}`;
    session.events.push({
      type: 'instruction_received',
      instruction_id: instructionId,
      instruction: decoded.instruction,
      cwd: decoded.cwd ?? null,
      idempotency_key: decoded.idempotency_key ?? null,
      artifact_refs: decoded.artifact_refs ?? [],
      metadata: decoded.metadata ?? {},
      created_at: nowIso()
    });

    return {
      accepted: true,
      instruction_id: instructionId,
      status: 'queued',
      metadata: {
        transport_backend: 'headless',
        frame_bytes: encoded.byte_length
      }
    };
  }

  poll(input: WorkerPollInput): unknown {
    const session = this.sessionsByWorkerId.get(input.worker_id);
    if (!session) {
      throw new WorkerProviderError(`headless worker not found: ${input.worker_id}`, {
        code: 'WORKER_NOT_FOUND',
        retryable: false
      });
    }

    const cursor = safeCursor(input.cursor);
    const limit = safeLimit(input.limit);
    const events = session.events.slice(cursor, cursor + limit);
    const nextCursor = cursor + events.length;

    return {
      worker_id: session.worker_id,
      status: session.status,
      cursor: String(nextCursor),
      events
    };
  }

  interrupt(input: WorkerInterruptInput): unknown {
    const session = this.sessionsByWorkerId.get(input.worker_id);
    if (!session) {
      throw new WorkerProviderError(`headless worker not found: ${input.worker_id}`, {
        code: 'WORKER_NOT_FOUND',
        retryable: false
      });
    }

    session.status = 'interrupted';
    session.events.push({
      type: 'interrupted',
      reason: input.reason ?? null,
      created_at: nowIso()
    });

    return {
      interrupted: true,
      status: 'interrupted'
    };
  }

  collectArtifacts(input: WorkerCollectArtifactsInput): unknown {
    const session = this.sessionsByWorkerId.get(input.worker_id);
    if (!session) {
      throw new WorkerProviderError(`headless worker not found: ${input.worker_id}`, {
        code: 'WORKER_NOT_FOUND',
        retryable: false
      });
    }

    const artifacts: WorkerArtifactEnvelope[] = [];
    return {
      worker_id: session.worker_id,
      artifacts
    };
  }
}
