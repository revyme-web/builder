// generator-styles.ts — Style writes against the JSX source.
// Covers: container-query overrides (responsive replicas), border overlays
// (::after), hover styles, ::before/::after pseudo rules, smooth-scroll opt-in,
// variant style objects (component variants), and conditional `order` for FLIP
// reordering. Variant + container-query writes use updateNodeInCode from
// generator-crud (resolved at call time — circular import is intentional).
import { ensureRootPerfIsolation } from '@/code/variants/variant-perf';
import { parseVariantConfig } from '@/code/variants/variant-config';

import { toKebab, SHORTHAND_LONGHANDS } from '@/shared/css-utils';
import { escapeRegExp } from '@/shared/regex-utils';
import { CSS_LAYOUT_DEFAULTS } from '@/shared/constants';
import { cssTransformToMotionProps, MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import { parseJSX } from '@/code/parsing/ast-utils';
import * as t from '@babel/types';
import _traverse from '@babel/traverse';

const traverseAst = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

/** Which present width-keys belong to the RESIZED viewport — DRIFT-PROOF.
 *  Exact match first. Otherwise ORDINAL: in this dialect each non-primary
 *  viewport owns at most one band/key, so orphan keys (matching no current
 *  viewport width) map to band-less viewports by descending order. Width
 *  proximity is NOT reliable — real drifted files carry arbitrary stale keys
 *  (live find 2026-08-06: config mobile=375, mobile band keyed 756, tablet
 *  min-floor remembering 392 — proximity assigned 756 to tablet and stranded
 *  it; ordinal maps [768,756] ↔ [tablet 768, mobile 375] correctly, and a
 *  doubly-drifted [900,300] ↔ [tablet, mobile] correctly too). Exported for
 *  tests + reuse by every width-keyed rewriter. */
export function resolveResizedKeys(
  presentKeys: number[],
  oldWidth: number,
  oldVpWidths: number[],
): number[] {
  if (presentKeys.includes(oldWidth)) return [oldWidth];
  const vpSet = new Set(oldVpWidths);
  const orphans = presentKeys.filter(k => !vpSet.has(k)).sort((a, b) => b - a);
  if (orphans.length === 0) return [];
  // Primary (widest) never owns a band; band-less = non-primary vps without an
  // exact-keyed entry, descending — same order the orphans are matched in.
  const primary = Math.max(...oldVpWidths);
  const present = new Set(presentKeys);
  const ownerless = oldVpWidths
    .filter(w => w !== primary && !present.has(w))
    .sort((a, b) => b - a);
  const idx = ownerless.indexOf(oldWidth);
  if (idx < 0 || idx >= orphans.length) return [];
  return [orphans[idx]];
}

/** min-width boundary for a breakpoint's @media band: the next-smaller
 *  band starts at the NEXT width in `vpWidths` (descending, from
 *  getSortedBreakpointWidths()) + 1px; undefined for the smallest/unknown
 *  width (bare max-width query). Was an identical nested closure in five
 *  @media serializers below. */
function getMinWidth(vpWidths: number[], mw: number): number | undefined {
  const idx = vpWidths.indexOf(mw);
  if (idx < 0 || idx >= vpWidths.length - 1) return undefined; // smallest or unknown
  // Lower bound = the next-smaller breakpoint; EMITTERS add +0.02px so the
  // band excludes the exact smaller width (the mobile TILE at 375 was
  // catching tablet-band rules — a tablet-only display:none leaked into
  // mobile, the "dragged out of tablet hid mobile too" report) while still
  // matching fractional phones (375.33 ≥ 375.02). This also matches the JS
  // runtime gates, which were always EXCLUSIVE (`width > lower`).
  // (Historical: was INCLUSIVE `${minW}px` after the +1px fractional-gap bug.)
  // `min-width: 376px` next to `max-width: 375px` leaves the open gap
  // (375, 376) that a real phone's FRACTIONAL CSS width (375.3px on
  // high-DPI Android) falls into — matching NEITHER band, so the page
  // rendered the unqueried DESKTOP base (live find 2026-07-21; same class
  // of bug Bootstrap fixes with 767.98px bounds). With min = the smaller
  // breakpoint, 375.3 lands in the tablet band; at EXACTLY 375 both bands
  // match and the cascade resolves it: serializers emit bands in
  // DESCENDING width order, so the smaller band comes later and wins.
  return vpWidths[idx + 1];
}

/**
 * Carry a band's rules DOWN before it gains a lower bound it never had.
 *
 * The smallest viewport's band is emitted OPEN (`@media (max-width: 430px)`, no
 * min-width), so it also styles every width beneath it. Add a viewport below it
 * and `getMinWidth` now returns a floor — the band becomes
 * `(max-width: 430px) and (min-width: 375.02px)` and the range it used to cover
 * implicitly is revoked in one write. Bands do not cascade, so the new viewport
 * renders with the DESKTOP base: the tile visibly collapses.
 *
 * The trap is that the collapse is DELAYED. Adding the viewport doesn't
 * regenerate the CSS; the floor appears on the next unrelated responsive edit,
 * so the page falls apart long after the change that doomed it (live find
 * 2026-08-10: a 4-viewport page whose 375 tile held 1 rule while the band that
 * had been styling it held 65).
 *
 * So: whenever a band is OPEN in the file but is about to be bounded, seed the
 * band below it with what it was already rendering. Existing rules in the lower
 * band WIN — it is the more specific intent — and this is a no-op when the band
 * was already bounded, which is every ordinary write.
 */
export function seedBandLosingImplicitCoverage(
  code: string,
  rules: Map<number, Map<string, Map<string, string>>>,
  vpWidths: number[],
): void {
  for (const width of [...rules.keys()]) {
    const floor = getMinWidth(vpWidths, width);
    if (floor === undefined) continue;                       // still the smallest — stays open
    // Was this band OPEN in the file we're rewriting? (`(max-width: Npx) {`,
    // no `and (min-width…)`). Decimal-tolerant, matching the parser regexes.
    const open = new RegExp(`@(?:media|container)[^{]*?\\(max-width:\\s*${width}(?:\\.\\d+)?px\\s*\\)\\s*\\{`);
    const bounded = new RegExp(`@(?:media|container)[^{]*?\\(max-width:\\s*${width}(?:\\.\\d+)?px\\s*\\)\\s*and\\s*\\(min-width`);
    if (!open.test(code) || bounded.test(code)) continue;    // absent, or already bounded
    const source = rules.get(width);
    if (!source || source.size === 0) continue;
    if (!rules.has(floor)) rules.set(floor, new Map());
    const target = rules.get(floor)!;
    let carried = 0;
    for (const [nodeId, props] of source) {
      if (!target.has(nodeId)) target.set(nodeId, new Map());
      const into = target.get(nodeId)!;
      for (const [prop, value] of props) {
        if (into.has(prop)) continue;                        // the lower band already decided
        into.set(prop, value);
        carried++;
      }
    }
    if (carried > 0) {
      trace.action('generator-styles:seeded-uncovered-band', { from: width, to: floor, props: carried });
    }
  }
}

/** Resting value for each motion transform prop — the `default` variant needs
 *  this explicitly so framer-motion can animate BACK to it from another variant
 *  (0 for rotate/skew/translate, 1 for scale). */
const MOTION_TRANSFORM_NEUTRAL: Record<string, string> = {
  rotate: '0', rotateX: '0', rotateY: '0', rotateZ: '0',
  scale: '1', scaleX: '1', scaleY: '1',
  skewX: '0', skewY: '0',
  x: '0', y: '0', z: '0',
  transformPerspective: '0',
};

/** CSS-INITIAL fallback for the animate-back seed — the LAST tier of
 *  readBaseValues. When a variant write touches a prop the node's base style
 *  doesn't carry (and it's not an SVG attr or motion transform), the default
 *  entry previously got NOTHING — and framer-motion never resets a prop the
 *  target variant doesn't mention, so the value STUCK after any pass through
 *  that variant (live find 2026-08-06: a Nav wrapper's mobile-only
 *  `flex: 1 0 0px` survived back to desktop after a breakpoint crossing —
 *  logo centered until reload; the sibling `pointerEvents: none` residue made
 *  buttons unclickable). Non-inherited props only: forcing initials on
 *  INHERITED text props (color, font family/size/weight, lineHeight) would
 *  sever inheritance — those are excluded deliberately, and the dialect
 *  writes text styles inline on text nodes anyway (the inline base wins the
 *  seed before this tier). */
const CSS_NEUTRAL_FALLBACK: Record<string, string> = {
  flex: '0 1 auto', flexGrow: '0', flexShrink: '1', flexBasis: 'auto',
  alignSelf: 'auto', order: '0',
  // Flex-CONTAINER props: UA stylesheets never set these, so their spec
  // initials ARE the computed base on any element (unlike `display`, whose
  // computed value is UA-per-tag — block for div, inline for span — and is
  // therefore deliberately NOT seedable; where display matters the builder
  // writes it inline and the inline tier wins the seed).
  alignItems: 'normal', alignContent: 'normal', justifyContent: 'normal',
  flexDirection: 'row', flexWrap: 'nowrap',
  width: 'auto', height: 'auto',
  minWidth: 'auto', minHeight: 'auto', maxWidth: 'none', maxHeight: 'none',
  gap: '0px', rowGap: '0px', columnGap: '0px',
  padding: '0px', paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
  margin: '0px', marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
  left: 'auto', top: 'auto', right: 'auto', bottom: 'auto',
  borderRadius: '0px', opacity: '1',
  backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
  boxShadow: 'none', filter: 'none', backdropFilter: 'none',
  pointerEvents: 'auto',
};

/** SVG presentation props whose BASE value lives as a tag ATTRIBUTE on
 *  shape/path elements (camel or kebab in JSX). Used by the animate-back
 *  seeding to give the default entry a real return value. Box/geometry
 *  attrs (width/height/x/y/d) deliberately excluded — different channels. */
const SVG_PRESENTATION_PROPS = new Set([
  'fill', 'stroke', 'strokeWidth', 'strokeDasharray', 'strokeDashoffset',
  'strokeLinecap', 'strokeLinejoin', 'strokeOpacity', 'fillOpacity',
  'opacity', 'strokeMiterlimit',
]);

/** SVG spec defaults — the animate-back value when the tag carries NO attr
 *  for a presentation prop a variant entry sets (e.g. dasharray added on a
 *  variant of a shape that never had one: reverting to default must land on
 *  'none', not keep the variant's pattern). */
const SVG_PRESENTATION_DEFAULTS: Record<string, string> = {
  stroke: 'none', strokeWidth: '1', strokeDasharray: 'none',
  strokeDashoffset: '0', strokeLinecap: 'butt', strokeLinejoin: 'miter',
  strokeOpacity: '1', fillOpacity: '1', opacity: '1', strokeMiterlimit: '4',
};
import { parseContainerRules } from '../stores/container-query-store';
import { parseCanvasConfig } from '../project/canvas-config';
import { getSortedBreakpointWidths } from '../stores/viewport-store';
import { transformAllResponsiveAttrs } from '../components/instance-prop-overrides';
import { rewriteListConfigBreakpoints, addListConfigBreakpoint, removeListConfigBreakpoint } from './cms-responsive-gen';
import { trace } from '@/shared/debug-trace';
import { findTagClose, findJSXDataIdIndex, quoteStyleValue, findStyleObjectEnd, findMatchingCloseTagIndex, findSubtreeRange, findBalancedBraceEnd } from './generator-utils';
import { updateNodeInCode } from './generator-crud';
import { isIndexInsideSlotConst } from './slot-ops';


// ─── :lang() rule preservation ──────────────────────────────────────────────
// updateContainerQueryStyle / clearContainerStylesForNode re-serialize the
// WHOLE <style> block from parseContainerRules' model, which only understands
// plain `[data-id]` band rules — locale rules (`:lang(fr) [data-id] {…}`,
// top-level AND banded) were being EATEN on every regular replica style write
// (and their props merged into the plain rule — the "Reset Override removed
// the locale transform everywhere" report). Extract them first, re-inject
// after serialization.
function extractLangRules(css: string): {
  css: string;
  topLevel: string[];
  banded: Map<number, string[]>;
} {
  const banded = new Map<number, string[]>();
  const langRuleRe = /:lang\([^)]+\)[^{]*\{[^}]*\}\s*/g;
  // 1. Banded: walk @media/@container blocks brace-balanced.
  const headRe = /@(?:media|container)\s*\([^)]*max-width:\s*(\d+)px[^)]*\)[^{]*\{/g;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(css)) !== null) {
    let depth = 1;
    let i = headRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    const width = parseInt(m[1], 10);
    const inner = css.slice(headRe.lastIndex, i - 1);
    const found = inner.match(langRuleRe) ?? [];
    if (found.length > 0) {
      const list = banded.get(width) ?? [];
      for (const r of found) list.push(r.trim());
      banded.set(width, list);
    }
    out += css.slice(cursor, headRe.lastIndex) + inner.replace(langRuleRe, '') + '}';
    cursor = i;
    headRe.lastIndex = i;
  }
  out += css.slice(cursor);
  // 2. Top-level: whatever :lang rules remain outside bands.
  const topLevel = (out.match(langRuleRe) ?? []).map(r => r.trim());
  out = out.replace(langRuleRe, '');
  return { css: out, topLevel, banded };
}

export function updateContainerQueryStyle(
  code: string,
  nodeId: string,
  maxWidth: number,
  styles: Record<string, string>,
): string {
  trace.fn('generator.updateContainerQueryStyle', { nodeId, maxWidth, styles });

  // Parse existing CSS rules using shared parser (no duplication with container-query-store)
  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);

  const lang = blockMatch ? extractLangRules(blockMatch[2]) : { css: '', topLevel: [], banded: new Map<number, string[]>() };
  const rules = blockMatch
    ? parseContainerRules(lang.css)
    : new Map<number, Map<string, Map<string, string>>>();

  // Apply the style changes. Empty value = remove property (the codebase-wide
  // "Empty String = Remove Property" convention). Without this a
  // "Reset Override" wrote `height:  !important;` (no value) into the
  // @media rule instead of dropping the line.
  if (!rules.has(maxWidth)) rules.set(maxWidth, new Map());
  const selectorMap = rules.get(maxWidth)!;
  if (!selectorMap.has(nodeId)) selectorMap.set(nodeId, new Map());
  const nodeProps = selectorMap.get(nodeId)!;
  for (const [key, value] of Object.entries(styles)) {
    const kebab = toKebab(key);
    if (value === '' || value === undefined || value === null) {
      nodeProps.delete(kebab);
    } else {
      nodeProps.set(kebab, value);
    }
  }
  // Clean up empty containers so the serializer doesn't emit an empty
  // selector block or an empty @media wrapper.
  if (nodeProps.size === 0) selectorMap.delete(nodeId);
  if (selectorMap.size === 0) rules.delete(maxWidth);

  // Compute min-width boundaries from current viewport widths so each breakpoint targets only its viewport.
  // e.g. tablet (768px) → @media (max-width: 768px) and (min-width: 376px)
  //      mobile (375px) → @media (max-width: 375px)   (no min-width for smallest)
  // Uses getSortedBreakpointWidths() which reads the live (possibly resized) viewport widths.
  const vpWidths = getSortedBreakpointWidths();
  // A band that is OPEN in the file but about to be bounded loses the range it
  // was implicitly styling — carry its rules down first.
  seedBandLosingImplicitCoverage(code, rules, vpWidths);

  // Serialize back to CSS (union of regular-rule widths and :lang-only widths
  // so a band whose regular rules vanished still carries its locale rules).
  // Global :lang rules FIRST — banded :lang rules share their specificity and
  // must sit LATER in the cascade to win at their widths.
  let newCss = '\n';
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  const sortedWidths = [...new Set([...rules.keys(), ...lang.banded.keys()])].sort((a, b) => b - a);
  for (const width of sortedWidths) {
    const selectors = rules.get(width) ?? new Map<string, Map<string, string>>();
    const langRules = lang.banded.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpWidths, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      // ─── Inset-pin auto-clear ─────────────────────────────────────
      // When a replica's full-inset pin is being authored (`left +
      // right` and/or `top + bottom` set, with `right`/`bottom` having
      // no equivalent base override), CSS's cascade leaves the BASE
      // `width` / `height` in effect — and for an absolute element
      // with `width` set, `right` is IGNORED. Net result: the
      // replica's pin can never grow the element with its parent.
      //
      // The cleanest fix is to auto-emit `width: auto !important` /
      // `height: auto !important` alongside the inset values so the
      // replica explicitly resets the base dimension. Only fires when
      // the user hasn't already authored an explicit `width`/`height`
      // for this replica — preserves any manual override.
      const propsForOutput = new Map(props);
      const hasLeft = propsForOutput.has('left');
      const hasRight = propsForOutput.has('right');
      const hasTop = propsForOutput.has('top');
      const hasBottom = propsForOutput.has('bottom');
      const hasWidth = propsForOutput.has('width');
      const hasHeight = propsForOutput.has('height');
      if (hasLeft && hasRight && !hasWidth) propsForOutput.set('width', 'auto');
      if (hasTop && hasBottom && !hasHeight) propsForOutput.set('height', 'auto');
      const decls = [...propsForOutput.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  if (blockMatch) {
    const [fullMatch, prefix, , suffix] = blockMatch;
    // If every rule has been removed, drop the whole <style> block so the
    // file doesn't carry an empty `<style>{\`\n  \`}</style>` artifact after
    // the user resets their last responsive override.
    if (rules.size === 0 && lang.topLevel.length === 0 && lang.banded.size === 0) {
      const before = code.slice(0, blockMatch.index!);
      const after = code.slice(blockMatch.index! + fullMatch.length);
      // Trim a single trailing newline + indentation from `before` if `after`
      // also starts with whitespace, so we don't leave a blank line.
      const trimmedBefore = before.replace(/\n[ \t]*$/, '\n');
      return trimmedBefore + after.replace(/^\s*\n/, '');
    }
    return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
  } else {
    // No existing block, and there's nothing to write — leave the file alone.
    if (rules.size === 0 && lang.topLevel.length === 0 && lang.banded.size === 0) return code;
    const rootCloseMatch = code.match(/\}\}>\s*\n/);
    if (!rootCloseMatch) return code;
    const insertIdx = rootCloseMatch.index! + rootCloseMatch[0].length;
    const styleBlock = `  <style>{\`${newCss}\`}</style>\n`;
    return code.slice(0, insertIdx) + styleBlock + code.slice(insertIdx);
  }
}

/** Properties that place an OUT-OF-FLOW box. Meaningless-to-harmful on a flow
 *  child: `left`/`top` still shift a `position: relative` element, and a banded
 *  `position: absolute` would pull it back out of the layout entirely. */
export const POSITIONAL_STYLE_KEYS = ['position', 'left', 'top', 'right', 'bottom', 'inset'] as const;

/**
 * Strip a node's POSITIONAL @media overrides from every breakpoint, leaving all
 * its other per-viewport values (width, font-size, order, …) untouched.
 *
 * Needed whenever a child stops being absolutely positioned in the PRIMARY tile
 * — sizing a parent to auto injects layout on it and converts its children to
 * `position: relative`, but that conversion only ever cleared the tile it ran
 * in. The replicas' banded `left: 69.5px !important` survived and kept shifting
 * a child that is now a flow item, with no inset control left in the panel to
 * undo it (user report 2026-08-08: the subtext sat offset on tablet + mobile
 * and could not be recovered).
 *
 * `clearContainerStylesForNode` is the wrong tool here — it would also throw
 * away the per-viewport width and font-size the user deliberately set. Only the
 * keys that contradict the new flow model come out.
 *
 * `transform` is narrowed rather than dropped: a banded `translate(-50%, -50%)`
 * offsets a flow child just like `left` does, but a `rotate`/`scale` in the same
 * declaration is still valid and is kept.
 */
