// close-overlay-gen.ts — "Close Overlay" interaction.
//
// A child INSIDE an overlay can close it by setting the overlay's state var to
// false: the overlay renders as `{<var> && <motion.div data-id="overlay-X">…}`
// where `<var> = stateVarName('overlay-X')`, so closing is `set<X>Open(false)`.
//
// This is structurally a "Set Variable → false" on the overlay's state var, so
// ADD/REMOVE reuse page-interactions-gen (with an explicit 'boolean' type so the
// literal is `false`, not "false"). The Delay wraps the call in setTimeout —
// `() => setTimeout(() => set<X>Open(false), ms)` — which the plain Set-Variable
// parser can't read, so this file owns the parse + the delay wrap/unwrap.
//
// Works identically for `relative` and `fixed` overlays (same state setter).

import * as t from '@babel/types';
import generate from '@babel/generator';
import { parseJSX, findFirstElementByDataId, findAttribute } from '../parsing/ast-utils';
import { parseOverlayCalls } from '../parsing/overlay-parser';
import { stateVarName } from './overlay-gen';
import { addPageInteractionInCode, removePageInteractionInCode } from './page-interactions-gen';
import { attrForTrigger, triggerForAttr, type InteractionTrigger } from '../features/page-interactions';
import { trace } from '@/shared/debug-trace';

export interface CloseOverlayInteraction {
  nodeId: string;
  trigger: InteractionTrigger;
  overlayId: string;
  /** Delay before closing, in seconds (0 = immediate). */
  delay: number;
}

/** `set<StateVar>` — the setter that closes the overlay (matches overlay-gen). */
export function overlayCloseSetter(overlayId: string): string {
  const v = stateVarName(overlayId);
  return `set${v.charAt(0).toUpperCase()}${v.slice(1)}`;
}

/** Map of `set<X>Open` → overlayId for every overlay declared in the file. */
function setterToOverlayMap(code: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of parseOverlayCalls(code)) {
    if (o.overlayId) m.set(overlayCloseSetter(o.overlayId), o.overlayId);
  }
  return m;
}

/** Is `node` a `set<X>Open(false)` call for a known overlay? → overlayId | null. */
function matchOverlayClose(node: t.Node, map: Map<string, string>): string | null {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return null;
  if (!map.has(node.callee.name)) return null;
  if (node.arguments.length !== 1 || !t.isBooleanLiteral(node.arguments[0], { value: false })) return null;
  return map.get(node.callee.name) ?? null;
}

/** Detect a close in a handler body expr/stmt-expr — direct OR setTimeout-wrapped. */
function detectClose(e: t.Node, map: Map<string, string>): { overlayId: string; delayMs: number } | null {
  const direct = matchOverlayClose(e, map);
  if (direct) return { overlayId: direct, delayMs: 0 };
  if (
    t.isCallExpression(e) &&
    t.isIdentifier(e.callee, { name: 'setTimeout' }) &&
    e.arguments.length >= 1 &&
    t.isArrowFunctionExpression(e.arguments[0])
  ) {
    const ov = matchOverlayClose(e.arguments[0].body, map);
    if (ov) {
      const msArg = e.arguments[1];
      const delayMs = msArg && t.isNumericLiteral(msArg) ? msArg.value : 0;
      return { overlayId: ov, delayMs };
    }
  }
  return null;
}

/** Read a node's `data-id` string from its opening element. */
function dataIdOf(opening: t.JSXOpeningElement): string | null {
  const a = findAttribute(opening, 'data-id') as t.JSXAttribute | null;
  return a && a.value && t.isStringLiteral(a.value) ? a.value.value : null;
}

/**
 * The id of the overlay that ENCLOSES `nodeId` (the nearest ancestor whose
 * data-id is a declared overlay), or null. This is what gates the "Close
 * Overlay" menu item — only children inside an overlay can close it. Walks
 * AST ancestors (excludes the node itself, so selecting the overlay backdrop
 * doesn't offer closing itself — it already dismisses on outside-click).
 */
export function enclosingOverlayForNode(code: string, nodeId: string): string | null {
  const ast = parseJSX(code);
  if (!ast) return null;
  const overlayIds = new Set(parseOverlayCalls(code).map((o) => o.overlayId).filter(Boolean));
  if (overlayIds.size === 0) return null;
  let found: string | null = null;
  findFirstElementByDataId(ast, nodeId, (path) => {
    let p = path.parentPath;
    while (p) {
      if (typeof p.isJSXElement === 'function' && p.isJSXElement()) {
        const id = dataIdOf((p.node as t.JSXElement).openingElement);
        if (id && overlayIds.has(id)) { found = id; return; }
      }
      p = p.parentPath;
    }
  });
  return found;
}

