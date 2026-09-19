// oracle/extensions/editability/rules.ts — Phase 2 editability extension.
//
// Two tier-2 oracle rules that gate hand-written code the editor can't round-trip
// back into the panel the user edits it from:
//
//   MOTION_PROPS_ON_INSTANCE
//     Motion props (whileHover, animate, initial, ...) on a component INSTANCE
//     tag — the generator writes the instance wrapper, but motion props apply
//     inside the MASTER. Hand-writing them on the instance means the live site
//     animates nothing where the user thought it would, and the Animation
//     panel reads nothing from the master. Direct the model to either apply
//     motion on the master, or wrap the instance in a motion element.
//
//   PAGE_VAR_UNDECLARED
//     onClick={... setX(literal)} where X is not declared in the page's
//     @pageVariables block. The Interactions panel keys its row set off the
//     declared variables, so a setter on an undeclared name renders the panel
//     row invisible — the user can never edit the interaction.
//
// Both rules MUST stay isolated: they run from a try/catch in check-file.ts so
// a thrown extension never blocks the core oracle.

import * as t from '@babel/types';
import _traverse from '@babel/traverse';
import { MOTION_PROP_NAMES } from '@/code/parsing/parser';
import { getPageVariables } from '@/code/features/page-variables';
import type { OracleViolation } from '../../checks/shared';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

const INSTANCE_EXEMPT_TAGS = new Set([
  // Next.js routing wrapper — handled separately (motion props don't apply).
  'Link',
  // motion.create(Link) — same Link shape, just animated.
  'MotionLink',
  // framer-motion provider/wrapper components. They are PascalCase imports of
  // framer-motion itself (not user component instances) and accept motion
  // props as part of their API. Flagging them here would forbid every
  // <MotionConfig transition={...}> / <LayoutGroup> / <AnimatePresence>
  // call site the rest of the codebase already accepts as legitimate.
  'MotionConfig',
  'LayoutGroup',
  'AnimatePresence',
  'LayoutGroup',
]);

const SETTER_TRIGGER_ATTRS = new Set(['onClick', 'onMouseEnter', 'onMouseLeave']);

/**
 * Run both editability rules and append any violations to violations.
 * opts.kind gates PAGE_VAR_UNDECLARED (pages only — components and templates
 * are exempt because their variable system is the component variant config,
 * not page variables).
 */
export function runEditabilityRules(
  code: string,
  ast: t.File,
  violations: OracleViolation[],
  opts: { kind?: string; path?: string } = {},
): void {
  checkMotionPropsOnInstance(ast, violations);
  if (opts.kind === 'page') {
    checkPageVarUndeclared(code, ast, violations);
  }
}

/**
 * MOTION_PROPS_ON_INSTANCE — a JSX element whose tag is a PascalCase
 * JSXIdentifier (a component instance), NOT motion.* (lowercase member) and
 * NOT Link / MotionLink, carrying any motion prop name. The instance
 * wrapper carries placement only — motion props on it are silently dropped by
 * the generator, so the live site animates nothing where the user expected.
 */
function checkMotionPropsOnInstance(ast: t.File, v: OracleViolation[]): void {
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const nameNode = opening.name;
      // Only plain JSXIdentifier — a member chain like motion.div is a JSXMemberExpression,
      // so member chains naturally drop out here.
      if (!t.isJSXIdentifier(nameNode)) return;
      const tag = nameNode.name;
      // Must be PascalCase (a component instance), not a lowercase DOM tag.
      if (!tag || !/^[A-Z]/.test(tag)) return;
      if (INSTANCE_EXEMPT_TAGS.has(tag)) return;
      const attrs = opening.attributes.filter((a): a is t.JSXAttribute => t.isJSXAttribute(a));
      const offender = attrs.find((a) =>
        t.isJSXIdentifier(a.name) && MOTION_PROP_NAMES.includes(a.name.name));
      if (!offender) return;
      const line = opening.loc?.start.line;
      const dataIdAttr = attrs.find((a) => t.isJSXIdentifier(a.name) && a.name.name === 'data-id');
      const dataId = dataIdAttr && t.isStringLiteral(dataIdAttr.value) ? dataIdAttr.value.value : undefined;
      const idSuffix = dataId ? ' (data-id "' + dataId + '")' : '';
      v.push({
        code: 'MOTION_PROPS_ON_INSTANCE',
        tier: 2,
        line,
        elementId: dataId,
        message: 'Motion prop "' + offender.name.name + '" on <' + tag + '>' + idSuffix + ' at line ' + line + ' — motion props on a component INSTANCE are silently skipped by the generator (the instance wrapper carries placement only; motion lives inside the master). Apply the prop on the MASTER component (edit components/<' + tag + '>.tsx), or wrap this instance in a motion element (<motion.div data-id="..."><' + tag + ' ... /></motion.div>) so the prop belongs to a node the runtime drives.',
      });
    },
  });
}

