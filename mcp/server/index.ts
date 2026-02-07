import { SqliteStore } from '../store/sqlite-store.js';
import { StructuredLogger } from './tracing.js';
import { MCPServer } from './server.js';
import { PolicyEngine } from './policy-engine.js';

interface CreateServerOptions {
  dbPath?: string;
  logPath?: string;
  profileDir?: string;
  storeOptions?: {
    busyTimeoutMs?: number;
    lockRetries?: number;
    lockBackoffMs?: number;
  };
  store?: SqliteStore;
  logger?: StructuredLogger;
  policyEngine?: PolicyEngine;
}

export function createServer(options: CreateServerOptions = {}): MCPServer {
  const store = options.store ?? new SqliteStore(options.dbPath ?? '.tmp/team-orchestrator.sqlite', options.storeOptions);
  const logger = options.logger ?? new StructuredLogger(options.logPath ?? '.tmp/team-events.log');
  const policyEngine = options.policyEngine ?? new PolicyEngine(options.profileDir ?? 'profiles');
  const server = new MCPServer({ store, logger });
  server.policyEngine = policyEngine;
  return server;
}
