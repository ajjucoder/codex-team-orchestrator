export const REQUIRED_TRIGGER_PHRASE = 'use agent teams';

type TaskSize = 'small' | 'medium' | 'high';

function normalizePrompt(prompt: unknown): string {
  return typeof prompt === 'string' ? prompt : '';
}

export function hasAgentTeamsTrigger(prompt: unknown): boolean {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return false;
  return normalized.toLowerCase().includes(REQUIRED_TRIGGER_PHRASE);
}

export function extractObjectiveFromPrompt(prompt: unknown): string {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return 'Execute requested objective';
  const withoutTrigger = normalized
    .replace(/use agent teams/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutTrigger || 'Execute requested objective';
}

export function inferTaskSizeFromPrompt(prompt: unknown): TaskSize {
  const raw = normalizePrompt(prompt);
  if (!raw) return 'small';
  const normalized = raw.toLowerCase();

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