export function stripPositionalContainerStyles(code: string, nodeId: string): string {
  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  const lang = extractLangRules(blockMatch[2]);
  const rules = parseContainerRules(lang.css);

  const kebabKeys = POSITIONAL_STYLE_KEYS.map((k) => toKebab(k));
  let touched = 0;
  for (const [, selectorMap] of rules) {
    const props = selectorMap.get(nodeId);
    if (!props) continue;
    for (const key of kebabKeys) {
      if (props.delete(key)) touched++;
    }
    const transform = props.get('transform');
    if (transform) {
      const residual = transform
        .replace(/translate[XY3]?d?\([^)]*\)/g, '')
        .trim()
        .replace(/\s+/g, ' ');
      if (residual !== transform) {
        touched++;
        if (residual) props.set('transform', residual);
        else props.delete('transform');
      }
    }
    if (props.size === 0) selectorMap.delete(nodeId);
  }
  if (touched === 0) return code;

  trace.action('generator.stripPositionalContainerStyles', { nodeId, removed: touched });

  const vpWidths = getSortedBreakpointWidths();
  seedBandLosingImplicitCoverage(code, rules, vpWidths);
  let newCss = '\n';
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  // Union with the :lang-only widths (same as updateContainerQueryStyle's
  // serializer) — a band whose regular rules all vanished must still carry
  // its locale rules instead of being dropped wholesale.
  const sortedWidths = [...new Set([...rules.keys(), ...lang.banded.keys()])].sort((a, b) => b - a);
  for (const width of sortedWidths) {
    const selectors = rules.get(width) ?? new Map<string, Map<string, string>>();
    const langRules = lang.banded.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpWidths, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}

/**
 * The component-file twin of `stripPositionalContainerStyles`: drop the
 * positional keys from every entry of the node's `variants` object.
 *
 * A component has no `@media` bands — its replicas are variant artboards, and a
 * per-variant `left`/`top` lives in the `<id>Variants` const. Same failure, same
 * shape: the primary's children go flow when the parent is sized to auto, and a
 * variant entry's leftover `left: '40px'` keeps shoving one of them.
 *
 * Written directly against the object rather than looping
 * `updateVariantStyleInCode`, because that path also runs the variant-list
 * wiring and root perf-isolation passes — real edits to a file that may need no
 * edit at all. This touches only the keys it removes, and returns `code`
 * untouched when there are none.
 *
 * `transform` / `x` / `y` are deliberately left alone: in a variants object
 * those are the animation channels, and clearing them would silently delete a
 * per-variant motion the user authored. Only the CSS box-offset keys go.
 */
