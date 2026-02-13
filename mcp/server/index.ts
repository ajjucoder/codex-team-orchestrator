import { SqliteStore } from '../store/sqlite-store.js';
import { StructuredLogger } from './tracing.js';
import { MCPServer } from './server.js';
import { PolicyEngine } from './policy-engine.js';
import { HookEngine } from './hooks.js';
import { registerBuiltInPolicyHooks } from './policy-hooks.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import { RuntimeGitIsolationManager } from '../runtime/git-manager.js';
import type { WorkerAdapter } from '../runtime/worker-adapter.js';
import { createCodexWorkerAdapter, type CodexTransport } from '../runtime/providers/codex.js';
import {
  createCodexTransport,
  type CodexTransportFactoryOptions,
  type ManagedRuntimeTransportMode
} from '../runtime/transport-factory.js';
import type { ToolServerLike } from './tools/types.js';

interface StoreFactoryOptions {
  busyTimeoutMs?: number;
  lockRetries?: number;
  lockBackoffMs?: number;
}

export interface CreateServerOptions {
  dbPath?: string;
  logPath?: string;
  profileDir?: string;
  storeOptions?: StoreFactoryOptions;
  store?: SqliteStore;
  logger?: StructuredLogger;
  policyEngine?: PolicyEngine;
  hookEngine?: HookEngine;
  runtimeMode?: 'host_orchestrated_default' | 'managed_runtime';
  managedRuntime?: {
    enabled?: boolean;
    provider?: 'codex';
    transport?: CodexTransport;
    transportMode?: ManagedRuntimeTransportMode;
    transportFactory?: Omit<CodexTransportFactoryOptions, 'mode'>;
  };
  workerAdapter?: WorkerAdapter;
  gitManager?: RuntimeGitIsolationManager;
}

export interface CreateSchedulerOptions {
  dbPath?: string;
  storeOptions?: StoreFactoryOptions;
  store?: SqliteStore;
  server?: MCPServer;
  tickIntervalMs?: number;
  readyTaskLimit?: number;
  gitManager?: RuntimeGitIsolationManager;
}

interface BootstrapResolution {
  runtimeMode: 'host_orchestrated_default' | 'managed_runtime';
  managedRuntimeEnabled: boolean;
  workerAdapter?: WorkerAdapter;
  gitManager?: RuntimeGitIsolationManager;
}

function resolveBootstrap(options: CreateServerOptions, store: SqliteStore): BootstrapResolution {
  const managedRuntimeEnabled = options.managedRuntime?.enabled === true || options.runtimeMode === 'managed_runtime';
  const runtimeMode = managedRuntimeEnabled ? 'managed_runtime' : 'host_orchestrated_default';

  let workerAdapter = options.workerAdapter;
  if (!workerAdapter && managedRuntimeEnabled && options.managedRuntime?.transport) {
    const provider = options.managedRuntime.provider ?? 'codex';
    if (provider !== 'codex') {
      throw new Error(`unsupported managed runtime provider: ${provider}`);
    }
    workerAdapter = createCodexWorkerAdapter(options.managedRuntime.transport);
  } else if (!workerAdapter && managedRuntimeEnabled) {
    const provider = options.managedRuntime?.provider ?? 'codex';
    if (provider !== 'codex') {
      throw new Error(`unsupported managed runtime provider: ${provider}`);
    }
    const transport = createCodexTransport({
      ...(options.managedRuntime?.transportFactory ?? {}),
      mode: options.managedRuntime?.transportMode
    });
    workerAdapter = createCodexWorkerAdapter(transport.transport);
  }

  const gitManager = options.gitManager
    ?? (managedRuntimeEnabled ? new RuntimeGitIsolationManager({ store }) : undefined);

  return {
    runtimeMode,
    managedRuntimeEnabled,
    workerAdapter,
    gitManager
  };
}

export function createServer(options: CreateServerOptions = {}): MCPServer {
  const store = options.store ?? new SqliteStore(options.dbPath ?? '.tmp/team-orchestrator.sqlite', options.storeOptions);
  const logger = options.logger ?? new StructuredLogger(options.logPath ?? '.tmp/team-events.log');
  const policyEngine = options.policyEngine ?? new PolicyEngine(options.profileDir ?? 'profiles');
  const hookEngine = options.hookEngine ?? new HookEngine();
  const bootstrap = resolveBootstrap(options, store);
  const server = new MCPServer({
    store,
    logger,
    workerAdapter: bootstrap.workerAdapter,
    gitManager: bootstrap.gitManager,
    runtimeMode: bootstrap.runtimeMode,
    managedRuntimeEnabled: bootstrap.managedRuntimeEnabled
  });
  server.policyEngine = policyEngine;
  server.hookEngine = hookEngine;
  registerBuiltInPolicyHooks(server as unknown as ToolServerLike);
  return server;
}

export function createScheduler(options: CreateSchedulerOptions = {}): RuntimeScheduler {
  const store = options.server?.store
    ?? options.store
    ?? new SqliteStore(options.dbPath ?? '.tmp/team-orchestrator.sqlite', options.storeOptions);
  const policyEngine = options.server?.policyEngine as { resolveTeamPolicy?: (team: { profile?: string | null } | null | undefined) => Record<string, unknown> } | undefined;

  return new RuntimeScheduler({
    store,
    tickIntervalMs: options.tickIntervalMs,
    readyTaskLimit: options.readyTaskLimit,
    gitManager: options.gitManager,
    resolveTeamPolicy: (team) => {
      if (!policyEngine || typeof policyEngine.resolveTeamPolicy !== 'function') {
        return {};
      }
      return policyEngine.resolveTeamPolicy(team) ?? {};
    }
  });
}
