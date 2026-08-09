// generator-utils.ts — Shared internals for the generator-* modules.
// Holds the babel `generate` instance and JSX-aware tag-boundary helpers.
// Everything here is consumed by generator-crud / -styles / -attrs / -motion.

import _generate from '@babel/generator';
import { escapeRegExp } from '@/shared/regex-utils';

export const generate = (typeof _generate === 'function' ? _generate : (_generate as any).default) as typeof _generate;

// ─── Responsive media-query gates ──────────────────────────────────────────

/** Map every `const __mqN = useMediaQuery('…')` → gate name → max-width px.
 *  Captures the WHOLE query then extracts max-width, so BANDED gates
 *  (`(max-width: 768px) and (min-width: 376px)`) map too — not just bare
 *  max-width (a bare-only regex missed banded gates and re-emitted a
 *  duplicate useMediaQuery const per write). Shared by the responsive
 *  attrs / text-vars / style-vars generators. */
export function scanGates(code: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of code.matchAll(/const\s+(__mq\d+)\s*=\s*useMediaQuery\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const w = /max-width:\s*(\d+)px/.exec(g[2]);
    if (w) m.set(g[1], parseInt(w[1], 10));
  }
  return m;
}

// ─── Tag-attribute helpers (JSON data-attr carriers) ───────────────────────
// Generators persist feature specs as `data-x='<json>'` attributes on the
// node's opening tag (instance-fx, glide, scroll-variant, scroll-fx, loop,
// form-state, overlay…). These are THE shared read/write/strip primitives —
// previously re-implemented per feature.

/** Source range of `attr=…` within a tag (leading whitespace included), or
 *  null when the attribute isn't present. Brace/string-balanced, so a nested
 *  object or an arrow body can't end the value early. Shared by the strip and
 *  read helpers below so both agree on where an attribute ends. */
