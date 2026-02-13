import { execFileSync } from 'node:child_process';
import type { CodexTransport } from './providers/codex.js';
import { HeadlessTransport, type HeadlessTransportOptions } from './transports/headless-transport.js';
import { TmuxTransport, type TmuxTransportOptions } from './transports/tmux-transport.js';

export type ManagedRuntimeTransportMode = 'auto' | 'tmux' | 'headless';

type EnvironmentMap = Record<string, string | undefined>;

export interface CodexTransportFactoryOptions {
  mode?: ManagedRuntimeTransportMode;
  env?: EnvironmentMap;
  ci?: boolean;
  stdoutIsTTY?: boolean;
  hasTmuxBinary?: boolean;
  tmuxOptions?: TmuxTransportOptions;
  headlessOptions?: HeadlessTransportOptions;
}

export interface CodexTransportResolution {
  requested_mode: ManagedRuntimeTransportMode;
  mode_source: 'input' | 'env' | 'default';
  selected_backend: 'tmux' | 'headless';
  reason:
    | 'explicit_headless'
    | 'explicit_tmux'
    | 'ci_headless'
    | 'non_tty_headless'
    | 'tmux_available'
    | 'tmux_unavailable_fallback';
  fallback_applied: boolean;
  transport: CodexTransport;
}

const TRANSPORT_ENV_KEYS = [
  'ATX_MANAGED_RUNTIME_TRANSPORT',
  'CODEX_MANAGED_RUNTIME_TRANSPORT'
] as const;

function normalizeMode(value: unknown): ManagedRuntimeTransportMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'tmux' || normalized === 'headless') {
    return normalized;
  }
  return null;
}

function readModeFromEnv(env: EnvironmentMap): ManagedRuntimeTransportMode | null {
  for (const key of TRANSPORT_ENV_KEYS) {
    const resolved = normalizeMode(env[key]);
    if (resolved) return resolved;
  }
  return null;
}

function isTruthy(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function detectTmuxBinary(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveTransportMode(
  mode: ManagedRuntimeTransportMode | undefined,
  env: EnvironmentMap
): { requested_mode: ManagedRuntimeTransportMode; mode_source: 'input' | 'env' | 'default' } {
  const fromInput = normalizeMode(mode);
  if (fromInput) {
    return {
      requested_mode: fromInput,
      mode_source: 'input'
    };
  }
  const fromEnv = readModeFromEnv(env);
  if (fromEnv) {
    return {
      requested_mode: fromEnv,
      mode_source: 'env'
    };
  }
  return {
    requested_mode: 'auto',
    mode_source: 'default'
  };
}

function createHeadlessTransport(options: CodexTransportFactoryOptions): HeadlessTransport {
  return new HeadlessTransport(options.headlessOptions);
}

function createTmuxTransport(options: CodexTransportFactoryOptions): TmuxTransport {
  return new TmuxTransport(options.tmuxOptions);
}

export function createCodexTransport(options: CodexTransportFactoryOptions = {}): CodexTransportResolution {
  const env = options.env ?? process.env;
  const ci = options.ci ?? isTruthy(env.CI);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout?.isTTY);
  const hasTmuxBinary = options.hasTmuxBinary ?? detectTmuxBinary();
  const mode = resolveTransportMode(options.mode, env);

  if (mode.requested_mode === 'headless') {
    return {
      ...mode,
      selected_backend: 'headless',
      reason: 'explicit_headless',
      fallback_applied: false,
      transport: createHeadlessTransport(options)
    };
  }

  if (mode.requested_mode === 'tmux') {
    if (hasTmuxBinary) {
      return {
        ...mode,
        selected_backend: 'tmux',
        reason: 'explicit_tmux',
        fallback_applied: false,
        transport: createTmuxTransport(options)
      };
    }
    return {
      ...mode,
      selected_backend: 'headless',
      reason: 'tmux_unavailable_fallback',
      fallback_applied: true,
      transport: createHeadlessTransport(options)
    };
  }

  if (ci) {
    return {
      ...mode,
      selected_backend: 'headless',
      reason: 'ci_headless',
      fallback_applied: false,
      transport: createHeadlessTransport(options)
    };
  }

  if (!stdoutIsTTY) {
    return {
      ...mode,
      selected_backend: 'headless',
      reason: 'non_tty_headless',
      fallback_applied: false,
      transport: createHeadlessTransport(options)
    };
  }

  if (hasTmuxBinary) {
    return {
      ...mode,
      selected_backend: 'tmux',
      reason: 'tmux_available',
      fallback_applied: false,
      transport: createTmuxTransport(options)
    };
  }

  return {
    ...mode,
    selected_backend: 'headless',
    reason: 'tmux_unavailable_fallback',
    fallback_applied: true,
    transport: createHeadlessTransport(options)
  };
}
