export const REQUIRED_TRIGGER_PHRASE = 'use agent teams';

export function hasAgentTeamsTrigger(prompt) {
  if (!prompt) return false;
  return prompt.toLowerCase().includes(REQUIRED_TRIGGER_PHRASE);
}

export function extractObjectiveFromPrompt(prompt) {
  if (!prompt) return 'Execute requested objective';
  const withoutTrigger = prompt
    .replace(/use agent teams/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutTrigger || 'Execute requested objective';
}

export function inferTaskSizeFromPrompt(prompt) {
  if (!prompt) return 'small';
  const normalized = prompt.toLowerCase();

  const highSignals = [
    'large',
    'complex',
    'across',
    'multi-file',
    'migration',
    'refactor',
    'end-to-end',
    'e2e',
    'parallel'
  ];
  const mediumSignals = [
    'feature',
    'implement',
    'integration',
    'optimize',
    'review',
    'test'
  ];

  if (highSignals.some((signal) => normalized.includes(signal))) {
    return 'high';
  }
  if (mediumSignals.some((signal) => normalized.includes(signal))) {
    return 'medium';
  }

  const words = normalized.split(/\s+/).filter(Boolean).length;
  if (words >= 45) return 'high';
  if (words >= 18) return 'medium';
  return 'small';
}
