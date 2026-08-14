// glide-gen.ts — "Glide" effect (our take on the reference's "Flow").
//
// Added on a NORMAL container node, Glide makes that container's children glide
// smoothly when one of them changes size — e.g. an FAQ accordion item opening
// pushes the items below it DOWN with a spring instead of jumping. The mechanism
// is framer-motion's shared layout animation: every direct child becomes a
// `layout` member of one `<LayoutGroup>` at the container, so when any member
// resizes, the others re-project to their new positions together.
//
// We wrap each direct child in a `<motion.div data-glide-item layout>` rather
// than editing the children themselves — exactly why the reference's Flow works with
// "no nested components needed": component instances keep their OWN internal
// LayoutGroup (needed for their variant animations), and the wrapper — which
// lives in the Flow's LayoutGroup, OUTSIDE the component — is what coordinates
// the siblings. The two layers compose: inner group = intra-variant smoothness,
// outer Glide group = sibling glide. See lessons + project memory.
//
// The container itself becomes `motion.* layout` too, so the effect chains UP
// when an ancestor is also a Glide node (the reference adds Flow at multiple levels).
//
// State lives on the container as a `data-glide='<json>'` attribute (mirrors the
// `data-scroll-fx` per-node effect pattern) so the Animation tool can detect /
// edit / remove it. Reuses ensureMotionTag / getOpeningTag /
// findMatchingCloseTagIndex from generator-utils (no duplication).

import { trace } from '@/shared/debug-trace';
import { ensureMotionTag, getOpeningTag } from './generator-motion';
import { findMatchingCloseTagIndex, insertAfterLastImportLine, getJsonAttr } from './generator-utils';

export interface GlideSpec {
  /** framer-motion transition for the layout animation (flat Record, same shape
   *  TransitionPanel reads/writes). Drives the spring/ease of the glide. */
  transition?: Record<string, string>;
}

/** Default = a gentle time-based spring (matches TransitionPanel's spring default). */
const DEFAULT_TRANSITION: Record<string, string> = { type: 'spring', duration: '0.5', bounce: '0.25', delay: '0' };

// ─── small JSX helpers ────────────────────────────────────────────────────────

/** Same literal detection as updateMotionPropInCode: numbers/arrays/objects/
 *  booleans are emitted unquoted, everything else single-quoted. */
function isJsxLiteral(v: string): boolean {
  if (v === '') return false;
  if (!isNaN(Number(v))) return true;
  if (v.startsWith('[') && v.endsWith(']')) return true;
  if (v.startsWith('{') && v.endsWith('}')) return true;
  if (v === 'true' || v === 'false') return true;
  return false;
}

/** Serialize a flat Record into a JSX object-literal body: `{ a: 1, b: 'x' }`. */
function objLiteral(props: Record<string, string>): string {
  const body = Object.entries(props)
    .filter(([k, v]) => v !== '' && v !== undefined && !k.startsWith('_'))
    .map(([k, v]) => `${k}: ${isJsxLiteral(v) ? v : `'${v}'`}`)
    .join(', ');
  return `{ ${body} }`;
}

/** Scan from `<` at fromLt to the opening tag's `>` (brace/string aware). */
function findTagGt(code: string, fromLt: number, end: number): number {
  let depth = 0, inStr = '';
  for (let i = fromLt; i < end; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return i;
  }
  return -1;
}

