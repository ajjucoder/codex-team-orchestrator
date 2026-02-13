export type RuntimeBackend = 'codex' | 'claude' | 'opencode';

export interface BackendCommandContext {
  backend: RuntimeBackend;
  role: string;
  model: string | null;
  metadata: Record<string, unknown>;
}

export interface BackendCommand {
  backend: RuntimeBackend;
  command: string;
  args: string[];
}

export type BackendCommandBuilder = (context: BackendCommandContext) => {
  command: string;
  args?: string[];
};

const DEFAULT_BACKEND_BUILDERS: Record<RuntimeBackend, BackendCommandBuilder> = {
  codex: ({ model }) => ({
    command: 'codex',
    args: model ? ['--model', model] : []
  }),
  claude: ({ model }) => ({
    command: 'claude',
    args: model ? ['--model', model] : []
  }),
  opencode: ({ model }) => ({
    command: 'opencode',
    args: model ? ['--model', model] : []
  })
};

const backendBuilders = new Map<RuntimeBackend, BackendCommandBuilder>(
  Object.entries(DEFAULT_BACKEND_BUILDERS) as Array<[RuntimeBackend, BackendCommandBuilder]>
);

function normalizeBackend(value: string): RuntimeBackend | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'opencode') {
    return normalized;
  }
  return null;
}

function normalizeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

export function listSupportedBackends(): RuntimeBackend[] {
  return [...backendBuilders.keys()].sort((left, right) => left.localeCompare(right));
}

export function registerBackendCommandBuilder(backend: RuntimeBackend, builder: BackendCommandBuilder): void {
  backendBuilders.set(backend, builder);
}

export function resetBackendCommandBuilders(): void {
  backendBuilders.clear();
  for (const [backend, builder] of Object.entries(DEFAULT_BACKEND_BUILDERS) as Array<[RuntimeBackend, BackendCommandBuilder]>) {
    backendBuilders.set(backend, builder);
  }
}

export function buildBackendCommand(input: {
  backend: string;
  role: string;
  model: string | null;
  metadata?: Record<string, unknown>;
}): BackendCommand {
  const backend = normalizeBackend(input.backend);
  if (!backend) {
    const supported = listSupportedBackends().join(', ');
    throw new Error(`unsupported backend '${input.backend}'. supported backends: ${supported}`);
  }

  const builder = backendBuilders.get(backend);
  if (!builder) {
    const supported = listSupportedBackends().join(', ');
    throw new Error(`backend command builder unavailable for '${backend}'. supported backends: ${supported}`);
  }

  const result = builder({
    backend,
    role: input.role,
    model: input.model,
    metadata: input.metadata ?? {}
  });

  const command = String(result.command ?? '').trim();
  if (!command) {
    throw new Error(`backend command builder returned empty command for '${backend}'`);
  }

  return {
    backend,
    command,
    args: normalizeArgs(result.args)
  };
}
