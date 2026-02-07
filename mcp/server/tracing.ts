import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface StructuredEvent {
  payload?: unknown;
  [key: string]: unknown;
}

interface StructuredLogRecord extends StructuredEvent {
  timestamp: string;
  payload: unknown;
}

function redactSecrets(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(redactSecrets);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const isSecret = /secret|token|password|apikey|api_key|authorization/i.test(key);
    out[key] = isSecret ? '[REDACTED]' : redactSecrets(value);
  }
  return out;
}

export class StructuredLogger {
  readonly filePath: string;

  constructor(filePath = '.tmp/team-events.log') {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  log(event: StructuredEvent): StructuredLogRecord {
    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      ...event,
      payload: redactSecrets(event.payload ?? {})
    };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    return record;
  }
}
