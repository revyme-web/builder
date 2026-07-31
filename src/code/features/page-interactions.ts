// page-interactions.ts — Per-node "Set Variable" interactions on regular pages.
//
// On a page file, the user can wire interactions like:
//   "On Click of this button, set the `fade` variable to 0.39"
// The source of truth is the JSX itself — the event handler attribute on the
// node:
//
//   <div data-id="button" onClick={() => setFade(0.39)}>...</div>
//
// We detect these by scanning the selected node's opening element for
// `onClick`/`onMouseEnter`/`onMouseLeave` attributes whose handler bodies
// contain `setVarName(value)` calls. This file is the parser side; code
// generation lives in `src/code/generation/page-interactions-gen.ts`.
//
// Why source-of-truth in JSX (not a separate `pageInteractions = [...]` array
// like variants do)?
//   - Interactions are NODE-local. Storing them in a top-level array would
//     require nodeId in every entry plus a sync layer keeping the JSX in step
//     with the array. The handler attribute IS the truth — easier.
//   - Round-trips through prettier/format/manual edits stay coherent.
//
// Component master files keep using `connection-config.ts` for variant
// switches (different mechanism, different file type). The two systems
// coexist; InteractionsTool dispatches to the right one based on file type.

import { parseJSX, findFirstElementByDataId, findAttribute, traverse } from '../parsing/ast-utils';
import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Trigger events supported on regular DOM elements. `inView` and `clickStart`
 * (framer-motion-only) are deliberately omitted from the page-interaction set
 * — those rely on motion props or IntersectionObserver and we'll add them in
 * a follow-up if needed.
 */
export type InteractionTrigger = 'click' | 'mouseEnter' | 'mouseLeave';

export const INTERACTION_TRIGGERS: InteractionTrigger[] = ['click', 'mouseEnter', 'mouseLeave'];

export interface PageInteraction {
  nodeId: string;
  trigger: InteractionTrigger;
  /** The setter variable name, e.g. `fade` (so `setFade` is the handler call). */
  varName: string;
  /** Stored as a string so the type-aware editor controls (number/color/text/boolean) handle conversion uniformly. */
  value: string;
}

// ─── Trigger ↔ JSX attribute mapping ────────────────────────────────────────

const TRIGGER_TO_ATTR: Record<InteractionTrigger, string> = {
  click: 'onClick',
  mouseEnter: 'onMouseEnter',
  mouseLeave: 'onMouseLeave',
};

const ATTR_TO_TRIGGER: Record<string, InteractionTrigger> = {
  onClick: 'click',
  onMouseEnter: 'mouseEnter',
  onMouseLeave: 'mouseLeave',
};

export function attrForTrigger(trigger: InteractionTrigger): string {
  return TRIGGER_TO_ATTR[trigger];
}

export function triggerForAttr(attr: string): InteractionTrigger | null {
  return ATTR_TO_TRIGGER[attr] ?? null;
}

// ─── Setter name conversion ─────────────────────────────────────────────────

/** `fade` → `setFade`. Mirrors the shape syncPageVariableHooks emits. */
export function setterName(varName: string): string {
  return `set${varName.charAt(0).toUpperCase()}${varName.slice(1)}`;
}

/** `setFade` → `fade`. Returns null when the prefix doesn't match. */
export function varNameFromSetter(setter: string): string | null {
  if (!setter.startsWith('set') || setter.length <= 3) return null;
  const rest = setter.slice(3);
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Extract all "Set Variable" interactions on a single node. Walks the node's
 * opening-element attributes, looks at each event handler's body, and pulls
 * `setX(value)` calls that match a known page-variable setter shape.
 *
 * Returns interactions in stable trigger order (click → mouseEnter → mouseLeave)
 * so the panel UI doesn't reorder rows on every parse.
 */
export function parsePageInteractionsForNode(code: string, nodeId: string): PageInteraction[] {
  const ast = parseJSX(code);
  if (!ast) return [];

  const out: PageInteraction[] = [];
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    for (const attr of opening.attributes) {
      if (!t.isJSXAttribute(attr)) continue;
      if (!t.isJSXIdentifier(attr.name)) continue;
      const trigger = triggerForAttr(attr.name.name);
      if (!trigger) continue;
      if (!attr.value || !t.isJSXExpressionContainer(attr.value)) continue;
      const expr = attr.value.expression;
      // Two shapes we recognize:
      //   () => setFade(0.5)              — single arrow with one call
      //   () => { setFade(0.5); setBrand('#ff'); }  — block body with multiple
      // We collect from both. Anything else (named handler ref, complex logic)
      // is left alone — that's user-authored code.
      const calls = collectSetterCallsFromHandler(expr);
      for (const call of calls) {
        out.push({ nodeId, trigger, varName: call.varName, value: call.value });
      }
    }
  });

  // Stable sort by trigger order, then by varName for determinism.
  const triggerOrder: Record<InteractionTrigger, number> = { click: 0, mouseEnter: 1, mouseLeave: 2 };
  out.sort((a, b) => triggerOrder[a.trigger] - triggerOrder[b.trigger] || a.varName.localeCompare(b.varName));
  trace.fn('page-interactions:parse-node', { nodeId, count: out.length });
  return out;
}

