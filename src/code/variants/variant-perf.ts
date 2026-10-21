// variant-perf.ts — perf isolation for design components whose VARIANTS
// animate expensive properties.
//
// the reference tweens variant values directly: layout props (left/top/width/…)
// reflow every frame, and paint-heavy props (filter/boxShadow/gradients)
// re-rasterize every frame. On a large page those per-frame invalidations
// cascade into document-wide Layout / Layerize / Commit work — a tiny
// auto-cycling component measurably janked a 700-node live page (the
// Illustration/Chat find, profiled: Commit 54ms + Layerize 26ms/frame).
//
// The cure is to isolate the component ROOT: `contain: 'layout'` bounds
// reflow to the component's box (the Layout/Commit half of the jank), and
// `willChange: 'transform'` pins it onto its own compositor layer so its
// repaints never touch the page's layer tree (the Layerize half). `paint`
// containment is added ONLY when the root already clips its children
// (overflow hidden/clip/auto/scroll in every state): paint containment clips
// like `overflow: clip`, so on a root with overflow VISIBLE it cut off
// whatever hangs outside — a dropdown's menu, an icon's round caps.
//
// ROOT ONLY. Children are already inside the root's containment; isolating
// them buys nothing, clips them (Overflow: Visible on such a frame did
// nothing), and spends a GPU layer each. The old injector found "the root"
// with `<motion\.\w+[^>]*…style={{`, which cannot cross the `=>` of a root
// handler (`onHoverEnd={() => …}`) and stamped the FIRST CHILD instead —
// repeatedly, as children were added (user report 2026-10-19).
//
// NOT applied blanket-wise: every promoted layer holds a GPU texture
// (w×h×4×DPR²) — isolation only pays when the animated props are in the
// heavy sets below. Composite-safe animators (x/y/scale/rotate/opacity)
// and paint-light ones (colors/borderRadius) stay unpromoted.

import { trace } from '@/shared/debug-trace';
import { findVariantRootOpeningTag } from '@/shared/variant-root';

/** Per-frame REFLOW when tweened. */
export const LAYOUT_ANIMATED_PROPS = new Set([
  'left', 'top', 'right', 'bottom', 'inset',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap', 'fontSize', 'lineHeight', 'letterSpacing',
  'borderWidth', 'flexBasis',
]);

/** Per-frame expensive RASTER when tweened. */
export const PAINT_HEAVY_ANIMATED_PROPS = new Set([
  'filter', 'backdropFilter', 'boxShadow', 'textShadow',
  'backgroundImage', 'clipPath', 'maskImage', 'WebkitMaskImage',
]);

export function isHeavyAnimatedProp(prop: string): boolean {
  return LAYOUT_ANIMATED_PROPS.has(prop) || PAINT_HEAVY_ANIMATED_PROPS.has(prop);
}

/** True when any `const xxxVariants = {…}` object in the file animates a
 *  heavy prop in a NON-default entry (the default entry mirrors the base —
 *  only the presence of a heavy prop across states means it TWEENS). */
export function variantsAnimateHeavyProps(code: string): boolean {
  const declRe = /const\s+\w+Variants\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;
    const body = code.slice(open + 1, close);
    for (const entry of splitTopLevelEntries(body)) {
      // The default entry mirrors the base style, so a heavy prop there alone
      // never tweens. Scanning it isolated a Header whose link variants were
      // default-only `{ left: '0px', top: '0px' }`, and the isolation clipped
      // its fixed dropdown at the header's bottom edge (user report 2026-10-20).
      if (entry.key === 'default') continue;
      for (const keyMatch of entry.value.matchAll(/(?:^|[{,])\s*'?([A-Za-z][\w]*)'?\s*:/g)) {
        if (isHeavyAnimatedProp(keyMatch[1])) return true;
      }
    }
  }
  return false;
}

/** Split a variants object body into its top-level `key: value` entries —
 *  brace/bracket/paren-balanced and string-aware, so a nested object or a
 *  quoted value containing `,` / `:` never splits an entry. */
