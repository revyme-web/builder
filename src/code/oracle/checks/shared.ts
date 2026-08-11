// oracle/checks/shared.ts — helpers + types shared across the oracle's check
// groups. All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { TEXT_TAGS } from '@/shared/constants';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

export type FileKind = 'page' | 'component' | 'code-component' | 'template';

export interface OracleViolation {
  /** Stable catalog code, e.g. 'CLASSNAME_STYLING'. */
  code: string;
  /** Teaching message: what broke → why it matters here → what to write instead. */
  message: string;
  elementId?: string;
  line?: number;
  tier: 1 | 2 | 3;
}

/** Tags the parser treats as transparent wrappers — no data-id needed, never a node.
 *  `PageTransitions` is the generated Page-Effects controller: it wraps {children} and renders them
 *  through unchanged (a SPA View-Transitions pass-through), so it's never a canvas box. */
const TRANSPARENT_TAGS = new Set(['AnimatePresence', 'LayoutGroup', 'MotionConfig', 'Fragment', 'React.Fragment', 'PageTransitions', 'RevymeSplitText']);

/** Inline rich-text runs inside a text element — not structural nodes. */
const INLINE_RUN_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'br', 'sup', 'sub']);

/** The first argument of the setVariant(...) call inside a trigger handler. */
function findSetVariantArg(fn: t.ArrowFunctionExpression | t.FunctionExpression): t.Expression | null {
  let arg: t.Expression | null = null;
  const visit = (node: t.Node): void => {
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'setVariant' }) && t.isExpression(node.arguments[0])) {
      arg = node.arguments[0] as t.Expression;
      return;
    }
    if (t.isExpressionStatement(node)) visit(node.expression);
    if (t.isBlockStatement(node)) node.body.forEach(visit);
  };
  if (t.isExpression(fn.body)) visit(t.expressionStatement(fn.body));
  else visit(fn.body);
  return arg;
}

/** Does the ternary chain end with the `variant` identifier (the builder's
 *  stay-put fallthrough)? A bare non-conditional arg is never compliant. */
function endsWithVariantFallthrough(expr: t.Expression): boolean {
  if (!t.isConditionalExpression(expr)) return false;
  let cur: t.Expression = expr;
  while (t.isConditionalExpression(cur)) cur = cur.alternate as t.Expression;
  return t.isIdentifier(cur, { name: 'variant' });
}

/** Is this element the component ROOT (its style object spreads ...style)? */
function isRootCandidate(attrs: t.JSXAttribute[]): boolean {
  const styleAttr = attrs.find((a) => a.name.name === 'style');
  if (!styleAttr || !t.isJSXExpressionContainer(styleAttr.value) || !t.isObjectExpression(styleAttr.value.expression)) return false;
  return styleAttr.value.expression.properties.some((p) => t.isSpreadElement(p) && t.isIdentifier(p.argument, { name: 'style' }));
}

/** useSpring(useTransform(...), cfg) → the inner useTransform call; plain call → itself. */
function unwrapSpring(call: t.CallExpression): t.CallExpression | null {
  if (t.isIdentifier(call.callee, { name: 'useSpring' }) && t.isCallExpression(call.arguments[0])) {
    return call.arguments[0] as t.CallExpression;
  }
  return call;
}

/** Does this expression tree reference any identifier from `names`? (shallow walk) */
function containsIdentifierFrom(node: t.Node, names: Set<string>): boolean {
  if (t.isIdentifier(node)) return names.has(node.name);
  if (t.isBinaryExpression(node)) {
    return containsIdentifierFrom(node.left, names) || containsIdentifierFrom(node.right, names);
  }
  if (t.isConditionalExpression(node)) {
    return containsIdentifierFrom(node.test, names) || containsIdentifierFrom(node.consequent, names) || containsIdentifierFrom(node.alternate, names);
  }
  if (t.isTemplateLiteral(node)) return node.expressions.some((e) => containsIdentifierFrom(e, names));
  if (t.isCallExpression(node)) return node.arguments.some((a) => containsIdentifierFrom(a, names));
  if (t.isUnaryExpression(node)) return containsIdentifierFrom(node.argument, names);
  return false;
}


function jsxTagName(name: t.JSXOpeningElement['name']): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    const parts: string[] = [];
    let cur: t.JSXMemberExpression['object'] | t.JSXIdentifier = name;
    while (t.isJSXMemberExpression(cur)) { parts.unshift(cur.property.name); cur = cur.object; }
    if (t.isJSXIdentifier(cur)) parts.unshift(cur.name);
    return parts.join('.');
  }
  return '';
}

function jsxAttrs(opening: t.JSXOpeningElement): t.JSXAttribute[] {
  return opening.attributes.filter((a): a is t.JSXAttribute => t.isJSXAttribute(a) && typeof a.name.name === 'string');
}

function stringAttr(attrs: t.JSXAttribute[], name: string): string | undefined {
  const a = attrs.find((x) => x.name.name === name);
  if (a && t.isStringLiteral(a.value)) return a.value.value;
  return undefined;
}

