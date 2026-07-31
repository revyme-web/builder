// responsive-instance-prop-vars-gen.ts — per-VIEWPORT VARIABLE binding on a component-INSTANCE prop.
//
// The THIRD rail for a component-instance prop, alongside:
//   1. `data-responsive` LITERALS (instance-prop-overrides.ts) — per-viewport static values, merged by
//      withResponsiveProps. CANNOT hold a variable (the HOC merges literals only).
//   2. the BASE `prop={var}` binding (attrPropRefs) — one variable, cascades to every viewport.
// This adds: a per-viewport VARIABLE via an inline `__mq`-gated ternary in the attr —
//   `direction={(__mq2 ? tabletVar : baseExpr)}`
// so a hoisted variable can be bound on a single replica tile without touching the base (Desktop).
//
// Same `__mqN` banded-gate shape as the per-viewport STYLE (responsive-style-vars-gen) + TEXT
// (responsive-text-vars-gen) variables — this is their instance-prop-ATTR twin. Deploy-correct: plain
// JS evaluates the ternary per viewport; the canvas resolves it per-tile via the parser
// (responsiveAttrPropValues → responsiveProps → responsivePropStyles → Renderer fold).

import {
  buildScopedScalarExpr,
  parseScopedScalarExpr,
  ensureMediaQueryHook,
  sweepOrphanMediaGates,
  type SerScope,
} from './generator-motion';
import { findInstanceTag, setResponsiveOverride } from '../components/instance-prop-overrides';
import { parsePageVariables } from '../features/page-variables';
import { trace } from '@/shared/debug-trace';

/** maxW from a banded query `(max-width: Wpx) and (min-width: Ppx)` (or a bare `(max-width: Wpx)`). */
function maxWidthFromQuery(query: string): number | null {
  const m = query.match(/max-width:\s*(\d+)px/);
  return m ? parseInt(m[1], 10) : null;
}
function minWidthFromQuery(query: string): number {
  const m = query.match(/min-width:\s*([\d.]+)px/);
  return m ? parseInt(m[1], 10) : 0;
}

// Match `prop="x"` / `prop='x'` / `prop={…}` on a tag, NOT inside `data-prop=`/`aria-prop=`.
const attrValRe = (prop: string) => new RegExp(`(?<![\\w-])${prop}=(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`);

/** Read the current value of `prop` on the instance tag as a scoped expression { base, responsive[] }. */
function readScopedAttr(
  tagContent: string,
  code: string,
  prop: string,
): { base: string; responsive: Array<{ scope: SerScope; value: string }> } {
  const m = tagContent.match(attrValRe(prop));
  if (!m) return { base: 'undefined', responsive: [] };
  if (m[1] !== undefined) return { base: JSON.stringify(m[1]), responsive: [] }; // "literal"
  if (m[2] !== undefined) return { base: JSON.stringify(m[2]), responsive: [] }; // 'literal'
  const inner = (m[3] ?? '').trim();                                            // {expr}
  if (!inner) return { base: 'undefined', responsive: [] };
  // parseScopedScalarExpr peels any existing `__mq ? v :` segments → { base, responsive } so a 2nd
  // per-viewport override on the SAME prop CHAINS instead of clobbering the first (parity w/ variants).
  return parseScopedScalarExpr(code, inner);
}

/** Replace (or insert) `prop={…}` on the instance tag at [tagStart,tagEnd). */
function writeAttr(code: string, nodeId: string, componentName: string, propName: string, valueExpr: string | null): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;
  let tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const existingRe = new RegExp(`\\s*(?<![\\w-])${propName}=(?:"[^"]*"|'[^']*'|\\{[^}]*\\})`);
  if (valueExpr === null) {
    tagContent = tagContent.replace(existingRe, ''); // remove the attr entirely
  } else {
    const formatted = `${propName}={${valueExpr}}`;
    if (existingRe.test(tagContent)) tagContent = tagContent.replace(existingRe, ` ${formatted}`);
    else {
      const nameEnd = tagContent.indexOf(' ', 1); // after `<ComponentName`
      tagContent = nameEnd >= 0 ? `${tagContent.slice(0, nameEnd)} ${formatted}${tagContent.slice(nameEnd)}` : tagContent;
    }
  }
  return code.slice(0, tag.tagStart) + tagContent + code.slice(tag.tagEnd);
}