function splitTopLevelEntries(body: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  const push = (raw: string) => {
    const colon = raw.indexOf(':');
    if (colon < 0) return;
    const key = raw.slice(0, colon).trim().replace(/^(['"])(.*)\1$/, '$2');
    entries.push({ key, value: raw.slice(colon + 1) });
  };
  let depth = 0, inStr = '', start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { push(body.slice(start, i)); start = i + 1; }
  }
  push(body.slice(start));
  return entries;
}

export type IsolationMode = 'layout' | 'layout paint';

const snippetFor = (mode: IsolationMode) => `contain: '${mode}', willChange: 'transform', `;

/** OUR pair at the START of a style object — as injected inline, or reprinted
 *  one prop per line (a reprint splits it; an exact-string match then never
 *  recognised it again). Group 1 = `style={{` + whitespace (kept), group 3 =
 *  the contain value. A hand-authored `contain` in any other shape — not
 *  first, not paired with `willChange: 'transform'`, another value — never
 *  matches, so it is never touched. */
const PAIR_AT_STYLE_START = /(style=\{\{\s*)contain:\s*(['"])(layout(?: paint)?)\2,\s*willChange:\s*(['"])transform\4,\s*/g;

/** Cheap pre-check for the load-time heal: does the file carry our pair at all? */
export function hasPerfIsolationPair(code: string): boolean {
  return new RegExp(PAIR_AT_STYLE_START.source).test(code);
}

/** Overflow values that already clip children to the padding box — paint
 *  containment on top of them changes nothing visible. */
const CLIPPING_OVERFLOW = new Set(['hidden', 'clip', 'auto', 'scroll']);

/** Last literal value of `key` in an object body (later keys win, and
 *  generated style objects do repeat keys). Null = not set. */
function lastLiteral(body: string, key: string): string | null {
  let v: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|[\\s,{])['"]?${key}['"]?\\s*:\\s*(['"])([^'"]*)\\1`, 'g'))) v = m[2];
  return v;
}

/** Body of `const NAME = { … }` (brace-matched), or null. */
function constObjectBody(code: string, name: string): string | null {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{`).exec(code);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(open + 1, i); }
  }
  return null;
}

/** True only when the root clips its children in EVERY state: the base style
 *  says hidden/clip/auto/scroll on both axes (unset = CSS `visible`), and no
 *  variant entry of the root switches either axis to something else. */
export function rootClipsChildren(code: string, rootTag: string, styleBody: string): boolean {
  const o = lastLiteral(styleBody, 'overflow');
  const x = lastLiteral(styleBody, 'overflowX') ?? o;
  const y = lastLiteral(styleBody, 'overflowY') ?? o;
  if (x === null || y === null || !CLIPPING_OVERFLOW.has(x) || !CLIPPING_OVERFLOW.has(y)) return false;
  const variantsName = rootTag.match(/\bvariants=\{(\w+)\}/)?.[1];
  const variantsBody = variantsName ? constObjectBody(code, variantsName) : null;
  if (variantsBody) {
    for (const m of variantsBody.matchAll(/['"]?overflow[XY]?['"]?\s*:\s*(['"])([^'"]*)\1/g)) {
      if (!CLIPPING_OVERFLOW.has(m[2])) return false;
    }
  }
  return true;
}

/** BIDIRECTIONAL perf-isolation maintenance on the component ROOT (located
 *  by `findVariantRootOpeningTag` — brace-aware, so a root handler's `=>`
 *  can't send it to a child). Idempotent in every direction:
 *    • strips our pair from any element that is NOT the root (where the old
 *      regex left it);
 *    • variants animate a heavy prop → the root carries the pair, `layout` or
 *      `layout paint` per `rootClipsChildren` — flipped in place when the
 *      root's overflow changes;
 *    • no heavy props remain → our pair comes off the root, so the stale
 *      layer promotion stops costing GPU texture memory.
 *  A hand-authored `contain` (any other shape) is never touched or doubled. */
export function ensureRootPerfIsolation(code: string): string {
  const root = findVariantRootOpeningTag(code);
  if (!root) return code;

  let stray = 0;
  const out = code.replace(PAIR_AT_STYLE_START, (m: string, lead: string, ...rest: unknown[]) => {
    const offset = rest[3] as number;
    if (offset >= root.start && offset < root.end) return m;
    stray++;
    return lead;
  });
  if (stray > 0) trace.action('variant-perf:stray-isolation-removed', { count: stray });

  const tag = findVariantRootOpeningTag(out);
  if (!tag) return out;
  const tagText = out.slice(tag.start, tag.end);
  const styleRel = tagText.search(/\bstyle=\{\{/);
  if (styleRel < 0) return out;
  const styleAt = tag.start + styleRel;
  const styleOpen = styleAt + 'style={{'.length;
  let depth = 2;
  let end = styleOpen;
  for (let i = styleOpen; i < out.length; i++) {
    if (out[i] === '{') depth++;
    else if (out[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const styleBody = out.slice(styleOpen, end);

  const want: IsolationMode | null = variantsAnimateHeavyProps(out)
    ? (rootClipsChildren(out, tagText, styleBody) ? 'layout paint' : 'layout')
    : null;

  const ours = new RegExp(PAIR_AT_STYLE_START.source).exec(out.slice(styleAt, end));
  if (ours && ours.index === 0) {
    if (ours[3] === want) return out;
    trace.action(want ? 'variant-perf:root-isolation-mode' : 'variant-perf:root-isolation-removed', { from: ours[3], to: want });
    return out.slice(0, styleAt) + ours[1] + (want ? snippetFor(want) : '') + out.slice(styleAt + ours[0].length);
  }
  if (!want || styleBody.includes('contain:')) return out;
  trace.action('variant-perf:root-isolation-injected', { mode: want });
  return out.slice(0, styleOpen) + ' ' + snippetFor(want) + out.slice(styleOpen);
}
