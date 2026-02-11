interface GuardrailPolicy {
  guardrails?: {
    early_stop_on_consensus?: boolean;
    block_secret_leakage?: boolean;
    redact_sensitive_inputs?: boolean;
  };
  budgets?: {
    idle_shutdown_ms?: unknown;
  };
  command_policy?: {
    default_allow?: unknown;
    deny_patterns?: unknown;
    allow_prefixes?: unknown;
    block_in_plan_mode?: unknown;
    escalation_policy?: unknown;
  };
}

interface TeamLifecycleRecord {
  team_id: string;
  profile: string;
  last_active_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

interface IdleFinalizationRecord {
  team_id: string;
  profile: string;
  idle_ms: number;
  idle_threshold_ms: number;
}

export interface SecretScanResult {
  matched: boolean;
  matched_rule: string | null;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  matched_rule: string;
  deny_reason: string | null;
  escalation_policy: string | null;
}

interface EarlyStopInput {
  policy?: GuardrailPolicy;
  consensus_reached: boolean;
  open_tasks: number;
}

interface IdleSweepInput {
  teams: TeamLifecycleRecord[];
  policyByProfile: (profile: string) => GuardrailPolicy | undefined;
  nowMs?: number;
}

function toMs(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCsvList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const DEFAULT_SECRET_PATTERNS: Array<{ rule: string; regex: RegExp }> = [
  { rule: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/i },
  { rule: 'generic_api_key', regex: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-\/+=]{8,}/i },
  { rule: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/i },
  { rule: 'private_key_block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

function redactByKeyName(key: string): boolean {
  return /secret|token|password|apikey|api_key|authorization/i.test(key);
}

export function scanForSecrets(value: unknown): SecretScanResult {
  if (typeof value !== 'string') {
    return { matched: false, matched_rule: null };
  }
  for (const pattern of DEFAULT_SECRET_PATTERNS) {
    if (pattern.regex.test(value)) {
      return { matched: true, matched_rule: pattern.rule };
    }
  }
  return { matched: false, matched_rule: null };
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scanForSecrets(value).matched ? '[REDACTED_SECRET]' : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (redactByKeyName(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = redactSensitiveValue(entry);
  }
  return output;
}

export function compactPayload(summary: string, artifactRefs: unknown[] | null | undefined): { summary: string; artifact_refs: unknown[] } {
  return {
    summary,
    artifact_refs: artifactRefs ?? []
  };
}

export function evaluateEarlyStop({ policy, consensus_reached, open_tasks }: EarlyStopInput): { should_stop: boolean; reason: string } {
  const enabled = Boolean(policy?.guardrails?.early_stop_on_consensus ?? true);
  if (enabled && consensus_reached && open_tasks === 0) {
    return {
      should_stop: true,
      reason: 'consensus reached with no open tasks'
    };
  }
  return {
    should_stop: false,
    reason: 'continue execution'
  };
}

export function evaluateIdleTeams({ teams, policyByProfile, nowMs = Date.now() }: IdleSweepInput): IdleFinalizationRecord[] {
  const referenceNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const finalized: IdleFinalizationRecord[] = [];
  for (const team of teams) {
    const policy = policyByProfile(team.profile);
    const idleMs = toMs(policy?.budgets?.idle_shutdown_ms, 180000);
    const timestamp = team.last_active_at ?? team.updated_at ?? team.created_at ?? '';
    const lastActive = Date.parse(timestamp);
    if (!Number.isFinite(lastActive)) continue;
    if (referenceNow - lastActive >= idleMs) {
      finalized.push({
        team_id: team.team_id,
        profile: team.profile,
        idle_ms: referenceNow - lastActive,
        idle_threshold_ms: idleMs
      });
    }
  }
  return finalized;
}

function parseRegexList(rawPatterns: unknown): RegExp[] {
  const patterns = readCsvList(rawPatterns);
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      // ignore invalid regex entries from profile config.
    }
  }
  return compiled;
}

function parseAllowedPrefixes(policy: GuardrailPolicy | undefined, role: string): string[] {
  const commandPolicy = asRecord(policy?.command_policy);
  const allowPrefixes = asRecord(commandPolicy?.allow_prefixes);
  if (!allowPrefixes) return [];

  const rolePrefixes = readCsvList(allowPrefixes[role]);
  const defaultPrefixes = readCsvList(allowPrefixes.default);
  return [...new Set([...rolePrefixes, ...defaultPrefixes])];
}

export function evaluateCommandPolicy({
  policy,
  role,
  mode,
  command
}: {
  policy?: GuardrailPolicy;
  role: string;
  mode: string;
  command: string;
}): CommandPolicyDecision {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return {
      allowed: false,
      matched_rule: 'command_missing',
      deny_reason: 'proposed_command is required for command policy evaluation',
      escalation_policy: null
    };
  }

  const commandPolicy = asRecord(policy?.command_policy);
  const blockInPlanMode = readBool(commandPolicy?.block_in_plan_mode, true);
  if (blockInPlanMode && mode === 'plan') {
    return {
      allowed: false,
      matched_rule: 'plan_mode_block',
      deny_reason: 'command execution is blocked in plan mode',
      escalation_policy: readString(commandPolicy?.escalation_policy)
    };
  }

  const secretScan = scanForSecrets(normalizedCommand);
  if (secretScan.matched) {
    return {
      allowed: false,
      matched_rule: `secret_block:${secretScan.matched_rule}`,
      deny_reason: 'command appears to contain a secret',
      escalation_policy: readString(commandPolicy?.escalation_policy)
    };
  }

  const denyPatterns = parseRegexList(commandPolicy?.deny_patterns);
  for (const pattern of denyPatterns) {
    if (pattern.test(normalizedCommand)) {
      return {
        allowed: false,
        matched_rule: `deny_pattern:${pattern.source}`,
        deny_reason: `command denied by policy pattern: ${pattern.source}`,
        escalation_policy: readString(commandPolicy?.escalation_policy)
      };
    }
  }

  const allowPrefixes = parseAllowedPrefixes(policy, role);
  for (const prefix of allowPrefixes) {
    if (normalizedCommand.startsWith(prefix)) {
      return {
        allowed: true,
        matched_rule: `allow_prefix:${prefix}`,
        deny_reason: null,
        escalation_policy: null
      };
    }
  }

  const defaultAllow = readBool(commandPolicy?.default_allow, false);
  if (!defaultAllow && allowPrefixes.length > 0) {
    return {
      allowed: false,
      matched_rule: 'allow_prefix_miss',
      deny_reason: `command does not match allow-list for role ${role}`,
      escalation_policy: readString(commandPolicy?.escalation_policy)
    };
  }

  return {
    allowed: defaultAllow,
    matched_rule: defaultAllow ? 'default_allow' : 'default_deny',
    deny_reason: defaultAllow ? null : 'command denied by default policy',
    escalation_policy: defaultAllow ? null : readString(commandPolicy?.escalation_policy)
  };
}