/**
 * Bind `varName` to `propName` ONLY at the viewport `query`'s band — `prop={(__mqN ? varName : base)}`.
 * Keeps the existing base + any OTHER per-viewport branches (chains). Clears any `data-responsive`
 * literal for the same {viewport, prop} so the inline variable wins at deploy.
 */
/** Per-LOCALE instance-prop value (optionally width-banded for a per-replica
 *  locale value): writes `prop={__activeLocale === 'fr' ? value : base}` (or
 *  `… && __mqN ?` when maxWidth-banded) via the shared scoped-expr chain —
 *  the locale twin of the per-viewport variable below. `value === null`
 *  removes that locale scope (Reset Override). Deploy-correct: useLocale()
 *  re-renders the ternary on locale switch. */
export function setLocaleInstancePropInCode(
  code: string,
  nodeId: string,
  componentName: string,
  propName: string,
  locale: string,
  value: string | null,
  bandQuery?: string,
): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) { trace.error('localeInstanceProp:no-tag', { nodeId, componentName }); return code; }
  const cur = readScopedAttr(code.slice(tag.tagStart, tag.tagEnd), code, propName);
  const key = bandQuery ? `l:${locale}|q:${bandQuery}` : `l:${locale}`;
  const next = cur.responsive.filter((r) => {
    const sk = 'locale' in r.scope ? (r.scope.query ? `l:${r.scope.locale}|q:${r.scope.query}` : `l:${r.scope.locale}`) : null;
    return sk !== key;
  });
  if (value !== null) {
    // LOCALE_PROP_DEFAULT_SENTINEL bakes the literal `undefined` — the
    // replica-removal marker: runtime falls through to the prop default and
    // the panel reads it as "localization removed on this replica".
    const branch = value === '__locale_default__' ? 'undefined' : JSON.stringify(value);
    next.unshift({ scope: bandQuery ? { locale, query: bandQuery } : { locale }, value: branch });
  }
  const built = buildScopedScalarExpr(code, cur.base, next);
  let out = writeAttr(built.code, nodeId, componentName, propName,
    next.length === 0 && !cur.base.startsWith('(')
      ? (cur.base === 'undefined' ? null : cur.base)
      : built.expr);
  out = sweepOrphanMediaGates(out);
  trace.action('localeInstanceProp:set', { nodeId, propName, locale, banded: !!bandQuery, removed: value === null });
  return out;
}

export function setResponsiveInstancePropVarInCode(
  code: string, nodeId: string, componentName: string,
  query: string, propName: string, varName: string,
): string {
  const tag0 = findInstanceTag(code, nodeId, componentName);
  if (!tag0) { trace.action('resp-instance-prop:tag-not-found', { nodeId, propName }); return code; }
  const { base, responsive } = readScopedAttr(code.slice(tag0.tagStart, tag0.tagEnd), code, propName);
  const newResp = [
    ...responsive.filter((r) => !('query' in r.scope && r.scope.query === query)),
    { scope: { query } as SerScope, value: varName },
  ];
  // buildScopedScalarExpr ensures the `const __mqN = useMediaQuery('<query>')` gate in `code`.
  const built = buildScopedScalarExpr(code, base, newResp);
  let out = ensureMediaQueryHook(built.code);
  out = writeAttr(out, nodeId, componentName, propName, built.expr);
  const w = maxWidthFromQuery(query);
  if (w != null) out = setResponsiveOverride(out, nodeId, componentName, w, propName, '', null); // clear literal
  trace.action('resp-instance-prop:set-var', { nodeId, propName, varName, query });
  return out;
}

/** Drop the per-viewport variable branch for `query` → revert that tile to the base (or remove the
 *  attr if no base + no other branches). Sweeps the now-orphan `__mqN` gate. */
