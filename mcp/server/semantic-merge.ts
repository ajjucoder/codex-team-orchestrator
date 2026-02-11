export interface SemanticMergeInput {
  base: string;
  ours: string;
  theirs: string;
  min_confidence?: number;
}

export interface SemanticMergeOption {
  strategy: 'ours' | 'theirs' | 'combine' | 'manual';
  score: number;
  confidence: number;
  rationale: string;
  merged_text: string;
}

export interface SemanticMergeResult {
  selected: SemanticMergeOption;
  ranked_options: SemanticMergeOption[];
  fallback_required: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split(/\W+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

function combineTexts(ours: string, theirs: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of [...ours.split('\n'), ...theirs.split('\n')]) {
    const normalized = line.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(line);
  }
  return out.join('\n');
}

function scoreCandidate({
  base,
  candidate,
  reference
}: {
  base: string;
  candidate: string;
  reference: string;
}): number {
  const baseTokens = tokenize(base);
  const candidateTokens = tokenize(candidate);
  const referenceTokens = tokenize(reference);
  const preserveStructure = jaccard(baseTokens, candidateTokens);
  const targetAlignment = jaccard(referenceTokens, candidateTokens);
  return clamp((targetAlignment * 0.7) + (preserveStructure * 0.3), 0, 1);
}

export function proposeSemanticMerge(input: SemanticMergeInput): SemanticMergeResult {
  const minConfidence = clamp(Number(input.min_confidence ?? 0.7), 0.5, 0.95);
  const { base, ours, theirs } = input;

  const combined = combineTexts(ours, theirs);
  const options: SemanticMergeOption[] = [
    {
      strategy: 'ours',
      merged_text: ours,
      score: scoreCandidate({ base, candidate: ours, reference: ours }),
      confidence: 0,
      rationale: 'preserves local branch intent'
    },
    {
      strategy: 'theirs',
      merged_text: theirs,
      score: scoreCandidate({ base, candidate: theirs, reference: theirs }),
      confidence: 0,
      rationale: 'preserves incoming branch intent'
    },
    {
      strategy: 'combine',
      merged_text: combined,
      score: scoreCandidate({ base, candidate: combined, reference: `${ours}\n${theirs}` }),
      confidence: 0,
      rationale: 'merges non-overlapping semantic units'
    }
  ];

  for (const option of options) {
    const deltaPenalty = Math.min(0.2, Math.abs(option.merged_text.length - base.length) / Math.max(1, base.length));
    option.confidence = clamp(option.score - deltaPenalty, 0, 1);
  }

  options.sort((left, right) => right.confidence - left.confidence);
  const selected = options[0];
  if (selected.confidence < minConfidence) {
    const manual: SemanticMergeOption = {
      strategy: 'manual',
      score: selected.score,
      confidence: selected.confidence,
      rationale: `confidence ${selected.confidence.toFixed(3)} below threshold ${minConfidence.toFixed(3)}`,
      merged_text: ''
    };
    return {
      selected: manual,
      ranked_options: [...options, manual],
      fallback_required: true
    };
  }

  return {
    selected,
    ranked_options: options,
    fallback_required: false
  };
}