/**
 * Walk the entire AST and pull interactions from EVERY node that has any.
 * Used by the atom that populates the panel on selection — keeps a single
 * pass through the AST instead of one per selected node.
 */
export function parseAllPageInteractions(code: string): PageInteraction[] {
  const ast = parseJSX(code);
  if (!ast) return [];

  const out: PageInteraction[] = [];
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const idAttr = findAttribute(opening, 'data-id');
      if (!idAttr || idAttr.value?.type !== 'StringLiteral') return;
      const nodeId = idAttr.value.value;

      for (const attr of opening.attributes) {
        if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue;
        const trigger = triggerForAttr(attr.name.name);
        if (!trigger) continue;
        if (!attr.value || !t.isJSXExpressionContainer(attr.value)) continue;
        const calls = collectSetterCallsFromHandler(attr.value.expression);
        for (const call of calls) {
          out.push({ nodeId, trigger, varName: call.varName, value: call.value });
        }
      }
    },
  });
  trace.fn('page-interactions:parse-all', { count: out.length });
  return out;
}

// ─── Internal: handler body inspection ──────────────────────────────────────

interface SetterCall {
  varName: string;
  value: string;
}

/**
 * Given the expression in `onClick={...}`, pull out every `setX(literalValue)`
 * call that follows our naming convention and has a single literal argument
 * we can reason about.
 *
 * Skips:
 *   - Calls whose callee isn't a simple `setX` identifier (member access, etc.)
 *   - Calls with non-literal arguments (expressions, refs) — not user-editable
 *     through a variable picker; leave them alone
 */
function collectSetterCallsFromHandler(expr: t.Expression | t.JSXEmptyExpression): SetterCall[] {
  const out: SetterCall[] = [];
  if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return out;

  const body = expr.body;
  if (t.isCallExpression(body)) {
    const call = extractSetterCall(body);
    if (call) out.push(call);
    return out;
  }
  if (t.isBlockStatement(body)) {
    for (const stmt of body.body) {
      if (!t.isExpressionStatement(stmt)) continue;
      if (!t.isCallExpression(stmt.expression)) continue;
      const call = extractSetterCall(stmt.expression);
      if (call) out.push(call);
    }
  }
  return out;
}

/**
 * Pull `{ varName, value }` from a `setX(arg)` call expression. Returns null
 * for calls that don't look like a setter (wrong name shape, non-literal arg,
 * member-access callee, multiple args, etc.).
 */
function extractSetterCall(call: t.CallExpression): SetterCall | null {
  if (!t.isIdentifier(call.callee)) return null;
  const varName = varNameFromSetter(call.callee.name);
  if (!varName) return null;
  if (call.arguments.length !== 1) return null;
  const arg = call.arguments[0];
  // Literal-only: string/number/boolean. Other expressions are user code we
  // shouldn't paraphrase as a single value string.
  if (t.isStringLiteral(arg)) return { varName, value: arg.value };
  if (t.isNumericLiteral(arg)) return { varName, value: String(arg.value) };
  if (t.isBooleanLiteral(arg)) return { varName, value: String(arg.value) };
  // Negative numeric literals show up as UnaryExpression('-', NumericLiteral)
  if (
    t.isUnaryExpression(arg) &&
    arg.operator === '-' &&
    t.isNumericLiteral(arg.argument)
  ) return { varName, value: `-${arg.argument.value}` };
  return null;
}