export function resetResponsiveInstancePropVarInCode(
  code: string, nodeId: string, componentName: string,
  query: string, propName: string,
): string {
  const tag0 = findInstanceTag(code, nodeId, componentName);
  if (!tag0) return code;
  const { base, responsive } = readScopedAttr(code.slice(tag0.tagStart, tag0.tagEnd), code, propName);
  // Removing a per-replica VARIABLE override must leave the replica with its OWN value as a per-viewport
  // LITERAL override — NOT revert to the base/PRIMARY binding (the user saw the primary's variable reappear
  // on shadow + padding + hide). The panel detects per-viewport literals via DATA-RESPONSIVE
  // (responsiveOverrides → propOverridden + propValue), NOT an inline-ternary literal — so we (1) drop the
  // inline ternary VARIABLE branch, then (2) re-add the removed variable's current value as a data-responsive
  // literal on the SAME tile. GENERAL for every variable type (setResponsiveOverride coerces bool/number).
  const removed = responsive.find((r) => 'query' in r.scope && r.scope.query === query);
  const removedVar = removed ? parsePageVariables(code)?.variables.find((v) => v.name === removed.value) : undefined;
  const newResp = responsive.filter((r) => !('query' in r.scope && r.scope.query === query));
  const built = buildScopedScalarExpr(code, base, newResp);
  let out = built.code;
  // No branches left + base is the passthrough `undefined` (the attr was absent originally) → remove it.
  const removeAttr = newResp.length === 0 && built.expr === 'undefined';
  out = writeAttr(out, nodeId, componentName, propName, removeAttr ? null : built.expr);
  out = sweepOrphanMediaGates(out);
  // Re-express the removed variable's value as a per-viewport LITERAL override on this tile (a doubly-quoted
  // stored default is healed). Defensive: a branch value that isn't a known page variable → plain revert.
  const maxW = maxWidthFromQuery(query);
  if (removedVar && maxW != null) {
    const raw = /^"([^"]*)"$/.test(removedVar.default) ? removedVar.default.slice(1, -1) : removedVar.default;
    out = setResponsiveOverride(out, nodeId, componentName, maxW, propName, raw, null);
  }
  trace.action('resp-instance-prop:reset-var', { nodeId, propName, query, literalOverride: !!removedVar });
  return out;
}

/**
 * Read, for the instance at `vpWidth`, each prop whose inline ternary has a VARIABLE branch covering
 * that width → Map<prop, varName>. Powers the per-viewport variable pill in ComponentPropsTool.
 */
/** Classify a ternary-branch expression as a VARIABLE (bare identifier) or a LITERAL value. The JS keywords
 *  `undefined` / `null` are treated as the empty literal — the boolean nav "No" state writes `undefined`, and
 *  it must NOT be read back as a variable named "undefined". */
function classifyBranch(raw: string): { value: string; isVar: boolean } {
  raw = raw.trim();
  if (raw === 'undefined' || raw === 'null') return { value: '', isVar: false };
  if (/^[a-zA-Z_$][\w$]*$/.test(raw)) return { value: raw, isVar: true };
  let value = raw;
  try { value = JSON.parse(raw); } catch { value = raw.replace(/^["'](.*)["']$/s, '$1'); }
  return { value: String(value), isVar: false };
}

/** The per-viewport VALUE of each ternary-gated attr at `vpWidth`. `isVar` distinguishes a bare-identifier
 *  branch (a variable) from a string-literal branch (an inline per-tile override, e.g. after the user removes
 *  a base variable on a replica → that tile diverges to its own literal). */
export function getResponsiveInstancePropValueAtViewport(
  code: string, nodeId: string, componentName: string, vpWidth: number,
): Map<string, { value: string; isVar: boolean }> {
  const result = new Map<string, { value: string; isVar: boolean }>();
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return result;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const attrRe = /(?<![\w-])([a-zA-Z_]\w*)=\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(tagContent)) !== null) {
    const prop = m[1];
    const inner = m[2].trim();
    if (!inner.includes('__mq')) continue; // only ternary-gated attrs
    const { responsive } = parseScopedScalarExpr(code, inner);
    for (const r of responsive) {
      // Width scopes only — locale-scoped entries resolve via the locale
      // instance-prop path, not this per-viewport variable read.
      if (!('query' in r.scope) || r.scope.query === undefined || 'locale' in r.scope) continue;
      const maxW = maxWidthFromQuery(r.scope.query);
      const minW = minWidthFromQuery(r.scope.query);
      if (maxW != null && vpWidth <= maxW && vpWidth >= minW) {
        result.set(prop, classifyBranch(r.value));
      }
    }
  }
  return result;
}

/** Only the branches that are VARIABLES (bare identifiers) — back-compat for existing callers. */
export function getResponsiveInstancePropVarAtViewport(
  code: string, nodeId: string, componentName: string, vpWidth: number,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [k, v] of getResponsiveInstancePropValueAtViewport(code, nodeId, componentName, vpWidth)) {
    if (v.isVar) result.set(k, v.value);
  }
  return result;
}

