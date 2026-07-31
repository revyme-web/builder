// hoist-prop.ts — Hoist a nested-instance prop into the parent component's
// signature so it becomes a controllable variable at every level above.
//
// Mental model. Given a parent component file containing a nested instance:
//
//   function UxTaPa({ style, initialVariant }) {
//     return <RoHuVu poon="#4e4e2b" />;
//   }
//
// Hoisting `poon` produces:
//
//   /** @pageVariables { "variables": [{"name":"cardBg","type":"color","default":"#4e4e2b"}] } */
//   function UxTaPa({ style, initialVariant, cardBg = '#4e4e2b' }) {
//     return <RoHuVu poon={cardBg} />;
//   }
//
// Now every `<UxTaPa>` instance on the page (or in another higher-up
// component) gets a `cardBg` control in its properties panel — the
// existing component-registry + ComponentPropsTool pipeline picks the
// new prop up automatically. Recursion is implicit: the user can hoist
// `cardBg` from THAT level too, all the way up.
//
// Re-uses three existing pieces:
//   - `@pageVariables` annotation for metadata (name, type, default, description)
//     via `addPageVariableInCode`. We don't invent a new annotation kind —
//     component files use the same one as pages, and the parser already
//     merges both into `propDefaults` (parser.ts ~line 1612).
//   - The function-signature destructure injection from `variable-ops.ts`
//     (`addPropToParams`). Same destructure-handling rules apply.
//   - The standard JSX walker (`findFirstElementByDataId`).
//
// What's NEW here is the JSX rewrite on the INSTANCE side: take a child
// component tag's attribute and swap the literal value for an identifier
// reference to the freshly-added parent variable. Every instance of the
// same `componentName` in the same parent file that has the same
// literal-valued `propName` gets the same rewrite — per user spec, ONE
// shared parent variable covers all sibling instances.

import * as t from '@babel/types';
import generate from '@babel/generator';
import { parseJSX, findFirstElementByDataId } from '../parsing/ast-utils';
import { addPageVariableInCode, type PageVariableType } from './page-variables';
import { getScrollVariant, setScrollVariantInCode, type ScrollVariantSpec } from '../generation/scroll-variant-gen';
import type { SerScope } from '../generation/generator-motion';
import { setResponsiveInstancePropVarInCode } from '../generation/responsive-instance-prop-vars-gen';
import { setConditionalInstancePropVarInCode } from '../components/instance-prop-overrides';
import { trace } from '@/shared/debug-trace';

/**
 * Source value extracted from a nested-instance prop, with the AST node it
 * was found in so the caller can replace it in place.
 */
interface ExtractedLiteral {
  /** The literal string the prop currently holds. */
  literal: string;
  /** The JSX attribute node we'll rewrite. */
  attribute: t.JSXAttribute;
}

export interface HoistInstancePropOptions {
  /** Data-id of the nested instance JSX element. */
  instanceNodeId: string;
  /** Tag name of the nested component (used for the multi-instance sweep). */
  componentName: string;
  /** Prop on the child instance we're hoisting (e.g. `poon`). */
  propName: string;
  /** Variable metadata (name + type + default + optional description). */
  variable: {
    name: string;
    type: PageVariableType;
    default: string;
    description?: string;
  };
  /** Active editing scope. A page-viewport `{query}` (a replica) hoists a
   *  PER-VIEWPORT binding — for a scroll-variant `initialVariant` it writes
   *  `responsive[scope].fromVar` (this viewport's own variable), keeping the base.
   *  Null / undefined / `{variant}` → the base (Desktop) binding, which cascades. */
  scope?: SerScope | null;
}

/**
 * Pure transform: given the parent component file's source code and a
 * description of what to hoist, returns the new source. Idempotent
 * fallbacks: if the variable already exists with the same name, or if
 * the instance prop doesn't have a literal value we can capture, the
 * function returns the input unchanged and logs the reason.
 */
