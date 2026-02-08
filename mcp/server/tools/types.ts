import type { SqliteStore } from '../../store/sqlite-store.js';
import type { PolicyEngine } from '../policy-engine.js';
import type { HookEngine } from '../hooks.js';

export type ToolInput = Record<string, unknown>;
export type ToolContext = Record<string, unknown>;

export interface ToolResult {
  [key: string]: any;
  ok?: boolean;
  error?: string;
}

export type ToolHandler = (input: ToolInput, context?: ToolContext) => ToolResult;

export type ToolServerLike = {
  store: SqliteStore;
  logger: {
    log(event: Record<string, unknown>): Record<string, unknown>;
  };
  policyEngine?: PolicyEngine;
  hookEngine?: HookEngine;
  registerTool(name: string, schemaFileName: string, handler: ToolHandler): void;
  callTool(name: string, input: ToolInput, context?: ToolContext): ToolResult;
  tools?: Map<string, unknown>;
};

export type ToolRegistrar = (server: ToolServerLike) => void;
