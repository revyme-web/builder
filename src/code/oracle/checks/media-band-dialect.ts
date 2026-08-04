// media-band-dialect.ts — banded @media head format + :lang cascade order.
//
// The responsive system writes RANGED bands: `@media (max-width: <bp>px) and
// (min-width: <smaller-bp + 0.02>px)`. The fractional lower bound is
// load-bearing both ways:
//   · an INTEGER inclusive bound (`min-width: 375px`) also matches the exact
//     smaller breakpoint — the canvas renders each viewport tile at exactly
//     its width, so a tablet-band rule (e.g. `display:none`) leaks onto the
//     375 mobile tile (the "dragged out of tablet hid mobile too" find,
//     2026-07-22);
//   · a `+1` bound (`min-width: 376px`) leaves a fractional gap — real phones
//     report widths like 375.3px (high-DPI scaling) where NEITHER band
//     matches and the page falls back to desktop styles.
// `<smaller-bp>.02` excludes the exact boundary AND covers fractional phones.
//
// Locale styles: GLOBAL `:lang()` rules must come BEFORE every banded block.
// Banded and global rules have equal specificity, so source order decides —
// a trailing global `:lang` beats every banded per-replica locale value and
// the replica paints the base locale color on every tile (the "French shows
// purple, not tablet blue" find).

import type * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs, stringAttr, type OracleViolation } from './shared';
import { parseCanvasConfig } from '@/code/project/canvas-config';

/** Collect the file's <style> template-literal CSS (same walk as
 *  checkMediaColumnFlipRebase). */
function collectStyleCSS(ast: t.File): string {
  let css = '';
  traverse(ast, {
    JSXElement(path: { node: t.JSXElement }) {
      if (jsxTagName(path.node.openingElement.name) !== 'style') return;
      for (const child of path.node.children) {
        if (child.type === 'JSXExpressionContainer' && child.expression.type === 'TemplateLiteral') {
          css += child.expression.quasis.map((q) => q.value.raw).join('');
        }
      }
    },
  });
  return css;
}

/**
 * DUPLICATE_BREAKPOINT_SECTION — a root section whose fixed width equals a
 * configured viewport width AND whose visibility is display-toggled in the
 * banded CSS is the fingerprint of "sections duplicated per breakpoint":
 * a desktop stack and a tablet/mobile stack living side by side in the same
 * flow, swapped with `display` rules. The pattern doubles page weight, makes
 * reordering scramble (hidden twins shift flow indices), and any width the
 * bands don't cover renders BOTH stacks. Responsiveness must be expressed as
 * overrides on ONE section set instead. (Found on an AI responsive pass,
 * 2026-08-05.)
 */
export function checkDuplicateBreakpointStack(code: string, ast: t.File, v: OracleViolation[]): void {
  const vps = parseCanvasConfig(code)?.viewports ?? [];
  if (vps.length === 0) return;
  const byWidth = new Map<string, string>(vps.map((vp) => [`${vp.width}px`, vp.label ?? vp.id]));
  const css = collectStyleCSS(ast);
  if (!css || !/display\s*:/.test(css)) return;

  traverse(ast, {
    JSXElement(path: { node: t.JSXElement }) {
      if (stringAttr(jsxAttrs(path.node.openingElement), 'data-id') !== 'root') return;
      for (const child of path.node.children) {
        if (child.type !== 'JSXElement') continue;
        const attrs = jsxAttrs(child.openingElement);
        const id = stringAttr(attrs, 'data-id');
        if (!id) continue;
        const styleAttr = attrs.find((a) => a.name.name === 'style');
        const obj = styleAttr?.value?.type === 'JSXExpressionContainer'
          && styleAttr.value.expression.type === 'ObjectExpression'
          ? styleAttr.value.expression : null;
        if (!obj) continue;
        let width: string | null = null;
        for (const p of obj.properties) {
          if (p.type !== 'ObjectProperty' || p.computed || p.value.type !== 'StringLiteral') continue;
          const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
          if (key === 'width') width = p.value.value;
        }
        if (!width || !byWidth.has(width)) continue;
        const idRe = new RegExp(`\\[data-id="${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"\\]\\s*\\{[^}]*display\\s*:`);
        if (!idRe.test(css)) continue;
        const name = stringAttr(attrs, 'data-name') ?? id;
        v.push({
          code: 'DUPLICATE_BREAKPOINT_SECTION', tier: 2,
          message: `Root section '${name}' (data-id "${id}") is a per-breakpoint DUPLICATE: its fixed width '${width}' equals the ${byWidth.get(width)} viewport width and its visibility is display-toggled in the banded CSS. Never duplicate a section per breakpoint. Keep ONE fluid section (width '100%') and express every breakpoint difference as banded overrides on that same section and its children. Duplicate stacks double the page weight, scramble drag reordering (hidden twins shift flow order), and render BOTH stacks at any width the bands leave uncovered. Fold this section's differences into its twin as banded rules, then delete this section.`,
        });
      }
    },
  });
}