export function hoistInstancePropInCode(
  code: string,
  opts: HoistInstancePropOptions,
): string {
  trace.fn('hoist-prop.hoistInstancePropInCode', {
    instanceNodeId: opts.instanceNodeId,
    componentName: opts.componentName,
    propName: opts.propName,
    variableName: opts.variable.name,
  });

  // SCROLL-VARIANT COEXISTENCE. When the variant (`initialVariant`) is hoisted on an
  // instance that ALSO has a scroll variant, the variant binding is OWNED by the
  // scroll state machine (`initialVariant={…Sv}`). A blind binding swap would
  // disconnect the scroll effect. Instead, wire the variable into the machine's
  // RESTING/START state via the spec's `fromVar`: the scroll effect keeps animating to
  // its target, and the variable picks the START per route (set it = the target → the
  // effect is invisible; set it ≠ target → the effect plays). Binding + target untouched.
  // Default '' so it falls through to the per-viewport resting until set per route.
  if (opts.propName === 'initialVariant') {
    const sv = getScrollVariant(code, opts.instanceNodeId);
    if (sv) {
      // PER-VIEWPORT: hoisting on a replica (`scope` is a page-viewport `{query}`)
      // binds THIS viewport's resting to its own variable via `responsive[scope].fromVar`,
      // keeping the base `fromVar` (Desktop) intact so it still cascades. On the primary
      // (no query scope) → the base `fromVar`, which applies to every viewport.
      const scope = opts.scope && 'query' in opts.scope ? opts.scope : null;
      let newSpec: ScrollVariantSpec;
      if (scope) {
        const responsive = [...(sv.responsive ?? [])];
        const idx = responsive.findIndex((r) => 'query' in r.scope && r.scope.query === scope.query);
        if (idx >= 0) responsive[idx] = { ...responsive[idx], fromVar: opts.variable.name };
        else responsive.push({ scope, fromVar: opts.variable.name });
        newSpec = { ...sv, responsive };
      } else {
        newSpec = { ...sv, fromVar: opts.variable.name };
      }
      let result = setScrollVariantInCode(code, opts.instanceNodeId, newSpec);
      const ast2 = parseJSX(result);
      if (ast2) {
        addParentFunctionParam(ast2, opts.variable.name, '');
        try { result = generate(ast2, { retainLines: true }, result).code; }
        catch (err) { trace.error('hoist-prop:scroll-variant-generate-failed', { error: err instanceof Error ? err.message : String(err) }); }
      }
      result = addPageVariableInCode(result, { name: opts.variable.name, type: opts.variable.type, default: '' });
      trace.action('hoist-prop:scroll-variant-fromVar', { instanceNodeId: opts.instanceNodeId, variableName: opts.variable.name });
      return result;
    }
  }

  // PER-VIEWPORT VARIABLE (a plain prop hoisted on a REPLICA tile). Unlike the base hoist, this must
  // NOT touch the base / sibling instances — it binds the new variable ONLY at this viewport's band via
  // an inline `__mq` ternary (`prop={(__mqN ? newVar : prevBase)}`), keeping the base (Desktop) intact.
  // This is the instance-prop-attr twin of the per-viewport style/text variable shapes. The scroll-
  // variant case above is handled separately; everything else routes here when scope is a `{query}`.
  // `initialVariant` IS allowed here (variant SELECTION per-viewport) — a SCROLL-variant instance is
  // already handled+returned above (responsive[scope].fromVar); a NON-scroll instance has no other
  // per-viewport-VARIABLE mechanism (data-responsive holds only LITERAL variant names), so it also needs
  // the inline ternary. The parser routes a per-viewport `initialVariant` branch to responsiveVariantMap
  // (NOT responsiveProps→styles) so the variant lowering stays correct (see project-parser expandComponent).
  const vpScope = opts.scope && 'query' in opts.scope ? opts.scope : null;
  if (vpScope) {
    let result = code;
    const ast0 = parseJSX(result);
    if (ast0) {
      addParentFunctionParam(ast0, opts.variable.name, opts.variable.default);
      try { result = generate(ast0, { retainLines: true }, result).code; }
      catch (err) { trace.error('hoist-prop:per-viewport-generate-failed', { error: err instanceof Error ? err.message : String(err) }); }
    }
    result = addPageVariableInCode(result, { name: opts.variable.name, type: opts.variable.type, default: opts.variable.default });
    result = setResponsiveInstancePropVarInCode(result, opts.instanceNodeId, opts.componentName, vpScope.query!, opts.propName, opts.variable.name);
    trace.action('hoist-prop:per-viewport-var', { instanceNodeId: opts.instanceNodeId, propName: opts.propName, variableName: opts.variable.name, query: vpScope.query });
    return result;
  }

  // PER-VARIANT VARIABLE — the variant (or any prop) hoisted INSIDE a component master on a NON-DEFAULT
  // parent variant. `scope` is a `{ variant }` (getActiveAnimationScope returns this on a component file).
  // Bind the new variable ONLY on that parent variant via the conditional ternary
  // (`prop={variant === 'v6' ? newVar : base}`), keeping the base literal so every OTHER parent variant is
  // untouched — the per-VARIANT twin of the `{query}` branch above. Without this, a `{variant}` scope fell
  // through to the GLOBAL bind below, so a hoisted nested variant applied to EVERY parent variant.
  const varScope = opts.scope && 'variant' in opts.scope ? opts.scope : null;
  if (varScope) {
    let result = code;
    const ast0 = parseJSX(result);
    if (ast0) {
      addParentFunctionParam(ast0, opts.variable.name, opts.variable.default);
      try { result = generate(ast0, { retainLines: true }, result).code; }
      catch (err) { trace.error('hoist-prop:per-variant-generate-failed', { error: err instanceof Error ? err.message : String(err) }); }
    }
    result = addPageVariableInCode(result, { name: opts.variable.name, type: opts.variable.type, default: opts.variable.default });
    result = setConditionalInstancePropVarInCode(result, opts.instanceNodeId, opts.componentName, opts.propName, varScope.variant, opts.variable.name, opts.variable.default);
    trace.action('hoist-prop:per-variant-var', { instanceNodeId: opts.instanceNodeId, propName: opts.propName, variableName: opts.variable.name, variant: varScope.variant });
    return result;
  }

  const ast = parseJSX(code);
  if (!ast) {
    trace.error('hoist-prop:parse-failed', 'parseJSX returned null');
    return code;
  }

  // 1. Find the source instance, extract its literal value, and rewrite
  //    THAT specific attribute to an identifier reference. The caller-
  //    supplied `variable.default` may differ from what we read here
  //    (the modal allows editing) — we use whichever the caller passed
  //    as the variable default; the JSX rewrite just swaps to the
  //    identifier regardless of the original literal.
  const extracted = extractAndRewriteSourceInstance(ast, opts);
  if (!extracted) {
    trace.action('hoist-prop:source-instance-not-rewritable', {
      instanceNodeId: opts.instanceNodeId,
      propName: opts.propName,
    });
    return code;
  }

  // 2. Sweep every OTHER instance of the same component with the same
  //    literal-valued prop and rewrite them too. The user-confirmed
  //    semantics: one shared parent variable covers all matching
  //    sibling instances. Avoids the surprising case where 6 sibling
  //    `<RoHuVu poon="#4e4e2b" />` instances get hoisted but only the
  //    one the user clicked starts reading the new variable.
  //
  //    VARIANT EXCEPTION (2026-07-29): `initialVariant` is IDENTITY-scoped,
  //    not value-scoped. A hoisted variant variable ("Home State") controls
  //    THE clicked instance's state; six nav buttons merely sharing the same
  //    CURRENT variant is coincidence, and folding them all made the one
  //    variable flip every button at once (user repro: header ViDaPo × 6).
  //    Only THIS instance binds — other instances can opt in via the
  //    "Set Variable" menu (@propMeta.variantOf keeps offering it).
  if (opts.propName !== 'initialVariant') {
    rewriteMatchingSiblingInstances(ast, opts, extracted.literal);
  } else {
    trace.action('hoist-prop:variant-sweep-skipped', {
      instanceNodeId: opts.instanceNodeId,
      componentName: opts.componentName,
    });
  }

  // 3. Add the new prop to the parent function's destructured params with
  //    the chosen default value. Mirrors `variable-ops.ts:addPropToFunction`
  //    so the destructure shape stays consistent with how style-bound
  //    variables get added.
  const signatureUpdated = addParentFunctionParam(ast, opts.variable.name, opts.variable.default);
  if (!signatureUpdated) {
    // Function signature missing or already has the name. We still write
    // the @pageVariables annotation and JSX rewrites below — those are
    // independently useful, and the function param can be added by hand
    // when the signature is in an unusual shape we don't recognise yet.
    trace.action('hoist-prop:signature-not-updated', {
      variableName: opts.variable.name,
    });
  }

  let result: string;
  try {
    result = generate(ast, { retainLines: true }, code).code;
  } catch (err) {
    trace.error('hoist-prop:generate-failed', { error: err instanceof Error ? err.message : String(err) });
    return code;
  }

  // 4. Add the @pageVariables annotation entry. Done as a string-level
  //    transform (the annotation lives in a JSDoc comment, not in the
  //    AST), so it runs AFTER the babel regenerate. `addPageVariableInCode`
  //    is a no-op when the variable already exists, so re-hoisting under
  //    the same name doesn't duplicate the entry.
  result = addPageVariableInCode(result, {
    name: opts.variable.name,
    type: opts.variable.type,
    default: opts.variable.default,
  });

  trace.action('hoist-prop:done', {
    componentName: opts.componentName,
    propName: opts.propName,
    variableName: opts.variable.name,
  });
  return result;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Find the source instance element (by data-id), extract the literal value
 * of `propName`, and replace the AST node in place with an identifier
 * reference to the variable. Returns the extracted literal so the caller
 * can drive the sibling sweep with the SAME literal value as match key.
 *
 * Handles three value shapes the parser already recognises for instance
 * props:
 *   - `prop="literal"`                       → StringLiteral attribute value
 *   - `prop={"literal"}`                     → JSXExpressionContainer wrapping StringLiteral
 *   - `prop={cond ? 'a' : ...}` (ternary)    → take the `default` branch
 *                                              (last unconditional alternate),
 *                                              matching how `setConditionalInstanceProp`
 *                                              already treats fallbacks
 *
 * Returns null on no-match (silent no-op for the caller).
 */
function extractAndRewriteSourceInstance(
  ast: any,
  opts: HoistInstancePropOptions,
): ExtractedLiteral | null {
  let result: ExtractedLiteral | null = null;

  findFirstElementByDataId(ast, opts.instanceNodeId, (path) => {
    const opening = path.node.openingElement;
    const attr = opening.attributes.find(
      (a: any): a is t.JSXAttribute =>
        t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === opts.propName,
    );

    // Case A: attr is absent from the JSX. The instance is using the
    // master's default (the user never set this prop on this instance).
    // Hoisting is still meaningful — the user picked the default in
    // the modal, and we need to wire the prop through so the variable
    // is settable at parent level. INJECT a fresh attribute with the
    // identifier as its value. The sibling-sweep below is a no-op for
    // this case (no source literal to match against), which is the
    // right behaviour: other instances that ALSO use the master's
    // default keep using it independently.
    if (!attr) {
      const newAttr = t.jsxAttribute(
        t.jsxIdentifier(opts.propName),
        t.jsxExpressionContainer(t.identifier(opts.variable.name)),
      );
      opening.attributes.push(newAttr);
      // Empty-string literal signals "no source value" to the caller; the
      // sibling sweep treats `literal === null` as "skip", but we want
      // the sweep to genuinely no-op in this branch (master-default
      // siblings aren't ours to claim), so we still return a marker
      // with `literal === ''`. The sweep's `literal === sourceLiteral`
      // check naturally bails for any sibling that has a real literal.
      result = { literal: '', attribute: newAttr };
      return;
    }

    // Case B: attr is present. Extract its literal value and swap to an
    // identifier reference — the original case.
    //
    // When the attr value is something we DON'T have a literal extractor
    // for (e.g. `transition={{ type: 'tween', duration: 0.3 }}` — an
    // ObjectExpression, or `style={someStyleVar}` — a non-prop-ref
    // Identifier, or anything else complex), `readLiteralFromAttr`
    // returns null. We STILL rewrite the attr to the identifier — the
    // user picked the new default value in the modal, and that flows
    // through to the parent function-signature destructure + the
    // @pageVariables annotation. The only thing we lose is the
    // sibling-sweep (no literal to match against), which is the right
    // call — siblings with non-literal values aren't safe to fold
    // under a shared variable without user review anyway. Visible
    // bug this guards against: hoist on a `transition` row that's
    // bound to an inline object silently produced no variable at
    // all. Now it always at least wires the parent variable through
    // the JSX of THIS instance.
    const literal = readLiteralFromAttr(attr);
    attr.value = t.jsxExpressionContainer(t.identifier(opts.variable.name));
    // Empty-string literal means "no source to match against for
    // sibling sweep" — `rewriteMatchingSiblingInstances` compares
    // against this string so empty == no siblings match. That's the
    // safe default for non-extractable values.
    result = { literal: literal ?? '', attribute: attr };
  });

  return result;
}

/**
 * Walk every JSX element whose tag matches `componentName`, find the same
 * `propName`, and rewrite its literal value to the same identifier
 * reference when the literal MATCHES the source instance's literal. Other
 * sibling instances with a different literal are left alone — only the
 * ones that "would have wanted the same value" get folded into the
 * shared variable.
 */
function rewriteMatchingSiblingInstances(
  ast: any,
  opts: HoistInstancePropOptions,
  sourceLiteral: string,
): void {
  // No babel traverse dependency — keep this small and walk JSXElement
  // nodes ourselves via the existing findFirstElementByDataId mechanism
  // would only hit ONE element, so instead use a tiny recursive walker.
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (t.isJSXElement(node)) {
      const opening = node.openingElement;
      const tagName = t.isJSXIdentifier(opening.name) ? opening.name.name : '';
      if (tagName === opts.componentName) {
        const attr = opening.attributes.find(
          (a: any): a is t.JSXAttribute =>
            t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === opts.propName,
        );
        if (attr) {
          const literal = readLiteralFromAttr(attr);
          // Skip the source we already rewrote (its value is now an
          // Identifier, not a literal — readLiteralFromAttr returns null).
          if (literal !== null && literal === sourceLiteral) {
            attr.value = t.jsxExpressionContainer(t.identifier(opts.variable.name));
          }
        }
      }
    }
    // Recurse into children + JSX expressions
    for (const key of Object.keys(node)) {
      const value = (node as any)[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && value.type) visit(value);
    }
  };
  visit(ast);
}

