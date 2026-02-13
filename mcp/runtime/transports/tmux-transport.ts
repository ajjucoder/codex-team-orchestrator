import { createHash, randomUUID } from 'node:crypto';
import { WorkerProviderError, type WorkerArtifactEnvelope, type WorkerCollectArtifactsInput, type WorkerInterruptInput, type WorkerPollInput, type WorkerSendInstructionInput, type WorkerSpawnInput } from '../worker-adapter.js';
import { TmuxManager } from '../tmux-manager.js';

const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;

interface InstructionFrameWire {
  version: 1;
  instruction_b64: string;
  cwd: string | null;
  idempotency_key: string | null;
  artifact_refs: Array<{ artifact_id: string; version: number }>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InstructionFramePayload {
  instruction: string;
  cwd?: string;
  idempotency_key?: string;
  artifact_refs?: Array<{ artifact_id: string; version: number }>;
  metadata?: Record<string, unknown>;
}

export interface EncodedInstructionFrame {
  frame: string;
  byte_length: number;
}

interface TmuxSessionState {
  worker_id: string;
  session_name: string;
  pane_ref: string;
  status: 'spawned' | 'running' | 'interrupted' | 'failed';
  events: Record<string, unknown>[];
}

export interface TmuxTransportOptions {
  manager?: TmuxManager;
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

function normalizeSessionName(input: WorkerSpawnInput): string {
  const team = input.team_id.replace(/[^A-Za-z0-9_-]+/g, '_');
  const agent = input.agent_id.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${team}_${agent}`.slice(0, 48) || `tmux_${randomUUID().slice(0, 8)}`;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function frameHash(frame: string): string {
  return createHash('sha256').update(frame).digest('hex');
}

export function encodeInstructionFrame(
  payload: InstructionFramePayload,
  maxInstructionBytes = DEFAULT_MAX_INSTRUCTION_BYTES
): EncodedInstructionFrame {
  const wire: InstructionFrameWire = {
    version: 1,
    instruction_b64: Buffer.from(payload.instruction, 'utf8').toString('base64'),
    cwd: payload.cwd ?? null,
    idempotency_key: payload.idempotency_key ?? null,
    artifact_refs: payload.artifact_refs ?? [],
    metadata: payload.metadata ?? {},
    created_at: nowIso()
  };

  const frame = JSON.stringify(wire);
  const byteLength = Buffer.byteLength(frame, 'utf8');
  if (byteLength > maxInstructionBytes) {
    throw new WorkerProviderError(
      `instruction frame exceeds max bytes (${byteLength} > ${maxInstructionBytes})`,
      {
        code: 'INSTRUCTION_TOO_LARGE',
        retryable: false,
        details: {
          byte_length: byteLength,
          max_instruction_bytes: maxInstructionBytes
        }
      }
    );
  }

  return {
    frame,
    byte_length: byteLength
  };
}

export function decodeInstructionFrame(frame: string): InstructionFramePayload {
  let parsed: InstructionFrameWire;
  try {
    parsed = JSON.parse(frame) as InstructionFrameWire;
  } catch {
    throw new WorkerProviderError('invalid instruction frame json', {
      code: 'INSTRUCTION_FRAME_INVALID_JSON',
      retryable: false
    });
  }

  if (parsed.version !== 1 || typeof parsed.instruction_b64 !== 'string') {
    throw new WorkerProviderError('invalid instruction frame schema', {
      code: 'INSTRUCTION_FRAME_INVALID_SCHEMA',
      retryable: false
    });
  }

  return {
    instruction: Buffer.from(parsed.instruction_b64, 'base64').toString('utf8'),
    cwd: parsed.cwd ?? undefined,
    idempotency_key: parsed.idempotency_key ?? undefined,
    artifact_refs: Array.isArray(parsed.artifact_refs) ? parsed.artifact_refs : [],
    metadata: normalizeMetadata(parsed.metadata)
  };
}

export class TmuxTransport {
  readonly manager: TmuxManager;
  readonly maxInstructionBytes: number;
  private readonly sessionsByWorkerId: Map<string, TmuxSessionState>;

  constructor(options: TmuxTransportOptions = {}) {
    this.manager = options.manager ?? new TmuxManager();
    this.maxInstructionBytes = Math.max(1024, Number(options.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES));
    this.sessionsByWorkerId = new Map();
  }

  spawn(input: WorkerSpawnInput): unknown {
    const sessionName = normalizeSessionName(input);
    const paneRef = this.manager.createDetachedSession(sessionName);
    const workerId = `tmux_${randomUUID().replace(/-/g, '')}`;

    this.sessionsByWorkerId.set(workerId, {
      worker_id: workerId,
      session_name: sessionName,
      pane_ref: paneRef,
      status: 'running',
      events: []
    });

    return {
      worker_id: workerId,
      status: 'spawned',
      metadata: {
        session_name: sessionName,
        pane_ref: paneRef,
        transport_backend: 'tmux'
      }
    };
  }

  sendInstruction(input: WorkerSendInstructionInput): unknown {
    const session = this.sessionsByWorkerId.get(input.worker_id);
    if (!session) {
      throw new WorkerProviderError(`tmux worker not found: ${input.worker_id}`, {
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

    this.manager.sendFramedInstruction({
      session_name: session.session_name,
      pane_ref: session.pane_ref,
      frame: encoded.frame,
      idempotency_key: input.idempotency_key
    });

    const instructionId = `tmux_inst_${session.events.length + 1}`;
    session.events.push({
      type: 'instruction_enqueued',
      instruction_id: instructionId,
      frame_sha256: frameHash(encoded.frame),
      frame_bytes: encoded.byte_length,
      idempotency_key: input.idempotency_key ?? null,
      created_at: nowIso()
    });

    return {
      accepted: true,
      instruction_id: instructionId,
      status: 'queued',
      metadata: {
        transport_backend: 'tmux',
        session_name: session.session_name,
        pane_ref: session.pane_ref,
        frame_bytes: encoded.byte_length
      }
    };
  }

  poll(input: WorkerPollInput): unknown {
    const session = this.sessionsByWorkerId.get(input.worker_id);
    if (!session) {
      throw new WorkerProviderError(`tmux worker not found: ${input.worker_id}`, {
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
      throw new WorkerProviderError(`tmux worker not found: ${input.worker_id}`, {
        code: 'WORKER_NOT_FOUND',
        retryable: false
      });
    }

    this.manager.interruptSession(session.pane_ref);
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
      throw new WorkerProviderError(`tmux worker not found: ${input.worker_id}`, {
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
