// parse-utils.ts — Shared string-walking primitives for the codegen/parsing
// layer. The canonical homes for helpers that were historically copy-pasted
// per generator (Phase 9 dedup).

/** Find the matching closing parenthesis. Skips strings AND line comments.
 *
 *  Escape handling uses a proper escaped-FLAG walk, not a `code[i-1] !== '\\'`
 *  lookbehind — the lookbehind misreads `\\"` (escaped backslash followed by a
 *  REAL closing quote) as an escaped quote and overruns the string. */
export function findMatchingParen(code: string, openIndex: number): number {
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }

    // Skip // line comments (they may contain quotes that break string tracking)
    if (ch === '/' && i + 1 < code.length && code[i + 1] === '/') {
      const lineEnd = code.indexOf('\n', i);
      if (lineEnd >= 0) { i = lineEnd; } else { i = code.length; }
      continue;
    }

    // A `'` / `"` only opens a string if it CLOSES on the same line — a JS
    // string literal can't contain a raw newline. Without that check an
    // apostrophe in JSX TEXT ("we've ever heard…") opened a string that
    // swallowed the rest of the scan, so the `)` was never found. Live find
    // 2026-07-25: pasting a CMS-bound heading whose row text had an apostrophe
    // made `getEnclosingMapParamsForNode` return null → the paste never
    // re-bound and stayed "Missing" inside its own collection list.
    // Backticks are exempt: template literals legitimately span lines.
    if (ch === "'" || ch === '"') {
      const lineEnd = code.indexOf('\n', i + 1);
      const close = code.indexOf(ch, i + 1);
      if (close !== -1 && (lineEnd === -1 || close < lineEnd)) inString = ch;
      continue;
    }
    if (ch === '`') { inString = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
