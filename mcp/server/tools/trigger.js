import { hasAgentTeamsTrigger, extractObjectiveFromPrompt, REQUIRED_TRIGGER_PHRASE } from '../trigger.js';

export function registerTriggerTools(server) {
  server.registerTool('team_trigger', 'team_trigger.schema.json', (input) => {
    const triggered = hasAgentTeamsTrigger(input.prompt);
    if (!triggered) {
      return {
        ok: true,
        triggered: false,
        reason: `missing trigger phrase: ${REQUIRED_TRIGGER_PHRASE}`
      };
    }

    if (!server.tools.has('team_start')) {
      return {
        ok: false,
        triggered: true,
        error: 'team_start must be registered before team_trigger'
      };
    }

    const objective = extractObjectiveFromPrompt(input.prompt);
    const startInput = {
      objective,
      profile: input.profile ?? 'default'
    };
    if (input.max_threads !== undefined) {
      startInput.max_threads = input.max_threads;
    }

    const started = server.callTool('team_start', startInput, {
      active_session_model: input.active_session_model ?? null
    });

    return {
      ok: true,
      triggered: true,
      trigger_phrase: REQUIRED_TRIGGER_PHRASE,
      team: started.team
    };
  });
}
