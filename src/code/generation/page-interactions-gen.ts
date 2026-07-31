// page-interactions-gen.ts — Code generation for "Set Variable" interactions.
//
// Writes `onClick={() => setFade(0.5)}` (or merges into an existing handler)
// onto a node's opening element. The reverse (remove) takes a setter out of
// the handler body, dropping the whole attribute when the body becomes empty.
//
// Coexistence:
//   - Component master files use `connection-config.ts` for variant switches
//     (they emit `onTap`, `setVariant(...)` on the root motion element).
//     This file is for regular page files where the handler is a plain
//     `onClick` etc. on any node.
//   - We never edit handlers we didn't create. If a node has an `onClick`
//     authored by the user with non-setter calls, we add ours alongside in a
//     block body and leave the existing calls in place.

import * as t from '@babel/types';
import generate from '@babel/generator';
import { parseJSX, findFirstElementByDataId, findAttribute } from '../parsing/ast-utils';
import {
  setterName,
  varNameFromSetter,
  attrForTrigger,
  type InteractionTrigger,
} from '../features/page-interactions';
import { parsePageVariables, type PageVariableType } from '../features/page-variables';
import { trace } from '@/shared/debug-trace';

// ─── Build a literal expression for a typed value string ────────────────────

/**
 * Turn the user's stringy default into the right AST literal so the generated
 * code reads naturally:
 *   number  → 0.5            (NumericLiteral)
 *   boolean → true / false   (BooleanLiteral)
 *   color   → '#ff0000'      (StringLiteral)
 *   text    → 'whatever'     (StringLiteral)
 *
 * Falls back to a string literal when a number variable's value is non-numeric
 * (keeps the file syntactically valid even with weird input from the panel).
 */
function buildArgumentLiteral(type: PageVariableType, value: string): t.Expression {
  switch (type) {
    case 'number': {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) return t.stringLiteral(value);
      // Negative numbers must be wrapped in a UnaryExpression — babel rejects
      // a NumericLiteral with `value: -0.5`.
      if (n < 0) return t.unaryExpression('-', t.numericLiteral(-n));
      return t.numericLiteral(n);
    }
    case 'boolean':
      return t.booleanLiteral(value === 'true');
    case 'color':
    case 'text':
    case 'image':
    default:
      // image stores the full CSS string (`url(...)`); colour stores a hex/
      // rgb/etc. string. Both are plain string literals at the call site.
      return t.stringLiteral(value);
  }
}

/**
 * Build a `setX(arg)` call expression for one interaction.
 */
function buildSetterCall(varName: string, type: PageVariableType, value: string): t.CallExpression {
  return t.callExpression(t.identifier(setterName(varName)), [buildArgumentLiteral(type, value)]);
}

// ─── Add or update an interaction ───────────────────────────────────────────

/**
 * Attach `onTrigger={() => setX(value)}` to a node, or merge it into the node's
 * existing handler body when one is already present:
 *
 *   No handler on this trigger:
 *     →  onClick={() => setFade(0.5)}
 *
 *   Handler exists with one prior setter call (single-expression arrow):
 *     before:  onClick={() => setBrand('#ff')}
 *     after:   onClick={() => { setBrand('#ff'); setFade(0.5); }}
 *
 *   Handler exists as a block body — append to (or replace within) the block:
 *     before:  onClick={() => { setBrand('#ff'); }}
 *     after:   onClick={() => { setBrand('#ff'); setFade(0.5); }}
 *
 * Replaces a previous setter for the SAME varName (one call per setter per
 * trigger; updating the value, not stacking duplicates).
 *
 * The variable's type comes from the @pageVariables annotation — we read it
 * inside the generator so callers don't need to plumb it through.
 */
