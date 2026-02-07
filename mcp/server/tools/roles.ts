import type { ToolServerLike } from './types.js';
import { ROLE_PACK_V1, ROLE_NAMES } from '../role-pack.js';

function readTeamId(input: Record<string, unknown>): string {
  return typeof input.team_id === 'string' ? input.team_id : '';
}

export function registerRoleTools(server: ToolServerLike): void {
  server.registerTool('team_role_catalog', 'team_role_catalog.schema.json', (input) => {
    const teamId = readTeamId(input);
    const team = server.store.getTeam(teamId);
    if (!team) {
      return { ok: false, error: `team not found: ${teamId}` };
    }

    return {
      ok: true,
      role_pack_version: 'v1',
      roles: ROLE_NAMES.map((roleName) => ROLE_PACK_V1[roleName])
    };
  });
}
