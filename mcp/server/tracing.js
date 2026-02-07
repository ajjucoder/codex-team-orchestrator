import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function redactSecrets(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(redactSecrets);

  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    const isSecret = /secret|token|password|apikey|api_key|authorization/i.test(key);
    out[key] = isSecret ? '[REDACTED]' : redactSecrets(value);
  }
  return out;
}

export class StructuredLogger {
  constructor(filePath = '.tmp/team-events.log') {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  log(event) {
    const record = {
      timestamp: new Date().toISOString(),
      ...event,
      payload: redactSecrets(event.payload ?? {})
    };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    return record;
  }
}
