import { ROLE_PACK_V1, ROLE_NAMES } from '../role-pack.js';

export function registerRoleTools(server) {
  server.registerTool('team_role_catalog', 'team_role_catalog.schema.json', (input) => {
    const team = server.store.getTeam(input.team_id);
    if (!team) {
      return { ok: false, error: `team not found: ${input.team_id}` };
    }

    return {
      ok: true,
      role_pack_version: 'v1',
      roles: ROLE_NAMES.map((roleName) => ROLE_PACK_V1[roleName])
    };
  });
}
