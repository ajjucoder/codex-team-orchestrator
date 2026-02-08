type HookPhase = 'pre' | 'post';

export interface HookContext {
  event: string;
  tool_name: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  result?: Record<string, unknown> | null;
}

export interface HookHandlerResult {
  allow?: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface HookDefinition {
  name: string;
  event: string;
  phase: HookPhase;
  order?: number;
  timeout_ms?: number;
  fail_closed?: boolean;
  handler: (context: HookContext) => HookHandlerResult | void;
}

export interface HookTraceEntry {
  name: string;
  event: string;
  phase: HookPhase;
  order: number;
  duration_ms: number;
  outcome: 'allow' | 'block' | 'timeout' | 'error';
  reason: string | null;
  metadata?: Record<string, unknown>;
}

export interface HookDispatchResult {
  ok: boolean;
  blocked_by: string | null;
  deny_reason: string | null;
  traces: HookTraceEntry[];
}

export class HookEngine {
  readonly hooks: HookDefinition[];

  constructor() {
    this.hooks = [];
  }

  register(hook: HookDefinition): void {
    this.hooks.push({
      ...hook,
      order: hook.order ?? 100,
      timeout_ms: hook.timeout_ms ?? 100,
      fail_closed: hook.fail_closed !== false
    });
  }

  dispatch(phase: HookPhase, context: HookContext): HookDispatchResult {
    const candidates = this.hooks
      .filter((hook) => hook.phase === phase && hook.event === context.event)
      .sort((a, b) => {
        const orderDelta = Number(a.order ?? 100) - Number(b.order ?? 100);
        if (orderDelta !== 0) return orderDelta;
        return a.name.localeCompare(b.name);
      });

    const traces: HookTraceEntry[] = [];
    for (const hook of candidates) {
      const startedAtMs = Date.now();
      let hookResult: HookHandlerResult | void = undefined;
      let outcome: HookTraceEntry['outcome'] = 'allow';
      let reason: string | null = null;

      try {
        hookResult = hook.handler(context);
      } catch (error) {
        outcome = 'error';
        reason = String((error as { message?: unknown })?.message ?? error ?? 'hook error');
      }

      const durationMs = Math.max(0, Date.now() - startedAtMs);
      if (durationMs > Number(hook.timeout_ms ?? 100)) {
        outcome = 'timeout';
        reason = `hook timeout exceeded ${hook.timeout_ms}ms`;
      } else if (outcome === 'allow' && hookResult?.allow === false) {
        outcome = 'block';
        reason = hookResult.reason ?? 'hook blocked';
      }

      const trace: HookTraceEntry = {
        name: hook.name,
        event: hook.event,
        phase,
        order: Number(hook.order ?? 100),
        duration_ms: durationMs,
        outcome,
        reason,
        metadata: hookResult?.metadata
      };
      traces.push(trace);

      if (phase === 'pre') {
        const shouldBlock = outcome === 'block' ||
          ((outcome === 'timeout' || outcome === 'error') && hook.fail_closed !== false);
        if (shouldBlock) {
          return {
            ok: false,
            blocked_by: hook.name,
            deny_reason: reason ?? 'hook blocked',
            traces
          };
        }
      }
    }

    return {
      ok: true,
      blocked_by: null,
      deny_reason: null,
      traces
    };
  }
}
