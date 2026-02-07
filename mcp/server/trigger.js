export const REQUIRED_TRIGGER_PHRASE = 'use agent teams';

export function hasAgentTeamsTrigger(prompt) {
  if (!prompt) return false;
  return prompt.toLowerCase().includes(REQUIRED_TRIGGER_PHRASE);
}

export function extractObjectiveFromPrompt(prompt) {
  return prompt.replace(/use agent teams/gi, '').trim() || 'Execute requested objective';
}
