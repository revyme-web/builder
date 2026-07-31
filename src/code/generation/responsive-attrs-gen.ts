/**
 * responsive-attrs-gen.ts — per-viewport & per-variant RESPONSIVE HTML ATTRIBUTES
 * on raw form controls (`<input>`/`<select>`/`<textarea>`): `type`, `name`,
 * `required`, `placeholder`, …
 *
 * `type` can't be made responsive with CSS (it's a content attribute, not a
 * style), so — mirroring how instance-fx / scroll-variant / motion props go
 * responsive — we encode overrides as a CONDITIONAL ATTR EXPRESSION that React
 * evaluates at runtime (source = deploy reality, no extra runtime effect):
 *
 *   per-viewport:  type={__mq0 ? "date" : "text"}      // __mq0 = useMediaQuery('(max-width: 768px)')
 *   chained:       type={__mq1 ? "tel" : __mq0 ? "date" : "text"}   // smallest width first
 *   per-variant:   type={variant === 'mobile' ? "date" : "text"}    // inside a component master
 *
 * The breakpoint gates reuse `ensureMediaGate` (one `useMediaQuery` const per
 * query, shared across features) + `ensureMediaQueryHook` import. The base value
 * is always the ternary's final fallback (the primary/desktop value).
 */

import { trace } from '@/shared/debug-trace';
import { findJSXDataIdIndex, findTagClose, scanGates } from './generator-utils';
import { ensureMediaGate, ensureMediaQueryHook, sweepOrphanMediaGates } from './generator-motion';

/** A parsed responsive attribute: the base (fallback) + per-viewport overrides. */
export interface ResponsiveAttr {
  base: string;
  /** breakpoint width (px) → override value. */
  byViewport: Map<number, string>;
  /** variant name → override value. */
  byVariant: Map<string, string>;
}

/** The media query a viewport-width override gates on (max-width cascade). */
function queryForWidth(width: number): string {
  return `(max-width: ${width}px)`;
}

/** Map every `const __mqN = useMediaQuery('…')` → { gate: width, width: gate }.
 *  Captures the WHOLE query then extracts max-width — so BANDED gates
 *  (`(max-width: 768px) and (min-width: 376px)`) map too, not just bare
 *  max-width (the old bare-only regex missed banded gates and re-emitted a
 *  duplicate useMediaQuery const per write — same scan the responsive
 *  text/style-vars generators use). */
function scanGatesBothWays(code: string): { gateToWidth: Map<string, number>; widthToGate: Map<number, string> } {
  const gateToWidth = scanGates(code);
  const widthToGate = new Map<number, string>();
  for (const [gate, width] of gateToWidth) widthToGate.set(width, gate);
  return { gateToWidth, widthToGate };
}

/** Locate a node's opening-tag slice [start, end) (end = index of the closing `>`). */
function tagSpan(code: string, nodeId: string): { ltIdx: number; gtIdx: number; tag: string } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return null;
  const ltIdx = code.lastIndexOf('<', idIdx);
  const gtIdx = findTagClose(code, idIdx);
  if (ltIdx < 0 || gtIdx < 0) return null;
  return { ltIdx, gtIdx, tag: code.slice(ltIdx, gtIdx) };
}

/** Read an attr off a tag slice into a ResponsiveAttr (string form or ternary form). */
export function parseResponsiveAttr(code: string, nodeId: string, attr: string): ResponsiveAttr {
  const out: ResponsiveAttr = { base: '', byViewport: new Map(), byVariant: new Map() };
  const span = tagSpan(code, nodeId);
  if (!span) return out;
  const { tag } = span;

  // String form: attr="value"
  const sm = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag);
  if (sm) { out.base = sm[1]; return out; }

  // Expression form: attr={ <ternary chain> } (our ternaries never nest braces).
  const em = new RegExp(`\\s${attr}=\\{([^}]*)\\}`).exec(tag);
  if (!em) return out;
  let rest = em[1].trim();
  const { gateToWidth } = scanGatesBothWays(code);
  // Consume leading `<gate-or-variant-test> ? "value" :` branches. The variant
  // axis keys on `initialVariant` (always a master param; `variant` only exists
  // with connections) — accept legacy `variant ===` when reading too.
  const vpBranch = /^(__mq\d+)\s*\?\s*"([^"]*)"\s*:\s*/;
  const varBranch = /^(?:initialVariant|variant)\s*===\s*'([^']*)'\s*\?\s*"([^"]*)"\s*:\s*/;
  for (;;) {
    let m = vpBranch.exec(rest);
    if (m) {
      const w = gateToWidth.get(m[1]);
      if (w != null) out.byViewport.set(w, m[2]);
      rest = rest.slice(m[0].length);
      continue;
    }
    m = varBranch.exec(rest);
    if (m) {
      out.byVariant.set(m[1], m[2]);
      rest = rest.slice(m[0].length);
      continue;
    }
    break;
  }
  const baseM = /^"([^"]*)"$/.exec(rest);
  out.base = baseM ? baseM[1] : rest;
  return out;
}

/** Convenience: the resolved value for a given viewport width (override or base). */
export function getResponsiveAttrAtViewport(code: string, nodeId: string, attr: string, vpWidth: number): string {
  const r = parseResponsiveAttr(code, nodeId, attr);
  return r.byViewport.get(vpWidth) ?? r.base;
}