/** From a `{` index, return the index just past its matching `}` (brace/string aware). */
function skipBraces(code: string, fromBrace: number, end: number): number {
  let depth = 0, inStr = '';
  for (let i = fromBrace; i < end; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return end;
}

/** The body of an opening tag's `style={{…}}` (between the inner braces), brace +
 *  string aware. MUST be used to scope value extraction: other attrs (e.g. a
 *  Header's `data-scroll-variant` / `data-responsive`) carry CSS-ish strings like
 *  `(max-width: 768px)` where `\bwidth:` would otherwise false-match and inject
 *  garbage into the wrapper. */
function styleBodyOf(openTag: string): string {
  const idx = openTag.indexOf('style={{');
  if (idx === -1) return '';
  let i = idx + 'style={{'.length;
  let depth = 2, str = '';
  const start = i;
  for (; i < openTag.length; i++) {
    const c = openTag[i];
    if (str) { if (c === '\\') { i++; continue; } if (c === str) str = ''; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; continue; }
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return openTag.slice(start, i);
}

/** Pull a CSS value out of a style-object body — `\bprop\s*:` is safe for
 *  `order`/`flex` (no word boundary inside `border`/`flexDirection`). Always pass
 *  a styleBodyOf() result, NOT a whole tag (see styleBodyOf). */
function extractStyleVal(styleBody: string, prop: string): string | null {
  const m = styleBody.match(new RegExp(`\\b${prop}\\s*:\\s*('[^']*'|"[^"]*"|[^,}]+)`));
  return m ? m[1].trim() : null;
}

// ─── children walking ─────────────────────────────────────────────────────────

/** The [start,end) span of node N's children (between its opening `>` and its
 *  matching closing tag). null if self-closing / not found. */
function childrenRegion(code: string, nodeId: string): { start: number; end: number; tagName: string } | null {
  const got = getOpeningTag(code, nodeId);
  if (!got) return null;
  if (code[got.gt - 1] === '/') return null; // self-closing → no children
  const nameM = got.tag.match(/^<([a-zA-Z][\w.]*)/);
  if (!nameM) return null;
  const tagName = nameM[1];
  const closeIdx = findMatchingCloseTagIndex(code, tagName, got.gt + 1);
  if (closeIdx === -1) return null;
  return { start: got.gt + 1, end: closeIdx, tagName };
}

/** Top-level JSX ELEMENT children inside `region` (relative spans). Skips text
 *  and `{…}` expression children — only real elements take layout space. */
function topLevelElementChildren(region: string): Array<{ s: number; e: number }> {
  const spans: Array<{ s: number; e: number }> = [];
  let i = 0;
  const end = region.length;
  while (i < end) {
    const ch = region[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '{') { i = skipBraces(region, i, end); continue; }
    if (ch === '<') {
      const nameM = region.slice(i).match(/^<\s*([a-zA-Z][\w.]*)/);
      if (!nameM) { i++; continue; }
      const tagName = nameM[1];
      const gt = findTagGt(region, i, end);
      if (gt === -1) break;
      let childEnd: number;
      if (region[gt - 1] === '/') {
        childEnd = gt + 1; // self-closing
      } else {
        const ci = findMatchingCloseTagIndex(region, tagName, gt + 1);
        if (ci === -1) break;
        childEnd = ci + `</${tagName}>`.length;
      }
      // <style>/<script> are non-visual — never wrap them, so a Glide container
      // (e.g. the page root, which holds a global <style> block) doesn't get an
      // empty layout wrapper around a style/script tag. A bare <LayoutGroup> is
      // never a real child either — wrapping one puts EVERY sibling inside a
      // single glide item (the Adore corruption, 2026-08-14); normalizeRegion
      // unwraps them before scanning, this skip is the belt to that suspender.
      if (tagName !== 'style' && tagName !== 'script' && tagName !== 'LayoutGroup') spans.push({ s: i, e: childEnd });
      i = childEnd;
      continue;
    }
    i++; // stray text
  }
  return spans;
}

// ─── read ─────────────────────────────────────────────────────────────────────

export function hasGlide(code: string, nodeId: string): boolean {
  const got = getOpeningTag(code, nodeId);
  return !!got && /\sdata-glide='/.test(got.tag);
}

export function getGlide(code: string, nodeId: string): GlideSpec | null {
  return getJsonAttr<GlideSpec>(code, nodeId, 'data-glide');
}

// ─── apply / update / remove ──────────────────────────────────────────────────

/** Add `motion`/`LayoutGroup` from framer-motion if used and not imported. */
function ensureGlideImports(code: string): string {
  for (const name of ['motion', 'LayoutGroup']) {
    if (!new RegExp(`\\b${name}\\b`).test(code)) continue;
    if (new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*['"]framer-motion['"]`).test(code)) continue;
    if (/import\s*\{[^}]*\}\s*from\s*['"]framer-motion['"]/.test(code)) {
      code = code.replace(/(import\s*\{)([^}]*)(\}\s*from\s*['"]framer-motion['"])/, (_m, a, b, c) => `${a}${b}, ${name}${c}`);
    } else {
      const importLine = `import { ${name} } from 'framer-motion';`;
      code = insertAfterLastImportLine(code, importLine) ?? (importLine + '\n' + code);
    }
  }
  return code;
}

/** Add `layout` + `transition` + `data-glide='<json>'` to N's opening tag
 *  (idempotent — strips any prior copies first). */
function addNodeAttrs(code: string, nodeId: string, spec: GlideSpec, transBody: string): string {
  const got = getOpeningTag(code, nodeId);
  if (!got) return code;
  const tag = got.tag
    .replace(/\s*data-glide='[^']*'/g, '')
    .replace(/\s*\blayout\b(=\{true\})?/g, '')
    .replace(/\s*transition=\{[\s\S]*?\}\}/g, '');
  const json = JSON.stringify(spec);
  const newTag = tag.replace(/^(<[a-zA-Z][\w.]*)/, `$1 layout transition={${transBody}} data-glide='${json}'`);
  return code.slice(0, got.tagStart) + newTag + code.slice(got.gt);
}

function applyGlide(code: string, nodeId: string, spec: GlideSpec): string {
  const transBody = objLiteral(spec.transition || DEFAULT_TRANSITION);
  const region = childrenRegion(code, nodeId);
  let wrapped = 0;

  if (region) {
    let inner = code.slice(region.start, region.end);
    // Normalize any leftover glide structure first (re-entrancy: apply on a
    // page whose earlier remove only half-worked must self-heal, never nest).
    inner = unwrapDirectLayoutGroups(inner);
    inner = unwrapGlideItems(inner);
    const spans = topLevelElementChildren(inner);
    wrapped = spans.length;
    for (let k = spans.length - 1; k >= 0; k--) {
      const { s, e } = spans[k];
      const childText = inner.slice(s, e);
      const gt = findTagGt(inner, s, e);
      const childOpen = gt === -1 ? childText : inner.slice(s, gt + 1);
      // The wrapper REPLACES the child as the parent's flex/grid item, so it must
      // occupy the child's exact slot. Copy the child's placement (order/flex) AND
      // its cross-axis sizing (width/alignSelf) — NOT a hardcoded width:'100%',
      // which broke centering: in an `alignItems: center` column a full-width
      // wrapper fills the row and the child sits left-aligned inside it. A child
      // with no width → omit width so the wrapper sizes per the parent's
      // align-items (stretch → full, center → content-width centered). Height is
      // deliberately NOT copied — the wrapper must track the child's content
      // height so it grows when the child does (the whole point of Glide).
      const sb = styleBodyOf(childOpen);
      const order = extractStyleVal(sb, 'order') ?? "'0'";
      const flex = extractStyleVal(sb, 'flex') ?? "'0 0 auto'";
      const width = extractStyleVal(sb, 'width');
      const alignSelf = extractStyleVal(sb, 'alignSelf');
      const styleParts = [`order: ${order}`, `flex: ${flex}`];
      if (width) styleParts.push(`width: ${width}`);
      if (alignSelf) styleParts.push(`alignSelf: ${alignSelf}`);
      const wrapper =
        `<motion.div data-glide-item layout transition={${transBody}} style={{ ${styleParts.join(', ')} }}>` +
        childText + `</motion.div>`;
      inner = inner.slice(0, s) + wrapper + inner.slice(e);
    }
    const region2 = `<LayoutGroup>${inner}</LayoutGroup>`;
    code = code.slice(0, region.start) + region2 + code.slice(region.end);
  }

  code = ensureMotionTag(code, nodeId);          // <div> → <motion.div> (+ closer)
  code = addNodeAttrs(code, nodeId, spec, transBody);
  code = ensureGlideImports(code);               // motion + LayoutGroup
  trace.action('glide:apply', { nodeId, wrapped });
  return code;
}

/** Unwrap every bare `<LayoutGroup>` that is a DIRECT child of the region.
 *  Repeats until none remain, so stacked layers (each one a failed remove's
 *  leftover that a later apply re-wrapped) all collapse. Component-internal
 *  LayoutGroups are untouched — they are never direct region children. */
function unwrapDirectLayoutGroups(inner: string): string {
  let guard = 0;
  while (guard++ < 100) {
    let changed = false;
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }
      if (ch === '{') { i = skipBraces(inner, i, inner.length); continue; }
      if (ch === '<') {
        const nameM = inner.slice(i).match(/^<\s*([a-zA-Z][\w.]*)/);
        if (!nameM) { i++; continue; }
        const tagName = nameM[1];
        const gt = findTagGt(inner, i, inner.length);
        if (gt === -1) break;
        if (inner[gt - 1] === '/') { i = gt + 1; continue; }
        const ci = findMatchingCloseTagIndex(inner, tagName, gt + 1);
        if (ci === -1) break;
        const childEnd = ci + `</${tagName}>`.length;
        if (tagName === 'LayoutGroup') {
          inner = inner.slice(0, i) + inner.slice(gt + 1, ci) + inner.slice(childEnd);
          changed = true;
          break; // offsets shifted — rescan from the top
        }
        i = childEnd;
        continue;
      }
      i++;
    }
    if (!changed) break;
  }
  return inner;
}

/** Delete-time reaper: a glide wrapper whose only child was removed is a
 *  layout-affecting husk (it kept the child's copied width/order). Exported
 *  for generator-crud's removeNode path. */
export function sweepEmptyGlideWrappers(code: string): string {
  return code.replace(/<motion\.div data-glide-item[^>]*>\s*<\/motion\.div>/g, '');
}

/** Unwrap every `<motion.div data-glide-item …>child</motion.div>` → child. */
function unwrapGlideItems(inner: string): string {
  let result = inner;
  let guard = 0;
  while (guard++ < 1000) {
    const idx = result.indexOf('data-glide-item');
    if (idx === -1) break;
    const lt = result.lastIndexOf('<', idx);
    if (lt === -1) break;
    const nameM = result.slice(lt).match(/^<([a-zA-Z][\w.]*)/);
    if (!nameM) break;
    const tagName = nameM[1];
    const gt = findTagGt(result, lt, result.length);
    if (gt === -1) break;
    const closeIdx = findMatchingCloseTagIndex(result, tagName, gt + 1);
    if (closeIdx === -1) break;
    const childText = result.slice(gt + 1, closeIdx);
    result = result.slice(0, lt) + childText + result.slice(closeIdx + `</${tagName}>`.length);
  }
  return result;
}

/** Strip glide attrs from N, then revert `motion.<tag>` → `<tag>` when no other
 *  motion props remain (keeps the source clean on remove). */
function cleanNodeTag(code: string, nodeId: string): string {
  let got = getOpeningTag(code, nodeId);
  if (!got) return code;
  const tag = got.tag
    .replace(/\s*data-glide='[^']*'/g, '')
    .replace(/\s*\blayout\b(=\{true\})?/g, '')
    .replace(/\s*transition=\{[\s\S]*?\}\}/g, '');
  code = code.slice(0, got.tagStart) + tag + code.slice(got.gt);

  got = getOpeningTag(code, nodeId);
  if (!got) return code;
  const nameM = got.tag.match(/^<motion\.([a-z][\w-]*)/);
  const stillMotion = /\b(animate|initial|whileHover|whileTap|whileInView|whileDrag|whileFocus|variants|drag|exit|layoutId)\b/.test(got.tag);
  if (nameM && !stillMotion) {
    const base = nameM[1];
    const closeIdx = findMatchingCloseTagIndex(code, `motion.${base}`, got.gt + 1); // before opening shrinks
    const newOpen = got.tag.replace(/^<motion\.[a-z][\w-]*/, `<${base}`);
    code = code.slice(0, got.tagStart) + newOpen + code.slice(got.gt); // opening −("motion.".length)
    if (closeIdx !== -1) {
      const newCloseIdx = closeIdx - 'motion.'.length;
      const closePat = `</motion.${base}>`;
      if (code.slice(newCloseIdx, newCloseIdx + closePat.length) === closePat) {
        code = code.slice(0, newCloseIdx) + `</${base}>` + code.slice(newCloseIdx + closePat.length);
      }
    }
  }
  return code;
}

function removeGlide(code: string, nodeId: string): string {
  const region = childrenRegion(code, nodeId);
  if (region) {
    let inner = code.slice(region.start, region.end);
    // Structural, not the old anchored `^<LayoutGroup>…</LayoutGroup>$` regex:
    // the moment a child was INSERTED after the group (add-section on a glided
    // page), that anchor failed silently, the group survived the remove, and
    // the next apply wrapped the leftover group as ONE child — every sibling
    // inside a single glide item + stacked groups (the Adore page, 2026-08-14).
    // Fixpoint loop: unwrapping an item can EXPOSE deeper leftover groups (the
    // mega-wrapper held the previous generation's whole structure), so a single
    // pass of each is not enough.
    for (let guard = 0; guard < 20; guard++) {
      const before = inner;
      inner = unwrapDirectLayoutGroups(inner);
      inner = unwrapGlideItems(inner);
      if (inner === before) break;
    }
    code = code.slice(0, region.start) + inner + code.slice(region.end);
  }
  code = cleanNodeTag(code, nodeId);
  trace.action('glide:remove', { nodeId });
  return code;
}

/**
 * Add / update / remove the Glide effect on a node.
 *   spec === null → remove. Already-glided → re-apply with the new transition
 *   (remove→apply, so every wrapper picks up the change). Otherwise → add.
 */
export function setGlideInCode(code: string, nodeId: string, spec: GlideSpec | null): string {
  trace.fn('glide.set', { nodeId, remove: spec === null });
  if (spec === null) return removeGlide(code, nodeId);
  if (hasGlide(code, nodeId)) return applyGlide(removeGlide(code, nodeId), nodeId, spec);
  return applyGlide(code, nodeId, spec);
}
