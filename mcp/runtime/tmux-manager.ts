import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_MAX_INSTRUCTION_BYTES = 64 * 1024;

export type TmuxRunner = (args: string[]) => string;

export interface TmuxManagerOptions {
  runner?: TmuxRunner;
  maxInstructionBytes?: number;
  bufferPrefix?: string;
}

export interface TmuxFramedInstructionInput {
  session_name: string;
  pane_ref?: string;
  frame: string;
  idempotency_key?: string;
}

export interface TmuxFramedInstructionResult {
  accepted: boolean;
  target: string;
  buffer_name: string;
  frame_bytes: number;
}

function runTmux(args: string[]): string {
  return execFileSync('tmux', args, {
    encoding: 'utf8'
  });
}

function sanitizeToken(value: string, fallback: string): string {
  const token = value.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
  return token.length > 0 ? token : fallback;
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class TmuxManager {
  readonly runner: TmuxRunner;
  readonly maxInstructionBytes: number;
  readonly bufferPrefix: string;

  constructor(options: TmuxManagerOptions = {}) {
    this.runner = options.runner ?? runTmux;
    this.maxInstructionBytes = Math.max(1024, Number(options.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES));
    this.bufferPrefix = sanitizeToken(options.bufferPrefix ?? 'atx-frame', 'atx-frame');
  }

  createDetachedSession(sessionName: string, launchCommand: string[] = []): string {
    const normalizedSession = sanitizeToken(sessionName, 'atx_session');
    const commandArgs = launchCommand
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
    this.runner(['new-session', '-d', '-s', normalizedSession, ...commandArgs]);
    return `${normalizedSession}:0.0`;
  }

  sendFramedInstruction(input: TmuxFramedInstructionInput): TmuxFramedInstructionResult {
    const frameBytes = Buffer.byteLength(input.frame, 'utf8');
    if (frameBytes > this.maxInstructionBytes) {
      throw new Error(`instruction frame exceeds max bytes (${frameBytes} > ${this.maxInstructionBytes})`);
    }

    const sessionName = sanitizeToken(input.session_name, 'atx_session');
    const target = input.pane_ref?.trim().length
      ? input.pane_ref
      : `${sessionName}:0.0`;
    const idempotencyToken = sanitizeToken(input.idempotency_key ?? '', 'frame');
    const bufferName = `${this.bufferPrefix}-${idempotencyToken}-${hashToken(input.frame)}`.slice(0, 64);

    const tempDir = mkdtempSync(join(tmpdir(), 'atx-tmux-frame-'));
    const frameFile = join(tempDir, `${bufferName}.json`);

    try {
      writeFileSync(frameFile, input.frame, 'utf8');
      this.runner(['load-buffer', '-b', bufferName, frameFile]);
      this.runner(['paste-buffer', '-d', '-b', bufferName, '-t', target]);
      this.runner(['send-keys', '-t', target, 'Enter']);
      return {
        accepted: true,
        target,
        buffer_name: bufferName,
        frame_bytes: frameBytes
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  interruptSession(target: string): void {
    const normalizedTarget = sanitizeToken(target, 'atx_session:0.0');
    this.runner(['send-keys', '-t', normalizedTarget, 'C-c']);
  }

  killSession(sessionName: string): void {
    const normalizedSession = sanitizeToken(sessionName, 'atx_session');
    this.runner(['kill-session', '-t', normalizedSession]);
  }
}
