export const REQUIRED_TRIGGER_PHRASE = 'use agents team';
export const TRIGGER_PHRASE_ALIASES = [REQUIRED_TRIGGER_PHRASE, 'use agent teams'] as const;

type TaskSize = 'small' | 'medium' | 'high';

function normalizePrompt(prompt: unknown): string {
  return typeof prompt === 'string' ? prompt : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasAgentTeamsTrigger(prompt: unknown): boolean {
  const normalized = normalizePrompt(prompt).toLowerCase();
  if (!normalized) return false;
  return TRIGGER_PHRASE_ALIASES.some((phrase) => normalized.includes(phrase));
}

export function extractObjectiveFromPrompt(prompt: unknown): string {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return 'Execute requested objective';
  const withoutTrigger = TRIGGER_PHRASE_ALIASES
    .reduce(
      (acc, phrase) => acc.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' '),
      normalized
    )
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