export function findTagAttrRange(tag: string, attr: string): { start: number; end: number } | null {
  const m = tag.match(new RegExp(`\\s*\\b${escapeRegExp(attr)}=`));
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  while (i < tag.length && /\s/.test(tag[i])) i++;
  if (tag[i] === "'" || tag[i] === '"') {
    const q = tag[i]; i++;
    while (i < tag.length && tag[i] !== q) i++;
    i++;
  } else if (tag[i] === '{') {
    let depth = 0, inStr = '';
    for (; i < tag.length; i++) {
      const ch = tag[i];
      if (inStr) { if (ch === inStr) inStr = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
  } else return null;
  return { start: m.index, end: i };
}

/** The raw `attr=…` source on this tag, or null when absent. Lets a caller
 *  INSPECT an attribute before deciding whether to strip it. */
export function readTagAttrRaw(tag: string, attr: string): string | null {
  const range = findTagAttrRange(tag, attr);
  return range ? tag.slice(range.start, range.end) : null;
}

/** Strip `attr={{…}}` / `attr={…}` / `attr='…'` from a tag, brace/string-balanced.
 *  (Promoted from generator-motion; the balanced walk replaces the per-feature
 *  `\{[^}]*\}` regexes that under-stripped nested-brace expression values.) */
export function stripTagAttrBalanced(tag: string, attr: string): string {
  const range = findTagAttrRange(tag, attr);
  if (!range) return tag;
  return tag.slice(0, range.start) + tag.slice(range.end);
}

/** Strip EVERY occurrence of `attr={…}` across a whole source file, using the
 *  balanced walk above. The `\s*attr=\{[^}]*\}` form this replaces stopped at
 *  the FIRST `}`, so a multi-statement handler —
 *
 *      onTap={() => { const _n = …; if (_n) setVariant(_n); }}
 *
 *  — lost its body but left the expression container's closing brace behind,
 *  producing `<motion.div}` and a file that no longer parses (user report
 *  2026-08-08: deleting a variant blanked the whole component). */
export function stripAllTagAttrsBalanced(code: string, attr: string): string {
  let out = code;
  for (;;) {
    const next = stripTagAttrBalanced(out, attr);
    if (next === out) return out;   // each pass removes one occurrence
    out = next;
  }
}

/** Remove the `key: { … }` entry from every object literal in `code`, walking
 *  braces so a NESTED object value (`'variant-1': { transition: { duration: 0.5 } }`)
 *  is consumed whole. The entry delimiter (`{` or `,`) is required so a short
 *  key can't match as a substring of a longer one ('open' must not chew into
 *  'reopen'), and is preserved so the surrounding object stays well-formed —
 *  a trailing comma is valid JS. Quoted and bare keys both match: a hyphenated
 *  name is always written quoted in an object literal. */
export function removeObjectEntryBalanced(code: string, key: string): string {
  const esc = escapeRegExp(key);
  const entryRe = new RegExp(`([{,])\\s*['"]?${esc}['"]?\\s*:\\s*\\{`, 'g');
  let out = code;
  for (;;) {
    entryRe.lastIndex = 0;
    const m = entryRe.exec(out);
    if (!m || m.index === undefined) return out;
    const braceIdx = m.index + m[0].length - 1;
    const end = findBalancedBraceEnd(out, braceIdx);
    if (end === -1) return out;              // unbalanced source — leave it alone
    let i = end;
    while (i < out.length && /\s/.test(out[i])) i++;
    if (out[i] === ',') i++;                 // swallow the entry's own separator
    out = out.slice(0, m.index) + m[1] + out.slice(i);
  }
}

/** Index just past the `}` matching the `{` at `openIdx`, or -1 when
 *  unbalanced. String-aware so a brace inside a quoted value can't skew the
 *  depth count. */
export function findBalancedBraceEnd(src: string, openIdx: number): number {
  let depth = 0;
  let inStr = '';
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Add/replace/remove (`value=null`) a single attribute on a node's opening
 *  tag. `value` is RAW attribute-value source — include the quotes/braces
 *  yourself (`"'<json>'"`, `'{expr}'`). New attributes are inserted right
 *  after the tag name. (Write-side promoted from instance-fx-gen's
 *  setTagAttr, with the strip upgraded to the balanced walk above.) */
export function setTagAttr(code: string, nodeId: string, name: string, value: string | null): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const gt = findTagClose(code, idIdx);
  if (tagStart === -1 || gt === -1) return code;
  let tag = stripTagAttrBalanced(code.slice(tagStart, gt), name);
  if (value != null) tag = tag.replace(/^(<[a-zA-Z][\w.]*)/, `$1 ${name}=${value}`);
  return code.slice(0, tagStart) + tag + code.slice(gt);
}

/** Read a `name='<json>'` attribute from the node's opening tag — parsed
 *  JSON, or null when the node/attr is absent or the JSON is malformed. */
export function getJsonAttr<T>(code: string, nodeId: string, name: string): T | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  const gt = findTagClose(code, idIdx);
  if (tagStart === -1 || gt === -1) return null;
  const tag = code.slice(tagStart, gt);
  const m = tag.match(new RegExp(`\\s${escapeRegExp(name)}='([^']*)'`));
  if (!m) return null;
  try { return JSON.parse(m[1]) as T; } catch { return null; }
}

/** Write `name='<json>'` (single-quoted JSON attr) on the node's opening tag. */
export function setJsonAttr(code: string, nodeId: string, name: string, spec: unknown): string {
  return setTagAttr(code, nodeId, name, `'${JSON.stringify(spec)}'`);
}

/** Remove a `name=…` attribute from the node's opening tag. */
export function stripJsonAttr(code: string, nodeId: string, name: string): string {
  return setTagAttr(code, nodeId, name, null);
}

// ─── Import splicing ────────────────────────────────────────────────────────
// One family of helpers for the "make sure X is imported" dance previously
// re-implemented per feature (cms-gen, cms-pagination-gen, cms-paste-gen,
// cursor-gen, glide-gen, form-submit-gen, text-override-gen, sketch-anim-gen,
// generator-motion). Fallback behavior when a file has NO imports differs
// per site (bail / plain prepend / 'use client'-aware), so
// insertAfterLastImportLine returns null and callers keep their historic
// fallback.

/**
 * Insert `line` on its own line immediately AFTER the last top-level
 * `import …` line. Returns null when the code has no import lines.
 */
export function insertAfterLastImportLine(code: string, line: string): string | null {
  const last = [...code.matchAll(/^import .+$/gm)].pop();
  if (!last || last.index === undefined) return null;
  const at = last.index + last[0].length;
  return code.slice(0, at) + '\n' + line + code.slice(at);
}

/**
 * Ensure `import { …names }` (optionally with a default specifier via
 * `opts.ensureDefault`) exists for `moduleName`, merging missing names into
 * an existing import's specifier list (default specifier preserved). When
 * the module isn't imported at all, inserts a fresh import after a leading
 * 'use client' directive (else at the very top). Idempotent.
 */
export function ensureNamedImport(
  code: string,
  moduleName: string,
  names: string[],
  opts?: { ensureDefault?: string },
): string {
  const importRe = new RegExp(`import\\s+([^;]*?)\\s+from\\s+['"]${escapeRegExp(moduleName)}['"]\\s*;?`);
  const m = code.match(importRe);
  if (!m) {
    const parts = [opts?.ensureDefault ?? '', names.length ? `{ ${names.join(', ')} }` : ''].filter(Boolean);
    const line = `import ${parts.join(', ')} from '${moduleName}';\n`;
    const useClientMatch = code.match(/^['"]use client['"];?\s*\n/);
    const insertAt = useClientMatch ? useClientMatch[0].length : 0;
    return code.slice(0, insertAt) + line + code.slice(insertAt);
  }
  const spec = m[1].trim();
  // Default specifier (e.g. `React`) lives before any braces.
  const braceIdx = spec.indexOf('{');
  const defaultPart = braceIdx >= 0 ? spec.slice(0, braceIdx).replace(/,\s*$/, '').trim() : spec;
  const hasDefault = defaultPart.length > 0;
  const braceMatch = spec.match(/\{([^}]*)\}/);
  const existing = braceMatch ? braceMatch[1].split(',').map((n) => n.trim()).filter(Boolean) : [];
  const existingSet = new Set(existing);
  const missing = names.filter((n) => !existingSet.has(n));
  const needDefault = !!opts?.ensureDefault && !hasDefault;
  if (missing.length === 0 && !needDefault) return code;
  const all = [...existing, ...missing];
  const defaultSpec = hasDefault ? defaultPart : (opts?.ensureDefault ?? '');
  const parts = [defaultSpec, all.length ? `{ ${all.join(', ')} }` : ''].filter(Boolean);
  return code.replace(importRe, `import ${parts.join(', ')} from '${moduleName}';`);
}

/** Matches a COMPONENT's render `return` — `return <jsx>` or `return (<jsx>` — and NOT
 *  a nested callback's `return () => …` / `return fn(…)` / `return;`. Page-level hooks
 *  must be inserted before THIS, or they land inside an instance-fx hover/press handler
 *  (`return () => {…}`) — a nested scope — and crash as "undefined identifier". Requires
 *  JSX (`<`) right after the optional `(`, which only the render return has. */
export const RENDER_RETURN_RE = /^(\s*return\s*\(?\s*<)/m;

/**
 * Insert `text` immediately BEFORE the component's render `return (` line
 * (anchored by RENDER_RETURN_RE above), followed by `\n  ` so the return
 * keeps its indent. Returns null when the code has no render return —
 * each caller decides its own fallback (bail with the original code vs
 * skip the insert). This wraps the 3-line splice previously repeated at
 * ~12 generator sites.
 *
 * NOTE: `insertConstIntoEnclosingFn` (cms-responsive-gen) is a DIFFERENT,
 * deliberate anchor strategy — it walks up from a node to its enclosing
 * function so it works for component fns without `export default function`.
 * The two are intentionally separate; do not merge.
 */
export function insertBeforeRenderReturn(code: string, text: string): string | null {
  const m = code.match(RENDER_RETURN_RE);
  if (!m || m.index === undefined) return null;
  return code.slice(0, m.index) + text + '\n  ' + code.slice(m.index);
}

/**
 * Find the closing `>` of a JSX opening tag, skipping over `{{ }}` expressions.
 * Starts searching from `startIdx` (should be inside the tag).
 */
export function findTagClose(code: string, startIdx: number): number {
  let braceDepth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = startIdx; i < code.length; i++) {
    const ch = code[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '{') { braceDepth++; continue; }
    if (ch === '}') { braceDepth--; continue; }

    if (ch === '>' && braceDepth === 0) return i;
  }
  return -1;
}

/**
 * Find the index of `data-id="nodeId"` in JSX context, skipping CSS selector occurrences.
 * CSS selectors like `[data-id="x"]` in @media rules match the same pattern.
 * This function iterates occurrences and validates each is inside a JSX opening tag
 * (no unquoted `>` between data-id and the next `style={{` or end of opening tag).
 *
 * Returns the index of the data-id attribute in JSX, or -1 if not found.
 */
export function findJSXDataIdIndex(code: string, nodeId: string): number {
  return findJSXDataIdIndexFrom(code, nodeId, 0);
}

/** `findJSXDataIdIndex` starting at an offset — for callers that first narrow
 *  the search to a region (e.g. a `.map()` body). The CSS-selector rejection
 *  still applies, so a bad offset degrades to "not found" instead of matching a
 *  `[data-id="…"]` rule in the page's <style> block. */
export function findJSXDataIdIndexFrom(code: string, nodeId: string, from: number): number {
  const idPattern = `data-id="${nodeId}"`;
  let searchFrom = Math.max(0, from);

  while (searchFrom < code.length) {
    const idx = code.indexOf(idPattern, searchFrom);
    if (idx === -1) return -1;

    // In JSX: `<div data-id="x"` — preceded by whitespace (space, newline, tab)
    // In CSS: `[data-id="x"]` — preceded by `[` bracket
    // Check the character immediately before `data-id`
    if (idx > 0) {
      const prevChar = code[idx - 1];
      if (prevChar === ' ' || prevChar === '\n' || prevChar === '\t' || prevChar === '\r') {
        return idx; // JSX attribute — preceded by whitespace
      }
    }

    searchFrom = idx + idPattern.length;
  }

  return -1;
}

/**
 * Index of the `}` that closes an object literal whose body starts at
 * `objStart` (pass the index just PAST the opening `{` — e.g.
 * `styleIdx + 'style={{'.length` for a style object). String-aware: braces
 * inside '…', "…" and `…` are skipped. Returns -1 when unbalanced.
 *
 * CONVENTION: returns the index OF the closing `}` — callers that need
 * one-past (slice ends, `}}`-boundary splices) add 1 themselves. Promoted
 * from generator-motion's getJSXStyleValue walk; replaces ~15 hand-rolled
 * brace-depth walks (the naive ones were not string-aware — a brace inside
 * a quoted style value could derail them).
 */
export function findStyleObjectEnd(code: string, objStart: number): number {
  let depth = 1;
  let inStr: string | null = null;
  for (let i = objStart; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the `</tagName>` that matches an opening `<tagName>` whose body starts
 *  at `fromIdx`. Balances same-name opens/closes and SKIPS self-closing
 *  `<tagName … />` children (which have NO closer). Without the self-close skip a
 *  self-closing child (e.g. a logo-dot `<div … />`) over-counts depth, the real
 *  closer is never reached (returns -1), and a tag→motion rename leaves a
 *  mismatched `<motion.tag> … </tag>` that crashes the JSX parser. Returns -1 if
 *  the tag is unbalanced. Nested `<motion.tag>`/`</motion.tag>` don't match the
 *  bare `<tag`/`</tag>` patterns, so they're correctly ignored.
 *
 *  Promoted from generator-motion; consolidates ~10 per-file rewrites. Two
 *  reconciliations vs the historic copies (each feature taken from a copy,
 *  none invented): the opening-tag `>` scan delegates to the escape-aware
 *  findTagClose (as the cms-gen / generator-crud copies did), and the
 *  is-this-really-the-tag suffix set is the union seen across copies
 *  (space / > / \/ / \n / \r / \t). */
export function findMatchingCloseTagIndex(code: string, tagName: string, fromIdx: number): number {
  const openPattern = `<${tagName}`;
  const closePattern = `</${tagName}>`;
  let depth = 1;
  let searchFrom = fromIdx;
  while (depth > 0 && searchFrom < code.length) {
    const nextOpen = code.indexOf(openPattern, searchFrom);
    const nextClose = code.indexOf(closePattern, searchFrom);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const after = code[nextOpen + openPattern.length];
      if (after === ' ' || after === '>' || after === '/' || after === '\n' || after === '\r' || after === '\t') {
        // Real opening tag — find its own `>` (brace/string aware) to test self-close.
        const gt = findTagClose(code, nextOpen + openPattern.length);
        if (gt === -1) return -1;
        if (code[gt - 1] !== '/') depth++; // not self-closing → it has a matching closer
        searchFrom = gt + 1;
      } else {
        searchFrom = nextOpen + openPattern.length; // e.g. `<divider` — not our tag
      }
    } else {
      depth--;
      if (depth === 0) return nextClose;
      searchFrom = nextClose + closePattern.length;
    }
  }
  return -1;
}

/** Character range of a node's WHOLE JSX subtree — its opening tag through its
 *  matching close tag (or through the tag close when self-closing). Returns
 *  null when the id isn't in the code or the tag is malformed.
 *
 *  Extracted from `stripDataResponsiveInSubtree` when a second exit-to-canvas
 *  cleanup needed the same bounds (per-viewport @media rules — see
 *  `clearContainerStylesInSubtree`). Anything that must shed state for a
 *  dragged node AND everything nested inside it wants this range. */
export function findSubtreeRange(code: string, nodeId: string): { start: number; end: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return null;

  let end = tagEnd + 1;
  if (code[tagEnd - 1] !== '/') {
    const tagName = code.slice(tagStart + 1).match(/^[\w.]+/)?.[0];
    if (tagName) {
      const closeIdx = findMatchingCloseTagIndex(code, tagName, tagEnd + 1);
      if (closeIdx !== -1) end = closeIdx + `</${tagName}>`.length;
    }
  }
  return { start: tagStart, end };
}

/**
 * Serialize a CSS style value as a valid JS string literal for emission
 * into a `style={{ … }}` object.
 *
 * Most values are quote-free and keep the single-quoted form. But a
 * value that itself contains a single quote — most commonly a
 * multi-word `font-family` like `'Playfair Display', Georgia, serif`
 * (single-quoted font names are standard CSS) — cannot sit inside a
 * single-quoted literal: `'${v}'` would produce `''Playfair Display'…`
 * and break the JSX. Such values are emitted as a double-quoted (JSON)
 * literal instead, which escapes correctly for any content.
 */
export function quoteStyleValue(v: unknown): string {
  const s = String(v);
  // `var:X` is the parser's marker for an identifier reference in a JSX
  // style value (e.g. `style={{ opacity: foo }}` round-trips through the
  // parser as `styles.opacity = "var:foo"`). Emit it back as the bare
  // identifier — quoting would produce the string literal `'var:foo'`,
  // which the browser drops as invalid CSS (the visible "opacity does
  // not apply after paste" bug for scroll/motion bindings).
  //
  // Defensive: only treat as an identifier if what follows is a valid
  // JS identifier. Anything else falls through to normal quoting so a
  // legitimate string starting with `var:` still works.
  if (s.startsWith('var:')) {
    const ident = s.slice(4);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) return ident;
  }
  return s.includes("'") ? JSON.stringify(s) : `'${s}'`;
}

/**
 * Serialize an HTML/JSX attribute key+value into source text. Mirrors
 * `quoteStyleValue` but for the ATTRIBUTE position — so it knows to
 * emit `ref={X}` (JSX expression) instead of `ref="X"` (string) when
 * the value is the `var:X` identifier-reference sentinel.
 *
 * Without this, the parser-captured `attrs.ref = "var:fooRef"` round-
 * tripped as `ref="var:fooRef"` (a string literal), which React
 * happily accepted and then never assigned a real ref. Pasted scroll
 * transforms that depend on `useScroll({ target: fooRef })` then
 * threw "Target ref is defined but not hydrated" because the ref
 * stayed at its initial `null`.
 *
 * Boolean attrs (`controls`, `autoplay`, etc.) carry `v === ''` and
 * render as bare attributes. Strings get quoted as before.
 */
export function serializeJSXAttr(key: string, value: string): string {
  if (value.startsWith('var:')) {
    const ident = value.slice(4);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) return ` ${key}={${ident}}`;
  }
  if (value === '') return ` ${key}`;
  // JSON-valued attrs (`data-instance-fx`, `data-scroll-variant`, `data-responsive`) embed
  // DOUBLE quotes; wrapping them in `"…"` produces `data-instance-fx="{"hover"…` which the JSX
  // parser chokes on at the first inner `"` ("Unexpected token"). Wrap any value that contains a
  // double quote in SINGLE quotes instead — the canvas-node convention every other path already
  // uses (`data-responsive='{…}'`). Plain string values keep double quotes.
  const quote = value.includes('"') ? "'" : '"';
  return ` ${key}=${quote}${value}${quote}`;
}

/** True when `tagStart` falls inside the module-scope `const canvasNodes = (<>…</>)` fragment,
 *  which lives OUTSIDE the component function — React hooks (useRef/useEffect/useScroll/
 *  useMotionValue/useInView) can't be declared for nodes there, so hook-emitting codegen
 *  (On-Scroll text effects, Loop compose) must fall back to a self-contained form. Shared by
 *  text-anim-gen and generator-motion-loop (was private to text-anim-gen). */
export function isInCanvasNodes(code: string, tagStart: number): boolean {
  const m = code.match(/const\s+canvasNodes\s*=\s*\(?\s*<>/);
  return m?.index !== undefined && tagStart > m.index;
}

/**
 * Is `idx` inside a `const cn_X = …;` declaration (module-scope slot const)?
 *
 * Slot consts live at MODULE scope, so any prop expression on the JSX
 * inside them can only reference module-scope identifiers. In particular,
 * `initialVariant` / `variant` (function params + useState in the body)
 * are NOT accessible — emitting `initial={initialVariant}` on a tag
 * inside a slot const produces a `ReferenceError: initialVariant is not
 * defined` at module load.
 *
 * Codegen paths that inject framer-motion variant props (variants/animate/
 * initial) into `<motion.*>` tags use this helper to skip slot consts.
 *
 * Implementation: walk every `const cn_…\b` start, find its matching
 * top-level `;` while respecting brace/paren/bracket/string depth, and
 * check whether `idx` falls inside the range.
 */
export function isIndexInsideSlotConst(code: string, idx: number): boolean {
  const re = /\bconst\s+cn_\w+\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const start = m.index;
    if (start > idx) return false;
    // Find the end of this declaration (top-level `;`).
    let i = m.index + m[0].length;
    let brace = 0, paren = 0, bracket = 0;
    let stringChar: string | null = null;
    let end = -1;
    while (i < code.length) {
      const ch = code[i];
      if (stringChar) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === stringChar) stringChar = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { stringChar = ch; i++; continue; }
      if (ch === '{') { brace++; i++; continue; }
      if (ch === '}') { brace--; i++; continue; }
      if (ch === '(') { paren++; i++; continue; }
      if (ch === ')') { paren--; i++; continue; }
      if (ch === '[') { bracket++; i++; continue; }
      if (ch === ']') { bracket--; i++; continue; }
      if (ch === ';' && brace === 0 && paren === 0 && bracket === 0) { end = i; break; }
      i++;
    }
    if (end === -1) end = code.length;
    if (idx >= start && idx <= end) return true;
  }
  return false;
}

/** MODULE-SCOPE JSX — a node that CANNOT hold React hooks: it lives either in
 *  the `const canvasNodes = (<>…</>)` fragment (unconnected canvas node) or in
 *  a hoisted `const cn_X = <jsx/>` slot declaration (canvas node CONNECTED to a
 *  component slot — the live find 2026-07-13: a Loop on a marquee-connected
 *  word tile passed the canvasNodes check but still emitted hooks). Every
 *  hook-emitting effect generator must branch on THIS, not isInCanvasNodes. */
export function isModuleScopeJsx(code: string, tagStart: number): boolean {
  return isInCanvasNodes(code, tagStart) || isIndexInsideSlotConst(code, tagStart);
}
