/**
 * responsive-style-vars-gen.ts — per-VIEWPORT VARIABLE bindings on a style prop
 * of a normal page/template node.
 *
 * A page variable can't be expressed per-viewport with `@media` CSS (a CSS rule
 * can't reference a JS `useState` variable), so — exactly like scroll-variant
 * `fromVar`, instance-fx ranges and responsive raw-element attrs — we encode the
 * per-viewport binding as an inline `useMediaQuery`-gated ternary IN THE STYLE
 * OBJECT, whose branches are bare variable IDENTIFIERS (source = deploy reality):
 *
 *   backgroundColor: (__mq0 ? colorTablet : color1)
 *     // __mq0 = useMediaQuery('(max-width: 768px)'); colorTablet on Tablet, color1 elsewhere
 *   chained: (__mq1 ? colorMobile : __mq0 ? colorTablet : color1)   // smallest width first
 *
 * The base (ternary fallback) is the primary/Desktop value — itself a variable
 * identifier OR a literal. Gates reuse `ensureMediaGate` (one `useMediaQuery`
 * const per query, shared across features) + `ensureMediaQueryHook`. This mirrors
 * `setConditionalStyleInCode` (per-VARIANT) but keyed on viewport, and
 * `responsive-attrs-gen.ts` (per-viewport ATTR) but for STYLE props with
 * identifier (variable) values instead of string literals.
 */

import { trace } from '@/shared/debug-trace';
import { findJSXDataIdIndex, findStyleObjectEnd, scanGates } from './generator-utils';
import {
  ensureMediaQueryHook,
  sweepOrphanMediaGates,
  buildScopedScalarExpr,
  type SerScope,
} from './generator-motion';

/** A parsed per-viewport style-variable binding: the base fallback + per-viewport overrides. */
export interface ResponsiveStyleVar {
  /** Fallback expression (primary/Desktop): a variable identifier OR a literal like `'#fff'`. */
  base: string;
  /** breakpoint width (px) → override variable identifier. */
  byViewport: Map<number, string>;
}

/**
 * The media query a viewport-width override gates on. BANDED to that viewport's exclusive range —
 * `(max-width: Wpx) and (min-width: <prevBp+1>px)` — so a Tablet override does NOT cascade onto
 * Mobile (each replica inherits Desktop until changed individually, matching the `@media` system +
 * reusing the existing banded `__mqN`). The smallest breakpoint has no min-width. Breakpoints are
 * read from the page's `data-responsive` `_bp` list; falls back to a bare max-width if absent.
 */