/**
 * PAGE_VAR_UNDECLARED — pages only. For every JSX event handler
 * (onClick/onMouseEnter/onMouseLeave) whose body is an arrow calling
 * setX(literal), X must be a declared page variable (in /** @pageVariables
 * { ... } *\/). If it is not, the Interactions panel cannot show the row.
 *
 * We re-derive the declared set from the page source each call (cheap: a
 * single JSDoc block parse) so the rule stays valid no matter what edits
 * landed in the file between oracle passes.
 */
function checkPageVarUndeclared(code: string, ast: t.File, v: OracleViolation[]): void {
  const declared = new Set(getPageVariables(code).map((pv) => pv.name));
  if (declared.size === 0) {
    // No variables declared at all — every setter call is undeclared by
    // construction. Skip emitting N identical messages; the no-@pageVariables
    // gate is owned by other rules (and the model's own training to always
    // emit @pageVariables for stateful pages).
    return;
  }

  traverse(ast, {
    JSXAttribute(path) {
      if (!t.isJSXIdentifier(path.node.name)) return;
      if (!SETTER_TRIGGER_ATTRS.has(path.node.name.name)) return;
      const val = path.node.value;
      if (!val || !t.isJSXExpressionContainer(val)) return;
      const setterNames = collectSetterCallees(val.expression);
      if (setterNames.length === 0) return;
      const undeclared = setterNames.filter((n) => !declared.has(n));
      if (undeclared.length === 0) return;

      const element = path.parent;
      if (!element || !t.isJSXOpeningElement(element)) return;
      const tag = t.isJSXIdentifier(element.name) ? element.name.name : 'element';
      const attrs = element.attributes.filter((a): a is t.JSXAttribute => t.isJSXAttribute(a));
      const dataIdAttr = attrs.find((a) => t.isJSXIdentifier(a.name) && a.name.name === 'data-id');
      const dataId = dataIdAttr && t.isStringLiteral(dataIdAttr.value) ? dataIdAttr.value.value : undefined;
      const line = element.loc?.start.line ?? path.node.loc?.start.line;
      const setterLabels = undeclared.map((n) => 'set' + n.charAt(0).toUpperCase() + n.slice(1));
      const declLabels = undeclared.map((n) => '"' + n + '"');
      const idSuffix = dataId ? ' (data-id "' + dataId + '")' : '';
      v.push({
        code: 'PAGE_VAR_UNDECLARED',
        tier: 2,
        line,
        elementId: dataId,
        message: '<' + tag + '>' + idSuffix + ' at line ' + line + ' calls ' + setterLabels.join(', ') + ' on a variable that is NOT declared in the page /** @pageVariables { ... } */ block — the Interactions panel keys off declared variables, so this interaction is invisible to the editor. Add ' + declLabels.join(', ') + ' to the @pageVariables list (with a fitting type: number / text / boolean / color), then resubmit.',
      });
    },
  });
}

/**
 * Walk the handler expression and collect every setX(literal) callee name.
 * Restricted to setX(...) calls with a SINGLE literal argument (string /
 * number / boolean / unary-minus number) — anything else (refs, expressions,
 * function calls) is user-authored code the rule should not paraphrase.
 *
 * Mirrors the narrow shape src/code/features/page-interactions.ts's
 * extractSetterCall accepts (kept inline so the extension stays reversible
 * without re-wiring page-interactions exports).
 */
function collectSetterCallees(expr: t.Expression | t.JSXEmptyExpression): string[] {
  const out: string[] = [];
  if (!t.isArrowFunctionExpression(expr) && !t.isFunctionExpression(expr)) return out;
  const body = expr.body;
  const calls: t.CallExpression[] = [];
  if (t.isCallExpression(body)) calls.push(body);
  if (t.isBlockStatement(body)) {
    for (const stmt of body.body) {
      if (!t.isExpressionStatement(stmt)) continue;
      if (!t.isCallExpression(stmt.expression)) continue;
      calls.push(stmt.expression);
    }
  }
  for (const call of calls) extractInto(call, out);
  return out;
}

function extractInto(call: t.CallExpression, out: string[]): void {
  if (!t.isIdentifier(call.callee)) return;
  const name = call.callee.name;
  if (!name.startsWith('set') || name.length <= 3) return;
  if (call.arguments.length !== 1) return;
  const arg = call.arguments[0];
  const isLiteral =
    t.isStringLiteral(arg) ||
    t.isNumericLiteral(arg) ||
    t.isBooleanLiteral(arg) ||
    (t.isUnaryExpression(arg) && arg.operator === '-' && t.isNumericLiteral(arg.argument));
  if (!isLiteral) return;
  const rest = name.slice(3);
  const lower = rest.charAt(0).toLowerCase() + rest.slice(1);
  out.push(lower);
}