export function stripPositionalVariantStyles(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  let tagStart = idIdx;
  while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
  const tagEnd = findTagClose(code, tagStart);
  if (tagEnd === -1) return code;
  const varMatch = code.slice(tagStart, tagEnd).match(/variants=\{(\w+)\}/);
  if (!varMatch) return code;

  const varName = varMatch[1];
  const declMatch = new RegExp(`const\\s+${varName}\\s*=\\s*\\{`).exec(code);
  if (!declMatch) return code;
  const objOpen = declMatch.index + declMatch[0].length - 1;
  const objEnd = findBalancedBraceEnd(code, objOpen);
  if (objEnd === -1) return code;

  // Walk the variant ENTRIES and rewrite each one's own body. A flat regex over
  // the whole object can't do this: stripping `left: '0px',` consumes the comma
  // that the very next key needed as its left delimiter, so `top` right after it
  // survives — adjacent keys are the normal case here, not an edge one.
  const keyAlt = POSITIONAL_STYLE_KEYS.join('|');
  const declRe = new RegExp(
    `(?:'(?:${keyAlt})'|"(?:${keyAlt})"|\\b(?:${keyAlt}))\\s*:\\s*(?:'[^']*'|"[^"]*"|[^,}\\n]+)`,
    'g',
  );
  const entryOpen = /\{/g;
  const pieces: string[] = [];
  let cursor = objOpen + 1;
  let changed = false;
  entryOpen.lastIndex = cursor;
  let open: RegExpExecArray | null;
  while ((open = entryOpen.exec(code)) !== null && open.index < objEnd) {
    const close = findBalancedBraceEnd(code, open.index);
    if (close === -1 || close > objEnd) break;
    const entry = code.slice(open.index + 1, close);
    // Drop the declarations, then repair the separators the removal left behind.
    const stripped = entry
      .replace(declRe, '')
      .replace(/,\s*,/g, ',')
      .replace(/^\s*,/, '')
      .replace(/,\s*$/, '');
    if (stripped !== entry) {
      changed = true;
      pieces.push(code.slice(cursor, open.index + 1), stripped.trim() ? ` ${stripped.trim()} ` : '');
      cursor = close;
    }
    entryOpen.lastIndex = close;
  }
  if (!changed) return code;
  pieces.push(code.slice(cursor, objEnd));
  const nextBody = pieces.join('').slice(1);

  trace.action('generator.stripPositionalVariantStyles', { nodeId, varName });
  return code.slice(0, objOpen + 1) + nextBody + code.slice(objEnd);
}

/** Band widths whose @media rule carries an `order` declaration for `nodeId`.
 *  Cheap pre-check for `stripBandedOrderForNode` — parses only the `<style>`
 *  block, never the JSX, so callers can gate an expensive AST parse on it. */
export function findBandedOrderWidths(code: string, nodeId: string): number[] {
  const blockMatch = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s.exec(code);
  if (!blockMatch || !blockMatch[2].includes(`[data-id="${nodeId}"]`)) return [];
  const rules = parseContainerRules(extractLangRules(blockMatch[2]).css);
  const widths: number[] = [];
  for (const [width, selectorMap] of rules) {
    if (selectorMap.get(nodeId)?.has('order')) widths.push(width);
  }
  return widths;
}

/**
 * Delete the `order` declaration from EVERY @media band rule targeting
 * `nodeId`, keeping all its other banded props. A banded `order: N !important`
 * numbers the node within its CURRENT parent's sibling space (written by a
 * replica reorder); after a REPARENT those values are a foreign numbering in
 * the new parent. On a templated page — where the canvas merge strips the
 * sections' inline `order` and stacks them by DOM order — a single stale
 * banded order sorts the node BELOW every sibling, parking it at the bottom
 * of the page ("Social Proof vanishes on tablet + mobile after a layers-drag
 * out of the hero", 2026-08-11). Width / padding / font-size overrides are
 * node-local and survive the move — only `order` is sibling-space-relative.
 *
 * Routed through `updateContainerQueryStyle` per width (`''` = delete-key)
 * so empty-rule/band cleanup, `:lang()` preservation and open-band seeding
 * behave exactly like any panel write.
 */
export function stripBandedOrderForNode(code: string, nodeId: string): string {
  const widths = findBandedOrderWidths(code, nodeId);
  if (widths.length === 0) return code;
  trace.action('generator.stripBandedOrderForNode', { nodeId, widths });
  let result = code;
  for (const width of widths) {
    result = updateContainerQueryStyle(result, nodeId, width, { order: '' });
  }
  return result;
}

/**
 * Remove ALL @media rules for a specific node across ALL breakpoints.
 * Used before re-applying a typography preset to clear stale breakpoint rules.
 */
export function clearContainerStylesForNode(code: string, nodeId: string): string {
  trace.fn('generator.clearContainerStylesForNode', { nodeId });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  // Same :lang preservation as updateContainerQueryStyle — this serializer
  // would otherwise eat every locale rule in the block.
  const lang = extractLangRules(blockMatch[2]);
  const rules = parseContainerRules(lang.css);

  // Remove this node from every breakpoint
  let removed = 0;
  for (const [, selectorMap] of rules) {
    if (selectorMap.delete(nodeId)) removed++;
  }

  if (removed === 0) return code; // nothing to clear

  trace.action('generator.clearContainerStylesForNode:cleared', { nodeId, breakpointsCleared: removed });

  // Re-serialize
  const vpWidths = getSortedBreakpointWidths();

  let newCss = '\n';
  // Global :lang rules FIRST (banded :lang shares specificity; later wins).
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  const sortedWidths = [...rules.keys()].sort((a, b) => b - a);
  for (const width of sortedWidths) {
    const selectors = rules.get(width) ?? new Map<string, Map<string, string>>();
    const langRules = lang.banded.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpWidths, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}

/**
 * Remove ALL @media rules for a node AND every descendant in its JSX subtree.
 *
 * The exit-to-canvas twin of `stripDataResponsiveInSubtree`, and it exists for
 * the same reason: per-viewport overrides are keyed to breakpoint widths, and a
 * canvas node has no viewports. Leaving them behind means a node the user
 * hid on tablet, dragged out to the canvas and dragged back in is STILL hidden
 * on tablet — even though on the canvas it was plainly visible with no viewport
 * to hide it in (user report 2026-08-04). Entry only unhides the viewport it
 * lands in (`canvas-drag:entered-vp-display-unhide`), so anything not shed at
 * exit survives the whole round trip.
 *
 * Subtree-wide, not node-only: dragging out a section takes its children with
 * it, and their per-viewport rules are just as orphaned as the root's.
 */
export function clearContainerStylesInSubtree(code: string, nodeId: string): string {
  const range = findSubtreeRange(code, nodeId);
  if (!range) return code;
  // Every id the dragged markup carries. Same idiom as overlay-gen's clone walk.
  const ids = Array.from(
    new Set(Array.from(code.slice(range.start, range.end).matchAll(/data-id="([^"]+)"/g), (m) => m[1])),
  );
  let out = code;
  for (const id of ids) out = clearContainerStylesForNode(out, id);
  if (out !== code) {
    trace.action('generator:clear-container-styles-subtree', { nodeId, ids: ids.length });
  }
  return out;
}

/**
 * Remove ALL @media rules for a specific BREAKPOINT WIDTH — used when a
 * REPLICA VIEWPORT is deleted from a page. Every override the user authored
 * for that viewport is stripped along with the viewport itself; the other
 * breakpoints (including the primary's overrides) are preserved.
 */
export function clearContainerStylesForWidth(code: string, vpWidth: number): string {
  trace.fn('generator.clearContainerStylesForWidth', { vpWidth });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  const lang = extractLangRules(blockMatch[2]);
  const rules = parseContainerRules(lang.css);
  if (!rules.has(vpWidth)) return code;
  rules.delete(vpWidth);

  // Re-serialize remaining rules (same shape as clearContainerStylesForNode).
  const vpWidths = getSortedBreakpointWidths();
  let newCss = '\n';
  // Global :lang rules FIRST (banded :lang shares specificity; later wins).
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  const sortedWidths = [...rules.keys()].sort((a, b) => b - a);
  for (const width of sortedWidths) {
    const selectors = rules.get(width) ?? new Map<string, Map<string, string>>();
    const langRules = lang.banded.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpWidths, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  trace.action('generator.clearContainerStylesForWidth:cleared', { vpWidth });
  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}

/**
 * Rewrite all @media breakpoints in the code when a viewport width changes.
 * Remaps old max-width values to new ones and recomputes min-width boundaries.
 * Called when a viewport root is resized.
 *
 * @param code - Current JSX code
 * @param oldWidth - The previous viewport width (e.g. 375)
 * @param newWidth - The new viewport width (e.g. 900)
 */
/**
 * Rewrite all @media breakpoints when a viewport width changes.
 * 1. Remaps rules from oldWidth → newWidth (if any exist)
 * 2. Re-serializes ALL rules with fresh min-width boundaries from current viewport config
 *
 * Must be called AFTER syncViewportWidths() so getSortedBreakpointWidths() returns updated values.
 */
export function rewriteContainerBreakpoints(
  code: string,
  oldWidth: number,
  newWidth: number,
): string {
  trace.fn('generator.rewriteContainerBreakpoints', { oldWidth, newWidth });

  // Normalize FIRST: converge any drift-era stray band onto the config's own
  // viewport keys (see normalizeResponsiveBandKeys) so the exact-key rename
  // below just hits. The ordinal orphan claim further down stays as the
  // fallback for pages whose @canvas block is itself missing.
  code = normalizeResponsiveBandKeys(code);

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) { trace.action('rewriteBreakpoints:no-style-block'); return code; }

  // Parse existing rules
  const lang = extractLangRules(blockMatch[2]);
  const rules = parseContainerRules(lang.css);
  if (rules.size === 0) { trace.action('rewriteBreakpoints:no-rules'); return code; }

  trace.action('rewriteBreakpoints:parsed', {
    ruleWidths: [...rules.keys()],
    hasOldWidth: rules.has(oldWidth),
    vpWidths: getSortedBreakpointWidths(),
  });

  // Move rules from oldWidth to newWidth — PLUS any ORPHAN band that resolves
  // to the resized viewport. A band keyed to a width that matches NO current
  // viewport (drift from an earlier resize whose sync didn't run) would
  // otherwise never move again: `rules.has(oldWidth)` misses it, every later
  // resize strands it further, and the tile silently loses all its overrides
  // ("mobile at 375 with its band keyed 756; resize → styles gone",
  // 2026-08-06). Ownership is resolved ORDINALLY — see resolveResizedKeys.
  if (oldWidth !== newWidth) {
    const oldVpWidths = getSortedBreakpointWidths().map(w => (w === newWidth ? oldWidth : w));
    const keysToMove = resolveResizedKeys([...rules.keys()], oldWidth, oldVpWidths);
    for (const key of keysToMove) {
      const oldRules = rules.get(key)!;
      rules.delete(key);
      if (!rules.has(newWidth)) rules.set(newWidth, new Map());
      const newRules = rules.get(newWidth)!;
      for (const [nodeId, props] of oldRules) {
        if (!newRules.has(nodeId)) newRules.set(nodeId, new Map());
        const existing = newRules.get(nodeId)!;
        for (const [k, v] of props) existing.set(k, v);
      }
      if (key !== oldWidth) trace.action('rewriteBreakpoints:orphan-band-claimed', { orphanKey: key, oldWidth, newWidth });
    }
  }

  // Re-serialize ALL rules with updated min-width boundaries.
  // Even if no rules moved, the min-width boundaries may have changed
  // (e.g. resizing mobile changes tablet's min-width boundary).
  const vpWidths = getSortedBreakpointWidths();

  let newCss = '\n';
  // Global :lang rules FIRST (banded :lang shares specificity; later wins).
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  const sortedWidths = [...rules.keys()].sort((a, b) => b - a);
  for (const width of sortedWidths) {
    const selectors = rules.get(width) ?? new Map<string, Map<string, string>>();
    const langRules = lang.banded.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpWidths, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}

/**
 * NORMALIZE band keys to the page's OWN `@canvas` viewport widths — the invariant every
 * exact-key consumer (the properties panel's override lookup, the resize rename, the
 * per-band renderer) silently assumes.
 *
 * Pages that lived through the config-revert era accumulated STRAY bands: config
 * `[1440, 564, 429]` next to rules keyed `[768, 656, 500, 463, 351]` (real find
 * 2026-08-06). The DOM still painted overrides — max-width bands whose floors were lost
 * OVERLAP, so a 564 tile catches the old 768 band by cascade accident — but the panel's
 * exact-key lookup found nothing ("override in the DOM, panel shows desktop"), and a
 * resize past every stray key lost all styles at once ("mobile resized big looks like
 * desktop"). The band model is EXCLUSIVE intervals (see getMinWidth); overlap is itself
 * corruption.
 *
 * Normal form: ONE band per non-primary viewport, keyed at that viewport's width. Each
 * viewport's band is the FLATTENED state its tile currently paints: all bands whose
 * interval covers the viewport width, merged in cascade order (serializers emit widest
 * first, so the NARROWEST matching band wins per prop). Banded :lang rules follow their
 * band. Strays covering NO viewport are dropped (no tile paints them — keeping them is
 * exactly the live-vs-canvas divergence this heals) and traced. Idempotent: keys already
 * ⊆ config widths → byte-identical no-op. Deterministic from the code string alone (the
 * config is read from the file, not from editor state).
 */
export function normalizeResponsiveBandKeys(code: string): string {
  const config = parseCanvasConfig(code);
  if (!config?.viewports?.length) return code;
  const primaryW = (config.viewports.find(v => v.isPrimary) ?? config.viewports.reduce((a, b) => (b.width > a.width ? b : a))).width;
  const nonPrimary = config.viewports.map(v => v.width).filter(w => w !== primaryW);
  if (nonPrimary.length === 0) return code;
  const vpSet = new Set(nonPrimary);

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  // CHEAP GATE (this runs in the mutation-flush pipeline): band keys + floors
  // straight off the headers; all keys already viewport-keyed → no-op.
  const bandHeaderRe = /@media\s*\(max-width:\s*([\d.]+)px\)(?:\s*and\s*\(min-width:\s*([\d.]+)px\))?/g;
  const floors = new Map<number, number>();
  let hm: RegExpExecArray | null;
  while ((hm = bandHeaderRe.exec(blockMatch[2]))) {
    floors.set(Number(hm[1]), hm[2] ? Number(hm[2]) : 0);
  }
  if (floors.size === 0) return code;
  if ([...floors.keys()].every(k => vpSet.has(k))) return code;

  const lang = extractLangRules(blockMatch[2]);
  const rules = parseContainerRules(lang.css);
  if (rules.size === 0) return code;

  // Flatten: per viewport, merge every band whose interval covers a REFERENCE
  // width, widest first, so the narrowest (= latest in serialized source,
  // cascade winner) band's value wins per prop.
  const bandKeysDesc = [...rules.keys()].sort((a, b) => b - a);
  const covers = (bandMax: number, w: number) => w <= bandMax && w >= (floors.get(bandMax) ?? 0);
  const claimed = new Set<number>();
  const flattenAt = (refW: number): { target: Map<string, Map<string, string>>; targetLang: string[] } => {
    const target = new Map<string, Map<string, string>>();
    const targetLang: string[] = [];
    for (const bandMax of bandKeysDesc) {
      if (!covers(bandMax, refW)) continue;
      claimed.add(bandMax);
      for (const [nodeId, props] of rules.get(bandMax)!) {
        if (!target.has(nodeId)) target.set(nodeId, new Map());
        const existing = target.get(nodeId)!;
        for (const [k, v] of props) existing.set(k, v);
      }
      for (const rule of lang.banded.get(bandMax) ?? []) targetLang.push(rule);
    }
    return { target, targetLang };
  };

  // Phase 1 — each viewport flattens what its tile paints TODAY.
  const merged = new Map<number, Map<string, Map<string, string>>>();
  const mergedLang = new Map<number, string[]>();
  const bandless: number[] = [];
  for (const vpW of nonPrimary) {
    if (!bandKeysDesc.some(b => covers(b, vpW))) { bandless.push(vpW); continue; }
    const { target, targetLang } = flattenAt(vpW);
    if (target.size > 0) merged.set(vpW, target);
    if (targetLang.length > 0) mergedLang.set(vpW, targetLang);
  }
  // Phase 2 — a viewport NO band covers was resized past its (drifted, never
  // renamed) band: the overrides still BELONG to that viewport (the user's
  // model: "the responsive overrides stay applied no matter how I resize").
  // Pair band-less viewports with leftover strays ORDINALLY (desc↔desc, the
  // resolveResizedKeys heuristic) and flatten at the STRAY's key — the full
  // cascade a tile at that width painted, i.e. the viewport's old look. Real
  // case 2026-08-06: config mobile already committed at 1310 while its
  // overrides sat in a stranded (max-width: 500px) band; interval-claiming
  // alone DROPPED them — exactly the loss being healed.
  if (bandless.length > 0) {
    const strays = bandKeysDesc.filter(b => !claimed.has(b));
    const bandlessDesc = [...bandless].sort((a, b) => b - a);
    for (let i = 0; i < bandlessDesc.length && i < strays.length; i++) {
      const vpW = bandlessDesc[i];
      const refW = strays[i];
      const { target, targetLang } = flattenAt(refW);
      if (target.size > 0) merged.set(vpW, target);
      if (targetLang.length > 0) mergedLang.set(vpW, targetLang);
      trace.action('generator:normalize-band-keys:stray-claim', { vpWidth: vpW, strayKey: refW });
    }
  }
  const dropped = bandKeysDesc.filter(k => !claimed.has(k));

  trace.action('generator:normalize-band-keys', {
    from: bandKeysDesc,
    to: [...merged.keys()],
    dropped,
  });

  // Serialize — identical shape to rewriteContainerBreakpoints, floors from
  // the config's own width set.
  const vpAll = config.viewports.map(v => v.width).sort((a, b) => b - a);
  let newCss = '\n';
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  for (const width of [...merged.keys()].sort((a, b) => b - a)) {
    const selectors = merged.get(width)!;
    const langRules = mergedLang.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpAll, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}

/**
 * Rewrite `data-responsive` attrs on component instances when a viewport width changes.
 * The per-viewport variant choice is keyed by viewport WIDTH (`{ "768": { initialVariant } }`)
 * and the breakpoint list is mirrored in `_bp` — both go STALE when a breakpoint is resized
 * (the keyed entry no longer matches any viewport, so the instance shows the wrong variant on
 * the resized tile). Mirrors `rewriteContainerBreakpoints`/`rewriteAnimationBreakpoints`:
 *   1. re-key the resized breakpoint's entry (oldWidth → newWidth), merging into any existing
 *      entry at newWidth;
 *   2. refresh `_bp` to the current sorted (descending) widths.
 * Runs across EVERY `data-responsive` in the file (page instances + canvas nodes). Must be
 * called AFTER syncViewportWidths so `newWidths` reflects the resize.
 */
export function rewriteResponsiveBreakpoints(
  code: string,
  oldWidth: number,
  newWidth: number,
  newWidths: number[],
): string {
  trace.fn('generator.rewriteResponsiveBreakpoints', { oldWidth, newWidth });
  const sortedBp = [...newWidths].sort((a, b) => b - a);
  // transformAllResponsiveAttrs handles BOTH the static string form and the
  // computed `={JSON.stringify({…})}` form (CMS field-refs), so an `item.field`
  // rebound on the resized viewport is re-keyed instead of being silently dropped.
  // Old width set = the new set with the resized entry swapped back — used to
  // claim ORPHAN keys (ordinal drift heal, mirrors rewriteContainerBreakpoints).
  const oldVpWidths = newWidths.map(w => (w === newWidth ? oldWidth : w));
  const out = transformAllResponsiveAttrs(code, (model) => {
    const newKey = String(newWidth);
    if (oldWidth !== newWidth) {
      const numericKeys = Object.keys(model.overrides).map(Number).filter(Number.isFinite);
      const keysToMove = resolveResizedKeys(numericKeys, oldWidth, oldVpWidths);
      for (const num of keysToMove) {
        const k = String(num);
        const entry = model.overrides[k];
        if (!entry) continue;
        delete model.overrides[k];
        model.overrides[newKey] = { ...(model.overrides[newKey] || {}), ...entry }; // merge if newKey exists
      }
    }
    if (model.bp.length) model.bp = sortedBp;
  });
  // Re-key responsive Collection List configs (useResponsiveListConfig calls) too.
  return rewriteListConfigBreakpoints(out, oldWidth, newWidth);
}

/**
 * Rewrite `useResponsiveText(primary, { <width>: <value> }, [<widths>])` calls when a viewport
 * width changes. Text overrides are width-keyed exactly like `data-responsive` — but they had NO
 * rewriter at all, so a resized viewport silently lost its per-viewport text (and the stale
 * vpWidths array corrupted the runtime bucketing for every other override too, 2026-08-06).
 * AST-located, minimal string splices (no whole-file regenerate): re-keys the resized width's
 * entry (plus ORPHAN keys that bucket to the resized viewport — same drift heal as the @media
 * rewriter) and replaces the vpWidths array literal with the current widths.
 */
export function rewriteResponsiveTextBreakpoints(
  code: string,
  oldWidth: number,
  newWidth: number,
  newWidths: number[],
): string {
  if (!code.includes('useResponsiveText(') || oldWidth === newWidth) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  const oldVpWidths = newWidths.map(w => (w === newWidth ? oldWidth : w));
  const sortedDesc = [...newWidths].sort((a, b) => b - a);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const keyOf = (keyNode: t.ObjectProperty['key']): number => (
    t.isNumericLiteral(keyNode) ? keyNode.value
      : t.isStringLiteral(keyNode) ? Number(keyNode.value)
      : t.isIdentifier(keyNode) ? Number(keyNode.name) : NaN
  );
  traverseAst(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee, { name: 'useResponsiveText' })) return;
      const [, overridesArg, widthsArg] = path.node.arguments;
      // Overrides object: rename numeric keys (resized + orphans resolved to
      // the resized viewport — ordinal drift heal, see resolveResizedKeys).
      if (overridesArg && t.isObjectExpression(overridesArg)) {
        const props = overridesArg.properties.filter((p): p is t.ObjectProperty => t.isObjectProperty(p));
        const numericKeys = props.map(p => keyOf(p.key)).filter(Number.isFinite);
        const claimed = new Set(resolveResizedKeys(numericKeys, oldWidth, oldVpWidths));
        for (const prop of props) {
          const keyNode = prop.key;
          const num = keyOf(keyNode);
          if (!Number.isFinite(num) || !claimed.has(num)) continue;
          if (keyNode.start != null && keyNode.end != null) {
            edits.push({ start: keyNode.start, end: keyNode.end, text: String(newWidth) });
          }
        }
      }
      // vpWidths array: replace wholesale with the current widths.
      if (widthsArg && t.isArrayExpression(widthsArg) && widthsArg.start != null && widthsArg.end != null) {
        edits.push({ start: widthsArg.start, end: widthsArg.end, text: `[${sortedDesc.join(', ')}]` });
      }
    },
  });
  if (edits.length === 0) return code;
  trace.fn('generator.rewriteResponsiveTextBreakpoints', { oldWidth, newWidth, editCount: edits.length });
  let out = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * ADD a newly-created viewport's width to every instance's `data-responsive`. Refreshes `_bp` to
 * the current sorted widths so the new breakpoint shows up INSTANTLY (not only after a later
 * resize), and — mirroring `copyContainerRulesToNewWidth` for @media — copies the source replica's
 * per-viewport variant entry to the new width when the source has one. No-op for code without
 * `data-responsive`.
 */
export function addResponsiveBreakpoint(
  code: string,
  newWidth: number,
  sourceWidth: number,
  newWidths: number[],
): string {
  trace.fn('generator.addResponsiveBreakpoint', { newWidth, sourceWidth });
  const sortedBp = [...newWidths].sort((a, b) => b - a);
  const out = transformAllResponsiveAttrs(code, (model) => {
    const srcKey = String(sourceWidth), newKey = String(newWidth);
    if (sourceWidth !== newWidth && model.overrides[srcKey] && !model.overrides[newKey]) {
      model.overrides[newKey] = { ...model.overrides[srcKey] }; // inherit source viewport's overrides (matches @media copy)
    }
    if (model.bp.length) model.bp = sortedBp;
  });
  return addListConfigBreakpoint(out, newWidth);
}

/**
 * REMOVE a deleted viewport's width from every instance's `data-responsive`: drop the keyed
 * per-viewport variant entry AND refresh `_bp` to the current sorted widths. No-op without
 * `data-responsive`.
 */
export function removeResponsiveBreakpoint(
  code: string,
  width: number,
  newWidths: number[],
): string {
  trace.fn('generator.removeResponsiveBreakpoint', { width });
  const sortedBp = [...newWidths].sort((a, b) => b - a);
  const out = transformAllResponsiveAttrs(code, (model) => {
    delete model.overrides[String(width)];
    if (model.bp.length) model.bp = sortedBp;
  });
  return removeListConfigBreakpoint(out, width);
}

/**
 * Copy @media rules from a source viewport width to a new viewport width.
 * Used when creating a new viewport from an existing replica — the new viewport
 * inherits all responsive overrides from the source.
 */
export function copyContainerRulesToNewWidth(
  code: string,
  sourceWidth: number,
  newWidth: number,
): string {
  trace.fn('generator.copyContainerRulesToNewWidth', { sourceWidth, newWidth });
  if (sourceWidth === newWidth) return code;

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  const lang = extractLangRules(blockMatch[2]);
  const rules = parseContainerRules(lang.css);
  if (!rules.has(sourceWidth)) return code; // Source has no rules to copy

  // Deep-copy source rules to the new width
  const sourceRules = rules.get(sourceWidth)!;
  if (!rules.has(newWidth)) rules.set(newWidth, new Map());
  const newRules = rules.get(newWidth)!;
  for (const [nodeId, props] of sourceRules) {
    if (!newRules.has(nodeId)) newRules.set(nodeId, new Map());
    const existing = newRules.get(nodeId)!;
    for (const [k, v] of props) existing.set(k, v);
  }

  // Re-serialize with fresh min-width boundaries
  const vpWidths = getSortedBreakpointWidths();

  let newCss = '\n';
  // Global :lang rules FIRST (banded :lang shares specificity; later wins).
  for (const rule of lang.topLevel) newCss += `    ${rule}\n`;
  const sortedWidths = [...rules.keys()].sort((a, b) => b - a);
  for (const width of sortedWidths) {
    const selectors = rules.get(width) ?? new Map<string, Map<string, string>>();
    const langRules = lang.banded.get(width) ?? [];
    if (selectors.size === 0 && langRules.length === 0) continue;
    const minW = getMinWidth(vpWidths, width);
    const query = minW
      ? `@media (max-width: ${width}px) and (min-width: ${minW + 0.02}px)`
      : `@media (max-width: ${width}px)`;
    newCss += `    ${query} {\n`;
    for (const [id, props] of selectors) {
      if (props.size === 0) continue;
      const decls = [...props.entries()].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
      newCss += `      [data-id="${id}"] { ${decls} }\n`;
    }
    for (const rule of langRules) newCss += `      ${rule}\n`;
    newCss += `    }\n`;
  }
  newCss += '  ';

  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCss + suffix + code.slice(blockMatch.index! + fullMatch.length);
}


// ─── Border Overlay (::after) ─────────────────────────────────────────────────

/**
 * Write or update a ::after border overlay rule for a node in the <style> block.
 * Creates the style block if it doesn't exist.
 */
/** Create the page/master `<style>` block, anchored as the ROOT element's
 *  first child. The legacy heuristic — first `}}>\n` anywhere in the file —
 *  picked ANY style-object close: in a component master that was a nested
 *  `<motion.svg>` (the Adore contact form, 2026-08-12), so the border/
 *  placeholder rules became children of a decorative svg — they rendered,
 *  but deleting that svg would silently take every rule with it, and the
 *  user hunting for the write near their input found nothing. Anchoring at
 *  the first `data-id` element after `return` (= the root in both the page
 *  and master dialects) makes the block's home stable and predictable; the
 *  legacy match stays as the fallback for exotic shapes. */
function createStyleBlockInCode(code: string, css: string): string {
  const retIdx = code.search(/\breturn\s*[(<]/);
  const idIdx = code.indexOf('data-id="', retIdx === -1 ? 0 : retIdx);
  if (idIdx !== -1) {
    const gt = findTagClose(code, idIdx);
    if (gt !== -1 && code[gt - 1] !== '/') {
      return code.slice(0, gt + 1) + `\n  <style>{\`${css}\`}</style>` + code.slice(gt + 1);
    }
  }
  const rootCloseMatch = code.match(/\}\}>\s*\n/);
  if (!rootCloseMatch) return code;
  const insertIdx = rootCloseMatch.index! + rootCloseMatch[0].length;
  return code.slice(0, insertIdx) + `  <style>{\`${css}\`}</style>\n` + code.slice(insertIdx);
}

/** DETACH carry: merge a master's `<style>` CSS — selectors ALREADY remapped
 *  to the fresh `det-` ids by detachInstance's style interception — into the
 *  page's single `<style>` block (created at the root when the page has
 *  none). A page must keep ONE block: every reader/writer's styleBlockRegex
 *  matches the first block only, so letting the master's element land as a
 *  second block made its rules invisible to the pseudo-parser and
 *  unremovable by the rule writers. Without the carry the rules silently
 *  vanished from preview/live — the canvas alone kept them via the instance
 *  afterCSS carry, which dies with the instance (the Adore form,
 *  2026-08-12). */
export function mergeDetachedStyleCSSIntoPage(pageCode: string, css: string): string {
  const trimmed = css.trim();
  if (!trimmed) return pageCode;
  trace.action('generator.mergeDetachedStyleCSSIntoPage', { cssLen: trimmed.length });
  const chunk = `\n    ${trimmed}\n  `;
  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(pageCode);
  if (blockMatch) {
    const [fullMatch, prefix, body, suffix] = blockMatch;
    return pageCode.slice(0, blockMatch.index!) + prefix + body + chunk + suffix + pageCode.slice(blockMatch.index! + fullMatch.length);
  }
  return createStyleBlockInCode(pageCode, chunk);
}

export function updateBorderOverlayStyle(code: string, nodeId: string, afterCSS: string): string {
  trace.fn('generator.updateBorderOverlayStyle', { nodeId, cssLen: afterCSS.length });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  // Target `data-id` — the attribute present in the SOURCE/preview/live output (the published runtime
  // never sets `data-node-id`, that's an editor-only stamp, so a `[data-node-id]::after` rule renders
  // ONLY in the canvas, never on the live site). The editor element also carries `data-id`, so this
  // works everywhere.
  const nodeIdEsc = escapeRegExp(nodeId);
  const selector = `[data-id="${nodeId}"]::after`;

  let existingCSS = blockMatch ? blockMatch[2] : '';

  // Replace any existing ::after rule for this node — match BOTH `data-id` AND legacy `data-node-id`
  // so an old (canvas-only) rule MIGRATES to `data-id` on the next write.
  const ruleRegex = new RegExp(`\\s*\\[data-(?:node-)?id="${nodeIdEsc}"\\]::after\\s*\\{[^}]*\\}`, 's');
  if (ruleRegex.test(existingCSS)) {
    existingCSS = existingCSS.replace(ruleRegex, `\n    ${selector} {\n${afterCSS}\n    }`);
  } else {
    existingCSS += `\n    ${selector} {\n${afterCSS}\n    }\n  `;
  }

  if (blockMatch) {
    const [fullMatch, prefix, , suffix] = blockMatch;
    return code.slice(0, blockMatch.index!) + prefix + existingCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
  } else {
    return createStyleBlockInCode(code, existingCSS);
  }
}

/**
 * Remove the ::after border overlay rule for a node from the <style> block.
 */
export function removeBorderOverlayStyle(code: string, nodeId: string): string {
  trace.fn('generator.removeBorderOverlayStyle', { nodeId });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  // Remove the node's ::after rule in EITHER form (`data-id` new / `data-node-id` legacy).
  const nodeIdEsc = escapeRegExp(nodeId);
  const ruleRegex = new RegExp(`\\s*\\[data-(?:node-)?id="${nodeIdEsc}"\\]::after\\s*\\{[^}]*\\}`, 's');

  const newCSS = blockMatch[2].replace(ruleRegex, '');
  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
}


// ─── Hover Style ─────────────────────────────────────────────────────────────

/**
 * Write or update a :hover rule for a node in the <style> block.
 * Creates the style block if it doesn't exist.
 * Each property gets !important. Empty string values are filtered out (remove property).
 * If all properties are empty, the rule is removed entirely.
 */
export function updateHoverStyleInCode(code: string, nodeId: string, styles: Record<string, string>): string {
  trace.fn('generator.updateHoverStyleInCode', { nodeId, styleCount: Object.keys(styles).length });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  const selector = `[data-id="${nodeId}"]:hover`;
  const selectorEsc = escapeRegExp(selector);

  // Build CSS body from non-empty properties
  const entries = Object.entries(styles).filter(([, v]) => v !== '');

  // If no properties remain, remove the rule entirely
  if (entries.length === 0) {
    return removeHoverStyleInCode(code, nodeId);
  }

  const cssBody = entries.map(([k, v]) => `      ${toKebab(k)}: ${v} !important;`).join('\n');

  let existingCSS = blockMatch ? blockMatch[2] : '';

  // Replace existing :hover rule or append new one
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');
  if (ruleRegex.test(existingCSS)) {
    existingCSS = existingCSS.replace(ruleRegex, `\n    ${selector} {\n${cssBody}\n    }`);
  } else {
    existingCSS += `\n    ${selector} {\n${cssBody}\n    }\n  `;
  }

  if (blockMatch) {
    const [fullMatch, prefix, , suffix] = blockMatch;
    return code.slice(0, blockMatch.index!) + prefix + existingCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
  } else {
    return createStyleBlockInCode(code, existingCSS);
  }
}

/**
 * Remove the :hover rule for a node from the <style> block.
 */
export function removeHoverStyleInCode(code: string, nodeId: string): string {
  trace.fn('generator.removeHoverStyleInCode', { nodeId });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  const selector = `[data-id="${nodeId}"]:hover`;
  const selectorEsc = escapeRegExp(selector);
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');

  const newCSS = blockMatch[2].replace(ruleRegex, '');
  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
}


// ─── Pseudo Rules (::before / ::after / ::placeholder) ──────────────────────

/**
 * Write or update a ::before / ::after / ::placeholder CSS rule in the
 * <style> block. Mirrors updateHoverStyleInCode but for pseudo selectors
 * (`placeholder` styles a form control's placeholder text — the Input tool's
 * Placeholder Color; inline style objects can't reach it).
 * Creates the style block if it doesn't exist.
 * Each property gets !important. Empty string values are filtered out.
 * If no properties remain, the rule is removed entirely.
 */
export function updatePseudoStyleInCode(
  code: string, nodeId: string, pseudo: 'before' | 'after' | 'placeholder', styles: Record<string, string>
): string {
  trace.fn('generator.updatePseudoStyleInCode', { nodeId, pseudo, styleCount: Object.keys(styles).length });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  const selector = `[data-id="${nodeId}"]::${pseudo}`;
  const selectorEsc = escapeRegExp(selector);

  const entries = Object.entries(styles).filter(([, v]) => v !== '');

  if (entries.length === 0) {
    return removePseudoStyleInCode(code, nodeId, pseudo);
  }

  const cssBody = entries.map(([k, v]) => `      ${toKebab(k)}: ${v} !important;`).join('\n');

  let existingCSS = blockMatch ? blockMatch[2] : '';

  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');
  if (ruleRegex.test(existingCSS)) {
    existingCSS = existingCSS.replace(ruleRegex, `\n    ${selector} {\n${cssBody}\n    }`);
  } else {
    existingCSS += `\n    ${selector} {\n${cssBody}\n    }\n  `;
  }

  if (blockMatch) {
    const [fullMatch, prefix, , suffix] = blockMatch;
    return code.slice(0, blockMatch.index!) + prefix + existingCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
  } else {
    return createStyleBlockInCode(code, existingCSS);
  }
}

/**
 * Remove a ::before / ::after / ::placeholder rule from the <style> block.
 */
export function removePseudoStyleInCode(code: string, nodeId: string, pseudo: 'before' | 'after' | 'placeholder'): string {
  trace.fn('generator.removePseudoStyleInCode', { nodeId, pseudo });

  const styleBlockRegex = /(<style>\s*\{[`'])([\s\S]*?)([`']\}\s*<\/style>)/s;
  const blockMatch = styleBlockRegex.exec(code);
  if (!blockMatch) return code;

  const selector = `[data-id="${nodeId}"]::${pseudo}`;
  const selectorEsc = escapeRegExp(selector);
  const ruleRegex = new RegExp(`\\s*${selectorEsc}\\s*\\{[^}]*\\}`, 's');

  const newCSS = blockMatch[2].replace(ruleRegex, '');
  const [fullMatch, prefix, , suffix] = blockMatch;
  return code.slice(0, blockMatch.index!) + prefix + newCSS + suffix + code.slice(blockMatch.index! + fullMatch.length);
}


// ─── Smooth Scroll ───────────────────────────────────────────────────────────

/**
 * Add or remove a smooth scroll onClick handler on a link element.
 * When enabled, generates: onClick={(e) => { e.preventDefault(); document.getElementById('sectionId')?.scrollIntoView({ behavior: 'smooth' }); }}
 * The section ID is extracted from the href (e.g. "/#pricing" → "pricing", "#faq" → "faq").
 * When disabled, removes the onClick handler.
 */
export function setSmoothScrollInCode(code: string, nodeId: string, enabled: boolean): string {
  trace.fn('generator.setSmoothScrollInCode', { nodeId, enabled });

  // Find the element by data-id (JSX occurrence, not CSS selector)
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return code;

  // Find the opening tag boundaries
  const tagStart = code.lastIndexOf('<', idIndex);
  // Find the closing > of this opening tag
  const tagEnd = findTagClose(code, idIndex);
  if (tagEnd === -1) return code;

  const tagContent = code.substring(tagStart, tagEnd + 1);

  // Extract the href to get the section ID
  const hrefMatch = tagContent.match(/href=(?:\{([^}]+)\}|"([^"]+)"|'([^']+)')/);
  const hrefValue = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '') : '';
  const hashIdx = hrefValue.indexOf('#');
  const sectionId = hashIdx !== -1 ? hrefValue.slice(hashIdx + 1) : '';

  // Remove ALL existing onClick handlers (brace-depth aware, handles nested { behavior: 'smooth' })
  let newTag = tagContent;
  let onClickIdx;
  while ((onClickIdx = newTag.indexOf('onClick={')) !== -1) {
    // Walk forward from the opening { counting depth
    let braceDepth = 0;
    let end = onClickIdx + 'onClick='.length;
    for (; end < newTag.length; end++) {
      if (newTag[end] === '{') braceDepth++;
      else if (newTag[end] === '}') { braceDepth--; if (braceDepth === 0) { end++; break; } }
    }
    // Remove the onClick including any leading whitespace
    const leadingWs = onClickIdx > 0 && newTag[onClickIdx - 1] === ' ' ? onClickIdx - 1 : onClickIdx;
    newTag = newTag.slice(0, leadingWs) + newTag.slice(end);
  }

  // The `data-smooth-scroll` MARKER is the toggle's source of truth (the onClick reads it at runtime). When
  // it's already a per-viewport BRACE (`data-smooth-scroll={…}`, written by the boolean-nav rail) leave it
  // ALONE — the LinkTool owns it then. Otherwise manage the LITERAL marker: on for ANY enabled link (not just
  // anchors — a variable href has no literal #section, but the per-viewport toggle still needs to persist).
  const hasBraceSmooth = /\bdata-smooth-scroll=\{/.test(newTag);
  if (!hasBraceSmooth) {
    newTag = newTag.replace(/\s*data-smooth-scroll="[^"]*"/g, '');
    if (enabled) {
      const handler = ` data-smooth-scroll="true"`;
      const closeMatch = newTag.match(/(\/?>)$/);
      if (closeMatch) {
        const insertPos = newTag.length - closeMatch[0].length;
        newTag = newTag.slice(0, insertPos) + handler + newTag.slice(insertPos);
      }
    }
  }

  if (newTag === tagContent) return code;
  return code.slice(0, tagStart) + newTag + code.slice(tagEnd + 1);
}

/**
 * Sync the single RUNTIME `onClick` on a link element — the SOLE owner of the
 * link's click behaviour, combining two features into one handler (a link can
 * only have one onClick):
 *   1. ANCHOR SCROLL — when the href has a `#hash`, scroll to it (smoothly if
 *      the smooth flag is on, instantly otherwise). Native `<Link>` hash scroll
 *      is unreliable in the preview/App Router, so we always handle it.
 *   2. KEEP PARAMS — when `data-keep-params` is on, forward the current page's
 *      query string to the destination (merge, don't clobber the link's own
 *      params) via `location.assign`.
 * All inputs (href, smooth flag, keep-params flag) read the element's actual
 * expressions (prop or literal), so it works for literal AND variable links.
 * Injected when anchor-capable OR keep-params is active; removed otherwise.
 */
export function syncLinkHandlerInCode(code: string, nodeId: string): string {
  trace.fn('generator.syncLinkHandlerInCode', { nodeId });

  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return code;

  const tagStart = code.lastIndexOf('<', idIndex);
  const tagEnd = findTagClose(code, idIndex);
  if (tagEnd === -1) return code;
  const tagContent = code.substring(tagStart, tagEnd + 1);

  // href value — expression `{EXPR}` (prop) or string literal "LIT".
  const hrefExprMatch = tagContent.match(/\bhref=\{([^}]+)\}/);
  const hrefLitMatch = tagContent.match(/\bhref="([^"]*)"/);
  const hrefIsExpr = !!hrefExprMatch;
  const hrefLit = hrefLitMatch ? hrefLitMatch[1] : null;
  const hrefExpr = hrefIsExpr
    ? hrefExprMatch![1].trim()
    : (hrefLit != null ? JSON.stringify(hrefLit) : null);

  // smooth flag → the behavior guard. Expression (variable) → use it raw
  // (`smooth ? 'true' : undefined`, truthy iff on); literal "true" → `true`;
  // absent/false → `false`. The handler scrolls EITHER way — smoothly when on,
  // instantly (`'auto'`) when off — so a plain anchor link still scrolls.
  // Read the RESOLVED `data-smooth-scroll` at runtime — so a per-viewport ternary on the attr
  // (`data-smooth-scroll={(__mq ? "true" : undefined)}`) is honoured on the live page (the matching breakpoint
  // renders "true"/omits it; `dataset.smoothScroll` reflects that). This makes the handler value-independent.
  const smoothGuard = "e.currentTarget.dataset.smoothScroll === 'true'";

  // keep-params flag → guard. Expression (variable) raw, literal "true" → true.
  const keepExprMatch = tagContent.match(/\bdata-keep-params=\{([^}]+)\}/);
  const keepLitMatch = tagContent.match(/\bdata-keep-params="([^"]*)"/);
  const keepActive = !!keepExprMatch || (keepLitMatch && keepLitMatch[1] === 'true');
  const keepGuard = keepExprMatch
    ? keepExprMatch[1].trim()
    : (keepLitMatch && keepLitMatch[1] === 'true' ? 'true' : 'false');

  // Inject for any ANCHOR-CAPABLE link (variable href, or literal href with `#`)
  // OR when keep-params is active. Plain non-anchor links with no param
  // forwarding keep native navigation and get no handler.
  const anchorCapable = hrefExpr != null && (hrefIsExpr || (hrefLit != null && hrefLit.includes('#')));
  const shouldInject = hrefExpr != null && (anchorCapable || keepActive);

  // Strip ONLY the onClick THIS function manages (the anchor-scroll / keep-params
  // handler), never a USER-authored handler — e.g. onClick={event2} added via the
  // Interactions tool, or a setVariant toggle. The managed handler is always an
  // inline arrow carrying our markers (scrollIntoView / _u.searchParams /
  // `const _h = String(`); anything else is the user's and must survive an href
  // edit (the "setting Link To wiped my click event" bug). If we DO need to inject
  // (anchor/keep-params) AND a user handler exists, MERGE it (a link can carry only
  // one onClick) by calling it first inside the managed handler.
  // (brace-depth aware — the handler body has nested braces.)
  let newTag = tagContent;
  let userHandlerExpr: string | null = null;
  let onClickIdx;
  while ((onClickIdx = newTag.indexOf('onClick={')) !== -1) {
    let braceDepth = 0;
    const bodyStart = onClickIdx + 'onClick={'.length;
    let end = onClickIdx + 'onClick='.length;
    for (; end < newTag.length; end++) {
      if (newTag[end] === '{') braceDepth++;
      else if (newTag[end] === '}') { braceDepth--; if (braceDepth === 0) { end++; break; } }
    }
    const handlerBody = newTag.slice(bodyStart, end - 1).trim();
    const isManaged = /scrollIntoView\(|_u\.searchParams|const _h = String\(/.test(handlerBody);
    if (!isManaged) {
      // User handler: keep it as-is when we're not injecting; otherwise capture
      // it to merge into the managed handler below.
      if (!shouldInject) break;
      userHandlerExpr = handlerBody;
    }
    const leadingWs = onClickIdx > 0 && newTag[onClickIdx - 1] === ' ' ? onClickIdx - 1 : onClickIdx;
    newTag = newTag.slice(0, leadingWs) + newTag.slice(end);
  }

  if (shouldInject) {
    // Combined handler: run the USER's handler first (preserved across href
    // edits), then anchor scroll (same-page), else keep-params forwarding. Each
    // guard is the element's actual flag expression.
    const userCall = userHandlerExpr ? `(${userHandlerExpr})?.(e); ` : '';
    // A link that is a COMPONENT ROOT forwards instance props via a JSX spread
    // ({...rest}). An onClick set on the INSTANCE (a Tap / Close-Overlay
    // interaction → onClick={event1}) arrives through that spread, but the
    // managed handler is emitted LAST so it wins on the element and SWALLOWS the
    // forwarded click (the "clicking the text doesn't close the overlay, only the
    // X does" bug). Compose it: invoke the spread object's `.onClick` from inside
    // the managed handler, exactly like a source-authored userCall. `?.` keeps it
    // a no-op when the spread carries no onClick; plain page links (no spread) are
    // unaffected.
    const spreadMatch = tagContent.match(/\{\.\.\.([A-Za-z_$][\w$]*)\}/);
    const spreadCall = spreadMatch ? `(${spreadMatch[1]}.onClick)?.(e); ` : '';
    if (spreadCall) trace.action('generator.syncLinkHandler.composeForwardedOnClick', { nodeId, spread: spreadMatch![1] });
    // Anchor hijack ONLY when the target element exists on THIS page. A
    // root-anchored hash link (`/#features`) clicked from ANOTHER route
    // (e.g. /blog) has no such element — the old unconditional
    // e.preventDefault() + `getElementById(...)?.scrollIntoView` swallowed
    // the click entirely and the nav appeared dead. On the cross-page case
    // the <Link> navigates client-side (default not prevented) — but SPA
    // routers do NO native hash scrolling, so the handler also polls for
    // the target to MOUNT on the destination page and scrolls to it then
    // (10s cap). If the click somehow triggers a full load instead, the
    // interval dies with the page and the browser's native hash handling
    // takes over — either way the section is reached.
    const body = `(e) => { ${userCall}${spreadCall}const _h = String((${hrefExpr}) ?? ''); const _id = _h.split('#')[1]; if (_id) { const _el = document.getElementById(_id); if (_el) { e.preventDefault(); _el.scrollIntoView({ behavior: (${smoothGuard}) ? 'smooth' : 'auto' }); return; } let _n = 0; const _t = setInterval(() => { const _el2 = document.getElementById(_id); if (_el2) { clearInterval(_t); _el2.scrollIntoView({ behavior: 'smooth' }); } else if (++_n > 100) { clearInterval(_t); } }, 100); return; } if ((${keepGuard}) && typeof window !== 'undefined' && window.location.search) { e.preventDefault(); const _u = new URL(_h, window.location.href); new URLSearchParams(window.location.search).forEach((v, k) => { if (!_u.searchParams.has(k)) _u.searchParams.set(k, v); }); window.location.assign(_u.pathname + _u.search + _u.hash); } }`;
    const handler = ` onClick={${body}}`;
    const closeMatch = newTag.match(/(\/?>)$/);
    if (closeMatch) {
      const insertPos = newTag.length - closeMatch[0].length;
      newTag = newTag.slice(0, insertPos) + handler + newTag.slice(insertPos);
    }
  }

  if (newTag === tagContent) return code;
  return code.slice(0, tagStart) + newTag + code.slice(tagEnd + 1);
}


/** True when `nodeId` lives in the module-scope `const canvasNodes = (<>…</>)`
 *  fragment (or carries the legacy `data-canvas-node="true"` marker). Such an
 *  element is OUTSIDE the component function, so it MUST NOT receive variant
 *  wiring — `initial={initialVariant}` / `initialVariant === …` ternaries
 *  reference the component's `initialVariant` FUNCTION PARAM, which is undefined
 *  at module scope. Injecting it parses fine but fails validation with
 *  "References undefined identifier: initialVariant — would crash at runtime",
 *  so the whole mutation batch is rejected and the drag/resize REVERTS on
 *  mouseup. Canvas nodes never participate in variants (see CLAUDE.md "Canvas
 *  Nodes"), so variant writes on them collapse to a plain inline-style write. */
function isNodeInCanvasNodes(code: string, nodeId: string): boolean {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return false;
  // Legacy inline marker on the element's own opening tag.
  const tagOpen = code.lastIndexOf('<', idIdx);
  const tagClose = code.indexOf('>', idIdx);
  if (tagOpen !== -1 && tagClose !== -1 && tagClose > tagOpen
      && code.slice(tagOpen, tagClose).includes('data-canvas-node="true"')) {
    return true;
  }
  // The `const canvasNodes = (<>…</>)` fragment is always emitted AFTER the
  // `export default` statement, so any node whose data-id sits past it is a
  // canvas node (and the component function — where `initialVariant` is bound —
  // sits entirely before it).
  const cnIdx = code.search(/\bconst\s+canvasNodes\s*=/);
  return cnIdx !== -1 && idIdx > cnIdx;
}

/** True when the node's JSX tag is `<svg>` or `<motion.svg>` (an SVG wrapper). */
function isSvgWrapperTag(code: string, nodeId: string): boolean {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return false;
  let s = idIdx;
  while (s > 0 && code[s] !== '<') s--;
  return /^(motion\.)?svg\b/.test(code.slice(s + 1, idIdx).trim());
}

/** Collapse an inline `prop: variant === … ? 'A' : 'B'` size ternary on the
 *  node's `style={{…}}` back to its DEFAULT (final else) branch as a static
 *  literal. Used when migrating svg size out of an inline ternary into the
 *  variants object — leaving the ternary would let resolveVariantStyles apply a
 *  stale conditional ON TOP of the variant value. No-op when the prop is already
 *  a static literal (no `?`). */
function collapseInlineSizeTernary(code: string, nodeId: string, props: string[]): string {
  let result = code;
  for (const prop of props) {
    const idIdx = findJSXDataIdIndex(result, nodeId);
    if (idIdx === -1) continue;
    const tagEnd = result.indexOf('>', idIdx);
    if (tagEnd === -1) continue;
    const styleRel = result.slice(idIdx, tagEnd).indexOf('style={{');
    if (styleRel === -1) continue;
    const objStart = idIdx + styleRel + 'style={{'.length;
    const posEnd = findStyleObjectEnd(result, objStart);
    const pos = posEnd === -1 ? result.length : posEnd;
    const styleContent = result.slice(objStart, pos);
    // Value runs to the next top-level comma or `}` — a ternary holds no commas.
    const re = new RegExp(`(\\b${prop}\\s*:\\s*)([^,}]+)`);
    const m = styleContent.match(re);
    if (!m || !m[2].includes('?')) continue;
    // Final `: 'x'` / `: "x"` of the (possibly nested) ternary = default branch.
    const elseMatch = m[2].match(/:\s*(?:'([^']*)'|"([^"]*)")\s*$/);
    if (!elseMatch) continue;
    const baseVal = elseMatch[1] ?? elseMatch[2] ?? '';
    const newContent = styleContent.replace(re, `$1'${baseVal}'`);
    result = result.slice(0, objStart) + newContent + result.slice(pos);
  }
  return result;
}

/** Upgrade the variant wiring of OUR OWN generated dialect from scalar names
 *  to VARIANT LISTS: `initial={['default', initialVariant]}` /
 *  `animate={['default', variant]}`. framer-motion resolves each name in the
 *  list and merges left-to-right, so every switch target is
 *  `{...default, ...own}` — true inheritance for SPARSE entries in PLAIN
 *  deployable source. With a scalar name, raw motion KEEPS the last animated
 *  value for any prop the new entry omits (real-Chromium probe 2026-06-12:
 *  rotate stayed at the old variant's 80°; `x` fell back to the svg x ATTR —
 *  a 92px jump). The default entry is the base layer — the generator's
 *  ensureDefaultHasBaseValues already guarantees it states a base for every
 *  prop any entry uses. Pure literal swap of generated wiring; user-authored
 *  motion props never match these exact forms. */
export function ensureVariantListWiring(code: string): string {
  if (!code.includes('initial={initialVariant}')
    && !code.includes('animate={variant}')
    && !code.includes('animate={initialVariant}')) return code;
  return code
    .replace(/initial=\{initialVariant\}/g, "initial={['default', initialVariant]}")
    .replace(/animate=\{variant\}/g, "animate={['default', variant]}")
    .replace(/animate=\{initialVariant\}/g, "animate={['default', initialVariant]}");
}

/** The animate-back seed for `nodeId`, per prop, in tier order: inline style →
 *  SVG presentation attr → motion-transform neutral → CSS initial
 *  (CSS_NEUTRAL_FALLBACK). Extracted from updateVariantStyleInCode's closure so
 *  healSparseVariantDefaults applies the IDENTICAL logic file-wide — two
 *  implementations of the seed would drift. `pivotStyles` is the in-flight
 *  write on the closure path (rotation-pivot mirror); the healer passes none. */
/**
 * Would seeding `key` into an entry that already reads `entryContent` DESTROY
 * values that are already there?
 *
 * The animate-back seed appends (`…, padding: '0px',`), and a SHORTHAND appended
 * after its longhands nullifies every one of them. Editing the tablet variant's
 * padding seeded `padding: '0px'` onto the `default` entry — behind
 * `paddingTop: '90px'` — so the primary tile lost all its padding and the
 * section collapsed (user report 2026-08-08). The seed exists to give motion a
 * return value for a prop the entry otherwise lacks; when the entry already
 * states that box side-by-side, it HAS a return value and the shorthand is pure
 * destruction. Same law as `mergeStyleLayers`: with shorthands, position is
 * load-bearing.
 */
function seedWouldClobberLonghands(key: string, entryContent: string): boolean {
  const longhands = SHORTHAND_LONGHANDS[key];
  if (!longhands) return false;
  return longhands.some((lh) => new RegExp(`(?:^|[,{\\s])['"]?${lh}['"]?\\s*:`).test(entryContent));
}

function readBaseValuesForNode(
  code: string,
  nodeId: string,
  props: string[],
  pivotStyles?: Record<string, string>,
): Record<string, string> {
  const currentIdIdx = findJSXDataIdIndex(code, nodeId);
  if (currentIdIdx === -1) return {};
  // Find style={{ after data-id — TAG-BOUND: only accept a style attr on
  // THIS tag. A styleless tag (e.g. a plain svg group child) must not read
  // the NEXT tag's style object — that leaked a sibling's transformBox into
  // this node's default entry as `x: 'fill-box'` (live find 2026-06-11;
  // the jsx-tag-bound-regex lesson's exact failure mode).
  const tagClose = findTagClose(code, currentIdIdx);
  const searchEnd = tagClose === -1 ? Math.min(code.length, currentIdIdx + 2000) : tagClose;
  const searchSlice = code.slice(currentIdIdx, searchEnd);
  // SVG PRESENTATION props (fill/stroke family) carry their BASE as TAG
  // ATTRS (`fill="#3b82f6"`, kebab `stroke-width="0"` or camel
  // `strokeWidth="13"`), not inline style — without this fallback the
  // animate-back seed silently skipped and a variant fill stuck on the
  // live site when switching back to default (live report 2026-06-12,
  // black fill never reverting to blue). Tag-bound: searchSlice only.
  // Box/geometry attrs (width/height/x/y/d) are deliberately EXCLUDED —
  // they belong to the attr channel, never to entry seeds.
  const attrBase = (prop: string): string | null => {
    if (!SVG_PRESENTATION_PROPS.has(prop)) return null;
    const kebab = toKebab(prop);
    for (const name of [prop, kebab]) {
      const m = searchSlice.match(new RegExp(`\\s${name}="([^"]*)"`));
      if (m) return m[1];
    }
    // No attr on the tag — the SVG spec default IS the base (except fill,
    // whose spec default of black is too destructive to assume; our shapes
    // always carry an explicit fill attr anyway).
    return SVG_PRESENTATION_DEFAULTS[prop] ?? null;
  };
  const styleStart = searchSlice.indexOf('style={{');
  if (styleStart === -1) {
    // No inline style on this tag — presentation props still seed from
    // ATTRS, and every requested motion transform prop needs its NEUTRAL
    // animate-back value on the default entry.
    const neutral: Record<string, string> = {};
    for (const prop of props) {
      const av = attrBase(prop);
      if (av != null) { neutral[prop] = av; continue; }
      if (prop in MOTION_TRANSFORM_NEUTRAL) { neutral[prop] = MOTION_TRANSFORM_NEUTRAL[prop]; continue; }
      // Plain CSS prop with no base anywhere → seed its CSS initial (see
      // CSS_NEUTRAL_FALLBACK — the sticky-residue class).
      if (prop in CSS_NEUTRAL_FALLBACK) neutral[prop] = CSS_NEUTRAL_FALLBACK[prop];
    }
    return neutral;
  }
  const styleObjStart = currentIdIdx + styleStart + 'style={{'.length;
  // Find matching }}
  const posEnd = findStyleObjectEnd(code, styleObjStart);
  const pos = posEnd === -1 ? code.length : posEnd;
  const styleContent = code.slice(styleObjStart, pos);
  const result: Record<string, string> = {};
  for (const prop of props) {
    // Match quoted OR unquoted-numeric inline values (motion props like
    // `rotate: 14.1` are unquoted). ANCHORED at a key boundary — an
    // unanchored `x\s*:` matched the trailing x of `transformBox:` and read
    // its value ('fill-box') as the x base (live find 2026-06-11).
    const propRegex = new RegExp(`(?:^|[,{\\s])${prop}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|(-?\\d+(?:\\.\\d+)?))`);
    const m = styleContent.match(propRegex);
    if (m) { result[prop] = m[1] ?? m[2] ?? m[3] ?? ''; continue; }
    // SVG presentation base from the tag's attrs (see attrBase above).
    const av = attrBase(prop);
    if (av != null) { result[prop] = av; continue; }
    // A motion TRANSFORM prop set in some other variant but absent from the
    // base/inline style needs an explicit NEUTRAL value on the default entry
    // — otherwise framer-motion has no target to animate BACK to (rotate
    // stays stuck when switching variant-1 → default). 0 for rotate/skew/
    // translate, 1 for scale.
    if (prop in MOTION_TRANSFORM_NEUTRAL) { result[prop] = MOTION_TRANSFORM_NEUTRAL[prop]; continue; }
    // Plain CSS prop with no inline/attr base → seed its CSS initial so the
    // default entry always states a return value (CSS_NEUTRAL_FALLBACK —
    // framer never resets props the target variant doesn't mention; a
    // mobile-only `flex`/`pointerEvents` stuck on desktop after a
    // breakpoint crossing, 2026-08-06).
    if (prop in CSS_NEUTRAL_FALLBACK) result[prop] = CSS_NEUTRAL_FALLBACK[prop];
  }
  // The rotation PIVOT (transformBox / transformOrigin) must be CONSTANT across
  // variants. If it lives ONLY on the rotated variant, motion animates the
  // origin into existence on the FIRST default→variant transition and the
  // rotation wobbles / springs (subsequent toggles are fine once it's
  // established). Mirror the pivot we're WRITING this pass onto the default
  // entry too — harmless there (origin is irrelevant when rotate is 0) and it
  // stops the origin from animating. No-op for non-rotation writes (styles has
  // no pivot props).
  if (pivotStyles) {
    for (const p of ['transformBox', 'transformOrigin']) {
      if (typeof pivotStyles[p] === 'string' && pivotStyles[p] !== '' && result[p] == null) {
        result[p] = pivotStyles[p];
      }
    }
  }
  return result;
}

/** Keys a variant entry can carry that must NEVER be seeded into the default
 *  entry: framer config objects (not styles) and SVG geometry (`d` belongs to
 *  the attr channel — a morph target must not be flattened into rest state). */
const VARIANT_SEED_SKIP_KEYS = new Set(['transition', 'transitionEnd', 'd']);

/** Index of the `}` matching the `{` at `openIdx` — string-aware. -1 if unbalanced. */
function findBraceEnd(code: string, openIdx: number): number {
  let depth = 0;
  let str: string | null = null;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Top-level entries of a variants OBJECT literal (`default: {…}, 'variant-4':
 *  {…}`), brace-aware — the flat `[^}]*` regexes elsewhere break on entries
 *  carrying `transition: {…}`. Returns null on any shape it doesn't recognise
 *  (spread, non-object value) so callers skip rather than guess. */
function parseVariantEntries(
  code: string,
  objOpen: number,
  objEnd: number,
): { name: string; bodyStart: number; bodyEnd: number }[] | null {
  const entries: { name: string; bodyStart: number; bodyEnd: number }[] = [];
  let i = objOpen + 1;
  while (i < objEnd) {
    while (i < objEnd && /[\s,]/.test(code[i])) i++;
    if (i >= objEnd) break;
    const keyM = code.slice(i, Math.min(i + 200, objEnd)).match(/^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*:/);
    if (!keyM) return null;
    const name = keyM[1] ?? keyM[2] ?? keyM[3];
    i += keyM[0].length;
    while (i < objEnd && /\s/.test(code[i])) i++;
    if (code[i] !== '{') return null;
    const bodyEnd = findBraceEnd(code, i);
    if (bodyEnd === -1 || bodyEnd > objEnd) return null;
    entries.push({ name, bodyStart: i, bodyEnd });
    i = bodyEnd + 1;
  }
  return entries;
}

/** Top-level KEYS of one entry's object body — depth-1 only, so `transition:
 *  { duration: 0.3 }` contributes `transition`, never `duration`. */
function topLevelObjectKeys(code: string, bodyStart: number, bodyEnd: number): string[] {
  const keys: string[] = [];
  let i = bodyStart + 1;
  while (i < bodyEnd) {
    while (i < bodyEnd && /[\s,]/.test(code[i])) i++;
    if (i >= bodyEnd) break;
    const keyM = code.slice(i, Math.min(i + 200, bodyEnd)).match(/^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*:/);
    if (!keyM) break;
    keys.push(keyM[1] ?? keyM[2] ?? keyM[3]);
    i += keyM[0].length;
    // Skip the VALUE up to the next top-level comma — string/bracket-aware.
    let depth = 0;
    let str: string | null = null;
    while (i < bodyEnd) {
      const ch = code[i];
      if (str) {
        if (ch === '\\') i++;
        else if (ch === str) str = null;
      } else if (ch === "'" || ch === '"' || ch === '`') str = ch;
      else if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      else if (ch === ',' && depth === 0) break;
      i++;
    }
  }
  return keys;
}

/** FILE-WIDE sparse-default heal — the root-cause repair for the sticky-residue
 *  class (live find 2026-08-06: a Nav built before CSS_NEUTRAL_FALLBACK carried
 *  `default: {}` next to `'variant-4': { flex: '1 0 0px' }`; framer-motion never
 *  resets a prop the target variant doesn't mention, so after ANY breakpoint
 *  pass through variant-4 the flex stuck on desktop until reload — "completely
 *  random" live-only breakage). The per-write heal in updateVariantStyleInCode
 *  only repairs the ONE entry being touched; a user can't know which node in a
 *  component is corrupted. This runs in the mutation-flush pipeline, so ANY
 *  edit to a file re-establishes the invariant ensureVariantListWiring depends
 *  on: the default entry states a base for every prop any entry animates.
 *
 *  Safety: seeds through the SAME readBaseValuesForNode tiers as the shipped
 *  per-write heal (identical values, strictly wider coverage); only ADDS keys
 *  missing from `default` (never touches an existing value); skips any object
 *  whose shape it doesn't fully recognise; and validates the spliced result
 *  with a real parse, reverting to the input on failure — the worst case is a
 *  no-op, never a corrupted file. Idempotent: pass 2 finds nothing missing. */
/** FILE-WIDE repair for a variant entry whose SHORTHAND sits behind its own
 *  longhands — `{ paddingTop: '90px', …, paddingLeft: '0px', padding: '0px' }`.
 *  Applied to the DOM in key order the trailing shorthand nullifies every side,
 *  so the entry silently paints as zero. Nothing authors that shape on purpose
 *  (this dialect always emits the shorthand FIRST); it is the signature of the
 *  animate-back seed appending one, which `seedWouldClobberLonghands` now
 *  prevents. Existing files stay broken until something rewrites them, so this
 *  repairs on any edit — the [[feedback_variant_default_css_initial_seed]]
 *  reasoning: the user can't know which node is corrupted.
 *
 *  Deletes only the STRANDED shorthand, never a value. Cheap precheck, no-op on
 *  clean files, validate-or-revert like its sibling healer. */
export function healStrandedVariantShorthands(code: string): string {
  if (code.indexOf('variants={') === -1) return code;
  const cuts: Array<{ start: number; end: number }> = [];
  const constRe = /\bconst\s+(\w+)\s*=\s*\{/g;
  let cm: RegExpExecArray | null;
  while ((cm = constRe.exec(code))) {
    const varName = cm[1];
    if (!new RegExp(`variants=\\{(?:__applyInstanceSize\\()?${varName}\\b`).test(code)) continue;
    const objOpen = cm.index + cm[0].length - 1;
    const objEnd = findBraceEnd(code, objOpen);
    if (objEnd === -1) continue;
    const entries = parseVariantEntries(code, objOpen, objEnd);
    if (!entries) continue;
    for (const e of entries) {
      const body = code.slice(e.bodyStart + 1, e.bodyEnd);
      for (const [shorthand, longhands] of Object.entries(SHORTHAND_LONGHANDS)) {
        const shortRe = new RegExp(`(?:^|[,{\\s])(['"]?${shorthand}['"]?\\s*:\\s*(?:'[^']*'|"[^"]*"|[^,}]+),?)`);
        const sm = shortRe.exec(body);
        if (!sm) continue;
        const shortAt = sm.index + sm[0].indexOf(sm[1]);
        // Stranded only when a longhand it governs is declared BEFORE it.
        const strandedBy = longhands.some((lh) => {
          const lm = new RegExp(`(?:^|[,{\\s])['"]?${lh}['"]?\\s*:`).exec(body);
          return !!lm && lm.index < shortAt;
        });
        if (!strandedBy) continue;
        const absStart = e.bodyStart + 1 + shortAt;
        cuts.push({ start: absStart, end: absStart + sm[1].length });
        trace.action('generator:heal-stranded-variant-shorthand', { varName, variant: e.name, shorthand });
      }
    }
  }
  if (cuts.length === 0) return code;
  let healed = code;
  for (const c of cuts.sort((a, b) => b.start - a.start)) {
    healed = healed.slice(0, c.start) + healed.slice(c.end);
  }
  try {
    parseJSX(healed);
  } catch {
    trace.error('generator:heal-stranded-variant-shorthand:revert', { count: cuts.length });
    return code;
  }
  return healed;
}

export function healSparseVariantDefaults(code: string): string {
  if (code.indexOf('variants={') === -1) return code;

  // WIRED objects only: a tag carrying both data-id and variants={Name}
  // (plain or __applyInstanceSize-wrapped). An unreferenced const is dead
  // weight, not animation state.
  const wired = new Map<string, string>(); // varName → nodeId
  const wireRe = /variants=\{(?:__applyInstanceSize\()?(\w+)/g;
  let wm: RegExpExecArray | null;
  while ((wm = wireRe.exec(code))) {
    let tagStart = wm.index;
    while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
    const tagClose = findTagClose(code, wm.index);
    const tagSlice = code.slice(tagStart, tagClose === -1 ? Math.min(code.length, wm.index + 2000) : tagClose);
    const idM = tagSlice.match(/data-id="([^"]*)"/);
    if (idM && !wired.has(wm[1])) wired.set(wm[1], idM[1]);
  }
  if (wired.size === 0) return code;

  // ONE pass for all const positions — a per-object regex would rescan the
  // whole file per variants object (flushNow runs this on every mouseup).
  const constOpen = new Map<string, number>(); // varName → index of its '{'
  const constRe = /\bconst\s+(\w+)\s*=\s*\{/g;
  let cm: RegExpExecArray | null;
  while ((cm = constRe.exec(code))) {
    if (wired.has(cm[1]) && !constOpen.has(cm[1])) constOpen.set(cm[1], cm.index + cm[0].length - 1);
  }

  const edits: { start: number; end: number; text: string }[] = [];
  for (const [varName, nodeId] of wired) {
    const objOpen = constOpen.get(varName);
    if (objOpen === undefined) continue;
    const objEnd = findBraceEnd(code, objOpen);
    if (objEnd === -1) continue;
    const entries = parseVariantEntries(code, objOpen, objEnd);
    if (!entries) continue;
    const def = entries.find((e) => e.name === 'default');
    if (!def) continue; // hand-authored shape without our base layer — leave alone
    const defaultKeys = new Set(topLevelObjectKeys(code, def.bodyStart, def.bodyEnd));
    const missing: string[] = [];
    for (const e of entries) {
      if (e.name === 'default') continue;
      for (const k of topLevelObjectKeys(code, e.bodyStart, e.bodyEnd)) {
        if (VARIANT_SEED_SKIP_KEYS.has(k) || defaultKeys.has(k) || missing.includes(k)) continue;
        missing.push(k);
      }
    }
    if (missing.length === 0) continue;
    const seed = readBaseValuesForNode(code, nodeId, missing);
    if (Object.keys(seed).length === 0) continue;
    let newInner = code.slice(def.bodyStart + 1, def.bodyEnd).trimEnd();
    for (const [k, v] of Object.entries(seed)) {
      // Same guard as the write path — a heal must never make a file worse.
      if (seedWouldClobberLonghands(k, newInner)) continue;
      if (newInner && !newInner.endsWith(',')) newInner += ',';
      const key = k.startsWith('--') ? `'${k}'` : k;
      // Motion transform props are numeric (unquoted), like the variant entries.
      const isMotionNum = MOTION_TRANSFORM_PROPS.has(k) && /^-?\d+(\.\d+)?$/.test(v);
      newInner += ` ${key}: ${isMotionNum ? v : quoteStyleValue(v)},`;
    }
    edits.push({ start: def.bodyStart + 1, end: def.bodyEnd, text: newInner });
    trace.action('generator:heal-sparse-variant-defaults', { nodeId, varName, seeded: Object.keys(seed) });
  }
  if (edits.length === 0) return code;

  let healed = code;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    healed = healed.slice(0, e.start) + e.text + healed.slice(e.end);
  }
  // VALIDATE-OR-REVERT: a heal must never make a file worse. Only runs when
  // something was actually seeded (rare — once per corrupted file), so the
  // parse cost never touches the hot no-op path.
  try {
    parseJSX(healed);
  } catch (err) {
    trace.error('generator:heal-sparse-variant-defaults-revert', { error: String(err) });
    return code;
  }
  return healed;
}

export function updateVariantStyleInCode(
  code: string,
  nodeId: string,
  variantName: string,
  styles: Record<string, string>,
): string {
  // Perf isolation ride-along: when this write makes the component's
  // variants animate a LAYOUT or PAINT-HEAVY prop (left/top/width/filter/
  // boxShadow/…), stamp `contain:'layout paint' + willChange:'transform'`
  // onto the root so per-frame tweens can't reflow/repaint the whole page
  // (the Illustration/Chat live-jank find). No-op otherwise; idempotent.
  return ensureRootPerfIsolation(updateVariantStyleInCodeImpl(code, nodeId, variantName, styles));
}

function updateVariantStyleInCodeImpl(
  code: string,
  nodeId: string,
  variantName: string,
  styles: Record<string, string>,
): string {
  // Reset-override translation: the panel's Rotate control registers under
  // `transform`, but the unified rotation channel stores `rotate` in the
  // entry. A `transform: ''` reset must clear BOTH keys or the entry's
  // rotate survives the reset (Reset Override appeared to do nothing).
  if (styles.transform === '' && styles.rotate === undefined) {
    styles = { ...styles, rotate: '' };
  }
  // INHERITANCE MODEL (the responsive-system parity, 2026-06-12): the source
  // stays SPARSE — a variant entry carries ONLY independently-touched values,
  // exactly like an @media override. Untouched variants INHERIT the primary:
  // the canvas merges the default entry under the variant entry
  // (resolveVariantStyles), and at RUNTIME (preview = deployed = raw source,
  // NO transformation) the variant-list wiring `animate={['default', variant]}`
  // makes framer-motion itself do the same merge. The earlier write-time
  // seeding (a since-removed pass stamping neutral rotate/x/y into EVERY
  // variant) silently DETACHED all variants on first touch —
  // primary edits stopped syncing ("overridden by zeros"), the user-reported
  // break.
  return ensureVariantListWiring(
    updateVariantStyleInCodeInner(code, nodeId, variantName, styles),
  );
}

function updateVariantStyleInCodeInner(
  code: string,
  nodeId: string,
  variantName: string,
  styles: Record<string, string>,
): string {
  trace.fn('generator.updateVariantStyleInCode', { nodeId, variantName, styles });

  // A framer-motion variant animates the SVG `d` ATTRIBUTE, which needs RAW path data (`M0,0 L5,5 Z`) —
  // NOT the CSS `path("…")` form that @media overrides use. The shape-edit overlay commits `d` pre-wrapped
  // as `path("…")` (correct for the @media branch); unwrap it here so the variant stores raw `d`. Left
  // wrapped, motion sets `d="path("…")"` which is an invalid path → the shape renders empty on the live
  // site (the canvas renderer happened to tolerate it). Other props pass through untouched.
  if (typeof styles.d === 'string' && styles.d) {
    const m = styles.d.trim().match(/^path\(\s*(['"])([\s\S]*?)\1\s*\)$/);
    if (m) styles = { ...styles, d: m[2] };
  }

  // SVG wrapper per-variant SIZE lives in the variants OBJECT (value-tween),
  // not an inline `style` ternary. `layout` (FLIP) can't project an <svg> root,
  // so a width/height ternary on a motion.svg never animates at runtime (the
  // height just doesn't move while left/top do). replica-context now routes svg
  // size here instead of to a ternary; if an OLDER write already left an inline
  // `width/height: variant === … ? 'A' : 'B'` ternary, collapse it to its
  // default (else) branch so the static base + the variants object are the only
  // source — otherwise resolveVariantStyles would carry a stale conditional too.
  // HTML children are untouched (they keep the ternary; FLIP works for them).
  const svgSizeKeys = Object.keys(styles).filter(k => k === 'width' || k === 'height');
  if (svgSizeKeys.length > 0 && isSvgWrapperTag(code, nodeId)) {
    code = collapseInlineSizeTernary(code, nodeId, svgSizeKeys);
  }

  // CSS custom properties (`--x`, e.g. an overlay-border variable detached per variant) must be
  // QUOTED keys in the variant object literal — a bare `--x:` is a JS syntax error. Normal CSS
  // prop keys are valid identifiers and stay bare. `emitKey` writes the right form; `keyPat`
  // matches either quoted or bare so existing entries are found regardless. No-ops for non-`--`
  // keys, so every existing variant-write path is byte-identical.
  const emitKey = (k: string) => (k.startsWith('--') ? `'${k}'` : k);
  const keyPat = (k: string) => (k.startsWith('--') ? `['"]?${k}['"]?` : k);

  // Step 1: Find the node's element in the JSX
  const idPattern = `data-id="${nodeId}"`;
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  // Canvas-node guard FIRST: a `const canvasNodes`-fragment / `data-canvas-node`
  // element renders at MODULE scope where `initialVariant` is undefined, so a
  // variant write that injects `variants={…} initial={initialVariant}` reverts
  // the drag/resize ("References undefined identifier: initialVariant" at
  // validate). Collapse it to a plain inline-style write — canvas nodes don't
  // participate in variants. EXCLUDE slot-hoisted `cn_` consts: those legitimately
  // carry a variants object (the slot mechanism drives them) and the existing
  // path below already skips their `initialVariant` injection.
  if (isNodeInCanvasNodes(code, nodeId) && !isIndexInsideSlotConst(code, idIdx)) {
    return updateNodeInCode(code, nodeId, styles);
  }

  // Component-instance routing happens FIRST — before the canvas-only-props
  // strip — because instance positioning (left/top) is meaningful (the
  // strip exists to clean up master root left/top, not instance left/top).
  //
  // When the JSX tag is a PascalCase component name (e.g.
  // `<RoFeWe data-id="...">`), framer-motion's `variants` prop is silently
  // ignored — the component doesn't forward it to a motion element. Worse,
  // the legacy code path below converts `<RoFeWe>` to `<motion.RoFeWe>`,
  // which framer-motion's tag proxy doesn't recognise and React then
  // renders as a literal `<rofewe>` HTML element (the bug the user
  // observed: nested instance disappears from preview). For component
  // instances we instead write per-parent-variant style values as inline
  // JSX ternaries on the `style` prop — those evaluate against the
  // parent's `initialVariant` (or `variant`) at runtime, giving the same
  // per-parent-variant behaviour without breaking the JSX.
  let tagStartScan = idIdx;
  while (tagStartScan > 0 && code[tagStartScan] !== '<') tagStartScan--;
  const tagNameMatch = code.slice(tagStartScan + 1).match(/^([A-Za-z][A-Za-z0-9]*)/);
  const isComponentInstanceTag = !!tagNameMatch
    && tagNameMatch[1].length > 0
    && tagNameMatch[1][0] === tagNameMatch[1][0].toUpperCase()
    && tagNameMatch[1] !== 'LayoutGroup'
    && tagNameMatch[1] !== 'MotionConfig'
    // MotionLink is `motion.create(Link)` — a REAL motion component that forwards
    // `variants`/`animate`, NOT a plain instance. Treating it as an instance routed
    // its per-variant styles to the inline-ternary path (setConditionalStyleInCode),
    // which corrupts comma values like `rgba(…)`. Let it use the variants object like
    // any motion.* element (the tag-conversion path already special-cases MotionLink).
    && tagNameMatch[1] !== 'MotionLink';
  // Normalize a raw CSS `transform` string into motion MOTION PROPS (rotate /
  // scale / x / y / skew) BEFORE the instance redirect AND the variant-object
  // path. On a motion.* element with `layout={true}` — INCLUDING the motion.div
  // an instance (e.g. a vector set) forwards its style to — a `transform` string
  // fights motion's FLIP projection (both write the same CSS `transform`), so the
  // rotation never shows / never animates on the live site. The independent
  // motion props compose with the projection instead; the canvas Renderer folds
  // them back to CSS for the static tile. For an INSTANCE we also clear any prior
  // inline `transform` ternary so the two forms can't coexist on the style.
  if (typeof styles.transform === 'string') {
    const tval = styles.transform;
    const { transform: _t, ...rest } = styles;
    if (tval === '' || tval === 'none') {
      // Reset → clear the rotation (never write `transform: 'none'`, which would
      // clobber motion's composed transform).
      //
      // Seeded BEFORE the spread so an EXPLICIT `rotate` from the caller wins —
      // see the matching comment in `updateNodeInCode`. A write that clears the
      // CSS string AND sets a motion prop in one batch (`{ transform: '',
      // rotate: '90' }` — what Paste Style sends for a transform) was collapsing
      // to `rotate: ''`, so the value never reached the variant entry.
      //
      // `transform: ''` seeded too: since the pure-translate gate below, a
      // centering pin lives in the entry as a `transform` STRING — dropping
      // the key on reset (the old `...rest` alone) left the stale translate
      // in the entry, so un-centering a pinned node displaced it up-left by
      // half its size again. NOT x/y: those hold svg group-child position
      // deltas — wiping them on a plain transform clear would snap the child.
      styles = { rotate: '', transform: '', ...rest };
    } else if (tval.trim() && /\b(rotate|scale|skew)/i.test(tval)) {
      const motion = cssTransformToMotionProps(tval);
      styles = Object.keys(motion).length > 0 ? { ...rest, ...motion } : styles;
    }
    // Pure `translate(...)` (a centering pin) is NOT converted — same gate as
    // `updateNodeInCode`. The inline style KEEPS the CSS string for pure
    // translates, so converting only the variant mirror to x/y put the SAME
    // shift in two channels: the canvas fold composes variant x/y ON TOP of
    // the inline transform → translate(-100%,-100%) → the node jumps up-left
    // by half its size on the tile (center-pin inside a master, user report
    // 2026-07-29). As a plain `transform` string the entry OVERRIDES the
    // identical inline value in the resolve merge instead of doubling it,
    // and motion still animates the string form on variant switches.
    if (isComponentInstanceTag && !('transform' in styles)) {
      styles = { ...styles, transform: '' };
    }
  }

  if (isComponentInstanceTag) {
    return writeInstanceConditionalStyles(code, nodeId, variantName, styles);
  }

  // Strip canvas-only positioning from variant entries for root elements.
  // Variant roots have position managed by variantConfig (x, y), not CSS left/top.
  // These values leak from the Renderer's canvas layout and should NOT go to code.
  const CANVAS_ONLY_PROPS = new Set(['left', 'top', 'right', 'bottom', 'position']);
  const isRootNode = !code.includes(`"${nodeId}"`) || (() => {
    // Check if this node is a root (no parent in the component) by seeing if it's the
    // first data-id in the return statement
    const returnIdx = code.indexOf('return');
    if (returnIdx === -1) return false;
    const afterReturn = code.slice(returnIdx);
    const firstDataId = afterReturn.match(/data-id="([^"]*)"/);
    return firstDataId?.[1] === nodeId;
  })();
  if (isRootNode) {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(styles)) {
      if (!CANVAS_ONLY_PROPS.has(k)) filtered[k] = v;
    }
    if (Object.keys(filtered).length === 0) return code;
    styles = filtered;
  }

  // Helper: read base values from inline style={{...}} for the changed properties.
  // motion needs default variant to have base values so it knows what to animate BACK to.
  // Module-level core (shared with healSparseVariantDefaults — the file-wide
  // heal must seed IDENTICAL values or the two paths drift). `styles` rides
  // along so the rotation-pivot mirror sees what this write carries.
  const readBaseValues = (props: string[]): Record<string, string> =>
    readBaseValuesForNode(code, nodeId, props, styles);

  // Props this write actually SETS. A `'' = remove` entry has nothing to
  // animate back FROM, so seeding a return value for it is backwards — and for
  // a shorthand it is destructive: clearing `padding` on the tablet variant
  // seeded `padding: '0px'` onto `default`, behind its longhands, and zeroed
  // the primary's padding (user report 2026-08-08).
  const setProps = Object.keys(styles).filter((k) => styles[k] !== '');

  // Check if this node has a variants={...} prop
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  const tagSlice = code.slice(idIdx, tagEnd);
  // Match `variants={fooVariants}` OR the instance-size-override wrapped form
  // `variants={__applyInstanceSize(fooVariants, …)}` — capture the object name.
  const variantsMatch = tagSlice.match(/variants=\{(?:__applyInstanceSize\()?(\w+)/);

  let variantsVarName: string;

  if (variantsMatch) {
    // Node already has a variants prop
    variantsVarName = variantsMatch[1];
  } else {
    // Node doesn't have variants prop — create one
    variantsVarName = nodeId.replace(/-(.)/g, (_, c) => c.toUpperCase()).replace(/-/g, '') + 'Variants';

    // ORPHAN-CONST GUARD: a `<name>Variants` const can already exist at
    // module scope while the TAG carries no variants prop (an earlier
    // conversion failed half-way, or an edit stripped the prop but kept the
    // const). Re-declaring it is a duplicate-identifier crash the mutation
    // validator blocks-and-reverts (live find 2026-06-12: a plain-<svg> path
    // wrapper dragged in a group replica). Reuse the existing const: skip the
    // declaration, still wire the tag up (prop + motionize below), then FALL
    // THROUGH to the update-existing path so the entry lands in that const.
    const orphanConstExists = new RegExp(`\\bconst\\s+${variantsVarName}\\s*=`).test(code);

    if (!orphanConstExists) {
    // Read base values from inline style for the properties being set in this variant.
    // default entry must have these so framer-motion knows what to animate back to.
    const baseValues = readBaseValues(Object.keys(styles));
    const defaultProps = Object.keys(baseValues).length > 0
      ? '{ ' + Object.entries(baseValues).map(([k, v]) =>
          // Motion transform props are numeric (unquoted), like the variant entries.
          `${emitKey(k)}: ${MOTION_TRANSFORM_PROPS.has(k) && /^-?\d+(\.\d+)?$/.test(v) ? v : quoteStyleValue(v)}`
        ).join(', ') + ' }'
      : '{}';
    const NUMERIC_INIT = new Set(['order', 'opacity', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'x', 'y', 'z', 'transformPerspective']);
    // Filter empty-string values on non-default variants — they mean "no
    // override / inherit from default". Without this filter, drag-into-
    // layout flows that write `{ position: 'relative', left: '', ... }`
    // would persist literal empty strings in the new variants const,
    // and framer-motion would clear the inline width/height on render —
    // visible as the element collapsing to zero content size when the
    // variant became active. Mirror of the same fix in the
    // update-existing-variants path below.
    // Empty = remove the property → never write `key: ''` into ANY variant
    // (default included). On default a literal `background: ''` shorthand
    // wipes a sibling `backgroundColor` at render time (see the
    // update-existing path below for the full story).
    const styleEntriesForVariant = Object.entries(styles).filter(([, v]) => v !== '');
    if (styleEntriesForVariant.length === 0) {
      // Nothing meaningful to write — skip creating the variants const.
      return code;
    }
    const variantProps = styleEntriesForVariant.map(([k, v]) => {
      const isNum = NUMERIC_INIT.has(k) && /^-?\d+(\.\d+)?$/.test(v);
      return `${emitKey(k)}: ${isNum ? v : `'${v}'`}`;
    }).join(', ');
    // When variantName is 'default', merge styles into the single default entry
    // (don't create separate `default: {}` and `'default': { ... }` — same JS key, parser reads first only)
    let variantsConst: string;
    if (variantName === 'default') {
      // Drop empty-string values — `key: ''` in default renders as an empty
      // (and an empty `background` shorthand wipes a sibling backgroundColor).
      const mergedEntries: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...baseValues, ...styles })) {
        if (v !== '') mergedEntries[k] = v;
      }
      const mergedProps = Object.entries(mergedEntries).map(([k, v]) => {
        const isNum = NUMERIC_INIT.has(k) && /^-?\d+(\.\d+)?$/.test(v);
        return `${emitKey(k)}: ${isNum ? v : `'${v}'`}`;
      }).join(', ');
      variantsConst = `const ${variantsVarName} = {\n  default: { ${mergedProps} },\n};\n\n`;
    } else {
      variantsConst = `const ${variantsVarName} = {\n  default: ${defaultProps},\n  '${variantName}': { ${variantProps} },\n};\n\n`;
    }

    // Insert the const at the earliest of:
    //  (a) before the first `const cn_…` slot-hoisted decl, if any — those
    //      decls reference `variants={…}` at MODULE scope, so the variants
    //      object MUST be declared before them to avoid a TDZ ReferenceError
    //      at module load.
    //  (b) before the component function declaration (legacy path).
    //
    // Handles both function patterns:
    // - export default function Name(...)
    // - function Name(...) + export default withResponsiveProps(Name)
    let exportIdx = code.indexOf('export default function');
    if (exportIdx === -1) {
      // Try: standalone function declaration (used with withResponsiveProps wrapper)
      const funcMatch = code.match(/^function\s+\w+\s*\(/m);
      exportIdx = funcMatch ? code.indexOf(funcMatch[0]) : -1;
    }
    const firstCnMatch = code.match(/\bconst\s+cn_\w+\s*=/);
    const firstCnIdx = firstCnMatch ? code.indexOf(firstCnMatch[0]) : -1;
    let insertIdx = exportIdx;
    if (firstCnIdx !== -1 && (insertIdx === -1 || firstCnIdx < insertIdx)) {
      insertIdx = firstCnIdx;
    }
    if (insertIdx === -1) return updateNodeInCode(code, nodeId, styles);
    code = code.slice(0, insertIdx) + variantsConst + code.slice(insertIdx);
    }

    // Add variants={...} prop AND convert tag to motion.*
    const newIdIdx = findJSXDataIdIndex(code, nodeId);
    if (newIdIdx === -1) return code;

    // Add variants prop after data-id, plus THIS element's OWN `animate`/`initial`.
    //
    // EVERY variant element needs its own `animate` keyed on THIS component's
    // variant. Relying on framer-motion's parent→child variant propagation
    // (only the first/root element carrying `animate`) breaks across COMPONENT
    // boundaries: a child with `variants` but no `animate`, when this component
    // is rendered INSIDE another variant component, inherits the OUTER
    // component's variant — so two siblings land in different states (reported:
    // a nested menu's top bar rotated while the bottom stayed straight).
    //
    // Skip only when this element already carries `animate` (e.g. a connection
    // trigger) or it's a module-scope slot const (`initialVariant` is undefined
    // there). Use `animate={variant}` when connections are wired, else
    // `initialVariant` — via detectVariantVar.
    const inSlotConst = isIndexInsideSlotConst(code, newIdIdx);
    const s1TagEnd = findTagClose(code, newIdIdx);
    const s1Tag = s1TagEnd !== -1 ? code.slice(newIdIdx, s1TagEnd) : '';
    const s1HasAnimate = s1Tag.includes('animate={');
    // An APPEAR element already carries an OBJECT-form `initial` ({opacity, y}).
    // Adding the variant-array initial too emits a DUPLICATE JSX attribute —
    // React keeps the LAST (killing the appear) while the parser reads the
    // FIRST, and the pre-flush validator then blocks EVERY edit to the file
    // ("make a section with appears into a component → background change
    // blocked", 2026-07-28). Keep the object initial and inject only `animate`:
    // motion animates from the appear state INTO the variant labels on mount —
    // exactly the appear semantic (same rule as the connection-config root
    // guard, live find 2026-07-03).
    const s1HasInitial = s1Tag.includes(' initial={');
    const animateProps = (!inSlotConst && !s1HasAnimate)
      ? (s1HasInitial
        ? ` animate={['default', ${detectVariantVar(code)}]}`
        : ` initial={['default', initialVariant]} animate={['default', ${detectVariantVar(code)}]}`)
      : '';
    const insertAfter = newIdIdx + idPattern.length;
    code = code.slice(0, insertAfter) + ` variants={${variantsVarName}}${animateProps}` + code.slice(insertAfter);

    // Add framer-motion import if not present
    if (!code.includes("from 'framer-motion'") && !code.includes('from "framer-motion"')) {
      let importInsertIdx = code.indexOf('export default function');
      if (importInsertIdx === -1) {
        const funcMatch2 = code.match(/^function\s+\w+\s*\(/m);
        importInsertIdx = funcMatch2 ? code.indexOf(funcMatch2[0]) : -1;
      }
      if (importInsertIdx !== -1) {
        code = code.slice(0, importInsertIdx) + "import { motion } from 'framer-motion';\n\n" + code.slice(importInsertIdx);
      }
    }

    // Convert <tagName to <motion.tagName (find the < before data-id)
    const updatedIdIdx = findJSXDataIdIndex(code, nodeId);
    let tagStart = updatedIdIdx;
    while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
    const afterLt = tagStart + 1;
    // Extract current tag name
    const tagMatch = code.slice(afterLt).match(/^(\w+)/);
    if (tagMatch) {
      const currentTag = tagMatch[1];
      // Only convert if not already motion.* — and never wrap `MotionLink`
      // (it's already a `motion.create(Link)` component; `motion.MotionLink`
      // is invalid and would self-heal-strip back, churning the file).
      if (!currentTag.startsWith('motion') && currentTag !== 'MotionLink') {
        code = code.slice(0, afterLt) + `motion.${currentTag}` + code.slice(afterLt + currentTag.length);
        // Also convert the MATCHING closing tag </tagName> → </motion.tagName>.
        // DEPTH-COUNT to skip nested same-tag children: an SVG GROUP is
        // `<svg>…<svg>…</svg>…</svg>`, so a plain `indexOf('</svg>')` would hit a
        // CHILD's closing and produce `<svg>…</motion.svg>` mismatched tags — the
        // "Expected corresponding JSX closing tag" crash when dragging a vector
        // group into a variant. (Open token `<svg` doesn't match the now-converted
        // `<motion.svg` opening, so only the un-converted nested opens are counted.)
        const closeTok = `</${currentTag}>`;
        const openEnd = code.indexOf('>', findJSXDataIdIndex(code, nodeId));
        if (openEnd !== -1) {
          const closingIdx = findMatchingCloseTagIndex(code, currentTag, openEnd + 1);
          if (closingIdx !== -1) {
            code = code.slice(0, closingIdx) + `</motion.${currentTag}>` + code.slice(closingIdx + closeTok.length);
          }
        }
      }
    }

    if (!orphanConstExists) return code;
    // Orphan const: the tag is wired now — fall through to Step 2 so the
    // variant entry is written into the EXISTING const.
  }

  // Step 2: Update existing variants object
  const constPattern = `const ${variantsVarName}`;
  const constIdx = code.indexOf(constPattern);
  if (constIdx === -1) return code;

  // Ensure THIS variant element has its own animate/initial (may be missing on
  // older components, or when it wasn't the first element to get a variant).
  // Every variant element needs its own animate — see the create-path comment
  // above for why propagation across component boundaries fails. Checked against
  // THIS element's own tag (by data-id) so a sibling's animate doesn't suppress
  // it.
  const s2IdIdx = findJSXDataIdIndex(code, nodeId);
  const s2TagEnd = s2IdIdx !== -1 ? findTagClose(code, s2IdIdx) : -1;
  const s2Tag = s2IdIdx !== -1 && s2TagEnd !== -1 ? code.slice(s2IdIdx, s2TagEnd) : '';
  const thisAlreadyHasAnimate = s2Tag.includes('animate={');
  if (!thisAlreadyHasAnimate) {
    const variantsPropIdx = code.indexOf(`variants={${variantsVarName}}`);
    // Skip slot-hoisted consts — `initialVariant` is a function param and
    // can't be referenced from module scope (would crash with
    // `ReferenceError: initialVariant is not defined` on module load).
    if (variantsPropIdx !== -1 && !isIndexInsideSlotConst(code, variantsPropIdx)) {
      const afterVariants = variantsPropIdx + `variants={${variantsVarName}}`.length;
      // Same appear guard as the create-path above: an existing object-form
      // `initial` must not be doubled — inject only `animate` then.
      const s2Props = s2Tag.includes(' initial={')
        ? ` animate={['default', ${detectVariantVar(code)}]}`
        : ` initial={['default', initialVariant]} animate={['default', ${detectVariantVar(code)}]}`;
      code = code.slice(0, afterVariants) + s2Props + code.slice(afterVariants);
    }
  }

  // Find the variant entry: variantName: { ... } or 'variantName': { ... }
  // BOUNDED to THIS const's body. `code.slice(constIdx)` searched the rest
  // of the FILE: when this const lacked the entry, the regex matched the
  // NEXT const's entry — a replica GROUP resize wrote its box into the
  // grandchild path's variants const and the group snapped back on mouseup
  // (BiNuWe debug diff 2026-06-12: width/height/left/top landed beside the
  // d in shape…G0Variants while vector…Variants never got the entry).
  const constBodyEnd = (() => {
    const open = code.indexOf('{', constIdx);
    if (open === -1) return -1;
    let depth = 0;
    let str: string | null = null;
    for (let i = open; i < code.length; i++) {
      const ch = code[i];
      if (str) {
        if (ch === '\\') { i++; continue; }
        if (ch === str) str = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  })();
  // +2 keeps the closing `};` in the slice — the create-entry path below
  // locates its insert position via `afterConst.indexOf('};')`.
  const afterConst = constBodyEnd !== -1 ? code.slice(constIdx, Math.min(constBodyEnd + 2, code.length)) : code.slice(constIdx);
  const variantEntryRegex = new RegExp(`('?${variantName}'?\\s*:\\s*\\{)([^}]*)(\\})`);
  const entryMatch = afterConst.match(variantEntryRegex);

  // Helper: ensure the default entry has base values for the properties being changed.
  // Without this, framer-motion doesn't know what to animate BACK to when switching to default.
  const ensureDefaultHasBaseValues = (result: string, props: string[]): string => {
    // HEAL: props the target variant entry ALREADY carries need a default
    // base too — older writes predate the attr-fallback seeding (a stuck
    // variant fill never reverted on the live site because `default: {}`
    // had no return value). Union them in; the per-key only-if-missing
    // guard below keeps existing default values untouched.
    if (variantName !== 'default') {
      const cIdx0 = result.indexOf(`const ${variantsVarName}`);
      if (cIdx0 !== -1) {
        const entryM = result.slice(cIdx0).match(new RegExp(`'?${variantName}'?\\s*:\\s*\\{([^}]*)\\}`));
        if (entryM) {
          const keyRe = /(?:^|[,{\s])['"]?([A-Za-z][\w-]*)['"]?\s*:/g;
          let km: RegExpExecArray | null;
          const extra: string[] = [];
          while ((km = keyRe.exec(entryM[1]))) {
            if (!props.includes(km[1])) extra.push(km[1]);
          }
          if (extra.length > 0) props = [...props, ...extra];
        }
      }
    }
    const baseValues = readBaseValues(props);
    if (Object.keys(baseValues).length === 0) return result;
    // Find default: { ... } in the variants const
    const cIdx = result.indexOf(`const ${variantsVarName}`);
    if (cIdx === -1) return result;
    // Bounded to the const body (same leak class as the entry search above).
    const cOpen = result.indexOf('{', cIdx);
    let cDepth = 0, cEnd = -1;
    let cStr: string | null = null;
    for (let i = cOpen; i >= 0 && i < result.length; i++) {
      const ch = result[i];
      if (cStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === cStr) cStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { cStr = ch; continue; }
      if (ch === '{') cDepth++;
      else if (ch === '}') { cDepth--; if (cDepth === 0) { cEnd = i; break; } }
    }
    const afterC = cEnd !== -1 ? result.slice(cIdx, cEnd + 1) : result.slice(cIdx);
    const defaultMatch = afterC.match(/(default\s*:\s*\{)([^}]*?)(\})/);
    if (!defaultMatch) return result;
    let defaultContent = defaultMatch[2];
    for (const [key, value] of Object.entries(baseValues)) {
      // Never let a shorthand seed land behind the longhands it would nullify.
      if (seedWouldClobberLonghands(key, defaultContent)) continue;
      // Only add if not already in default entry
      if (!new RegExp(`${keyPat(key)}\\s*:`).test(defaultContent)) {
        defaultContent = defaultContent.trimEnd();
        if (defaultContent && !defaultContent.endsWith(',')) defaultContent += ',';
        // Motion transform props are numeric (unquoted), like the variant entries.
        const isMotionNum = MOTION_TRANSFORM_PROPS.has(key) && /^-?\d+(\.\d+)?$/.test(value);
        defaultContent += ` ${emitKey(key)}: ${isMotionNum ? value : quoteStyleValue(value)},`;
      }
    }
    const dmStart = cIdx + afterC.indexOf(defaultMatch[0]);
    const dmEnd = dmStart + defaultMatch[0].length;
    return result.slice(0, dmStart) + defaultMatch[1] + defaultContent + defaultMatch[3] + result.slice(dmEnd);
  };

  /**
   * VARIANT_OBJECT_MISSING_ENTRY — a transform animated on SOME variants needs a
   * NEUTRAL entry on the others.
   *
   * framer-motion keeps the LAST animated transform when it switches to a
   * variant whose entry doesn't mention that prop, so the element sticks
   * mid-state: rotate a card on variant-1, switch to variant-2, and it stays
   * rotated. `ensureDefaultHasBaseValues` covers the animate-back to `default`
   * only — every OTHER declared variant has the same problem, and a component
   * built entirely in the editor carried three of these (user report
   * 2026-07-26).
   *
   * Seeds only the props being written, only into variants that exist in
   * `variantConfig`, and only where the entry doesn't already state one — so an
   * intentional per-variant value is never touched.
   */
  /** The `default` entry's current value for a prop — the rest state every
   *  variant inherits when it states nothing of its own. */
  const defaultEntryValue = (code2: string, key: string): string | null => {
    const cIdx = code2.indexOf(`const ${variantsVarName}`);
    if (cIdx === -1) return null;
    const dm = code2.slice(cIdx).match(/default\s*:\s*\{([^}]*)\}/);
    if (!dm) return null;
    const vm = dm[1].match(new RegExp(`${keyPat(key)}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|(-?\\d+(?:\\.\\d+)?))`));
    return vm ? (vm[1] ?? vm[2] ?? vm[3] ?? null) : null;
  };

  const ensureTransformNeutralOnAllVariants = (result: string, props: string[]): string => {
    const motionProps = props.filter((k) => MOTION_TRANSFORM_PROPS.has(k));
    if (motionProps.length === 0) return result;
    const names = parseVariantConfig(result).map((v: { name: string }) => v.name).filter((n: string) => !!n && n !== 'default');
    if (names.length === 0) return result;
    let out = result;
    for (const name of names) {
      const cIdx = out.indexOf(`const ${variantsVarName}`);
      if (cIdx === -1) break;
      const m = out.slice(cIdx).match(new RegExp(`(['"]?${name}['"]?\\s*:\\s*\\{)([^}]*?)(\\})`));
      if (!m) {
        // NO entry at all for this variant. It still needs one: motion keeps the
        // LAST animated transform when it switches here, so the element arrives
        // stuck mid-state. Create the entry holding the REST value (what the
        // canvas already renders for this variant), so nothing changes visually
        // and motion has a target.
        const openIdx = out.indexOf('{', cIdx);
        if (openIdx === -1) continue;
        const seeded = motionProps.map((k) => {
          const rest = defaultEntryValue(out, k) ?? readBaseValues([k])[k] ?? MOTION_TRANSFORM_NEUTRAL[k] ?? '0';
          return `${emitKey(k)}: ${rest}`;
        }).join(', ');
        out = out.slice(0, openIdx + 1) + `\n  '${name}': { ${seeded} },` + out.slice(openIdx + 1);
        continue;
      }
      let content = m[2];
      let changed = false;
      for (const k of motionProps) {
        if (new RegExp(`${keyPat(k)}\\s*:`).test(content)) continue;
        // Seed what this variant ALREADY RENDERS at rest, not a blind neutral.
        // The canvas merges `default` under each variant, so a variant that
        // states nothing shows default's value — writing the neutral there would
        // silently CHANGE it (default rotate 45 → the variant snaps to 0). The
        // point is to give motion an explicit target, not to alter the design.
        // Falls back through the inline/attr base to the neutral when nothing
        // states a rest value.
        const restValue = defaultEntryValue(out, k) ?? readBaseValues([k])[k] ?? MOTION_TRANSFORM_NEUTRAL[k] ?? '0';
        content = content.trimEnd();
        if (content && !content.endsWith(',')) content += ',';
        content += ` ${emitKey(k)}: ${restValue},`;
        changed = true;
      }
      if (!changed) continue;
      const mStart = cIdx + out.slice(cIdx).indexOf(m[0]);
      out = out.slice(0, mStart) + m[1] + content + m[3] + out.slice(mStart + m[0].length);
    }
    return out;
  };

  if (entryMatch) {
    // Variant entry exists — update/add properties
    let entryContent = entryMatch[2];

    // Properties that should be numeric (no quotes) in variant entries
    const NUMERIC_PROPS = new Set(['order', 'opacity', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'x', 'y', 'z', 'transformPerspective', 'attrX', 'attrY']);
    for (const [key, value] of Object.entries(styles)) {
      // Empty-string value on a NON-default variant means "reset
      // override" — the user clicked Reset Override in the ControlLabel
      // menu, OR an atom is clearing the variant-specific value so the
      // node falls back to the default variant's value. framer-motion
      // resolves missing keys by inheriting from `default`, so the
      // correct shape is to DELETE the key from this variant's entry
      // (and from the property's `var(--...)` companion if any) — NOT
      // to write `key: ''`. Writing the empty string is what the user
      // saw as "reset removes the background entirely instead of
      // inheriting": framer-motion treats `''` as an explicit
      // "no value" and the rendered DOM gets `background: ''` which
      // clears the inherited pink default, leaving the variant
      // background-less.
      //
      // The default variant is special: an empty value there means
      // "remove the property from the source-of-truth", which the
      // shared empty-string-removes-property convention already handles
      // at the inline-style level — keep the existing write path.
      // Empty value → delete the key. Normally only on NON-default variants
      // (default inherits an empty as "remove from source-of-truth" at the
      // inline level). EXCEPTION: motion transform props (rotate/scale/x/y/…)
      // are mirrored onto the default variant too, so a rotation RESET must
      // delete them from default as well — otherwise `rotate: ''` is written.
      //
      // The `default` variant is NOT exempt. A prior version kept `key: ''`
      // on default, reasoning the inline-level removal covered it. It did
      // NOT: framer-motion applies the `default` variant's OWN object on
      // every render, so a baked `background: ''` (the SHORTHAND) clobbers
      // the `backgroundColor` set just before it — the user multi-selected
      // two nodes, set them white, and the edited one rendered with NO
      // background-color at all because `{ backgroundColor: '#fff',
      // background: '', backgroundImage: '' }` landed in `default` and the
      // empty shorthand wiped the color. Empty = remove the key, in EVERY
      // variant including default.
      if (value === '') {
        // Match either `key: 'value'`, `key: "value"`, or `key: 123` —
        // include the optional trailing comma + whitespace so the
        // surrounding object literal stays well-formed after deletion.
        const deleteRegex = new RegExp(`\\s*${keyPat(key)}\\s*:\\s*(?:'[^']*'|"[^"]*"|-?\\d+(?:\\.\\d+)?)\\s*,?`);
        entryContent = entryContent.replace(deleteRegex, '');
        continue;
      }
      const isNumeric = NUMERIC_PROPS.has(key) && /^-?\d+(\.\d+)?$/.test(value);
      const formattedValue = isNumeric ? value : `'${value}'`;
      // Value alternation must include the leading `-` so an existing NEGATIVE
      // numeric value (e.g. `rotate: -2`) is matched-and-REPLACED, not missed →
      // appended. Without `-?` here, every drag frame on a negatively-rotated
      // element added a fresh `rotate: -N` key (duplicate keys piling up).
      const propRegex = new RegExp(`(${keyPat(key)}\\s*:\\s*)(?:'[^']*'|"[^"]*"|-?\\d+(?:\\.\\d+)?)`);
      const propMatch = entryContent.match(propRegex);
      if (propMatch) {
        entryContent = entryContent.replace(propMatch[0], `${propMatch[1]}${formattedValue}`);
      } else {
        entryContent = entryContent.trimEnd();
        if (entryContent && !entryContent.endsWith(',')) entryContent += ',';
        entryContent += ` ${emitKey(key)}: ${formattedValue},`;
      }
    }


    const fullMatchStart = constIdx + afterConst.indexOf(entryMatch[0]);
    const fullMatchEnd = fullMatchStart + entryMatch[0].length;
    let result = code.slice(0, fullMatchStart) + entryMatch[1] + entryContent + entryMatch[3] + code.slice(fullMatchEnd);
    // Ensure default entry has base values for these properties
    if (variantName !== 'default') {
      result = ensureDefaultHasBaseValues(result, setProps);
    result = ensureTransformNeutralOnAllVariants(result, Object.keys(styles));
      result = ensureTransformNeutralOnAllVariants(result, Object.keys(styles));
    }
    // Add layout prop when order changes — CSS order is not animatable,
    // framer-motion's layout prop enables smooth FLIP animations for reorder.
    if ('order' in styles) {
      result = ensureLayoutProp(result, nodeId);
    }
    return result;
  }

  // Variant entry doesn't exist — create it
  const objMatch = afterConst.match(/=\s*\{([\s\S]*?)\};/);
  if (!objMatch) return code;

  const NUMERIC_NEW = new Set(['order', 'opacity', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'x', 'y', 'z', 'transformPerspective']);
  // Empty-string values on a non-default variant mean "no override" —
  // inherit from `default`. Filter them out at the create-new-entry path
  // (the update-existing-entry path above already deletes empty keys at
  // line 959). Without this, dragging an element into a layout that
  // routes `{ position: 'relative', left: '', right: '', top: '',
  // bottom: '' }` to a variant ended up writing literal empty strings.
  // On render, framer-motion would then clear `width`/`height`/etc. and
  // the element collapsed to zero content size when it re-entered the
  // variant.
  // Empty = remove → never write `key: ''` into ANY variant (default
  // included; an empty `background` shorthand on default wipes a sibling
  // backgroundColor at render time).
  const filteredEntries = Object.entries(styles).filter(([, v]) => v !== '');
  if (filteredEntries.length === 0) {
    // Nothing meaningful to write — keep default base-values sync below
    // (and order/layout) but skip creating an empty entry.
    let result = code;
    if (variantName !== 'default') {
      result = ensureDefaultHasBaseValues(result, setProps);
    result = ensureTransformNeutralOnAllVariants(result, Object.keys(styles));
      result = ensureTransformNeutralOnAllVariants(result, Object.keys(styles));
    }
    if ('order' in styles) {
      result = ensureLayoutProp(result, nodeId);
    }
    return result;
  }
  const propsStr = filteredEntries.map(([k, v]) => {
    const isNum = NUMERIC_NEW.has(k) && /^-?\d+(\.\d+)?$/.test(v);
    return `${emitKey(k)}: ${isNum ? v : `'${v}'`}`;
  }).join(', ');
  const newEntry = `\n  '${variantName}': { ${propsStr} },`;

  let insertPos = constIdx + afterConst.indexOf('};');

  // Ensure previous entry has a trailing comma (prevents syntax errors)
  const before = code.slice(0, insertPos);
  const lastNonWs = before.length - 1 - before.split('').reverse().findIndex(c => /\S/.test(c));
  if (lastNonWs >= 0 && before[lastNonWs] === '}') {
    // Previous entry's closing } has no comma — add one
    code = before.slice(0, lastNonWs + 1) + ',' + before.slice(lastNonWs + 1) + code.slice(insertPos);
    insertPos++; // adjust for added comma
  }

  let result = code.slice(0, insertPos) + newEntry + '\n' + code.slice(insertPos);
  // Ensure default entry has base values for these properties
  if (variantName !== 'default') {
    result = ensureDefaultHasBaseValues(result, setProps);
    result = ensureTransformNeutralOnAllVariants(result, Object.keys(styles));
  }
  // Add layout prop when order changes
  if ('order' in styles) {
    result = ensureLayoutProp(result, nodeId);
  }
  return result;
}

/**
 * Per-parent-variant style writes for a component INSTANCE (PascalCase tag).
 * Writes inline JSX ternary expressions in the `style={{...}}` prop, keyed
 * off the parent component's `initialVariant` (or `variant` when there are
 * connections). Unlike `updateVariantStyleInCode`'s legacy path, this does
 * NOT add `variants={...}` or convert the tag to `motion.*` — both of those
 * break for component instances (variants is silently ignored, and
 * `motion.<ComponentName>` falls through to a literal `<componentname>` HTML
 * element).
 *
 * For each style property:
 *   - Reads the existing value, treating it as a per-parent-variant map
 *     (literal → `{ default: literal }`; ternary → parsed map).
 *   - Updates the entry for `variantName`.
 *   - Writes back as a ternary when there are non-default branches, plain
 *     literal otherwise.
 */
function writeInstanceConditionalStyles(
  code: string,
  nodeId: string,
  variantName: string,
  styles: Record<string, string>,
): string {
  trace.fn('generator.writeInstanceConditionalStyles', { nodeId, variantName, styles });

  // Parent variable name: 'variant' when the parent component uses
  // `useState(initialVariant)` (connection wiring), otherwise 'initialVariant'.
  const parentVar = code.includes('useState(initialVariant)') ? 'variant' : 'initialVariant';

  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  // Find the style={{...}} object on this tag. If missing, insert an empty
  // one right after data-id so the per-property writes have somewhere to land.
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  const styleStartInTag = code.slice(idIdx, tagEnd).indexOf('style={{');
  let objStart: number;
  let objEnd: number;
  let result = code;
  if (styleStartInTag === -1) {
    // Insert empty style={{}} after data-id
    const insertAfter = idIdx + `data-id="${nodeId}"`.length;
    result = code.slice(0, insertAfter) + ' style={{}}' + code.slice(insertAfter);
    const reIdx = findJSXDataIdIndex(result, nodeId);
    objStart = result.indexOf('style={{', reIdx) + 'style={{'.length;
    const posEnd = findStyleObjectEnd(result, objStart);
    const pos = posEnd === -1 ? result.length : posEnd;
    objEnd = pos;
  } else {
    objStart = idIdx + styleStartInTag + 'style={{'.length;
    const posEnd = findStyleObjectEnd(result, objStart);
    const pos = posEnd === -1 ? result.length : posEnd;
    objEnd = pos;
  }

  let styleContent = result.slice(objStart, objEnd);

  for (const [prop, value] of Object.entries(styles)) {
    // A motion transform prop (rotate/scale/x/y/skew/…) must be authored as a
    // NUMBER so framer-motion animates it AND composes it with the layout
    // projection — a quoted CSS `transform` would fight the projection and never
    // render/animate. Its default branch is the NEUTRAL (0 / 1) so motion has a
    // target to animate back to. Non-motion props stay quoted strings.
    const isMotion = MOTION_TRANSFORM_PROPS.has(prop);
    const neutral = isMotion ? (MOTION_TRANSFORM_NEUTRAL[prop] ?? '0') : '';
    // Value capture: a quoted string OR a bare number (motion props).
    const VAL = `(?:'([^']*)'|"([^"]*)"|(-?\\d+(?:\\.\\d+)?))`;

    // Read the current value into a { variant → value } map (preserves sibling
    // overrides). Shapes: `prop: <val>` or `prop: parentVar === 'X' ? <a> : <b>`.
    const map: Record<string, string> = {};
    const literalMatch = styleContent.match(new RegExp(`(^|,)\\s*${prop}\\s*:\\s*${VAL}\\s*(?=,|$)`));
    if (literalMatch) {
      map['default'] = literalMatch[2] ?? literalMatch[3] ?? literalMatch[4] ?? '';
    } else {
      const exprMatch = styleContent.match(new RegExp(`${prop}\\s*:\\s*((?:[^,}]|'[^']*')+)`));
      if (exprMatch) {
        let cursor = exprMatch[1].trim();
        const branchRe = new RegExp(`^\\s*${parentVar}\\s*===\\s*['"]([^'"]+)['"]\\s*\\?\\s*${VAL}\\s*:\\s*(.+)$`);
        while (true) {
          const m = cursor.match(branchRe);
          if (!m) break;
          map[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
          cursor = m[5].trim();
        }
        const fb = cursor.match(new RegExp(`^${VAL}\\s*$`));
        if (fb) map['default'] = fb[1] ?? fb[2] ?? fb[3] ?? '';
      }
    }

    // Apply update for this parent variant. An empty value means "reset this
    // variant's override" → drop its branch (back to the default / neutral).
    if (variantName === 'default') {
      map['default'] = value;
    } else if (value === '' || value === (map['default'] ?? neutral)) {
      delete map[variantName];
    } else {
      map[variantName] = value;
    }

    // Format. Motion values stay unquoted numbers; default falls back to neutral.
    const fmt = (v: string) => (isMotion && /^-?\d+(\.\d+)?$/.test(v)) ? v : `'${v}'`;
    const branches = Object.entries(map).filter(([k]) => k !== 'default');
    const rawDefault = map['default'];
    const defaultVal = (rawDefault === undefined || rawDefault === '') ? neutral : rawDefault;
    let formatted: string;
    if (branches.length === 0) {
      // Remove the prop when nothing meaningful remains: empty (non-motion) or
      // the neutral with no overrides (motion → no rotation anywhere).
      formatted = (defaultVal === '' || (isMotion && defaultVal === neutral)) ? '' : fmt(defaultVal);
    } else {
      const chain = branches.map(([v, val]) => `${parentVar} === '${v}' ? ${fmt(val)}`).join(' : ');
      formatted = `${chain} : ${fmt(defaultVal)}`;
    }

    // Splice into styleContent
    const propMatcher = new RegExp(`(^|,)(\\s*)${prop}\\s*:\\s*(?:'[^']*'|"[^"]*"|[^,}]+(?:'[^']*'[^,}]*)*)`);
    if (formatted === '' && propMatcher.test(styleContent)) {
      // Remove the property entirely
      styleContent = styleContent.replace(propMatcher, (_m, lead) => (lead === ',' ? '' : ''));
    } else if (formatted !== '') {
      const replacement = `$1$2${prop}: ${formatted}`;
      if (propMatcher.test(styleContent)) {
        styleContent = styleContent.replace(propMatcher, replacement);
      } else {
        // Append to end of style object (before any trailing whitespace/comma)
        const trimmed = styleContent.trimEnd();
        const sep = trimmed.length === 0 || trimmed.endsWith(',') ? '' : ', ';
        styleContent = trimmed + sep + ' ' + `${prop}: ${formatted}`;
      }
    }
  }

  // Removing the FIRST prop leaves a dangling LEADING comma: the propMatcher
  // consumes `(^|,)…prop: val` but NOT the trailing comma, so `{ order: '1',
  // position: … }` → `{, position: … }` (`style={{,` — a parse crash that
  // takes down the whole page). Adjacent removals can leave a double comma.
  // Normalise both, mirroring setConditionalStyleInCode's post-splice cleanup.
  styleContent = styleContent.replace(/,\s*,/g, ', ').replace(/^\s*,\s*/, ' ');

  return result.slice(0, objStart) + styleContent + result.slice(objEnd);
}

/**
 * Add layout animation props to a motion element for reorder FLIP animation.
 * - layout={true}: enables FLIP (smooth position animation after CSS reflow)
 *
 * `layoutId={nodeId}` was previously also added here, but it caused a
 * subtle bug with AnimatePresence + popLayout: when a conditionally
 * rendered element unmounts (e.g. on variant switch), framer-motion
 * treats `layoutId`-tagged elements as participants in a shared-element
 * transition and animates them to their "new" layout position BEFORE
 * unmounting — visible as "pink frame waits and centers, THEN
 * disappears" instead of instant unmount. Since no other element ever
 * carries the SAME `layoutId` (each node generates a unique id from
 * its own data-id), the shared transition has no real destination and
 * just delays the unmount needlessly. We only need `layout={true}` for
 * sibling FLIP, so dropped `layoutId` entirely.
 */
function ensureLayoutProp(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  // Walk BACKWARD from `data-id` to find the start of the JSX tag
  // (the `<` character). The previous version sliced from `idIdx`
  // (= position of `data-id`), which missed any `layout={true}` /
  // `layoutId=...` written BEFORE `data-id` in the opening tag —
  // detection failed, props got added a second time, source ended up
  // with duplicates like `<motion.div layout={true} data-id="x" layout={true} ...>`.
  let tagStart = idIdx;
  while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
  const fullTagSlice = code.slice(tagStart, tagEnd);

  const idPattern = `data-id="${nodeId}"`;
  const insertAfter = idIdx + idPattern.length;
  let result = code;
  const propsToAdd: string[] = [];
  if (!/\blayout\s*=/.test(fullTagSlice)) propsToAdd.push('layout={true}');
  // Intentionally NOT adding `layoutId` — see comment above.
  if (propsToAdd.length > 0) {
    result = result.slice(0, insertAfter) + ' ' + propsToAdd.join(' ') + result.slice(insertAfter);
  }
  return result;
}

/**
 * Set a conditional order expression in an element's style prop based on variant state.
 * Generates: style={{ ...existing, order: variant === 'variant-1' ? 1 : 0 }}
 *
 * Order must be in inline style (not framer-motion variants) because:
 * - motion tweens order as a float, CSS truncates → no reflow
 * - React state change → instant style.order change → CSS reflow → layout FLIP animates
 *
 * Also adds layout={true} + layoutId for FLIP animation tracking.
 */
export function setConditionalOrderInCode(
  code: string,
  nodeId: string,
  orderMap: Record<string, number>, // variantName → order value
): string {
  trace.fn('generator.setConditionalOrderInCode', { nodeId, orderMap });

  // Which identifier drives the variant: `variant` (useState, only with
  // connections) or `initialVariant` (the always-present master param). A master
  // WITHOUT connections has no `variant` → `order: variant === …` references an
  // undefined identifier → "variant is not defined" crash on reorder. Use the
  // same detection the size ternary uses.
  const vvar = detectVariantVar(code);

  // Find the element's style={{ ... }} and inject/update order expression
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  const styleStart = code.indexOf('style={{', idIdx);
  if (styleStart === -1) return code;

  const objStart = styleStart + 'style={{'.length;
  const posEnd = findStyleObjectEnd(code, objStart);
  const pos = posEnd === -1 ? code.length : posEnd;
  // pos points at the inner } of }}

  let styleContent = code.slice(objStart, pos);

  // MERGE with existing per-variant branches in the inline ternary.
  // Without this, dragging a reorder on variant-1 (orderMap = { default,
  // 'variant-1' }) would WIPE the existing `variant === 'variant-2' ? N`
  // branch from a previous reorder on variant-2 — variants leak into
  // each other, and re-dragging on the other variant kept reverting.
  //
  // Extract every `variant === 'X' ? <num>` pair and the final fallback
  // from the current `order: ...` expression, then build a merged map:
  // existing branches + new orderMap (new values overwrite same-variant).
  // Lookbehind so `order:` is NOT matched inside `border:` (= "b"+"order:") —
  // without it, reordering an element that has a `border` strips the order out of
  // `border: '…'`, leaving a dangling `b` shorthand prop → "b is not defined".
  const orderMatchRegex = /(?<![A-Za-z0-9_-])order\s*:\s*([^,}]+)/;
  const existingOrderMatch = styleContent.match(orderMatchRegex);
  const mergedOrderMap: Record<string, number> = {};
  if (existingOrderMatch) {
    const expr = existingOrderMatch[1];
    // Branches: `<variant|initialVariant> === 'X' ? N` (accept either driver).
    const branchRegex = /(?:variant|initialVariant)\s*===\s*'([^']+)'\s*\?\s*(-?\d+(?:\.\d+)?)/g;
    let bm: RegExpExecArray | null;
    while ((bm = branchRegex.exec(expr)) !== null) {
      const n = parseFloat(bm[2]);
      if (!isNaN(n)) mergedOrderMap[bm[1]] = n;
    }
    // Final fallback — strip all `<var> === 'X' ? N :` segments and parse the
    // remainder as a number.
    const tail = expr.replace(/(?:variant|initialVariant)\s*===\s*'[^']+'\s*\?\s*-?\d+(?:\.\d+)?\s*:\s*/g, '').trim();
    const tailNum = parseFloat(tail);
    if (!isNaN(tailNum)) mergedOrderMap.default = tailNum;
  }
  // New values from this call WIN over existing same-variant values.
  for (const [k, v] of Object.entries(orderMap)) {
    mergedOrderMap[k] = v;
  }

  // Build the conditional expression from the merged map.
  const defaultOrder = mergedOrderMap['default'] ?? 0;
  // Drop branches whose value already EQUALS the default — `variant === 'v1' ? 1
  // : 1` is a no-op the reader has to decode, and it accumulates: every reorder
  // that doesn't actually move a node used to append another dead branch. A
  // dropped branch is loss-free, because re-reading the expression later
  // re-derives that variant's value from the default it fell through to.
  const nonDefaultEntries = Object.entries(mergedOrderMap)
    .filter(([k, v]) => k !== 'default' && v !== defaultOrder);

  let orderExpr: string;
  if (nonDefaultEntries.length === 0) {
    // QUOTED when it collapses to a literal. A bare `order: 0` renders fine but
    // the drag-to-reorder engine reads and writes CSS order as `String(n)`, so
    // it can't resolve a numeric literal and dragging silently no-ops — the
    // oracle's own ORDER_MUST_BE_STRING rule, which the builder was breaking
    // here. The TERNARY form keeps numeric branches: that's the one shape the
    // rule exempts, and the variant tool parses the numbers back out.
    orderExpr = `'${defaultOrder}'`;
  } else {
    const conditions = nonDefaultEntries.map(([vName, order]) =>
      `${vvar} === '${vName}' ? ${order}`
    ).join(' : ');
    orderExpr = `${conditions} : ${defaultOrder}`;
  }

  // Remove existing order property (static or expression). Lookbehind so it
  // never bites into `border:` / `borderColor:` etc.
  //
  // BOTH separators must be considered, not just the leading one. The old regex
  // ate `,?\s*` in front and nothing behind, which is only correct when `order`
  // has a property BEFORE it. When `order` was the FIRST property in the object
  // its trailing comma survived the removal and produced `style={{,` — a syntax
  // error that fails the whole module parse and blanks the page. Live repro: a
  // component whose `<p data-name="Tracking Expenses" style={{ order: '1', … }}`
  // was reordered on a variant tile (user report 2026-07-27).
  //
  // Same shape as the variants-object cleanup below: keep ONE comma when the
  // property sat between two others, drop everything otherwise.
  styleContent = styleContent.replace(
    /(,?)\s*(?<![A-Za-z0-9_-])order\s*:\s*(?:'[^']*'|"[^"]*"|[^,}]+)(\s*,)?/g,
    (_m, lead: string, trail: string | undefined) => (lead && trail ? ',' : ''),
  );

  // Add conditional order before the closing (but before ...style spread if present)
  const spreadIdx = styleContent.lastIndexOf('...style');
  if (spreadIdx !== -1) {
    // Insert before ...style
    styleContent = styleContent.slice(0, spreadIdx) + `order: ${orderExpr}, ` + styleContent.slice(spreadIdx);
  } else {
    // Append at end
    styleContent = styleContent.trimEnd();
    if (styleContent && !styleContent.endsWith(',')) styleContent += ',';
    styleContent += ` order: ${orderExpr}`;
  }

  let result = code.slice(0, objStart) + styleContent + code.slice(pos);

  // Strip `order: N` from EVERY entry of this element's variants object,
  // if it has one. The order is now in the inline ternary above — keeping
  // a stale `order: N` in `variants[X]` makes framer-motion overlay that
  // value on top of the inline ternary at runtime (variants win over the
  // inline rule for properties they declare). Visible symptom: the order
  // ternary applies correctly at React render → layout FLIP animates →
  // then framer-motion's variant overlay tweens `order` back to the
  // stale value → element snaps back to the wrong slot. Bug reported by
  // user: "starts animating to correct order then jumps back".
  const tagEndForVariants = result.indexOf('>', findJSXDataIdIndex(result, nodeId));
  if (tagEndForVariants !== -1) {
    const variantsAttrMatch = result
      .slice(findJSXDataIdIndex(result, nodeId), tagEndForVariants)
      .match(/variants=\{(?:__applyInstanceSize\()?(\w+)/);
    if (variantsAttrMatch) {
      const variantsVarName = variantsAttrMatch[1];
      const constMatch = result.match(new RegExp(`const\\s+${variantsVarName}\\s*=\\s*\\{`));
      if (constMatch) {
        const constStart = result.indexOf(constMatch[0]);
        // Find the const's closing `};`
        let d = 0, p = constStart + constMatch[0].length - 1;
        while (p < result.length) {
          if (result[p] === '{') d++;
          else if (result[p] === '}') { d--; if (d === 0) break; }
          p++;
        }
        if (p < result.length) {
          const constEnd = p + 1;
          const constBody = result.slice(constStart, constEnd);
          // Remove `order: N` (positive or negative int/float) from every
          // entry. Match with optional leading comma + whitespace and
          // optional trailing comma — keeps the surrounding object well-
          // formed (no dangling commas, no empty entries `{,}`).
          const orderRegex = /(,\s*)?order\s*:\s*-?\d+(?:\.\d+)?(\s*,)?/g;
          const cleanedBody = constBody.replace(orderRegex, (_m, lead, trail) => {
            // If only trailing comma, drop the trailing comma too so we
            // don't leave `{ , width: ... }`.
            return lead && trail ? ',' : '';
          });
          result = result.slice(0, constStart) + cleanedBody + result.slice(constEnd);
        }
      }
    }
  }

  // Add layout={true} + layoutId for FLIP animation
  result = ensureLayoutProp(result, nodeId);

  return result;
}

// detectVariantVar lives in scoped-expr.ts (leaf) — re-exported here for callers.
import { detectVariantVar } from './scoped-expr';
export { detectVariantVar };


/**
 * Set a per-variant value for a LAYOUT-AFFECTING style property as an inline
 * `style` TERNARY (e.g. `flexDirection: variant === 'variant-1' ? 'row' : 'column'`)
 * rather than in the framer-motion `variants` object.
 *
 * Why: framer-motion applies `variants`/`animate` values through its own rAF
 * loop, AFTER React commits and AFTER the `layout` (FLIP) prop has already
 * measured the box — so a layout-affecting prop in a variant snaps instead of
 * animating, and `layout` never engages. A `style` ternary is applied by React
 * synchronously during commit, so `layout` measures the new flow and FLIP-
 * animates the children smoothly. (Same reason `order` lives in a style ternary.)
 *
 * Merges with any existing per-variant branches, derives the `default` branch
 * from the current inline value, and strips the property from EVERY entry of the
 * element's `variants` object so framer-motion can't overlay a stale value.
 */
/** Find a top-level `prop: value` inside a style-object body, respecting (), [],
 *  {} and string literals — so a value with commas (rgba(), gradients, shadows,
 *  transitions) is NOT truncated at its first inner comma. `start` = the prop key
 *  index; `valStart`/`valEnd` bound the value (valEnd = the top-level `,` or the
 *  end of the body). The naive `[^,}]+` matchers this replaces shredded comma
 *  values and corrupted the ternary ("Unexpected token" on a per-variant color). */
function findTopLevelPropSpan(s: string, prop: string): { start: number; valStart: number; valEnd: number } | null {
  const m = new RegExp(`\\b${prop}\\s*:`).exec(s);
  if (!m) return null;
  const valStart = m.index + m[0].length;
  let pd = 0, bd = 0, cd = 0, str = '';
  let i = valStart;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (str) { if (ch === '\\') { i++; continue; } if (ch === str) str = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
    else if (ch === '(') pd++;
    else if (ch === ')') pd--;
    else if (ch === '[') bd++;
    else if (ch === ']') bd--;
    else if (ch === '{') cd++;
    else if (ch === '}') { if (cd === 0) break; cd--; }
    else if (ch === ',' && pd === 0 && bd === 0 && cd === 0) break;
  }
  return { start: m.index, valStart, valEnd: i };
}

export function setConditionalStyleInCode(
  code: string,
  nodeId: string,
  prop: string,
  variantName: string,
  value: string,
): string {
  trace.fn('generator.setConditionalStyleInCode', { nodeId, prop, variantName, value });

  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  // Canvas-node guard: a module-scope element can't reference `initialVariant`,
  // so write the value to its inline style directly instead of an
  // `initialVariant === …` ternary (which would dangle + revert the commit).
  // Slot-hoisted `cn_` consts are excluded (handled by the variants mechanism).
  if (isNodeInCanvasNodes(code, nodeId) && !isIndexInsideSlotConst(code, idIdx)) {
    return updateNodeInCode(code, nodeId, { [prop]: value });
  }

  const styleStart = code.indexOf('style={{', idIdx);
  if (styleStart === -1) return code;
  const objStart = styleStart + 'style={{'.length;
  const posEnd = findStyleObjectEnd(code, objStart);
  const pos = posEnd === -1 ? code.length : posEnd;
  let styleContent = code.slice(objStart, pos);

  // Parse the existing `prop: ...` value into a {variant → value} map so we
  // merge rather than clobber sibling-variant branches.
  const map: Record<string, string> = {};
  const parseSpan = findTopLevelPropSpan(styleContent, prop);
  if (parseSpan) {
    const expr = styleContent.slice(parseSpan.valStart, parseSpan.valEnd).trim();
    const branchRegex = /(?:variant|initialVariant)\s*===\s*'([^']+)'\s*\?\s*'([^']*)'/g;
    let bm: RegExpExecArray | null;
    while ((bm = branchRegex.exec(expr)) !== null) map[bm[1]] = bm[2];
    // Fallback (default) branch — strip the `X === 'v' ? 'val' :` segments and
    // read the trailing quoted literal (or a bare value).
    const tail = expr.replace(/(?:variant|initialVariant)\s*===\s*'[^']+'\s*\?\s*'[^']*'\s*:\s*/g, '').trim();
    const tailQuoted = tail.match(/^'([^']*)'/);
    if (tailQuoted) map.default = tailQuoted[1];
    else if (tail && !tail.includes('?')) map.default = tail.replace(/^['"]|['"]$/g, '');
  }
  // Apply this write. An empty value is a "reset override" — drop this
  // variant's branch so it reverts to the default (and the ternary collapses
  // to a plain value when no non-default branch remains).
  if (value === '') {
    delete map[variantName];
  } else {
    map[variantName] = value;
  }
  // CLEARING the DEFAULT branch with no sibling-variant branch remaining fully
  // REMOVES the prop — the "remove layout" case (the reference wipes flex/grid props
  // off the master). Falling through to write `CSS_LAYOUT_DEFAULTS[prop]` below
  // would leave e.g. `gridAutoFlow: 'row'` / `flexDirection: 'row'` behind, so
  // the Layout tool's hasFlexProps/hasGridProps stay TRUE → it re-detects a
  // layout it can never clear ("press − → switches to GRID → stuck forever").
  // This bites ONLY on a component master, because only the master routes
  // layout props through this conditional-style path; a plain page clears them
  // straight through updateNodeInCode (empty-string-removes-property).
  const removeProp = value === '' && variantName === 'default'
    && Object.keys(map).length === 0;
  if (removeProp) trace.action('generator.setConditionalStyle:removeLayoutProp', { nodeId, prop });
  if (map.default === undefined) {
    map.default = variantName === 'default' && value !== '' ? value : (CSS_LAYOUT_DEFAULTS[prop] ?? '');
  }

  // Build the expression. Collapse to a plain value when no non-default branch.
  const variantVar = detectVariantVar(code);
  const nonDefault = Object.entries(map).filter(([k, v]) => k !== 'default' && v !== map.default);
  let expr: string;
  if (nonDefault.length === 0) {
    expr = `'${map.default}'`;
  } else {
    const conds = nonDefault.map(([v, val]) => `${variantVar} === '${v}' ? '${val}'`).join(' : ');
    expr = `${conds} : '${map.default}'`;
  }

  // Remove the existing prop entry (FULL, comma-safe value), then re-insert
  // (before `...style` if present). A naive `[^,}]+`/single-quote matcher here
  // removed only PART of a comma value's ternary, leaving a dangling tail.
  const rmSpan = findTopLevelPropSpan(styleContent, prop);
  if (rmSpan) styleContent = styleContent.slice(0, rmSpan.start) + styleContent.slice(rmSpan.valEnd);
  // Removing the FIRST prop leaves a dangling leading comma (`{{, height: …}}` →
  // "Unexpected token") because the `,?` prefix only eats a comma BEFORE the
  // prop; a first prop has none, so the comma AFTER its value survives as a
  // leading one. A middle removal can leave a double comma. Normalise both.
  styleContent = styleContent.replace(/,\s*,/g, ', ').replace(/^\s*,\s*/, ' ');
  // Re-insert the prop unless we're fully removing it (default cleared, no
  // sibling branches) — the span removal above already dropped it.
  if (!removeProp) {
    const spreadIdx = styleContent.lastIndexOf('...style');
    if (spreadIdx !== -1) {
      styleContent = styleContent.slice(0, spreadIdx) + `${prop}: ${expr}, ` + styleContent.slice(spreadIdx);
    } else {
      styleContent = styleContent.trimEnd();
      if (styleContent && !styleContent.endsWith(',') && !styleContent.endsWith('{')) styleContent += ',';
      styleContent += ` ${prop}: ${expr}`;
    }
  }

  let result = code.slice(0, objStart) + styleContent + code.slice(pos);

  // Strip `prop` from EVERY entry of this element's variants object — keeping a
  // stale value there lets framer-motion overlay it over the inline ternary at
  // runtime and snap the element back (same failure mode the order path fixes).
  const tagEnd = result.indexOf('>', findJSXDataIdIndex(result, nodeId));
  if (tagEnd !== -1) {
    const variantsAttrMatch = result
      .slice(findJSXDataIdIndex(result, nodeId), tagEnd)
      .match(/variants=\{(?:__applyInstanceSize\()?(\w+)/);
    if (variantsAttrMatch) {
      const variantsVarName = variantsAttrMatch[1];
      const constMatch = result.match(new RegExp(`const\\s+${variantsVarName}\\s*=\\s*\\{`));
      if (constMatch) {
        const constStart = result.indexOf(constMatch[0]);
        let d = 0, p = constStart + constMatch[0].length - 1;
        while (p < result.length) {
          if (result[p] === '{') d++;
          else if (result[p] === '}') { d--; if (d === 0) break; }
          p++;
        }
        if (p < result.length) {
          const constEnd = p + 1;
          const constBody = result.slice(constStart, constEnd);
          const propRegex = new RegExp(`(,\\s*)?\\b${prop}\\s*:\\s*(?:'[^']*'|"[^"]*"|[^,}]+)(\\s*,)?`, 'g');
          const cleanedBody = constBody.replace(propRegex, (_m, lead, trail) => (lead && trail ? ',' : ''));
          result = result.slice(0, constStart) + cleanedBody + result.slice(constEnd);
        }
      }
    }
  }

  // FLIP needs layout on the element.
  result = ensureLayoutProp(result, nodeId);
  return result;
}