/** The BASE (else-branch / PRIMARY) value of a ternary-gated attr — what the primary viewport shows. Returns
 *  null when the attr ISN'T `__mq`-gated (the caller should fall back to the parsed node value, which is only
 *  wrong for ternaries — a raw `href={(__mq ? … : base)}` otherwise parses to the `__mq` gate, hiding `base`). */
export function getInstancePropBaseValue(
  code: string, nodeId: string, componentName: string, propName: string,
): { value: string; isVar: boolean } | null {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return null;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const m = new RegExp(`(?<![\\w-])${propName}=\\{([^}]*)\\}`).exec(tagContent);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner.includes('__mq')) return null; // not ternary-gated — caller uses the node value
  const { base } = parseScopedScalarExpr(code, inner);
  const raw = String(base ?? '').trim();
  if (!raw) return null;
  return classifyBranch(raw);
}

// ─── Boolean nav attrs (New Tab `target`) — per-viewport on the INNER condition ───────────────────────────
// A boolean nav attr is `attr={<cond> ? "ON" : undefined}` (or the string/absent forms). The simple-scalar
// rail can't touch it (its scoped parser mis-reads the boolean's own `? :`). Instead we make the CONDITION
// itself per-viewport: `(__mq ? <vpCond> : <baseCond>) ? "ON" : undefined`, reusing the scoped-expr engine on
// just the condition. `cond` is a boolean expr token: 'true' | 'false' | a variable name.
const BOOL_NAV_ON: Record<string, string> = { target: '"_blank"', 'data-smooth-scroll': '"true"' };

/** Read the boolean CONDITION of a nav attr as a scoped expr ({base, responsive}). Handles absent (→ 'false'),
 *  `attr="_blank"` (→ 'true'), `attr={<cond> ? "ON" : undefined}`, and the per-viewport `(__mq ? … : …)` form. */
function readBoolNavCond(code: string, nodeId: string, comp: string, attr: string): { base: string; responsive: { scope: SerScope; value: string }[]; on: string } | null {
  const on = BOOL_NAV_ON[attr]; if (!on) return null;
  const tag = findInstanceTag(code, nodeId, comp); if (!tag) return null;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const brace = new RegExp(`(?<![\\w-])${esc}=\\{([^{}]*)\\}`).exec(tagContent);
  if (brace) {
    const val = brace[1].trim();
    const onEsc = on.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bm = new RegExp(`^([\\s\\S]*?)\\s*\\?\\s*${onEsc}\\s*:\\s*undefined$`).exec(val);
    let cond = bm ? bm[1].trim() : (val === 'undefined' ? 'false' : val);
    if (cond.startsWith('(') && cond.endsWith(')')) cond = cond.slice(1, -1).trim();
    const { base, responsive } = parseScopedScalarExpr(code, cond);
    return { base: String(base ?? 'false').trim() || 'false', responsive, on };
  }
  const str = new RegExp(`(?<![\\w-])${esc}="([^"]*)"`).exec(tagContent);
  if (str) return { base: str[1] === on.slice(1, -1) ? 'true' : 'false', responsive: [], on };
  return { base: 'false', responsive: [], on }; // absent → No
}

/** Set the per-viewport boolean condition for THIS tile (`cond` = 'true'|'false'|varName), keeping the base. */
export function setBoolNavCondForViewport(code: string, nodeId: string, comp: string, query: string, attr: string, cond: string): string {
  const cur = readBoolNavCond(code, nodeId, comp, attr); if (!cur) return code;
  const newResp = [...cur.responsive.filter((r) => !('query' in r.scope && r.scope.query === query)), { scope: { query } as SerScope, value: cond }];
  const built = buildScopedScalarExpr(code, cur.base, newResp);
  let out = ensureMediaQueryHook(built.code);
  out = writeAttr(out, nodeId, comp, attr, `${built.expr} ? ${cur.on} : undefined`);
  trace.action('bool-nav:set-vp-cond', { nodeId, attr, query, cond });
  return out;
}

/** Set the BASE condition only — keeps every per-viewport branch (change/remove from primary). No-op if the
 *  attr has no per-viewport branches (caller writes the plain attr then). */
