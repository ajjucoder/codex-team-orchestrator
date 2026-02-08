export interface PermissionProfile {
  allow_all_tools: boolean;
  tools: Record<string, boolean>;
}

export interface PermissionConfig {
  profiles: Record<string, PermissionProfile>;
  role_binding: Record<string, string>;
}

export interface PermissionDecision {
  allowed: boolean;
  source_profile: string | null;
  matched_rule: string;
  deny_reason: string | null;
}

export interface PermissionValidationResult {
  ok: boolean;
  errors: string[];
  config: PermissionConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProfile(raw: Record<string, unknown>): PermissionProfile {
  const allowAllTools = raw.allow_all_tools === true;
  const toolsRaw = isRecord(raw.tools) ? raw.tools : {};
  const tools: Record<string, boolean> = {};
  for (const [toolName, allowed] of Object.entries(toolsRaw)) {
    if (typeof allowed === 'boolean' && toolName.trim().length > 0) {
      tools[toolName] = allowed;
    }
  }
  return {
    allow_all_tools: allowAllTools,
    tools
  };
}

function parsePermissionConfig(policy: Record<string, unknown>): PermissionConfig {
  const permissions = isRecord(policy.permissions) ? policy.permissions : {};
  const hasV2Shape = isRecord(permissions.profiles) || isRecord(permissions.role_binding);

  const roleBinding: Record<string, string> = {};
  const profiles: Record<string, PermissionProfile> = {};

  if (hasV2Shape) {
    const profilesRaw = isRecord(permissions.profiles) ? permissions.profiles : {};
    for (const [profileName, profileValue] of Object.entries(profilesRaw)) {
      if (!profileName.trim().length || !isRecord(profileValue)) continue;
      profiles[profileName] = normalizeProfile(profileValue);
    }

    const bindingRaw = isRecord(permissions.role_binding) ? permissions.role_binding : {};
    for (const [role, profileNameRaw] of Object.entries(bindingRaw)) {
      const profileName = pickString(profileNameRaw);
      if (!role.trim().length || !profileName) continue;
      roleBinding[role] = profileName;
    }
  } else {
    for (const [role, profileNameRaw] of Object.entries(permissions)) {
      const profileName = pickString(profileNameRaw);
      if (!role.trim().length || !profileName) continue;
      roleBinding[role] = profileName;
    }
  }

  return {
    profiles,
    role_binding: roleBinding
  };
}

function validateV2PermissionShape(policy: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const permissions = isRecord(policy.permissions) ? policy.permissions : {};
  const hasV2Shape = isRecord(permissions.profiles) || isRecord(permissions.role_binding);
  if (!hasV2Shape) return errors;

  if (!isRecord(permissions.profiles) || Object.keys(permissions.profiles).length === 0) {
    errors.push('permissions.profiles must be a non-empty object');
  } else {
    for (const [profileName, profile] of Object.entries(permissions.profiles)) {
      if (!profileName.trim().length) {
        errors.push('permissions.profiles has an empty profile name');
        continue;
      }
      if (!isRecord(profile)) {
        errors.push(`permissions.profiles.${profileName} must be an object`);
        continue;
      }
      if (profile.allow_all_tools !== undefined && typeof profile.allow_all_tools !== 'boolean') {
        errors.push(`permissions.profiles.${profileName}.allow_all_tools must be a boolean`);
      }
      if (profile.tools !== undefined) {
        if (!isRecord(profile.tools)) {
          errors.push(`permissions.profiles.${profileName}.tools must be an object`);
        } else {
          for (const [toolName, allowed] of Object.entries(profile.tools)) {
            if (!toolName.trim().length) {
              errors.push(`permissions.profiles.${profileName}.tools has an empty tool name`);
            }
            if (typeof allowed !== 'boolean') {
              errors.push(`permissions.profiles.${profileName}.tools.${toolName} must be a boolean`);
            }
          }
        }
      }
    }
  }

  if (permissions.role_binding !== undefined) {
    if (!isRecord(permissions.role_binding)) {
      errors.push('permissions.role_binding must be an object');
    } else {
      const profileNames = isRecord(permissions.profiles) ? new Set(Object.keys(permissions.profiles)) : new Set<string>();
      for (const [role, profileNameRaw] of Object.entries(permissions.role_binding)) {
        const profileName = pickString(profileNameRaw);
        if (!role.trim().length) {
          errors.push('permissions.role_binding has an empty role key');
          continue;
        }
        if (!profileName) {
          errors.push(`permissions.role_binding.${role} must be a non-empty string`);
          continue;
        }
        if (!profileNames.has(profileName)) {
          errors.push(`permissions.role_binding.${role} references unknown profile: ${profileName}`);
        }
      }
    }
  }

  return errors;
}

function validateLegacyPermissionShape(policy: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const permissions = isRecord(policy.permissions) ? policy.permissions : {};
  const hasV2Shape = isRecord(permissions.profiles) || isRecord(permissions.role_binding);
  if (hasV2Shape) return errors;

  for (const [role, profileNameRaw] of Object.entries(permissions)) {
    if (!role.trim().length) {
      errors.push('permissions has an empty role key');
      continue;
    }
    if (!pickString(profileNameRaw)) {
      errors.push(`permissions.${role} must be a non-empty string`);
    }
  }

  return errors;
}

export function validatePermissionConfig(policy: Record<string, unknown>): PermissionValidationResult {
  const errors = [
    ...validateV2PermissionShape(policy),
    ...validateLegacyPermissionShape(policy)
  ];
  return {
    ok: errors.length === 0,
    errors,
    config: parsePermissionConfig(policy)
  };
}

export function resolvePermissionProfileName(policy: Record<string, unknown>, role: string): string | null {
  const { config } = validatePermissionConfig(policy);
  return config.role_binding[role] ?? config.role_binding.default ?? null;
}

export function resolvePermissionProfile(policy: Record<string, unknown>, role: string): PermissionProfile | null {
  const { config } = validatePermissionConfig(policy);
  const profileName = config.role_binding[role] ?? config.role_binding.default ?? null;
  if (!profileName) return null;
  return config.profiles[profileName] ?? null;
}

function hasOwnBooleanRule(tools: Record<string, boolean>, key: string): boolean {
  return Object.hasOwn(tools, key);
}

function readOwnBooleanRule(tools: Record<string, boolean>, key: string): boolean {
  return Boolean(tools[key]);
}

function actionRuleKeys(toolName: string, action: string): string[] {
  return [
    `${toolName}:${action}`,
    `${toolName}.${action}`,
    `${toolName}#${action}`
  ];
}

export function evaluatePermissionDecision({
  policy,
  role,
  tool_name,
  action = null,
  profile_name_hint = null
}: {
  policy: Record<string, unknown>;
  role: string;
  tool_name: string;
  action?: string | null;
  profile_name_hint?: string | null;
}): PermissionDecision {
  const { config } = validatePermissionConfig(policy);
  const profileName = profile_name_hint ?? config.role_binding[role] ?? config.role_binding.default ?? null;
  if (!profileName) {
    return {
      allowed: true,
      source_profile: null,
      matched_rule: 'unbound_role_default_allow',
      deny_reason: null
    };
  }

  const profile = config.profiles[profileName];
  if (!profile) {
    return {
      allowed: true,
      source_profile: profileName,
      matched_rule: 'legacy_profile_reference_default_allow',
      deny_reason: null
    };
  }

  if (action) {
    for (const key of actionRuleKeys(tool_name, action)) {
      if (hasOwnBooleanRule(profile.tools, key)) {
        const allowed = readOwnBooleanRule(profile.tools, key);
        return {
          allowed,
          source_profile: profileName,
          matched_rule: key,
          deny_reason: allowed ? null : `profile ${profileName} denies ${key}`
        };
      }
    }
  }

  if (hasOwnBooleanRule(profile.tools, tool_name)) {
    const allowed = readOwnBooleanRule(profile.tools, tool_name);
    return {
      allowed,
      source_profile: profileName,
      matched_rule: tool_name,
      deny_reason: allowed ? null : `profile ${profileName} denies ${tool_name}`
    };
  }

  if (profile.allow_all_tools) {
    return {
      allowed: true,
      source_profile: profileName,
      matched_rule: 'allow_all_tools',
      deny_reason: null
    };
  }

  return {
    allowed: false,
    source_profile: profileName,
    matched_rule: 'implicit_deny',
    deny_reason: `profile ${profileName} does not allow ${tool_name}${action ? ` (${action})` : ''}`
  };
}
