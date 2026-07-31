/**
 * responsive-text-vars-gen.ts — per-VIEWPORT TEXT-content variable bindings on a template/page node.
 *
 * The text analog of `responsive-style-vars-gen.ts`. A text-content variable binds as the node's
 * sole JSX text child (`<p>{header}</p>`). To make it per-viewport — bind a DIFFERENT variable on
 * Tablet, or REMOVE (freeze to a literal) on one tile — we wrap the child in a `useMediaQuery`-gated
 * ternary whose branches are bare variable IDENTIFIERS and/or string literals (banded, so a Tablet
 * override doesn't paint Mobile):
 *
 *   <p>{(__mq2 ? tabletHeader : header)}</p>          // bind tabletHeader on Tablet, header elsewhere
 *   <p>{(__mq2 ? "Ready to change" : header)}</p>     // REMOVE on Tablet → frozen literal there
 *
 * Mirrors `bindTextVariableForVariantInCode` (per-VARIANT text) but keyed on `__mqN` instead of
 * `variant === '…'`. Reuses the shared gate machinery (`ensureMediaGate`/`buildScopedScalarExpr`/
 * `bandedQuery`-equivalent). Source = deploy reality.
 */

import { trace } from '@/shared/debug-trace';
import { findJSXDataIdIndex, findTagClose, scanGates } from './generator-utils';
import {
  ensureMediaQueryHook,
  sweepOrphanMediaGates,
  buildScopedScalarExpr,
  type SerScope,
} from './generator-motion';

/** A parsed per-viewport text binding: the base fallback + per-viewport branches (var ident or quoted literal). */
export interface ResponsiveTextVar {
  base: string;
  byViewport: Map<number, string>;
}

/** The BANDED media query for a viewport-width override (so a Tablet override does NOT touch Mobile). */
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

/** Locate a node's TEXT-CHILD content span: between the opening tag's `>` and the matching `</tag>`. */
function textChildSpan(code: string, nodeId: string): { start: number; end: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return null;
  const ltIdx = code.lastIndexOf('<', idIdx);
  if (ltIdx < 0) return null;
  const tag = code.slice(ltIdx + 1).match(/^[A-Za-z][\w.]*/)?.[0];
  if (!tag) return null;
  const gtIdx = findTagClose(code, idIdx);
  if (gtIdx < 0 || code[gtIdx - 1] === '/') return null; // self-closing → no children
  const closeIdx = code.indexOf(`</${tag}>`, gtIdx);
  if (closeIdx < 0) return null;
  return { start: gtIdx + 1, end: closeIdx };
}

/** Parse a text-child's content into { base, byViewport }. Handles `{expr}`, a bare `{ident}`, or
 *  a `{(__mqN ? branch : base)}` ternary chain. Branches are var idents OR quoted literals. */
function parseTextVarExpr(content: string, gateToWidth: Map<string, number>): ResponsiveTextVar {
  const out: ResponsiveTextVar = { base: '', byViewport: new Map() };
  let rest = content.trim();
  if (rest.startsWith('{') && rest.endsWith('}')) rest = rest.slice(1, -1).trim();
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
  // Consume `__mqN ? <branch> :` where branch is a quoted string or an identifier.
  const vpBranch = /^(__mq\d+)\s*\?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[\w.]+)\s*:\s*/;
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

function buildTextVarExpr(code: string, r: ResponsiveTextVar): { code: string; expr: string } {
  const responsive = [...r.byViewport.entries()]
    .sort((a, b) => a[0] - b[0]) // smallest width first → most-specific gate outermost
    .map(([w, v]) => ({ scope: { query: bandedQuery(code, w) } as SerScope, value: v }));
  return buildScopedScalarExpr(code, r.base, responsive);
}

function writeTextChild(code: string, nodeId: string, inner: string): string {
  const span = textChildSpan(code, nodeId);
  if (!span) return code;
  return code.slice(0, span.start) + `{${inner}}` + code.slice(span.end);
}

/**
 * Set (or clear) a PER-VIEWPORT text branch. `branch` is a variable identifier (bind) OR a quoted
 * string literal (a frozen value, used by REMOVE). Empty / equal-to-base clears that viewport.
 * `baseFallback` seeds the ternary fallback when the node has no existing text binding.
 */
export function setResponsiveTextVariableInCode(
  code: string,
  nodeId: string,
  vpWidth: number,
  branch: string,
  baseFallback: string,
): string {
  const span = textChildSpan(code, nodeId);
  if (!span) return code;
  const gateToWidth = scanGates(code);
  const childContent = code.slice(span.start, span.end);
  const r = parseTextVarExpr(childContent, gateToWidth);
  // A PLAIN-TEXT child (no `{…}` wrapper) parses to its raw words as `base` — NOT valid JS for the
  // ternary fallback (`… : Ready to change`). Use the caller's quoted `baseFallback` instead. Also
  // seed it when the child had no base at all.
  if (!childContent.trim().startsWith('{') || !r.base) r.base = baseFallback;
  if (!branch || branch === r.base) r.byViewport.delete(vpWidth);
  else r.byViewport.set(vpWidth, branch);

  const built = buildTextVarExpr(code, r);
  let next = writeTextChild(built.code, nodeId, built.expr);
  if (built.expr.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-text-vars:set', { nodeId, vpWidth, branch, base: r.base });
  return next;
}

/** Remove a per-viewport text branch (revert that tile to the cascaded base). */
export function resetResponsiveTextVariableInCode(code: string, nodeId: string, vpWidth: number): string {
  return setResponsiveTextVariableInCode(code, nodeId, vpWidth, '', '');
}

/** Replace the BASE branch of a per-viewport text ternary (e.g. the base var removed on the primary). */
export function setResponsiveTextBaseInCode(code: string, nodeId: string, newBase: string): string {
  const span = textChildSpan(code, nodeId);
  if (!span) return code;
  const r = parseTextVarExpr(code.slice(span.start, span.end), scanGates(code));
  r.base = newBase;
  const built = buildTextVarExpr(code, r);
  let next = writeTextChild(built.code, nodeId, built.expr);
  if (built.expr.includes('__mq')) next = ensureMediaQueryHook(next);
  next = sweepOrphanMediaGates(next);
  trace.action('responsive-text-vars:set-base', { nodeId, newBase });
  return next;
}

/** Read the per-viewport text binding off a node (base + width→branch). */
export function parseResponsiveTextVarInCode(code: string, nodeId: string): ResponsiveTextVar {
  const span = textChildSpan(code, nodeId);
  if (!span) return { base: '', byViewport: new Map() };
  return parseTextVarExpr(code.slice(span.start, span.end), scanGates(code));
}