export function setBoolNavCondBase(code: string, nodeId: string, comp: string, attr: string, cond: string): string {
  const cur = readBoolNavCond(code, nodeId, comp, attr); if (!cur || cur.responsive.length === 0) return code;
  const built = buildScopedScalarExpr(code, cond, cur.responsive);
  let out = ensureMediaQueryHook(built.code);
  out = writeAttr(out, nodeId, comp, attr, `${built.expr} ? ${cur.on} : undefined`);
  trace.action('bool-nav:set-base-cond', { nodeId, attr, cond });
  return out;
}

/** The base boolean condition ('true'|'false'|varName), or null if the attr isn't a boolean nav attr. */
export function getBoolNavCondBase(code: string, nodeId: string, comp: string, attr: string): string | null {
  return readBoolNavCond(code, nodeId, comp, attr)?.base ?? null;
}

/** Whether the boolean nav attr already has any per-viewport condition branch (→ writes must preserve them). */
export function boolNavHasViewportBranches(code: string, nodeId: string, comp: string, attr: string): boolean {
  const cur = readBoolNavCond(code, nodeId, comp, attr);
  return !!cur && cur.responsive.length > 0;
}

/** The per-viewport boolean condition at `vpWidth` ('true'|'false'|varName), or null if this tile has none. */
export function getBoolNavCondAtViewport(code: string, nodeId: string, comp: string, attr: string, vpWidth: number): string | null {
  const cur = readBoolNavCond(code, nodeId, comp, attr); if (!cur) return null;
  for (const r of cur.responsive) {
    if (!('query' in r.scope) || r.scope.query === undefined || 'locale' in r.scope) continue;
    const maxW = maxWidthFromQuery(r.scope.query); const minW = minWidthFromQuery(r.scope.query);
    if (maxW != null && vpWidth <= maxW && vpWidth >= minW) return r.value;
  }
  return null;
}

/** Drop the per-viewport condition for `query` (revert this tile to the base). */
export function resetBoolNavCondForViewport(code: string, nodeId: string, comp: string, query: string, attr: string): string {
  const cur = readBoolNavCond(code, nodeId, comp, attr); if (!cur) return code;
  const kept = cur.responsive.filter((r) => !('query' in r.scope && r.scope.query === query));
  if (kept.length === cur.responsive.length) return code;
  if (kept.length === 0) {
    // back to a plain base attr (no __mq) — Yes → `{"_blank"}`, No → drop the attr, var → `var ? "ON" : undefined`
    if (cur.base === 'true') return writeAttr(code, nodeId, comp, attr, cur.on);
    if (cur.base === 'false') return writeAttr(code, nodeId, comp, attr, null);
    return writeAttr(code, nodeId, comp, attr, `${cur.base} ? ${cur.on} : undefined`);
  }
  const built = buildScopedScalarExpr(code, cur.base, kept);
  let out = ensureMediaQueryHook(built.code);
  out = writeAttr(out, nodeId, comp, attr, `${built.expr} ? ${cur.on} : undefined`);
  return out;
}

/** Replace ONLY the BASE (else-branch / PRIMARY) of a ternary-gated attr, keeping EVERY per-viewport branch
 *  intact. This is "remove from the primary" without wiping the replicas' INDIVIDUAL overrides — the synced
 *  viewports (which fall through to the base) get `newBaseExpr`, the per-tile branches stay untouched. Returns
 *  the code unchanged (no-op) if the attr has no per-viewport branches — the caller removes the whole binding
 *  in that case. `newBaseExpr` is a RAW JS expression string (e.g. `'""'` for an empty literal). */
export function setInstancePropBaseInCode(
  code: string, nodeId: string, componentName: string, propName: string, newBaseExpr: string,
): string {
  const tag0 = findInstanceTag(code, nodeId, componentName);
  if (!tag0) return code;
  const { responsive } = readScopedAttr(code.slice(tag0.tagStart, tag0.tagEnd), code, propName);
  if (responsive.length === 0) return code; // no per-viewport branches to preserve — caller removes wholesale
  const built = buildScopedScalarExpr(code, newBaseExpr, responsive);
  let out = ensureMediaQueryHook(built.code);
  out = writeAttr(out, nodeId, componentName, propName, built.expr);
  trace.action('resp-instance-prop:set-base', { nodeId, propName, newBaseExpr });
  return out;
}