/**
 * Extract a string-literal value from a JSX attribute. Handles the three
 * shapes the parser's instance-prop walker accepts. Returns null when
 * the value is anything else (Identifier — already a variable; complex
 * expression — out of scope for hoisting).
 */
function readLiteralFromAttr(attr: t.JSXAttribute): string | null {
  const val = attr.value;
  if (!val) return null;
  if (t.isStringLiteral(val)) return val.value;
  if (t.isJSXExpressionContainer(val)) {
    const expr = val.expression;
    if (t.isStringLiteral(expr)) return expr.value;
    if (t.isNumericLiteral(expr)) return String(expr.value);
    if (t.isBooleanLiteral(expr)) return String(expr.value);
    // Conditional ternary — pick the default (final) branch. Walks
    // through chained `a === 'x' ? 'A' : b === 'y' ? 'B' : 'C'` and
    // returns 'C'. Anything other than literals along the way bails.
    if (t.isConditionalExpression(expr)) return walkTernaryDefault(expr);
  }
  return null;
}

function walkTernaryDefault(expr: t.Expression): string | null {
  let cursor: t.Expression = expr;
  for (let i = 0; i < 16; i++) {
    if (t.isConditionalExpression(cursor)) {
      cursor = cursor.alternate;
      continue;
    }
    if (t.isStringLiteral(cursor)) return cursor.value;
    if (t.isNumericLiteral(cursor)) return String(cursor.value);
    if (t.isBooleanLiteral(cursor)) return String(cursor.value);
    return null;
  }
  return null;
}