function bandedQuery(code: string, width: number): string {
  const m = code.match(/_bp"?\s*:\s*\[([\d,\s]+)\]/);
  const bps = m
    ? m[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
    : [];
  const prev = bps.filter((b) => b < width).pop();
  // INCLUSIVE lower bound (prev, not prev+1): fractional device widths fell
  // in the (prev, prev+1) gap and resolved the BASE value (same fix as the
  // @media bands in generator-styles getMinWidth). At exactly `prev` both
  // gates are true and the ternary chain checks the SMALLEST width first,
  // so the smaller band wins — matching the CSS cascade.
  return prev != null ? `(max-width: ${width}px) and (min-width: ${prev + 0.02}px)` : `(max-width: ${width}px)`;
}

/** Locate a node's `style={{ … }}` object content span: [objStart, objEnd) (between `{{` and the matching `}}`). */
function styleObjSpan(code: string, nodeId: string): { objStart: number; objEnd: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return null;
  const styleStart = code.indexOf('style={{', idIdx);
  if (styleStart < 0) return null;
  const objStart = styleStart + 'style={{'.length;
  const pos = findStyleObjectEnd(code, objStart);
  if (pos === -1) return null;
  return { objStart, objEnd: pos };
}

/** Find a TOP-LEVEL prop's key+value span inside the style-object content (paren/brace/bracket aware). */
function propValueSpan(
  content: string,
  prop: string,
): { keyStart: number; valStart: number; valEnd: number } | null {
  const re = new RegExp(`(^|[,{]\\s*)(?:${prop}|'${prop}'|"${prop}")\\s*:`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // Confirm the key sits at top level (not nested inside a value's braces/parens).
    let depth = 0;
    for (let i = 0; i < m.index + m[1].length; i++) {
      const c = content[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
    }
    if (depth !== 0) continue;
    const keyStart = m.index + m[1].length;
    const valStart = m.index + m[0].length;
    let d = 0, i = valStart;
    while (i < content.length) {
      const c = content[i];
      if (c === '{' || c === '(' || c === '[') d++;
      else if (c === '}' || c === ')' || c === ']') { if (d === 0) break; d--; }
      else if (c === ',' && d === 0) break;
      i++;
    }
    return { keyStart, valStart, valEnd: i };
  }
  return null;
}

/**
 * Parse a style value expression into { base, byViewport }. Handles a bare value
 * (`color1` / `'#fff'`), and a `__mqN ? <ident-or-literal> : …` ternary chain.
 * Per-VARIANT (`variant === '…'`) tests are NOT consumed here (left intact in base).
 */
function parseStyleVarExpr(exprRaw: string, gateToWidth: Map<string, number>): ResponsiveStyleVar {
  const out: ResponsiveStyleVar = { base: '', byViewport: new Map() };
  let rest = exprRaw.trim();
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
  // Consume leading `__mqN ? <value> :` branches (value = identifier or literal, never contains `?`/`:`).
  const vpBranch = /^(__mq\d+)\s*\?\s*([^?:]+?)\s*:\s*/;
  for (;;) {
    const m = vpBranch.exec(rest);
    if (!m) break;
    const w = gateToWidth.get(m[1]);
    if (w != null) out.byViewport.set(w, m[2].trim());
    rest = rest.slice(m[0].length);
  }
  out.base = rest.trim();
  return out;
}

/** Build the style value expression from a ResponsiveStyleVar, ensuring each gate exists. */
function buildStyleVarExpr(code: string, r: ResponsiveStyleVar): { code: string; expr: string } {
  const responsive = [...r.byViewport.entries()]
    .sort((a, b) => a[0] - b[0]) // smallest width first → most-specific gate outermost in the ternary
    .map(([w, v]) => ({ scope: { query: bandedQuery(code, w) } as SerScope, value: v }));
  return buildScopedScalarExpr(code, r.base, responsive);
}

/** Write (replace or insert) a style prop's value inside the node's style object. */
function writeStyleProp(code: string, nodeId: string, property: string, expr: string): string {
  const span = styleObjSpan(code, nodeId);
  if (!span) return code;
  let content = code.slice(span.objStart, span.objEnd);
  const entry = `${property}: ${expr}`;
  const pv = propValueSpan(content, property);
  if (pv) {
    content = content.slice(0, pv.keyStart) + entry + content.slice(pv.valEnd);
  } else {
    const spreadIdx = content.lastIndexOf('...style');
    if (spreadIdx !== -1) {
      content = content.slice(0, spreadIdx) + entry + ', ' + content.slice(spreadIdx);
    } else {
      const t = content.trimEnd();
      content = t + (t && !t.endsWith(',') && !t.endsWith('{') ? ', ' : ' ') + entry + ' ';
    }
  }
  return code.slice(0, span.objStart) + content + code.slice(span.objEnd);
}

/**
 * Set (or clear) a PER-VIEWPORT VARIABLE binding on `property`. Passing `varName === ''`
 * (or a name equal to the base) removes that viewport's override. `baseFallback` seeds the
 * ternary fallback when the prop has no existing value yet (the current Desktop value/binding).
 * Ensures the gate + `useMediaQuery` hook and sweeps any now-orphaned gate.
 */
export function setResponsiveStyleVariableInCode(
  code: string,
  nodeId: string,
  vpWidth: number,
  property: string,
  varName: string,
  baseFallback: string,
): string {
  const span = styleObjSpan(code, nodeId);
  if (!span) return code;
  const gateToWidth = scanGates(code);
  const pv = propValueSpan(code.slice(span.objStart, span.objEnd), property);
  const r: ResponsiveStyleVar = pv
    ? parseStyleVarExpr(code.slice(span.objStart, span.objEnd).slice(pv.valStart, pv.valEnd), gateToWidth)
    : { base: baseFallback, byViewport: new Map() };
  if (!r.base) r.base = baseFallback;

  if (!varName || varName === r.base) r.byViewport.delete(vpWidth);
  else r.byViewport.set(vpWidth, varName);

  const built = buildStyleVarExpr(code, r);
  let next = writeStyleProp(built.code, nodeId, property, built.expr);
  if (built.expr.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-style-vars:set', { nodeId, property, vpWidth, varName, base: r.base });
  return next;
}

/** Remove a per-viewport variable override (revert that viewport to the cascaded base). */
export function resetResponsiveStyleVariableInCode(
  code: string,
  nodeId: string,
  vpWidth: number,
  property: string,
): string {
  return setResponsiveStyleVariableInCode(code, nodeId, vpWidth, property, '', '');
}

/**
 * Replace the BASE (fallback / primary-viewport) branch of a per-viewport style binding with a new
 * expression — used when the base VARIABLE is removed on the primary tile: the value is a
 * `__mq ? override : base` ternary (not a bare identifier), so the plain unbind can't touch it.
 * Keeps the per-viewport override branches. `newBase` must be a JS expression (a quoted literal
 * like `'#97cffc'`, or an identifier). With no per-viewport branches it degrades to a plain write.
 */
export function setResponsiveStyleBaseInCode(
  code: string,
  nodeId: string,
  property: string,
  newBase: string,
): string {
  const span = styleObjSpan(code, nodeId);
  if (!span) return code;
  const pv = propValueSpan(code.slice(span.objStart, span.objEnd), property);
  if (!pv) return code;
  const r = parseStyleVarExpr(code.slice(span.objStart, span.objEnd).slice(pv.valStart, pv.valEnd), scanGates(code));
  r.base = newBase;
  const built = buildStyleVarExpr(code, r);
  let next = writeStyleProp(built.code, nodeId, property, built.expr);
  if (built.expr.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-style-vars:set-base', { nodeId, property, newBase, vpCount: r.byViewport.size });
  return next;
}

/** Read the per-viewport variable binding for `property` off a node (base + width→var). */
export function parseResponsiveStyleVarInCode(code: string, nodeId: string, property: string): ResponsiveStyleVar {
  const span = styleObjSpan(code, nodeId);
  if (!span) return { base: '', byViewport: new Map() };
  const content = code.slice(span.objStart, span.objEnd);
  const pv = propValueSpan(content, property);
  if (!pv) return { base: '', byViewport: new Map() };
  return parseStyleVarExpr(content.slice(pv.valStart, pv.valEnd), scanGates(code));
}