export function addPageInteractionInCode(
  code: string,
  nodeId: string,
  trigger: InteractionTrigger,
  varName: string,
  value: string,
  // Optional explicit type. Used by the Close Overlay interaction, whose target
  // (the overlay's `set<X>Open` state var) is NOT a declared @pageVariable, so
  // the type lookup below can't find it — we must force 'boolean' to emit
  // `setX(false)` rather than `setX("false")`.
  typeOverride?: PageVariableType,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  // Look up the variable's type so the call argument has the right literal kind.
  const config = parsePageVariables(code);
  const varDef = config?.variables.find(v => v.name === varName);
  const type: PageVariableType = typeOverride ?? varDef?.type ?? 'text';

  const newCall = buildSetterCall(varName, type, value);
  const attrName = attrForTrigger(trigger);
  let mutated = false;

  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const existing = findAttribute(opening, attrName) as t.JSXAttribute | null;

    if (!existing) {
      // No handler yet — drop a one-call arrow into a fresh attribute.
      const arrow = t.arrowFunctionExpression([], newCall);
      opening.attributes.push(
        t.jsxAttribute(t.jsxIdentifier(attrName), t.jsxExpressionContainer(arrow)),
      );
      mutated = true;
      return;
    }

    if (!existing.value || !t.isJSXExpressionContainer(existing.value)) return;
    const expr = existing.value.expression;
    if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) {
      // Handler is a named ref (e.g. `onClick={handleClick}`) — don't touch it.
      // The user authored that themselves; we'd lose their logic by replacing.
      trace.error('page-interactions-gen:add-skipped-named-handler', { nodeId, trigger });
      return;
    }

    // Fast path: handler is currently a single-expression body that's our
    // very setter — replace in place, don't promote to block (keeps the
    // generated code tidy).
    if (
      t.isCallExpression(expr.body) &&
      t.isIdentifier(expr.body.callee) &&
      varNameFromSetter(expr.body.callee.name) === varName
    ) {
      expr.body = newCall;
      mutated = true;
      return;
    }

    // Promote a single-expression body to a block so we have somewhere to
    // append. Existing single call becomes the first statement.
    if (!t.isBlockStatement(expr.body)) {
      const prev = expr.body;
      expr.body = t.blockStatement(
        t.isExpression(prev) ? [t.expressionStatement(prev)] : [],
      );
    }

    const block = expr.body as t.BlockStatement;
    // Replace any prior call to OUR setter (same varName), then append if absent.
    let replaced = false;
    for (let i = 0; i < block.body.length; i++) {
      const stmt = block.body[i];
      if (!t.isExpressionStatement(stmt)) continue;
      if (!t.isCallExpression(stmt.expression)) continue;
      const callee = stmt.expression.callee;
      if (!t.isIdentifier(callee)) continue;
      if (varNameFromSetter(callee.name) !== varName) continue;
      block.body[i] = t.expressionStatement(newCall);
      replaced = true;
      break;
    }
    if (!replaced) {
      block.body.push(t.expressionStatement(newCall));
    }
    mutated = true;
  });

  if (!mutated) return code;
  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('page-interactions-gen:add', { nodeId, trigger, varName, value });
    return out.code;
  } catch (err) {
    trace.error('page-interactions-gen:add-failed', { nodeId, trigger, varName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Remove an interaction ──────────────────────────────────────────────────

/**
 * Take a `setVarName(...)` call out of the handler. If the handler ends up
 * with no statements left, remove the attribute entirely so we don't leave
 * dangling `onClick={() => {}}`.
 */
export function removePageInteractionInCode(
  code: string,
  nodeId: string,
  trigger: InteractionTrigger,
  varName: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  const attrName = attrForTrigger(trigger);
  let mutated = false;

  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const existing = findAttribute(opening, attrName) as t.JSXAttribute | null;
    if (!existing || !existing.value || !t.isJSXExpressionContainer(existing.value)) return;
    const expr = existing.value.expression;
    if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return;

    const matchesSetter = (call: t.CallExpression): boolean => {
      if (!t.isIdentifier(call.callee)) return false;
      return varNameFromSetter(call.callee.name) === varName;
    };

    if (t.isCallExpression(expr.body) && matchesSetter(expr.body)) {
      // Sole call IS the one to remove → drop the whole attribute.
      opening.attributes = opening.attributes.filter((a: t.JSXAttribute | t.JSXSpreadAttribute) => a !== existing);
      mutated = true;
      return;
    }

    if (t.isBlockStatement(expr.body)) {
      const before = expr.body.body.length;
      expr.body.body = expr.body.body.filter(stmt => {
        if (!t.isExpressionStatement(stmt)) return true;
        if (!t.isCallExpression(stmt.expression)) return true;
        return !matchesSetter(stmt.expression);
      });
      if (expr.body.body.length !== before) mutated = true;
      // Empty block → remove attribute entirely.
      if (expr.body.body.length === 0) {
        opening.attributes = opening.attributes.filter((a: t.JSXAttribute | t.JSXSpreadAttribute) => a !== existing);
      }
      // Single statement left → collapse back to expression body for cleaner code.
      else if (expr.body.body.length === 1) {
        const onlyStmt = expr.body.body[0];
        if (t.isExpressionStatement(onlyStmt)) {
          expr.body = onlyStmt.expression;
        }
      }
    }
  });

  if (!mutated) return code;
  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('page-interactions-gen:remove', { nodeId, trigger, varName });
    return out.code;
  } catch (err) {
    trace.error('page-interactions-gen:remove-failed', { nodeId, trigger, varName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}