/**
 * Add a destructured prop with default to the parent component function's
 * params. Returns false when the function wasn't found or the prop name
 * already exists in the destructure.
 */
function addParentFunctionParam(ast: any, propName: string, defaultValue: string): boolean {
  let added = false;

  const tryAdd = (params: t.Node[]): boolean => {
    if (params.length === 0) {
      params.push(t.objectPattern([buildProp(propName, defaultValue)]));
      return true;
    }
    const firstParam = params[0];
    // Strip an outer AssignmentPattern if present (`{props} = {}` style).
    const target = t.isAssignmentPattern(firstParam) && t.isObjectPattern(firstParam.left)
      ? firstParam.left
      : firstParam;
    if (!t.isObjectPattern(target)) return false;
    // Skip if already destructured under this name — caller is re-hoisting
    // or the user picked a name that collides; the modal validation layer
    // should catch this before we get here, but defend regardless.
    const alreadyHas = target.properties.some(
      (p) => t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === propName,
    );
    if (alreadyHas) return false;
    // Insert BEFORE any `...rest` element — masters now carry `...rest` to
    // forward DOM props (onClick / data-overlay-trigger) to the root, and a
    // rest element MUST be last. A plain push appends AFTER it, emitting the
    // invalid `{ …, ...rest, newProp }` — a SyntaxError that crashes the page
    // (the reported hoist-variable regression). Mirrors variable-ops.ts's
    // insertParamPropBeforeRest.
    const restIdx = target.properties.findIndex((p) => t.isRestElement(p));
    if (restIdx >= 0) target.properties.splice(restIdx, 0, buildProp(propName, defaultValue));
    else target.properties.push(buildProp(propName, defaultValue));
    return true;
  };

  // No babel `traverse` import in this file — walk the program body to
  // find FunctionDeclaration / ArrowFunctionExpression at top-level (the
  // master function is always at module scope). Keeps the dependency
  // surface minimal and dodges the bundling overhead of pulling in
  // @babel/traverse here.
  for (const stmt of ast.program.body) {
    if (t.isFunctionDeclaration(stmt)) {
      if (tryAdd(stmt.params)) { added = true; break; }
    }
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if ((t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init))
            && tryAdd(decl.init.params)) {
          added = true;
          break;
        }
      }
      if (added) break;
    }
    if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration;
      if (t.isFunctionDeclaration(decl) && tryAdd(decl.params)) { added = true; break; }
    }
  }

  return added;
}

function buildProp(propName: string, defaultValue: string): t.ObjectProperty {
  return t.objectProperty(
    t.identifier(propName),
    t.assignmentPattern(t.identifier(propName), t.stringLiteral(defaultValue)),
    false,
    true, // shorthand
  );
}