/** Convenience: the resolved value for a variant (override or base). */
export function getResponsiveAttrForVariant(code: string, nodeId: string, attr: string, variant: string): string {
  const r = parseResponsiveAttr(code, nodeId, attr);
  return r.byVariant.get(variant) ?? r.base;
}

/** Build the JSX attr text (`attr="x"` or `attr={…ternary…}`) from a ResponsiveAttr,
 *  ensuring every needed gate exists in `code`. Returns updated code + the attr text. */
function buildAttr(code: string, attr: string, r: ResponsiveAttr): { code: string; attrText: string } {
  // No overrides → plain string attr (or removed when base is empty).
  if (r.byViewport.size === 0 && r.byVariant.size === 0) {
    return { code, attrText: r.base === '' ? '' : `${attr}="${r.base}"` };
  }
  let c = code;
  const parts: string[] = [];
  // Variant branches first (most specific), then viewport branches smallest-width
  // first. Test `initialVariant` (every master param; the breakpoint-driven
  // variant) — NOT `variant` (only present with connections → undefined here).
  for (const [name, val] of r.byVariant) parts.push(`initialVariant === '${name}' ? ${JSON.stringify(val)}`);
  const vpSorted = [...r.byViewport.entries()].sort((a, b) => a[0] - b[0]);
  for (const [w, val] of vpSorted) {
    const g = ensureMediaGate(c, queryForWidth(w));
    c = g.code;
    parts.push(`${g.gateVar} ? ${JSON.stringify(val)}`);
  }
  const ternary = parts.join(' : ') + ` : ${JSON.stringify(r.base)}`;
  return { code: c, attrText: `${attr}={${ternary}}` };
}

/** Replace (or insert) an attribute on a node's opening tag with `attrText`
 *  (empty string = remove the attribute). Re-finds the tag so it's safe to call
 *  after `code` was grown by gate insertion. */
function writeAttr(code: string, nodeId: string, attr: string, attrText: string): string {
  const span = tagSpan(code, nodeId);
  if (!span) return code;
  const { ltIdx, gtIdx } = span;
  let tag = code.slice(ltIdx, gtIdx);
  // Strip any existing form of the attr.
  tag = tag
    .replace(new RegExp(`\\s${attr}="[^"]*"`), '')
    .replace(new RegExp(`\\s${attr}=\\{[^}]*\\}`), '');
  if (attrText) {
    // Insert right after the tag name.
    const nameLen = tag.slice(1).match(/^[A-Za-z0-9.]+/)?.[0].length ?? 0;
    const at = 1 + nameLen;
    tag = tag.slice(0, at) + ' ' + attrText + tag.slice(at);
  }
  return code.slice(0, ltIdx) + tag + code.slice(gtIdx);
}

/**
 * Set (or clear) a PER-VIEWPORT attr override. `value === baseValue` or `''`
 * removes the override for that viewport. Ensures the gate + import, sweeps any
 * now-orphaned gate. `baseValue` seeds the fallback when the attr doesn't exist yet.
 */
export function setResponsiveAttrInCode(
  code: string,
  nodeId: string,
  vpWidth: number,
  attr: string,
  value: string,
  baseValue: string,
): string {
  const r = parseResponsiveAttr(code, nodeId, attr);
  if (!r.base && baseValue) r.base = baseValue;
  if (value === '' || value === r.base) r.byViewport.delete(vpWidth);
  else r.byViewport.set(vpWidth, value);

  const built = buildAttr(code, attr, r);
  let next = writeAttr(built.code, nodeId, attr, built.attrText);
  if (built.attrText.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-attrs:set-viewport', { nodeId, attr, vpWidth, value });
  return next;
}

/** Set (or clear) a PER-VARIANT attr override (`variant === 'name'` ternary). */
export function setVariantAttrInCode(
  code: string,
  nodeId: string,
  variant: string,
  attr: string,
  value: string,
  baseValue: string,
): string {
  const r = parseResponsiveAttr(code, nodeId, attr);
  if (!r.base && baseValue) r.base = baseValue;
  if (value === '' || value === r.base) r.byVariant.delete(variant);
  else r.byVariant.set(variant, value);

  const built = buildAttr(code, attr, r);
  let next = writeAttr(built.code, nodeId, attr, built.attrText);
  if (built.attrText.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-attrs:set-variant', { nodeId, attr, variant, value });
  return next;
}

/** Remove a per-viewport override (reset to base on that viewport). */
export function resetResponsiveAttrInCode(code: string, nodeId: string, vpWidth: number, attr: string): string {
  return setResponsiveAttrInCode(code, nodeId, vpWidth, attr, '', '');
}

/**
 * Set the BASE (fallback) value, PRESERVING any per-viewport / per-variant
 * overrides. A plain `updateHtmlAttrs` write on an attr that carries a
 * responsive ternary would replace the WHOLE expression with the string —
 * silently deleting every override (the FIT viewBox per-viewport case).
 */
export function setResponsiveAttrBaseInCode(code: string, nodeId: string, attr: string, value: string): string {
  const r = parseResponsiveAttr(code, nodeId, attr);
  r.base = value;
  const built = buildAttr(code, attr, r);
  let next = writeAttr(built.code, nodeId, attr, built.attrText);
  if (built.attrText.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-attrs:set-base', { nodeId, attr, value });
  return next;
}