/** Presence check for a (possibly value-less) attribute, e.g. `data-glide-item`. */
function hasAttr(attrs: t.JSXAttribute[], name: string): boolean {
  return attrs.some((x) => x.name.name === name);
}

/** Does this element need its own data-id? Transparent wrappers and inline
 *  rich-text runs inside a text element do not. */
function needsDataId(tag: string, path: NodePath<t.JSXElement>): boolean {
  const base = tag.startsWith('motion.') ? tag.slice('motion.'.length) : tag;
  if (TRANSPARENT_TAGS.has(tag) || TRANSPARENT_TAGS.has(base)) return false;
  // SVG shape children inherit identity from their <svg data-id> wrapper.
  // `foreignObject` is the FIT-text SVG wrapper (svg[data-id="X-svg"] >
  // foreignObject > p[data-id="X"]) — a structural container, never a node;
  // the svg wrapper and inner text carry the ids.
  if (['path', 'polygon', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'defs', 'g', 'text', 'pattern', 'stop', 'linearGradient', 'radialGradient', 'foreignObject'].includes(base)) return false;
  // inline runs inside a text element are rich-text, not nodes
  if (INLINE_RUN_TAGS.has(base)) {
    const parent = path.parentPath?.node;
    if (parent && t.isJSXElement(parent)) {
      const parentTag = jsxTagName(parent.openingElement.name);
      const parentBase = parentTag.startsWith('motion.') ? parentTag.slice('motion.'.length) : parentTag;
      if (TEXT_TAGS.has(parentBase)) return false;
    }
  }
  return true;
}

// ─── text expression rules ────────────────────────────────────────────────────

/** Accepted text-expression forms (everything else is uneditable). */
function isAllowedTextExpression(expr: t.Expression): boolean {
  // Structural conditional rendering ({cond && <El/>}, {cond ? <A/> : <B/>}) is
  // not text — it's the AnimatePresence visibility dialect. Always allowed here.
  if (rendersJSX(expr)) return true;
  if (t.isStringLiteral(expr) || t.isNumericLiteral(expr)) return true;
  if (t.isIdentifier(expr)) return true;                                // {propName}
  if (t.isMemberExpression(expr)) return true;                          // {item.field}
  if (t.isConditionalExpression(expr)) {                                // {variant === 'x' ? 'a' : 'b'}
    return isAllowedTextExpression(expr.consequent as t.Expression) && isAllowedTextExpression(expr.alternate as t.Expression);
  }
  if (t.isCallExpression(expr)) {
    if (t.isIdentifier(expr.callee) && expr.callee.name === 'useResponsiveText') return true;
    // {t('<data-id>')} — the localization dialect's translated-text form
    // (TRANSLATION_KEY_MISMATCH validates the key; here it's just allowed
    // as text). Strict shape: bare `t` with exactly one string literal.
    if (t.isIdentifier(expr.callee) && expr.callee.name === 't'
      && expr.arguments.length === 1 && t.isStringLiteral(expr.arguments[0])) return true;
    // {items.map((item) => <El/>)} — repeater dialect, structural not text
    if (t.isMemberExpression(expr.callee) && t.isIdentifier(expr.callee.property) && expr.callee.property.name === 'map') return true;
  }
  if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) return true; // plain template = literal
  return false;
}

/** Shallow scan: does this expression (through &&/||/?:/parens) produce JSX? */
function rendersJSX(expr: t.Expression): boolean {
  if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return true;
  if (t.isLogicalExpression(expr)) return rendersJSX(expr.right as t.Expression) || rendersJSX(expr.left as t.Expression);
  if (t.isConditionalExpression(expr)) {
    return rendersJSX(expr.consequent as t.Expression) || rendersJSX(expr.alternate as t.Expression);
  }
  if (t.isParenthesizedExpression?.(expr)) return rendersJSX((expr as t.ParenthesizedExpression).expression as t.Expression);
  return false;
}

export { traverse, TRANSPARENT_TAGS, findSetVariantArg, endsWithVariantFallthrough, isRootCandidate, unwrapSpring, containsIdentifierFrom, jsxTagName, jsxAttrs, stringAttr, hasAttr, needsDataId, isAllowedTextExpression };

/** STRICT code-component detection — the same JSDoc form the controls parser,
 *  library, canvas and publish flow key on (`/** @controls { … } *​/`, see
 *  CONTROLS_REGEX in code/components/controls-parser.ts). The old loose
 *  substring test (`@controls {` ANYWHERE) let a comment or a string literal
 *  flip a page/design component into the lax code-component rule set —
 *  silently dropping the style-object rules, the free-JS fence and the
 *  surface rules — while the parser, the library and publish still treated
 *  the file as a design component (kind split-brain, 2026-08-11). */
export function isCodeComponentSource(code: string): boolean {
  return /\/\*\*?\s*@controls\s*\{/.test(code);
}
