// Project classification (#46 §7). Deterministic keyword scoring. Pure.
//
// Maps a project/scope to an archetype (e.g. construction/LV, tech deployment,
// recurring consulting, compliance program, operational onboarding — whatever the
// tenant runs) so the pipeline can pick the right blueprint/defaults. Archetypes
// and their keywords are CALLER-PROVIDED (they are tenant-specific), so nothing is
// baked in; with no clear signal it returns the default and says why. No AI: it
// scores keyword hits across the supplied text + scope, ranks the archetypes, and
// reports matched keywords so the classification is explainable, not a black box.

export interface Archetype {
  name: string;
  keywords: string[];
  /** per-keyword-hit weight (default 1) — lets a strong signal outweigh several weak ones */
  weight?: number | undefined;
}

export interface ArchetypeScore {
  name: string;
  score: number;
  matched: string[];
}

export type Confidence = 'none' | 'low' | 'medium' | 'high';

export interface ClassificationResult {
  classification: string;
  confidence: Confidence;
  scores: ArchetypeScore[];
  rationale: string;
  defaultArchetype: string;
}

export interface ScopeLike {
  included?: string[] | undefined;
  assumptions?: string[] | undefined;
  quantities?: Array<{ item: string }> | undefined;
}

export interface ClassifyInput {
  archetypes: Archetype[];
  text?: string | undefined;
  scope?: ScopeLike | undefined;
  /** minimum top score to accept a classification (default 1) */
  minScore?: number | undefined;
  defaultArchetype?: string | undefined;
}

function buildHaystack(input: ClassifyInput): string {
  const parts: string[] = [];
  if (input.text) parts.push(input.text);
  const s = input.scope;
  if (s) {
    for (const x of s.included ?? []) parts.push(x);
    for (const x of s.assumptions ?? []) parts.push(x);
    for (const q of s.quantities ?? []) if (q?.item) parts.push(q.item);
  }
  return parts.join('\n').toLowerCase();
}

function confidenceOf(top: number, second: number): Confidence {
  if (top <= 0) return 'none';
  const margin = top - second;
  if (top >= 3 && margin >= 2) return 'high';
  if (top >= 2 && margin >= 1) return 'medium';
  return 'low';
}

/** Classify a project against a caller-provided archetype set. Pure/deterministic. */
export function classifyProject(input: ClassifyInput): ClassificationResult {
  const archetypes = input.archetypes ?? [];
  const minScore = input.minScore ?? 1;
  const defaultArchetype = input.defaultArchetype ?? 'Unclassified';
  const haystack = buildHaystack(input);

  const scores: ArchetypeScore[] = archetypes.map((a) => {
    const weight = a.weight != null && a.weight > 0 ? a.weight : 1;
    const matched: string[] = [];
    for (const kw of a.keywords ?? []) {
      const k = kw.trim().toLowerCase();
      if (k && haystack.includes(k)) matched.push(kw);
    }
    return { name: a.name, score: matched.length * weight, matched };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const top = scores[0];
  const second = scores[1];
  const topScore = top?.score ?? 0;
  const secondScore = second?.score ?? 0;

  let classification = defaultArchetype;
  let confidence: Confidence = 'none';
  let rationale: string;

  if (archetypes.length === 0) {
    rationale = 'No archetypes supplied — provide a caller archetype set (name + keywords) to classify against.';
  } else if (!haystack.trim()) {
    rationale = 'No text or scope supplied to classify — pass `text` (name/description) and/or `scope`.';
  } else if (topScore < minScore) {
    rationale = `No archetype reached the minimum score (${minScore}); best was "${top.name}" (${topScore}). Left as ${defaultArchetype}.`;
  } else {
    classification = top.name;
    confidence = confidenceOf(topScore, secondScore);
    const tie = secondScore === topScore ? ` (tie with "${second.name}" — review)` : '';
    rationale = `Matched ${top.matched.length} keyword(s) for "${top.name}" [${top.matched.join(', ')}]; score ${topScore} vs next ${secondScore}${tie}.`;
  }

  return { classification, confidence, scores, rationale, defaultArchetype };
}