/** Parse all Close Overlay interactions on a node (handles direct + delayed). */
export function parseCloseOverlayForNode(code: string, nodeId: string): CloseOverlayInteraction[] {
  const ast = parseJSX(code);
  if (!ast) return [];
  const map = setterToOverlayMap(code);
  if (map.size === 0) return [];

  const out: CloseOverlayInteraction[] = [];
  findFirstElementByDataId(ast, nodeId, (path) => {
    for (const attr of path.node.openingElement.attributes) {
      if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
      const trigger = triggerForAttr(attr.name.name);
      if (!trigger) continue;
      if (!attr.value || !t.isJSXExpressionContainer(attr.value)) continue;
      const expr = attr.value.expression;
      if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) continue;
      const body = expr.body;
      const exprs: t.Node[] = t.isBlockStatement(body)
        ? body.body.filter((s): s is t.ExpressionStatement => t.isExpressionStatement(s)).map((s) => s.expression)
        : [body];
      for (const e of exprs) {
        const hit = detectClose(e, map);
        if (hit) out.push({ nodeId, trigger, overlayId: hit.overlayId, delay: hit.delayMs / 1000 });
      }
    }
  });
  const order: Record<InteractionTrigger, number> = { click: 0, mouseEnter: 1, mouseLeave: 2 };
  out.sort((a, b) => order[a.trigger] - order[b.trigger] || a.overlayId.localeCompare(b.overlayId));
  trace.fn('close-overlay:parse-node', { nodeId, count: out.length });
  return out;
}

/** Add `on<Trigger>={() => set<X>Open(false)}` (merging into any existing handler). */
export function addCloseOverlayInCode(code: string, nodeId: string, trigger: InteractionTrigger, overlayId: string): string {
  trace.action('close-overlay:add', { nodeId, trigger, overlayId });
  return addPageInteractionInCode(code, nodeId, trigger, stateVarName(overlayId), 'false', 'boolean');
}

/** Remove the close call from the handler (unwrapping any delay first). */
export function removeCloseOverlayInCode(code: string, nodeId: string, trigger: InteractionTrigger, overlayId: string): string {
  trace.action('close-overlay:remove', { nodeId, trigger, overlayId });
  const undelayed = setCloseOverlayDelayInCode(code, nodeId, trigger, overlayId, 0);
  return removePageInteractionInCode(undelayed, nodeId, trigger, stateVarName(overlayId));
}

/** Wrap (or unwrap, when delaySec=0) the close call in setTimeout. */
export function setCloseOverlayDelayInCode(
  code: string,
  nodeId: string,
  trigger: InteractionTrigger,
  overlayId: string,
  delaySec: number,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const setter = overlayCloseSetter(overlayId);
  const map = new Map([[setter, overlayId]]);
  const ms = Math.max(0, Math.round((delaySec || 0) * 1000));
  const attrName = attrForTrigger(trigger);
  let mutated = false;

  const rebuild = (e: t.Node): t.Expression | null => {
    if (!detectClose(e, map)) return null;
    const call = t.callExpression(t.identifier(setter), [t.booleanLiteral(false)]);
    return ms > 0
      ? t.callExpression(t.identifier('setTimeout'), [t.arrowFunctionExpression([], call), t.numericLiteral(ms)])
      : call;
  };

  findFirstElementByDataId(ast, nodeId, (path) => {
    const existing = findAttribute(path.node.openingElement, attrName) as t.JSXAttribute | null;
    if (!existing || !existing.value || !t.isJSXExpressionContainer(existing.value)) return;
    const expr = existing.value.expression;
    if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return;
    const body = expr.body;
    if (t.isBlockStatement(body)) {
      for (let i = 0; i < body.body.length; i++) {
        const stmt = body.body[i];
        if (!t.isExpressionStatement(stmt)) continue;
        const rebuilt = rebuild(stmt.expression);
        if (rebuilt) { body.body[i] = t.expressionStatement(rebuilt); mutated = true; }
      }
    } else {
      const rebuilt = rebuild(body);
      if (rebuilt) { expr.body = rebuilt; mutated = true; }
    }
  });

  if (!mutated) return code;
  try {
    return generate(ast, { retainLines: true }, code).code;
  } catch {
    return code;
  }
}
