// pluralize.ts — Minimal English pluralizer, the same idea the reference uses to name a
// dropped collection's CONTAINER (the plural) while the repeated ITEM keeps the
// collection's own (singular) name: collection "Gallery" → container "Galleries"
// + item "Gallery"; "Photo" → "Photos"; "bliblablublu" → "bliblablublus".
//
// Rule order matches everyday English: uncountables stay, then a small irregular
// map, then the regular suffix rules (-y→-ies, sibilant→-es, default +s). Good
// enough for CMS collection names; not a full linguistics engine.

import { trace } from './debug-trace';

/** Nouns that don't change in the plural. */
const UNCOUNTABLE = new Set([
  'sheep', 'series', 'species', 'deer', 'fish', 'media', 'info', 'equipment',
  'news', 'data', 'content', 'staff', 'aircraft',
]);

/** Irregular plurals (lowercase keys). */
const IRREGULAR: Record<string, string> = {
  person: 'people', child: 'children', man: 'men', woman: 'women',
  tooth: 'teeth', foot: 'feet', mouse: 'mice', goose: 'geese',
  ox: 'oxen', leaf: 'leaves', life: 'lives', knife: 'knives', wife: 'wives',
  half: 'halves', wolf: 'wolves', shelf: 'shelves', loaf: 'loaves',
  cactus: 'cacti', focus: 'foci', fungus: 'fungi', nucleus: 'nuclei',
  analysis: 'analyses', thesis: 'theses', crisis: 'crises',
  datum: 'data', medium: 'media', index: 'indices', matrix: 'matrices',
};

/** Apply `model`'s value but keep `source`'s leading-letter capitalization. */
function matchCase(source: string, model: string): string {
  if (!source) return model;
  return source[0] === source[0].toUpperCase()
    ? model[0].toUpperCase() + model.slice(1)
    : model;
}

/**
 * Pluralize an English word. Returns the input unchanged when it's empty or
 * uncountable. Preserves the first-letter capitalization for irregulars.
 */
export function pluralize(word: string): string {
  if (!word || !word.trim()) return word;
  const w = word.trim();
  const lower = w.toLowerCase();

  if (UNCOUNTABLE.has(lower)) return w;
  if (IRREGULAR[lower]) return matchCase(w, IRREGULAR[lower]);

  // …consonant + y → …ies (Gallery → Galleries; but Day → Days, vowel+y).
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
  // sibilants → +es (Box → Boxes, Class → Classes, Dish → Dishes, Church → Churches).
  if (/(s|x|z|ch|sh)$/i.test(w)) return w + 'es';
  // default → +s (Photo → Photos, Legal → Legals, bliblablublu → bliblablublus).
  const out = w + 's';
  trace.fn('pluralize', { word: w, out });
  return out;
}

/** plural → singular, built by inverting the irregular map + a few extras. */
const IRREGULAR_INVERSE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IRREGULAR).map(([s, p]) => [p, s])),
  people: 'person', children: 'child', men: 'man', women: 'woman',
};

/**
 * Singularize an English word — the inverse of {@link pluralize}. Used for the
 * collection's repeated ITEM name ("Advisors" collection → item "Advisor";
 * "Gallery" → "Gallery", already singular). No-op for empty / uncountable.
 */
export function singularize(word: string): string {
  if (!word || !word.trim()) return word;
  const w = word.trim();
  const lower = w.toLowerCase();

  if (UNCOUNTABLE.has(lower)) return w;
  if (IRREGULAR_INVERSE[lower]) return matchCase(w, IRREGULAR_INVERSE[lower]);

  // …ies → …y (Galleries → Gallery, Categories → Category).
  if (/ies$/i.test(w) && w.length > 3) return w.slice(0, -3) + 'y';
  // sibilant + es → drop es (Boxes → Box, Dishes → Dish, Classes → Class).
  if (/(ches|shes|xes|zes|sses)$/i.test(w)) return w.slice(0, -2);
  // plain trailing -s (but NOT -ss like "Class") → drop it (Advisors → Advisor).
  if (/[^s]s$/i.test(w)) return w.slice(0, -1);
  // already singular.
  return w;
}