export function checkMediaBandDialect(code: string, ast: t.File, v: OracleViolation[]): void {
  const css = collectStyleCSS(ast);
  if (!css) return;

  // ── MEDIA_BAND_LOWER_BOUND — ranged heads must use fractional bounds ──
  const vpWidths = (parseCanvasConfig(code)?.viewports ?? [])
    .map((vp) => vp.width)
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b);
  const headRe = /@(?:media|container)\s*\(max-width:\s*([\d.]+)px\)\s*and\s*\(min-width:\s*(\d+)px\)/g;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(css)) !== null) {
    const maxW = parseFloat(m[1]);
    const minW = parseInt(m[2], 10);
    // Exact fix when the @canvas viewports are known: next-smaller bp + 0.02.
    // Without them (component files), the inclusive-form guess `minW + 0.02`
    // is stated alongside the rule.
    const smaller = vpWidths.filter((w) => w < maxW).pop();
    const suggested = smaller !== undefined
      ? `${smaller + 0.02}px`
      : `${minW + 0.02}px (the next-smaller breakpoint + 0.02)`;
    v.push({
      code: 'MEDIA_BAND_LOWER_BOUND', tier: 2,
      message: `Band head '@media (max-width: ${m[1]}px) and (min-width: ${minW}px)' uses an INTEGER lower bound — write 'min-width: ${suggested}'. An inclusive integer bound also matches the exact smaller breakpoint (the canvas mobile tile renders at exactly its width, so this band's rules leak onto it), and a +1 bound leaves a fractional gap where real phones (375.3px-class widths) fall back to desktop styles. The lower bound is always the NEXT-SMALLER breakpoint + 0.02.`,
    });
  }

  // ── MEDIA_TOP_BAND_CAPPED — no band may cap the widest breakpoint ──
  // The widest viewport's look IS the base styles; bands exist only for
  // SMALLER breakpoints. A band whose max-width reaches the widest viewport
  // (e.g. `(max-width: 1440px) and (min-width: 810.02px)` when desktop is
  // 1440) leaves every real screen WIDER than the cap uncovered — the base
  // styles win there, so sections the band hides reappear on >1440px
  // monitors (found on an AI responsive pass, 2026-08-05: duplicate tablet
  // sections rendered alongside the desktop set on wide screens).
  const largest = vpWidths[vpWidths.length - 1];
  if (largest !== undefined) {
    const capRe = /@(?:media|container)\s*\(max-width:\s*([\d.]+)px\)/g;
    const flagged = new Set<string>();
    let c: RegExpExecArray | null;
    while ((c = capRe.exec(css)) !== null) {
      const maxW = parseFloat(c[1]);
      if (maxW >= largest && !flagged.has(c[1])) {
        flagged.add(c[1]);
        v.push({
          code: 'MEDIA_TOP_BAND_CAPPED', tier: 2,
          message: `Band '@media (max-width: ${c[1]}px)' caps the WIDEST breakpoint (${largest}px) — screens wider than ${c[1]}px match no band and fall back to base styles, so everything this band changes silently reverts there (a section it hides reappears on a >${c[1]}px monitor). The widest viewport's look must live in BASE styles (inline or unbanded CSS); write bands only for SMALLER breakpoints. To hide an element on the widest viewport, hide it in its BASE style and reveal it in the smaller bands instead.`,
        });
      }
    }
  }

  // ── LANG_RULE_ORDER — global :lang rules must precede banded blocks ──
  // Walk top-level CSS; flag a depth-0 `:lang(` selector after any @media/
  // @container block opened.
  let depth = 0;
  let sawBand = false;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0) {
      if (css.startsWith('@media', i) || css.startsWith('@container', i)) {
        sawBand = true;
        i += css.startsWith('@media', i) ? 6 : 10;
        continue;
      }
      if (css.startsWith(':lang(', i) && sawBand) {
        v.push({
          code: 'LANG_RULE_ORDER', tier: 2,
          message: `A top-level ':lang()' rule appears AFTER an @media block in the <style>. Global :lang rules and banded (:lang inside @media) rules have EQUAL specificity, so source order decides — a trailing global :lang beats every banded per-replica locale value and the replica tiles paint the base locale value. Move ALL top-level :lang rules to the TOP of the <style>, before the first @media block.`,
        });
        break; // one violation is enough — the fix moves all of them
      }
    }
    i++;
  }
}
