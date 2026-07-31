// ghost-id.ts — Helpers for `.map()` ghost-copy node ids.
//
// Ghost copies of a collection template share the template's `data-id` but
// their `data-node-id` (and the ids the bridge rectCache uses) gets a `__N`
// suffix where N is the ghost's array index. Centralised here so callers
// don't reimplement the regex 7 different ways and accidentally drift on
// edge cases (e.g. nested `__` in unrelated ids).
//
// The "canonical id" is the suffix-stripped form — i.e. the template's id.
// Item 0 IS the template, so its id has no suffix and `getGhostIndex` returns
// null for it (use the explicit number 0 to mean "the template" if needed).

/** Trailing `__<digits>` capture, anchored to end of string. */
const GHOST_SUFFIX_RE = /__(\d+)$/;

/** True iff the id carries a `__N` ghost suffix. */
export function isGhostNodeId(id: string): boolean {
  return GHOST_SUFFIX_RE.test(id);
}

/** Extract the numeric ghost index from a suffix-bearing id, or null when
 *  there is no suffix. Use this when you need to know WHICH ghost was hit. */
export function getGhostIndex(id: string): number | null {
  const m = id.match(GHOST_SUFFIX_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** Strip the `__N` suffix to get the canonical (template) id. Returns the
 *  input unchanged when there's no ghost suffix. */
export function stripGhostSuffix(id: string): string {
  return id.replace(GHOST_SUFFIX_RE, '');
}

/** Build a ghost id from a template id and an index. Index 0 (the template
 *  itself) returns the canonical id unchanged — DOM ghosts only exist for
 *  indices 1 and above (item 0 IS the template). */
export function makeGhostId(templateId: string, ghostIndex: number): string {
  return ghostIndex > 0 ? `${templateId}__${ghostIndex}` : templateId;
}
