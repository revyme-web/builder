// regex-utils.ts — THE regex-escaping helper. The same char-class escape
// was hand-rolled ~85 times across the tree (with at least one malformed
// copy); import this instead of re-typing it.

/** Escape a string for literal use inside a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
