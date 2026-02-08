import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { validateEntity } from '../../mcp/server/contracts.js';
import { createServer } from '../../mcp/server/index.js';
import { validatePermissionConfig, resolvePermissionProfileName } from '../../mcp/server/permission-profiles.js';
import { registerTeamLifecycleTools } from '../../mcp/server/tools/team-lifecycle.js';
import { registerPolicyTools } from '../../mcp/server/tools/policies.js';

const dbPath = '.tmp/v2-002-unit.sqlite';
const logPath = '.tmp/v2-002-unit.log';

afterEach(() => {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(logPath, { force: true });
});

test('V2-002 permission profile schema validates contract shape', () => {
  const valid = validateEntity('permission_profile.schema.json', {
    allow_all_tools: false,
    tools: {
      team_status: true
    }
  });
  assert.equal(valid.ok, true, valid.errors.join('; '));

  const invalid = validateEntity('permission_profile.schema.json', {
    tools: {
      team_status: true
    }
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /allow_all_tools/);
});

test('V2-002 permission config validation rejects invalid v2 profiles', () => {
  const invalidPolicy = {
    permissions: {
      profiles: {
        safe_read: {
          allow_all_tools: 'yes',
          tools: {
            team_status: 'true'
          }
        }
      },
      role_binding: {
        default: 'missing_profile'
      }
    }
  } as unknown as Record<string, unknown>;

  const result = validatePermissionConfig(invalidPolicy);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /allow_all_tools must be a boolean/);
  assert.match(result.errors.join(' '), /references unknown profile/);
});

test('V2-002 permission config resolves deterministic profile bindings', () => {
  const policy = {
    permissions: {
      profiles: {
        unrestricted: {
          allow_all_tools: true
        },
        safe_read: {
          allow_all_tools: false,
          tools: {
            team_status: true,
            team_policy_get: true
          }
        }
      },
      role_binding: {
        default: 'safe_read',
        lead: 'unrestricted'
      }
    }
  } as unknown as Record<string, unknown>;

  const validation = validatePermissionConfig(policy);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(resolvePermissionProfileName(policy, 'lead'), 'unrestricted');
  assert.equal(resolvePermissionProfileName(policy, 'reviewer'), 'safe_read');
});

test('V2-002 legacy permissions mapping remains backward-compatible', () => {
  const legacyPolicy = {
    permissions: {
      default: 'safe-read',
      reviewer: 'review-only'
    }
  } as unknown as Record<string, unknown>;

  const validation = validatePermissionConfig(legacyPolicy);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(resolvePermissionProfileName(legacyPolicy, 'reviewer'), 'review-only');
  assert.equal(resolvePermissionProfileName(legacyPolicy, 'planner'), 'safe-read');
});

test('V2-002 tools reject invalid permission config on team start and policy swap', () => {
  const server = createServer({ dbPath, logPath });
  server.start();
  registerTeamLifecycleTools(server);
  registerPolicyTools(server);

  server.policyEngine.cache.set('valid-perms', {
    profile: 'valid-perms',
    limits: { default_max_threads: 2, hard_max_threads: 6 },
    permissions: {
      profiles: {
        unrestricted: {
          allow_all_tools: true
        }
      },
      role_binding: {
        default: 'unrestricted'
      }
    }
  });

  server.policyEngine.cache.set('invalid-perms', {
    profile: 'invalid-perms',
    limits: { default_max_threads: 2, hard_max_threads: 6 },
    permissions: {
      profiles: {
        unsafe: {
          allow_all_tools: 'true'
        }
      },
      role_binding: {
        default: 'unsafe'
      }
    }
  });

  const invalidStart = server.callTool('team_start', {
    objective: 'invalid profile should fail',
    profile: 'invalid-perms'
  });
  assert.equal(invalidStart.ok, false);
  assert.match(invalidStart.error, /invalid permissions config/);

  const validStart = server.callTool('team_start', {
    objective: 'valid profile should pass',
    profile: 'valid-perms'
  });
  assert.equal(validStart.ok, true);

  const invalidSwap = server.callTool('team_policy_set_profile', {
    team_id: validStart.team.team_id,
    profile: 'invalid-perms'
  });
  assert.equal(invalidSwap.ok, false);
  assert.match(invalidSwap.error, /invalid permissions config/);

  server.store.close();
});
