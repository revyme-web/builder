// variable-ops.ts — Create, remove, and hoist variables (React props).
//
// "Create Variable" extracts an inline style value into a component prop:
//   Before: style={{ backgroundColor: '#1a1a2e' }}
//   After:  style={{ backgroundColor: bgColor }}
//   + adds prop to function signature: ({ bgColor = '#1a1a2e' }: ...)
//
// Pure functions — take code string in, return code string out.

import { parseJSX, findFirstElementByDataId, findAttribute, traverse } from '../parsing/ast-utils';
import { updateBorderOverlayStyle } from '../generation/generator-styles';
import { isStructuralProp } from '../components/component-registry';
import { removePropMetaInCode } from '../components/prop-meta';
import * as t from '@babel/types';
import _generate from '@babel/generator';
import { trace } from '@/shared/debug-trace';

const generate = (typeof _generate === 'function' ? _generate : (_generate as any).default) as typeof _generate;

// ─── Create Variable ────────────────────────────────────────────────────────

/**
 * Extract an inline style value into a component prop.
 *
 * 1. Find the node's style property in the JSX
 * 2. Read its current value
 * 3. Replace the StringLiteral with an Identifier (prop name)
 * 4. Add the prop to the component function's destructured params with the default value
 *
 * Returns the modified code string, or the original if extraction fails.
 */
export function createVariableInCode(
  code: string,
  nodeId: string,
  styleProperty: string,
  propName: string,
  defaultValue?: string,
  /**
   * Optional list of longhand style props to REMOVE from the JSX style object
   * when binding a compound shorthand. Used by atoms like Border that produce
   * 12+ longhands (`borderTopWidth`, `borderTopColor`, ...). Calling
   * createVariableInCode(..., 'border', 'cardBorder', '1px solid red',
   * BORDER_LONGHANDS) drops the longhands and writes a single `border:
   * cardBorder` so the function signature only carries one prop.
   *
   * No-op for simple-value variables (Shadow / Filter / Padding / etc.) —
   * those properties live as a single key in the style object already.
   */
  clearLonghands?: string[],
  /** Literal kind for the prop's signature default. 'number' makes opacity/gap raw numbers (`gap = 16`),
   *  so a number variable is interchangeable across single-number controls. Defaults to 'string'. */
  literalKind: PropLiteralKind = 'string',
): string {
  // Hard guard: never bind a style onto a reserved/structural param. `initialVariant`
  // is the framer-motion variant SWITCHER — wiring e.g. boxShadow onto it (`boxShadow:
  // initialVariant`) overwrites the variant name with a CSS string and silently breaks
  // variant animation, and the value disappears from the component tool (which renders
  // `initialVariant` as the Variant dropdown). The UI entry points already filter these
  // out; this is the last line of defence against any caller.
  if (isStructuralProp(propName)) {
    trace.error('variable-ops:create-blocked-structural-prop', { nodeId, styleProperty, propName });
    return code;
  }

  const ast = parseJSX(code);
  if (!ast) return code;

  // BORDER VARIABLE → bind it into the `::after` OVERLAY (not inline). A frame's border is an
  // `::after` overlay (clean inset border that respects border-radius + overflow:hidden); an inline
  // `border: prop` renders a real box-border (overflows, sits under content — the user's bug). Bind
  // via a CSS custom property: the `::after` uses `border: var(--<prop>)` and the element sets
  // `'--<prop>': prop`. Use this path when there's an existing `::after` OR no real inline border
  // (author a fresh variable-driven overlay — CREATING the `::after`); keep the inline-shorthand
  // path only when the node genuinely has an inline border already.
  if (styleProperty === 'border') {
    const nidEsc = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const afterM = new RegExp(`\\[data-(?:node-)?id="${nidEsc}"\\]::after\\s*\\{([^}]*)\\}`, 's').exec(code);
    if (afterM || !nodeHasInlineBorderValue(ast, nodeId)) {
      return createBorderOverlayVariable(code, nodeId, propName, defaultValue, afterM);
    }
  }

  let currentValue: string | null = null;
  const longhandSet = clearLonghands && clearLonghands.length > 0 ? new Set(clearLonghands) : null;

  // Step 1: Find the node and replace the style value with an Identifier
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer') return;

    const expr = styleAttr.value.expression;
    if (!t.isObjectExpression(expr)) return;

    // Try to find existing property
    let propertyExists = false;
    for (const prop of expr.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key !== styleProperty) continue;

      // What we can capture/replace:
      //   - StringLiteral / NumericLiteral / static TemplateLiteral
      //     → standard create-variable: capture default, replace JSX value
      //   - Identifier matching `propName` (an existing variable being
      //     re-created with a new default — common when the user picks a
      //     preset on an already-bound property)
      //     → keep the JSX as-is, update only the function signature default
      // Anything else (ObjectExpression, interpolated TemplateLiteral, an
      // Identifier referencing a DIFFERENT variable) — bail.
      const isLiteral = t.isStringLiteral(prop.value) || t.isNumericLiteral(prop.value);
      const isStaticTemplate = t.isTemplateLiteral(prop.value)
        && prop.value.expressions.length === 0
        && prop.value.quasis.length === 1;
      const isSameIdentifier = t.isIdentifier(prop.value) && prop.value.name === propName;
      if (!isLiteral && !isStaticTemplate && !isSameIdentifier) {
        return;
      }

      propertyExists = true;
      // The default value the function signature gets:
      //   1. Caller-supplied `defaultValue` wins (modal-edited value flows here).
      //   2. Otherwise read the existing JSX literal so behavior matches the
      //      pre-modal flow when the modal didn't change anything.
      if (defaultValue != null) {
        currentValue = defaultValue;
      } else if (t.isStringLiteral(prop.value)) {
        currentValue = prop.value.value;
      } else if (t.isNumericLiteral(prop.value)) {
        currentValue = String(prop.value.value);
      } else if (isStaticTemplate) {
        currentValue = (prop.value as any).quasis[0].value.cooked ?? (prop.value as any).quasis[0].value.raw;
      }
      // For `isSameIdentifier && defaultValue == null`: nothing changed — the
      // variable already binds this property and no new default was provided.
      // Skip the function-signature update (currentValue stays null).

      // Replace with Identifier — no-op when the JSX is already that Identifier.
      if (!isSameIdentifier) {
        prop.value = t.identifier(propName);
      }
      break;
    }

    // Property not in style object — add it as Identifier with defaultValue
    if (!propertyExists && defaultValue != null) {
      currentValue = defaultValue;
      expr.properties.push(
        t.objectProperty(t.identifier(styleProperty), t.identifier(propName))
      );
    }

    // Clear longhands when binding a compound shorthand. We do this after the
    // main shorthand replacement so the longhand removal can't accidentally
    // strip the new identifier if `styleProperty` somehow appears in the list.
    if (currentValue !== null && longhandSet) {
      expr.properties = expr.properties.filter(p => {
        if (!t.isObjectProperty(p)) return true;
        const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
        return !(k && longhandSet.has(k));
      });
    }
  });

  if (currentValue === null) return code;

  // Step 2: Add prop to function signature
  const result = addPropToFunction(ast, propName, currentValue, literalKind);
  if (!result) return code;

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:create', { nodeId, styleProperty, propName, defaultValue: currentValue, clearedLonghands: longhandSet?.size ?? 0 });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:createVariable-generate-failed', { nodeId, styleProperty, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Does the node carry a REAL inline border (a `border` shorthand or any `border*Width/Style/Color`
 *  longhand with a non-empty literal value)? Empty (`border: ''`) / absent → false, so a fresh
 *  variable-driven border routes to the overlay path. */
function nodeHasInlineBorderValue(ast: Parameters<typeof findFirstElementByDataId>[0], nodeId: string): boolean {
  let has = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const styleAttr = findAttribute(path.node.openingElement, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
    for (const p of styleAttr.value.expression.properties) {
      if (!t.isObjectProperty(p)) continue;
      const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '';
      if (k !== 'border' && !BORDER_LONGHANDS.includes(k)) continue;
      if (t.isStringLiteral(p.value) && p.value.value.trim() !== '') has = true;
    }
  });
  return has;
}

/** Bind a border VARIABLE into a node's `::after` overlay (not inline). Rewrites (or CREATES) the
 *  overlay so it uses a single `border: var(--<prop>)`, sets `'--<prop>': prop` on the element's
 *  inline style, removes any inline `border`, and adds the prop (default = the current border value
 *  if any, else empty so an instance fills it). */
function createBorderOverlayVariable(
  code: string,
  nodeId: string,
  propName: string,
  defaultValue: string | undefined,
  afterMatch: RegExpExecArray | null,
): string {
  const cssVar = `--${propName}`;
  let borderValue = defaultValue ?? '';
  let body: string;
  if (afterMatch) {
    // EXISTING overlay — preserve scaffolding (content/inset/border-radius/…), reconstruct the
    // current border shorthand for the default, and replace the border-* longhands with one var.
    const afterCSS = afterMatch[1];
    const grab = (re: RegExp) => afterCSS.match(re)?.[1]?.trim();
    const existing = grab(/(?:^|[^-])\bborder:\s*([^;]+)/)
      ?? [grab(/border-width:\s*([^;]+)/), grab(/border-style:\s*([^;]+)/), grab(/border-color:\s*([^;]+)/)].filter(Boolean).join(' ');
    if (defaultValue == null && existing) borderValue = existing;
    body = afterCSS
      .replace(/[^\n]*border-(?:width|style|color|image[\w-]*)\s*:[^;]*;?/g, '')
      .replace(/[^\n]*(?:^|[^-])\bborder\s*:[^;]*;?/gm, (m) => m.replace(/\bborder\s*:[^;]*;?/, ''))
      .replace(/\n[ \t]*\n/g, '\n')
      .trimEnd();
    body += `\n  border: var(${cssVar});`;
  } else {
    // NO overlay yet — author the standard overlay scaffolding bound to the var.
    body = `  content: '';\n  position: absolute;\n  inset: 0;\n  border-radius: inherit;\n  pointer-events: none;\n  z-index: 1;\n  border: var(${cssVar});`;
  }
  // Write the ::after rule (updateBorderOverlayStyle creates the <style> block / replaces the rule).
  const result = updateBorderOverlayStyle(code, nodeId, body);

  // Inline: set the custom property to the prop (drop any stray inline border), then add the prop.
  const ast = parseJSX(result);
  if (!ast) return code;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
    const expr = styleAttr.value.expression;
    const cssVar = `--${propName}`;
    expr.properties = expr.properties.filter((p) => {
      if (!t.isObjectProperty(p)) return true;
      const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
      return k !== 'border' && k !== cssVar;   // drop inline border + any prior binding for this var
    });
    expr.properties.push(t.objectProperty(t.stringLiteral(cssVar), t.identifier(propName)));
  });
  if (!addPropToFunction(ast, propName, borderValue)) return code;
  try {
    const out = generate(ast, { retainLines: true }, result);
    trace.action('variable-ops:create-border-overlay', { nodeId, propName, defaultValue: borderValue });
    return out.code;
  } catch (err) {
    trace.error('variable-ops:createBorderOverlayVariable-generate-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Bind an overlay-border variable that applies ONLY on a given variant (standard per-variant
 * variable). The variant objects are MODULE-scope and can't reference props, so the binding lives in
 * an inline ternary on the custom property:
 *   `'--X': initialVariant === '<variant>' ? X : 'none'`  +  `::after { border: var(--X) }`  +  prop X
 * On `<variant>` the border resolves to the variable; on every other variant it's `none` (no border).
 * Idempotent on the prop (addPropToFunction keeps an existing default).
 */
export function setBorderOverlayVariableForVariant(
  code: string,
  nodeId: string,
  propName: string,
  variantName: string,
  defaultValue: string,
): string {
  const cssVar = `--${propName}`;
  // Ensure the `::after` consumes the var (create scaffolding if absent, else just retarget border).
  const nidEsc = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const afterM = new RegExp(`\\[data-(?:node-)?id="${nidEsc}"\\]::after\\s*\\{([^}]*)\\}`, 's').exec(code);
  let body: string;
  if (afterM) {
    body = afterM[1]
      .replace(/[^\n]*border-(?:width|style|color|image[\w-]*)\s*:[^;]*;?/g, '')
      .replace(/[^\n]*(?:^|[^-])\bborder\s*:[^;]*;?/gm, (m) => m.replace(/\bborder\s*:[^;]*;?/, ''))
      .replace(/\n[ \t]*\n/g, '\n').trimEnd();
    body += `\n  border: var(${cssVar});`;
  } else {
    body = `  content: '';\n  position: absolute;\n  inset: 0;\n  border-radius: inherit;\n  pointer-events: none;\n  z-index: 1;\n  border: var(${cssVar});`;
  }
  const result = updateBorderOverlayStyle(code, nodeId, body);

  // Inline: set `'--X': initialVariant === '<variant>' ? X : 'none'` (drop any prior border / --X).
  const ast = parseJSX(result);
  if (!ast) return code;
  const variantVar = /\banimate=\{variant\}/.test(result) || /animate=\{\['default',\s*variant\]\}/.test(result) || /\[variant,\s*set/.test(result) ? 'variant' : 'initialVariant';
  findFirstElementByDataId(ast, nodeId, (path) => {
    const styleAttr = findAttribute(path.node.openingElement, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
    const expr = styleAttr.value.expression;
    expr.properties = expr.properties.filter((p) => {
      if (!t.isObjectProperty(p)) return true;
      const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
      return k !== 'border' && k !== cssVar;
    });
    // `initialVariant === 'variant' ? propName : 'none'`
    const ternary = t.conditionalExpression(
      t.binaryExpression('===', t.identifier(variantVar), t.stringLiteral(variantName)),
      t.identifier(propName),
      t.stringLiteral('none'),
    );
    expr.properties.push(t.objectProperty(t.stringLiteral(cssVar), ternary));
  });
  if (!addPropToFunction(ast, propName, defaultValue)) return code;
  try {
    const out = generate(ast, { retainLines: true }, result);
    trace.action('variable-ops:set-border-overlay-for-variant', { nodeId, propName, variantName });
    return out.code;
  } catch (err) {
    trace.error('variable-ops:setBorderOverlayVariableForVariant-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Drop the branch whose test is `variant === '<variantName>'` from a (possibly chained) variant
 *  ternary, returning the cleaned expression (the remaining ternary, or the bare base when none
 *  remain). Non-conditional expressions pass through unchanged. */
function dropVariantTernaryBranch(expr: any, variantName: string): any {
  if (!t.isConditionalExpression(expr)) return expr;
  const test = expr.test;
  const isThis = t.isBinaryExpression(test) && test.operator === '==='
    && t.isIdentifier(test.left) && (test.left.name === 'initialVariant' || test.left.name === 'variant')
    && t.isStringLiteral(test.right) && test.right.value === variantName;
  if (isThis) return dropVariantTernaryBranch(expr.alternate, variantName); // drop → fall to the rest
  expr.alternate = dropVariantTernaryBranch(expr.alternate, variantName);
  return expr;
}

/**
 * Remove a PER-VARIANT style-variable OVERRIDE: drop `<variant>`'s branch from the inline
 * `<cssProp>: initialVariant === '<variant>' ? <variantVar> : <base>` ternary so the variant reverts
 * to the base (`<cssProp>: <base>` for a single override). The inverse of `setInlineVariableForVariant`
 * — used by "Remove variable" on a non-default variant when the BASE is also bound (so it can't be a
 * plain unbind). Leaves the (now-unused) prop in the signature; the modal's explicit delete drops it.
 */
export function removeVariantStyleVariableInCode(
  code: string,
  nodeId: string,
  cssProp: string,
  variantName: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  let done = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const styleAttr = findAttribute(path.node.openingElement, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
    for (const p of styleAttr.value.expression.properties) {
      if (!t.isObjectProperty(p)) continue;
      const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
      if (k !== cssProp || !t.isConditionalExpression(p.value)) continue;
      p.value = dropVariantTernaryBranch(p.value, variantName);
      done = true;
    }
  });
  if (!done) return code;
  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:remove-variant-style-variable', { nodeId, cssProp, variantName });
    return out.code;
  } catch (err) {
    trace.error('variable-ops:removeVariantStyleVariableInCode-failed', { nodeId, cssProp, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Bind a NON-border style variable that applies ONLY on a given variant. The OBVIOUS encoding —
 * `<cssProp>: variant === '<v>' ? <prop> : '<else>'` — is FORBIDDEN: the controls bind a variable only as
 * the WHOLE value, and (the real killer) when the element animates a variant OBJECT for that property,
 * framer-motion's variant entry overrides the inline ternary entirely → the variable silently does nothing
 * (the "logo stays black live + canvas" bug). The oracle blocks it (VARIABLE_TERNARY_BINDING).
 *
 * So we SPLIT the element into the engine's blessed per-variant pattern (a dedicated conditionally-rendered
 * element per the oracle's own guidance): the target variant gets a clone with a WHOLE-VALUE binding
 * `<cssProp>: <prop>` and its variant machinery (variants/initial/animate) STRIPPED (so no variant object can
 * override the variable), keeping the original data-id; every OTHER variant keeps the original element (its
 * variant object intact) under a `<nodeId>-base` id. Border uses `setBorderOverlayVariableForVariant`.
 *
 * SCOPE: single-variant binding (the common case). An element already wrapped in `{variant … && …}` (a 2nd
 * variant, or a re-bind) is a no-op — its parent is a LogicalExpression, not a JSX children context.
 */
export function setInlineVariableForVariant(
  code: string,
  nodeId: string,
  cssProp: string,
  variantName: string,
  propName: string,
  elseValue: string,
  defaultValue: string,
  /** When true, the BASE element's cssProp is emitted as a bare IDENTIFIER (the base VARIABLE) rather than a
   *  quoted literal — used when the base already binds its own variable for this prop. */
  elseIsIdentifier = false,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const variantVar = /\banimate=\{variant\}/.test(code) || /animate=\{\['default',\s*variant\]\}/.test(code) || /\[variant,\s*set/.test(code) ? 'variant' : 'initialVariant';
  const keyNode = () => (/^[A-Za-z_$][\w$]*$/.test(cssProp) ? t.identifier(cssProp) : t.stringLiteral(cssProp));
  const keyMatches = (p: t.ObjectExpression['properties'][number]) =>
    t.isObjectProperty(p) && ((t.isIdentifier(p.key) && p.key.name === cssProp) || (t.isStringLiteral(p.key) && p.key.value === cssProp));
  // Set (or insert) cssProp on an element's inline style object. Returns false if it has no style object.
  const setStyleOn = (el: t.JSXElement, valueExpr: t.Expression): boolean => {
    const styleAttr = findAttribute(el.openingElement, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return false;
    const props = styleAttr.value.expression.properties;
    const idx = props.findIndex(keyMatches);
    const op = t.objectProperty(keyNode(), valueExpr);
    if (idx >= 0) props[idx] = op; else props.push(op);
    return true;
  };
  const setDataId = (el: t.JSXElement, id: string) => {
    const idAttr = findAttribute(el.openingElement, 'data-id') as t.JSXAttribute | null;
    if (idAttr) idAttr.value = t.stringLiteral(id);
  };
  const stripVariantMachinery = (el: t.JSXElement) => {
    el.openingElement.attributes = el.openingElement.attributes.filter((a) =>
      !(t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && (a.name.name === 'variants' || a.name.name === 'initial' || a.name.name === 'animate')));
  };
  // ── IDIOMATIC PATH: put the variable straight INTO the element's variant OBJECT ──
  // If the element animates a variant object (`variants={logoNameVariants}`), the natural framer-motion shape
  // is `logoNameVariants['<variant>'] = { …, <cssProp>: <prop> }`. The const is MOVED into the component so it
  // can reference the prop at runtime. ONE element, animates, oracle-clean — the parser resolves the prop ref
  // (motionVariantVariables). Only elements with NO variant object fall through to the AnimatePresence split.
  let handledViaVariantObject = false;
  findFirstElementByDataId(ast, nodeId, (path: any) => {
    const el = path.node as t.JSXElement;
    if (t.isLogicalExpression(path.parent)) return; // already gated → leave it
    const variantsAttr = findAttribute(el.openingElement, 'variants') as t.JSXAttribute | null;
    if (!variantsAttr || variantsAttr.value?.type !== 'JSXExpressionContainer') return;
    const vex = variantsAttr.value.expression;
    let refName: string | null = null;
    if (t.isIdentifier(vex)) refName = vex.name;
    else if (t.isCallExpression(vex) && t.isIdentifier(vex.arguments?.[0])) refName = (vex.arguments[0] as t.Identifier).name; // __applyInstanceSize(X, …)
    if (!refName) return;
    const binding = path.scope?.getBinding(refName);
    if (!binding || !t.isVariableDeclarator(binding.path?.node) || !t.isObjectExpression(binding.path.node.init)) return;
    const fnPath = path.getFunctionParent?.();
    if (!fnPath || !t.isBlockStatement(fnPath.node?.body)) return;
    const initNode = binding.path.node.init as t.ObjectExpression;
    // set / insert the variant entry's `cssProp: <prop>` (a bare identifier = the variable reference)
    const variantKeyMatches = (p: any) => t.isObjectProperty(p) && ((t.isIdentifier(p.key) && p.key.name === variantName) || (t.isStringLiteral(p.key) && p.key.value === variantName));
    const existingVariant = initNode.properties.find(variantKeyMatches) as t.ObjectProperty | undefined;
    let variantObj: t.ObjectExpression;
    if (existingVariant && t.isObjectExpression(existingVariant.value)) variantObj = existingVariant.value;
    else { variantObj = t.objectExpression([]); initNode.properties.push(t.objectProperty(t.stringLiteral(variantName), variantObj)); }
    const pidx = variantObj.properties.findIndex(keyMatches);
    const newProp = t.objectProperty(keyNode(), t.identifier(propName));
    if (pidx >= 0) variantObj.properties[pidx] = newProp; else variantObj.properties.push(newProp);
    // MOVE the const into the component function if it's module-scope, so `<prop>` resolves at runtime
    // (a module-scope const referencing a component prop would be a ReferenceError on deploy).
    if (t.isProgram(binding.scope?.block)) {
      const declPath = binding.path.parentPath; // the VariableDeclaration
      const declClone = t.cloneNode(declPath.node, true) as t.Statement;
      declPath.remove();
      fnPath.node.body.body.unshift(declClone);
    }
    handledViaVariantObject = true;
  });
  if (handledViaVariantObject) {
    if (!addPropToFunction(ast, propName, defaultValue)) return code;
    try {
      const out = generate(ast, { retainLines: true }, code);
      trace.action('variable-ops:set-inline-var-for-variant', { nodeId, cssProp, propName, variantName, mode: 'variant-object' });
      return out.code;
    } catch (err) {
      trace.error('variable-ops:setInlineVariableForVariant-failed', { nodeId, cssProp, propName, error: err instanceof Error ? err.message : String(err) });
      return code;
    }
  }

  // ── FALLBACK: inline TERNARY (elements with NO variant object) ──
  // With no variant object to override it, `<cssProp>: variant === 'v' ? <prop> : <else>` works fine — the
  // parser reads it into conditionalStyleVariables and the panel shows the per-variant pill. CHAINS for
  // multiple variants (the new branch's else wraps any prior ternary). `elseIsIdentifier` keeps the base's
  // OWN variable as a bare identifier (`… ? newVar : baseVar`). (This is the original per-variant codegen —
  // it's ONLY the variant-OBJECT case above that needed the idiomatic rewrite, because there the object wins.)
  let done = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const styleAttr = findAttribute(path.node.openingElement, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
    const expr = styleAttr.value.expression;
    const keyOf = (p: t.ObjectExpression['properties'][number]) =>
      t.isObjectProperty(p) ? (t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null) : null;
    const existing = expr.properties.find((p): p is t.ObjectProperty => keyOf(p) === cssProp);
    const alternate: t.Expression = (existing && t.isConditionalExpression(existing.value))
      ? (dropVariantTernaryBranch(existing.value, variantName) as t.Expression)
      : (elseIsIdentifier ? t.identifier(elseValue) : t.stringLiteral(elseValue));
    expr.properties = expr.properties.filter((p) => keyOf(p) !== cssProp);
    const keyNodeLocal = /^[A-Za-z_$][\w$]*$/.test(cssProp) ? t.identifier(cssProp) : t.stringLiteral(cssProp);
    const ternary = t.conditionalExpression(
      t.binaryExpression('===', t.identifier(variantVar), t.stringLiteral(variantName)),
      t.identifier(propName), alternate);
    expr.properties.push(t.objectProperty(keyNodeLocal, ternary));
    done = true;
  });
  if (!done) return code;
  if (!addPropToFunction(ast, propName, defaultValue)) return code;
  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:set-inline-var-for-variant', { nodeId, cssProp, propName, variantName, mode: 'inline-ternary' });
    return out.code;
  } catch (err) {
    trace.error('variable-ops:setInlineVariableForVariant-failed', { nodeId, cssProp, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Insert a destructured prop into a component-signature ObjectPattern BEFORE any
 *  `...rest` element — masters now carry `...rest` to forward DOM props (onClick /
 *  data-overlay-trigger) to the root, and a rest element MUST be last, so a plain
 *  push would emit invalid `{ …, ...rest, newProp }`. */
function insertParamPropBeforeRest(pattern: t.ObjectPattern, prop: t.ObjectProperty): void {
  const restIdx = pattern.properties.findIndex(p => t.isRestElement(p));
  if (restIdx >= 0) pattern.properties.splice(restIdx, 0, prop);
  else pattern.properties.push(prop);
}

// ─── Bare prop (no default literal) ─────────────────────────────────────────

/**
 * Add a destructured prop to the component function signature. Used by the
 * component-cursor variable flow: the master's `withCursor(myCursor, …)` call
 * receives whatever the consuming page instance passes for `myCursor`.
 *
 * The default value is controlled by `defaultKind`:
 *   - `'none'` (default): bare `{ myCursor }` — no default. The prop is
 *     `undefined` until an instance supplies it.
 *   - `'nullComponent'`: `{ myCursor = () => null }` — a component that
 *     renders nothing. THIS is what cursor variables use: when the page
 *     instance hasn't chosen a component yet, `withCursor(myCursor, …)`
 *     receives a valid (null-rendering) component instead of `undefined`,
 *     so hovering does nothing instead of crashing the preview with
 *     "Element type is invalid" (React rejects `<undefined />`).
 *   - an identifier string: `{ myCursor = DefaultCursor }` — default is a
 *     bare identifier (a real component already in scope).
 *
 * Idempotent: if the prop is already in the signature, the function leaves
 * it alone (we never want to drop an existing default the user set).
 */
export function addBarePropToFunctionInCode(
  code: string,
  propName: string,
  defaultKind: 'none' | 'nullComponent' | string = 'none',
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  let touched = false;
  const makeDefaultExpr = (): t.Expression | null => {
    if (defaultKind === 'none') return null;
    if (defaultKind === 'nullComponent') {
      // `() => null` — a valid React component that renders nothing.
      return t.arrowFunctionExpression([], t.nullLiteral());
    }
    // `{}` → an empty-object default (e.g. a TRANSITION variable: `transVar = {}` — a valid framer-motion
    // transition the user edits in the modal). Without this it would become the bogus identifier `{}`.
    if (defaultKind === '{}') return t.objectExpression([]);
    // Any other string → treat as a bare identifier default.
    return t.identifier(defaultKind);
  };
  const makeProp = () => {
    const def = makeDefaultExpr();
    const valueExpr: t.LVal | t.Identifier = def
      ? t.assignmentPattern(t.identifier(propName), def)
      : t.identifier(propName);
    return t.objectProperty(t.identifier(propName), valueExpr, false, true);
  };

  const handle = (params: t.Node[]): boolean => {
    if (params.length === 0) {
      params.push(t.objectPattern([makeProp()]));
      return true;
    }
    const first = params[0];
    const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
    if (!t.isObjectPattern(target)) return false;
    for (const p of target.properties) {
      if (!t.isObjectProperty(p)) continue;
      const k = t.isIdentifier(p.key) ? p.key.name : null;
      if (k === propName) return false; // already declared — leave alone
    }
    insertParamPropBeforeRest(target, makeProp());
    return true;
  };

  traverse(ast, {
    // Module-scope only — never a nested empty-param arrow (see addPropToFunction).
    FunctionDeclaration(path: any) {
      if (touched || path.getFunctionParent()) return;
      if (handle(path.node.params)) { touched = true; path.stop(); }
    },
    ArrowFunctionExpression(path: any) {
      if (touched || path.getFunctionParent()) return;
      if (handle(path.node.params)) { touched = true; path.stop(); }
    },
  });

  if (!touched) return code;
  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:add-bare-prop', { propName, defaultKind });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:addBareProp-generate-failed', { propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Create a standalone TYPED variable (component prop) — the "+" type-picker flow. Adds a destructured
 * prop with a correctly-typed literal default so the runtime value matches the picked type:
 *   - 'number'  → `count = 5`        (NumericLiteral, unquoted)
 *   - 'boolean' → `visible = true`   (BooleanLiteral)
 *   - 'string'  → `title = "hi"`     (StringLiteral) — covers text/color/border/shadow/link/option/…
 * The TYPE id itself is persisted separately in the `@propMeta` block (see prop-meta.ts) since the
 * literal alone can't distinguish e.g. a Number from a numeric-looking string, or an Option from text.
 * Idempotent on the prop name (addPropExprToFunction leaves an existing prop alone). Pure string→string.
 */
export function createTypedVariableInCode(
  code: string,
  propName: string,
  literalKind: 'string' | 'number' | 'boolean',
  defaultValue: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  if (isStructuralProp(propName)) {
    trace.error('variable-ops:create-typed-blocked-structural', { propName });
    return code;
  }
  let defaultExpr: t.Expression;
  if (literalKind === 'number') {
    const n = parseFloat(defaultValue);
    defaultExpr = t.numericLiteral(Number.isFinite(n) ? n : 0);
  } else if (literalKind === 'boolean') {
    defaultExpr = t.booleanLiteral(defaultValue === 'true');
  } else {
    defaultExpr = t.stringLiteral(defaultValue);
  }
  if (!addPropExprToFunction(ast, propName, defaultExpr)) return code;
  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:create-typed-variable', { propName, literalKind, defaultValue });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:createTypedVariable-generate-failed', { propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Create a component variable for a BOOLEAN visibility-style property (Hide/Visible → display, Wrap →
 * flexWrap). Binds via a ternary instead of a bare identifier — `style={{ display: someBool }}` isn't
 * valid CSS — and adds a BooleanLiteral prop default:
 *
 *   <div style={{ display: 'none' }}/>            +  prop  hidden = true
 *     → <div style={{ display: hidden ? 'none' : '' }}/>
 *
 * The parser reads the ternary back as a `condvar:` binding (see parser.ts), so the pill/Set-Variable
 * surface it like any other variable. `boolDefault` is 'true' | 'false'. Pure string → string.
 */
export function createConditionalVariableInCode(
  code: string,
  nodeId: string,
  styleProperty: string,
  propName: string,
  consequent: string,
  alternate: string,
  boolDefault: string,
): string {
  if (isStructuralProp(propName)) {
    trace.error('variable-ops:create-conditional-blocked-structural', { nodeId, styleProperty, propName });
    return code;
  }
  const ast = parseJSX(code);
  if (!ast) return code;

  const ternary = () => t.conditionalExpression(
    t.identifier(propName), t.stringLiteral(consequent), t.stringLiteral(alternate),
  );

  let bound = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
    // No style attr yet — create `style={{ <prop>: <ternary> }}`.
    if (!styleAttr) {
      opening.attributes.push(
        t.jsxAttribute(t.jsxIdentifier('style'),
          t.jsxExpressionContainer(t.objectExpression([
            t.objectProperty(t.identifier(styleProperty), ternary()),
          ]))),
      );
      bound = true;
      return;
    }
    if (styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
    const expr = styleAttr.value.expression;
    for (const prop of expr.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key !== styleProperty) continue;
      prop.value = ternary();
      bound = true;
      return;
    }
    // Property absent in an existing style object — add it.
    expr.properties.push(t.objectProperty(t.identifier(styleProperty), ternary()));
    bound = true;
  });

  if (!bound) return code;
  if (!addPropToFunction(ast, propName, boolDefault, 'boolean')) return code;

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:create-conditional-variable', { nodeId, styleProperty, propName, consequent, alternate, boolDefault });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:createConditionalVariable-generate-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * FULL retroactive delete of a component variable — drops the prop AND removes every reference to it
 * across the whole component so nothing points at a variable that no longer exists:
 *   - inline style refs (`cssProp: prop`, `'--X': prop`, per-variant ternaries) → the prop's default literal
 *   - `{...withCursor(prop, …)}` cursor spreads → removed
 *   - the destructured prop → removed from the signature
 * The `@propMeta` entry is cleared separately by the mutation handler. Pure string→string.
 */
export function deleteComponentVariableInCode(code: string, propName: string, defaultValue?: string): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const def = (defaultValue && defaultValue.trim()) ? defaultValue : (readPropDefaultString(ast, propName) ?? '');
  // Boolean default (for `hidden ? 'none' : ''` style ternaries whose default is a BooleanLiteral, which
  // readPropDefaultString can't see). true → keep the consequent state, false/unknown → the alternate.
  const boolDef = readPropDefaultBool(ast, propName);

  // Replace any reference to `propName` with its default literal, recursing through ternary/binary/template.
  const inlineExpr = (expr: t.Expression): t.Expression => {
    if (t.isIdentifier(expr) && expr.name === propName) return t.stringLiteral(def);
    // Boolean visibility ternary (`propName ? 'none' : ''`): resolve to the branch the default picks.
    if (t.isConditionalExpression(expr) && t.isIdentifier(expr.test) && expr.test.name === propName) {
      const branch = boolDef === true ? expr.consequent : expr.alternate;
      return t.isExpression(branch) ? branch : t.stringLiteral('');
    }
    if (t.isConditionalExpression(expr)) {
      if (t.isExpression(expr.test)) expr.test = inlineExpr(expr.test);
      expr.consequent = inlineExpr(expr.consequent);
      expr.alternate = inlineExpr(expr.alternate);
      return expr;
    }
    if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
      if (t.isExpression(expr.left)) expr.left = inlineExpr(expr.left);
      if (t.isExpression(expr.right)) expr.right = inlineExpr(expr.right);
      return expr;
    }
    if (t.isTemplateLiteral(expr)) {
      expr.expressions = expr.expressions.map(e => (t.isExpression(e) ? inlineExpr(e) : e));
      return expr;
    }
    return expr;
  };

  traverse(ast, {
    JSXAttribute(path: any) {
      const a = path.node;
      if (!t.isJSXIdentifier(a.name)) return;
      if (a.name.name === 'style') {
        if (a.value?.type !== 'JSXExpressionContainer' || a.value.expression.type !== 'ObjectExpression') return;
        for (const prop of a.value.expression.properties) {
          if (t.isObjectProperty(prop) && t.isExpression(prop.value)) prop.value = inlineExpr(prop.value);
        }
        return;
      }
      // NON-style attribute bound to the variable — a component-instance PROP
      // (`padding={__mq2 ? padding1 : padding}`, `initialVariant={(__mq2 ? v2 : v)}`).
      // Inline the variable reference to its default literal so a full delete
      // doesn't leave a dangling identifier in the prop expression (the per-viewport
      // variant/prop variable bindings live here, not in a style object). inlineExpr
      // only rewrites `propName` identifiers, so unrelated handler/expr attrs are untouched.
      if (a.value?.type === 'JSXExpressionContainer' && t.isExpression(a.value.expression)) {
        a.value.expression = inlineExpr(a.value.expression);
      }
    },
    JSXSpreadAttribute(path: any) {
      const arg = path.node.argument;
      if (t.isCallExpression(arg) && t.isIdentifier(arg.callee) && arg.callee.name === 'withCursor'
        && arg.arguments[0] && t.isIdentifier(arg.arguments[0]) && (arg.arguments[0] as t.Identifier).name === propName) {
        path.remove();
      }
    },
    // TEXT-content references: a `{propName}` (or per-variant `{… ? 'lit' : propName}`) JSX CHILD — inline
    // it to the default literal so a full delete of a text variable doesn't leave a dangling identifier.
    JSXExpressionContainer(path: any) {
      if (path.parent?.type !== 'JSXElement' && path.parent?.type !== 'JSXFragment') return; // children only, not attrs
      if (t.isExpression(path.node.expression)) path.node.expression = inlineExpr(path.node.expression);
    },
  });

  removePropFromFunction(ast, propName);

  try {
    let out = generate(ast, { retainLines: true }, code).code;
    // SECTION-VARIABLE cleanups. A scroll-variant section var threads through
    // generated runtime + route map + the data-scroll-variant JSON — none of
    // which the AST inline above touches (they're not style/text/cursor). After
    // dropping the param, those dangling refs would make the code invalid (the
    // oracle then reverts the whole delete → "Remove does nothing"). Revert each
    // to the literal default. All no-ops for non-section variables.
    const esc = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const defLit = def.replace(/'/g, "\\'");
    out = out
      // route-map reassignment line — BOTH the plain form (`<name> = __tp.<name> ?? <name>;`)
      // AND the per-viewport `__mq`-gated form (`<name> = (__mq1 ? __tp['<name>@375'] : …) ?? __tp.<name> ?? <name>;`).
      // Any single line that assigns `<name>` and references `__tp` IS that reassignment.
      .replace(new RegExp(`\\n?[ \\t]*${esc} = [^\\n]*__tp[^\\n]*;`, 'g'), '')
      // getElementById(<name>) → literal id (scroll target reverts to a fixed id)
      .replace(new RegExp(`document\\.getElementById\\(${esc}\\)`, 'g'), `document.getElementById('${defLit}')`)
      // that effect's deps `[<name>]` → `[]` (the literal never changes)
      .replace(new RegExp(`\\}, \\[${esc}\\]\\)`, 'g'), '}, [])')
      // data-scroll-variant JSON `"sectionVar":"<name>"` (any position)
      .replace(new RegExp(`"sectionVar"\\s*:\\s*"${esc}",`, 'g'), '')
      .replace(new RegExp(`,\\s*"sectionVar"\\s*:\\s*"${esc}"`, 'g'), '')
      .replace(new RegExp(`"sectionVar"\\s*:\\s*"${esc}"`, 'g'), '');
    // Strip the prop's @propMeta entry too — otherwise the deleted variable's metadata (label / variantOf /
    // slider knobs) lingers and the panel still lists it ("start trial button variant of …" after delete).
    out = removePropMetaInCode(out, propName);
    trace.action('variable-ops:delete-component-variable', { propName });
    return out;
  } catch (err) {
    trace.error('variable-ops:deleteComponentVariable-failed', { propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Rename a component variable (prop) everywhere — the destructured param AND every reference (JSX style
 * values, `withCursor(prop, …)`, per-variant ternaries, `{prop}` children). Uses babel's scope-aware
 * rename so only THIS binding's references move (not unrelated identifiers of the same name). The
 * `@propMeta` key is moved separately by the mutation handler. No-op for empty / unchanged / structural
 * names. Pure string→string.
 */
export function renameComponentVariableInCode(code: string, oldName: string, newName: string): string {
  if (!newName || oldName === newName || isStructuralProp(newName)) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  let renamed = false;
  traverse(ast, {
    Function(path: any) {
      if (renamed) return;
      const binding = path.scope.getBinding(oldName);
      // Only the component function declares the prop as a destructured param.
      if (binding && (binding.kind === 'param' || binding.kind === 'local')) {
        path.scope.rename(oldName, newName);
        // scope.rename renames the BINDING + references but aliases the destructured KEY to keep the
        // external prop name (`{ oldName: newName = … }`). We want the PROP name itself to change, so
        // collapse that property back to shorthand (`{ newName = … }`).
        const first = path.node.params[0];
        const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
        if (t.isObjectPattern(target)) {
          for (const p of target.properties) {
            if (t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === oldName) {
              p.key = t.identifier(newName);
              p.shorthand = true;
            }
          }
        }
        renamed = true;
        path.stop();
      }
    },
  });
  if (!renamed) return code;
  try {
    let out = generate(ast, { retainLines: true }, code).code;
    // `scope.rename` renames identifier REFERENCES — but a section variable is
    // also referenced as a STRING inside the `data-scroll-variant` JSON attr
    // (`"sectionVar":"oldName"`), which babel leaves untouched. Sync it so the
    // scroll-variant binding still points at the renamed prop (else the JSON
    // says oldName while getElementById(newName) runs → broken). No-op for
    // non-section variables (the substring won't be present).
    const escOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`("sectionVar"\\s*:\\s*")${escOld}(")`, 'g'), `$1${newName}$2`);
    trace.action('variable-ops:rename-component-variable', { oldName, newName });
    return out;
  } catch (err) {
    trace.error('variable-ops:renameComponentVariable-failed', { oldName, newName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Remove a bare destructured prop from the component function signature.
 * Inverse of `addBarePropToFunctionInCode` — used when the cursor variable's
 * binding is removed and the prop is left orphaned. Pure string→string.
 *
 * Only touches the function signature; the caller is responsible for having
 * already stripped any JSX usage of the prop (e.g. the `withCursor(...)`
 * call). No-op when the prop isn't present.
 */
function removeBarePropFromFunctionInCode(code: string, propName: string): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  removePropFromFunction(ast, propName);

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:remove-bare-prop', { propName });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:removeBareProp-generate-failed', { propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Link / HTML-attribute variables ────────────────────────────────────────

/** Add a destructured prop with an arbitrary default EXPRESSION (string,
 *  boolean, etc.) to the component function signature. No-op if the prop is
 *  already declared. Returns whether it touched the AST. */
function addPropExprToFunction(ast: t.File, propName: string, defaultExpr: t.Expression): boolean {
  let added = false;
  const makeProp = () => t.objectProperty(
    t.identifier(propName),
    t.assignmentPattern(t.identifier(propName), defaultExpr),
    false, true,
  );
  const handle = (params: t.Node[]): boolean => {
    if (params.length === 0) { params.push(t.objectPattern([makeProp()])); return true; }
    const first = params[0];
    const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
    if (!t.isObjectPattern(target)) return false;
    for (const p of target.properties) {
      if (t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === propName) return false;
    }
    insertParamPropBeforeRest(target, makeProp());
    return true;
  };
  traverse(ast, {
    // Module-scope only — a nested empty-param arrow (e.g. `useState(() => …)`
    // in a useMediaQuery helper) would otherwise be the first "addable" target
    // and get corrupted into `({ prop = … }) =>`, crashing the render. See
    // addPropToFunction for the full story.
    FunctionDeclaration(path: any) { if (!added && !path.getFunctionParent() && handle(path.node.params)) { added = true; path.stop(); } },
    ArrowFunctionExpression(path: any) { if (!added && !path.getFunctionParent() && handle(path.node.params)) { added = true; path.stop(); } },
  });
  return added;
}

/** The link/navigation attributes that can become a variable. `string` =
 *  the prop holds the raw attr value (href). `newTab` / `smooth` = a boolean
 *  prop driving a conditional attr value, so the page instance can toggle it. */
export type LinkAttrKind = 'string' | 'newTab' | 'smooth';

/**
 * Turn a navigation attribute on an `<a>` / `<Link>` element into a component
 * variable: add a destructured prop to the master's signature and rewrite the
 * element's attribute to reference it. Mirrors `createVariableInCode` but for
 * HTML/nav attributes instead of inline styles.
 *
 *   href  (string) → `href={linkHref}`                          prop `linkHref = '/about'`
 *   target(newTab) → `target={newTab ? '_blank' : undefined}`   prop `newTab = false`
 *   smooth         → `data-smooth-scroll={s ? 'true' : undefined}` prop `s = true`
 *
 * The boolean kinds use a ternary so the page-instance toggle (a boolean
 * variable) maps cleanly to the real attribute value. Injects the attribute
 * when absent (e.g. a link with no `target` yet).
 */
export function createLinkAttrVariableInCode(
  code: string,
  nodeId: string,
  opts: { attrName: string; propName: string; kind: LinkAttrKind; defaultValue: string },
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  const propIdent = t.identifier(opts.propName);
  let attrValueExpr: t.Expression;
  let defaultExpr: t.Expression;
  if (opts.kind === 'string') {
    attrValueExpr = propIdent;
    defaultExpr = t.stringLiteral(opts.defaultValue);
  } else if (opts.kind === 'newTab') {
    attrValueExpr = t.conditionalExpression(propIdent, t.stringLiteral('_blank'), t.identifier('undefined'));
    defaultExpr = t.booleanLiteral(opts.defaultValue === 'true' || opts.defaultValue === '_blank');
  } else {
    attrValueExpr = t.conditionalExpression(propIdent, t.stringLiteral('true'), t.identifier('undefined'));
    defaultExpr = t.booleanLiteral(opts.defaultValue === 'true');
  }

  let touched = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const existing = findAttribute(opening, opts.attrName) as t.JSXAttribute | null;
    const newValue = t.jsxExpressionContainer(attrValueExpr);
    if (existing) {
      existing.value = newValue;
    } else {
      opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(opts.attrName), newValue));
    }
    touched = true;
  });
  if (!touched) return code;

  addPropExprToFunction(ast, opts.propName, defaultExpr);

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:create-link-attr-variable', { nodeId, attr: opts.attrName, propName: opts.propName, kind: opts.kind });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:createLinkAttrVariable-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Inverse of {@link createLinkAttrVariableInCode}: detach a nav-attr variable,
 * rewriting the element's attribute back to a literal and dropping the prop
 * from the master signature. The literal to restore is read from the prop's
 * current default (so the user keeps their value) — falling back to a sensible
 * empty/removed state when the prop has no default.
 *
 *   href={linkHref}  prop linkHref='/about'   → href="/about"   (prop removed)
 *   target={newTab?…} prop newTab=true        → target="_blank" (prop removed)
 *   target={newTab?…} prop newTab=false       → (attr removed)
 *   data-smooth-scroll={s?…} prop s=true      → data-smooth-scroll="true"
 */
export function removeLinkAttrVariableInCode(
  code: string,
  nodeId: string,
  opts: { attrName: string; propName: string; kind: LinkAttrKind; deleteProp?: boolean },
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  // Read the prop's current default from the function signature. Mirrors the
  // destructure-walking in addPropExprToFunction (handles a `{...} = {}`
  // defaulted param too).
  let defaultStr: string | null = null;
  let defaultBool = false;
  const readDefault = (params: t.Node[]) => {
    const first = params[0];
    if (!first) return;
    const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
    if (!t.isObjectPattern(target)) return;
    for (const prop of target.properties) {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key) || prop.key.name !== opts.propName) continue;
      const val = prop.value;
      if (t.isAssignmentPattern(val)) {
        const r = val.right;
        if (t.isStringLiteral(r)) defaultStr = r.value;
        else if (t.isBooleanLiteral(r)) defaultBool = r.value;
      }
    }
  };
  traverse(ast, {
    // Module-scope only — read the COMPONENT's default, never a nested arrow's.
    FunctionDeclaration(path: any) { if (!path.getFunctionParent()) readDefault(path.node.params); },
    ArrowFunctionExpression(path: any) { if (!path.getFunctionParent()) readDefault(path.node.params); },
  });

  let touched = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const existing = findAttribute(opening, opts.attrName) as t.JSXAttribute | null;
    if (!existing) return;
    if (opts.kind === 'string') {
      existing.value = t.stringLiteral(defaultStr ?? '');
    } else if (defaultBool) {
      // Restore the literal "on" value for the boolean nav attr.
      existing.value = t.stringLiteral(opts.kind === 'newTab' ? '_blank' : 'true');
    } else {
      // Boolean default is false → the attribute carries no value; drop it.
      opening.attributes = opening.attributes.filter((a: t.Node) => a !== existing);
    }
    touched = true;
  });
  if (!touched) return code;

  const out = ast;
  try {
    const generated = generate(out, { retainLines: true }, code).code;
    // `deleteProp: false` = UNBIND ONLY (the pill × on a node): rewrite the attr to its literal but KEEP the
    // param so the VARIABLE survives for other nodes — same rule as every other variable's × (the modal's
    // explicit delete is the only thing that drops it). Default (undefined/true) still drops the prop.
    const final = opts.deleteProp === false ? generated : removeBarePropFromFunctionInCode(generated, opts.propName);
    trace.action('variable-ops:remove-link-attr-variable', { nodeId, attr: opts.attrName, propName: opts.propName, kind: opts.kind, deleteProp: opts.deleteProp !== false });
    return final;
  } catch (err) {
    trace.error('variable-ops:removeLinkAttrVariable-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Border longhand list (used by BorderControl when creating a variable) ───

/**
 * All per-side and axis-shorthand keys that the Border atom produces in
 * `formatBorderIndividual` / `formatBorderUniform`. Pass to
 * createVariableInCode as `clearLonghands` so the resulting JSX only carries
 * the `border` shorthand identifier and not any leftover longhands.
 */
export const BORDER_LONGHANDS = [
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'borderWidth', 'borderStyle', 'borderColor',
];

// ─── Create Text Variable ───────────────────────────────────────────────────

/**
 * Replace an element's text children with a `{propName}` JSX expression and
 * add a destructured prop with the captured (or supplied) default text to
 * the component's function signature.
 *
 * Example:
 *   <p data-id="title">Hello</p>
 * becomes
 *   <p data-id="title">{title}</p>
 *   function Card({ title = 'Hello' }) { ... }
 *
 * Returns the modified code, or the original if anything goes wrong (no
 * matching node, mixed content, no extractable default text, etc.).
 */
/**
 * Capture a text node's plain-text content and replace its children with a single
 * `{propName}` expression. Returns the captured (trimmed) text, or `null` when the
 * node has mixed / non-text content (a child element, an existing binding) so the
 * caller bails. Shared by `createTextVariableInCode` (read-only @propMeta prop) and
 * `bindTextNodeAsPageVarInCode` (settable @pageVariables state). Mutates `ast`.
 */
function captureAndBindTextNode(ast: Parameters<typeof findFirstElementByDataId>[0], nodeId: string, propName: string, defaultValue?: string): string | null {
  let capturedText: string | null = null;
  findFirstElementByDataId(ast, nodeId, (path) => {
    // Descend through SINGLE wrapper elements first: a font-family (or any
    // styled) span that wraps the WHOLE text — `<p><span style>UI/ UX
    // Design</span></p>` — is the shape the text editor writes, and the old
    // walk bailed on it as "mixed content", so Create Variable silently
    // no-oped and the Variables modal opened empty (user report 2026-07-31).
    // Binding INSIDE the innermost wrapper keeps its styling:
    // `<span style>{content}</span>`. TRUE mixed content (multiple element
    // children / interleaved spans) still bails below.
    let el = path.node;
    for (;;) {
      const kids = el.children.filter((c: t.Node) => !(t.isJSXText(c) && c.value.trim() === ''));
      if (kids.length === 1 && t.isJSXElement(kids[0])) { el = kids[0] as typeof el; continue; }
      break;
    }
    // Walk children: gather all text. Bail on anything else (a child JSXElement,
    // a non-literal expression that's already a variable / collection binding).
    let buf = '';
    let nonTextSeen = false;
    for (const child of el.children) {
      if (t.isJSXText(child)) { buf += child.value; continue; }
      if (t.isJSXExpressionContainer(child)) {
        const exp = child.expression;
        if (t.isStringLiteral(exp)) { buf += exp.value; continue; }
        if (t.isNumericLiteral(exp)) { buf += String(exp.value); continue; }
        nonTextSeen = true;
        break;
      }
      nonTextSeen = true;
      break;
    }
    if (nonTextSeen) {
      trace.error('variable-ops:capture-text-mixed-content-bail', { nodeId, propName });
      return;
    }
    capturedText = (defaultValue != null ? defaultValue : buf).trim();
    if (capturedText.length === 0 && defaultValue == null) return;
    el.children = [t.jsxExpressionContainer(t.identifier(propName))];
  });
  return capturedText;
}

export function createTextVariableInCode(
  code: string,
  nodeId: string,
  propName: string,
  defaultValue?: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const capturedText = captureAndBindTextNode(ast, nodeId, propName, defaultValue);
  if (capturedText === null) return code;
  if (!addPropToFunction(ast, propName, capturedText)) return code;
  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:create-text', { nodeId, propName, defaultValue: capturedText });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:createTextVariable-generate-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Bind a text node to a PAGE-VARIABLE identifier `{propName}` (NOT a read-only
 * @propMeta prop). The caller declares the matching `@pageVariables` text entry +
 * syncs the `useState` hook, so the text becomes a SETTABLE state variable that
 * shows up in the Interactions tool's "Set Variable" list — a prop never does (no
 * setter). No-op on mixed content. Pure string→string.
 */
export function bindTextNodeAsPageVarInCode(
  code: string,
  nodeId: string,
  propName: string,
  defaultValue?: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const capturedText = captureAndBindTextNode(ast, nodeId, propName, defaultValue);
  if (capturedText === null) return code;
  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:bind-text-page-var', { nodeId, propName });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:bindTextPageVar-generate-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * BIND a text-content variable FOR ONE VARIANT only — the inverse of detach, and the per-variant
 * counterpart of `createTextVariable` (which binds on every variant). On a non-primary variant the text
 * child becomes a ternary where ONLY that variant uses the variable; the others keep their literal text:
 *
 *   <p>Normal</p>                          bind 'variant-2' → content
 *     → <p>{initialVariant === 'variant-2' ? content : 'Normal'}</p>
 *
 * Re-running for another variant extends the chain. Reads any existing per-variant ternary (literal AND
 * variable branches) so binds/detaches compose. Adds the prop to the signature (default = `propDefault`)
 * when it doesn't exist yet (the "Create Variable" path); leaves it alone for "Set Variable" (existing).
 * Uses `initialVariant` (always a prop) so it's valid at runtime. Pure string → string.
 */
export function bindTextVariableForVariantInCode(
  code: string,
  nodeId: string,
  variantName: string,
  propName: string,
  propDefault: string,
): string {
  if (isStructuralProp(propName)) {
    trace.error('variable-ops:bind-text-variant-blocked-structural', { nodeId, propName });
    return code;
  }
  const ast = parseJSX(code);
  if (!ast) return code;
  const propExists = readPropDefaultString(ast, propName) !== null;

  let bound = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const literals: Record<string, string> = {};
    const vars: Record<string, string> = {};
    let variantId: string | null = null;
    let fallbackText = propDefault;

    const significant = path.node.children.filter(
      (c: t.Node) => c.type === 'JSXElement' || c.type === 'JSXExpressionContainer'
        || (c.type === 'JSXText' && (c as t.JSXText).value.trim() !== ''),
    );
    const only = significant.length === 1 ? significant[0] : null;

    if (only && t.isJSXExpressionContainer(only) && t.isConditionalExpression(only.expression)) {
      // Existing per-variant ternary — read literal + variable branches so we extend, not clobber.
      let cursor: any = only.expression;
      while (cursor?.type === 'ConditionalExpression'
        && cursor.test?.type === 'BinaryExpression' && cursor.test.operator === '==='
        && cursor.test.left?.type === 'Identifier'
        && (cursor.test.left.name === 'initialVariant' || cursor.test.left.name === 'variant')
        && cursor.test.right?.type === 'StringLiteral') {
        variantId = cursor.test.left.name;
        const k = cursor.test.right.value;
        if (cursor.consequent?.type === 'StringLiteral') literals[k] = cursor.consequent.value;
        else if (cursor.consequent?.type === 'Identifier') vars[k] = cursor.consequent.name;
        cursor = cursor.alternate;
      }
      if (cursor?.type === 'StringLiteral') literals['default'] = cursor.value;
      else if (cursor?.type === 'Identifier') vars['default'] = cursor.name;
    } else if (only && t.isJSXExpressionContainer(only) && t.isIdentifier(only.expression)) {
      // Already globally bound `{content}` → that variable becomes the fallback for the other variants.
      vars['default'] = only.expression.name;
    } else {
      // Plain text → it's the fallback literal for every other variant.
      let txt = '';
      for (const c of path.node.children) {
        if (c.type === 'JSXText') txt += (c as t.JSXText).value.trim();
        else if (t.isJSXExpressionContainer(c) && t.isStringLiteral(c.expression)) txt += c.expression.value;
      }
      if (txt) fallbackText = txt;
    }

    vars[variantName] = propName; // bind the variable ON THIS VARIANT

    // Build `<id> === 'k' ? <branch> : … : <fallback>`. `<id>` is the component's variant identifier:
    // reuse an existing ternary's, else a `variant` useState if present, else the `initialVariant` prop
    // (always defined → never an undefined-`variant` runtime crash).
    const idName = variantId ?? (/\bconst\s*\[\s*variant\b/.test(code) ? 'variant' : 'initialVariant');
    const keys = [...new Set([...Object.keys(literals), ...Object.keys(vars)])].filter(k => k !== 'default');
    let expr: t.Expression = vars['default']
      ? t.identifier(vars['default'])
      : t.stringLiteral(literals['default'] ?? fallbackText);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i];
      const branch = vars[k] ? t.identifier(vars[k]) : t.stringLiteral(literals[k] ?? '');
      expr = t.conditionalExpression(
        t.binaryExpression('===', t.identifier(idName), t.stringLiteral(k)),
        branch, expr,
      );
    }
    path.node.children = [t.jsxExpressionContainer(expr)];
    bound = true;
    path.stop();
  });

  if (!bound) return code;
  if (!propExists) addPropToFunction(ast, propName, propDefault, 'string');

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:bind-text-variant', { nodeId, variantName, propName, propExists });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:bindTextVariableForVariant-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Remove Text Variable ───────────────────────────────────────────────────

/**
 * Inline a text variable back to literal JSX text and remove the prop from
 * the component signature. Inverse of `createTextVariableInCode`.
 */
export function removeTextVariableInCode(
  code: string,
  nodeId: string,
  propName: string,
  defaultValue: string,
  /** When false (the × pill — default) only UNBIND this node, KEEPING the prop so the variable stays in
   *  the modal for re-binding (mirrors style ×). True (modal "delete") drops the prop too. */
  deleteProp = false,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  // The literal to inject: the caller's value, else the variable's SIGNATURE default (so unbinding shows
  // the variable's text — `<p>{content}</p>` → `<p>qsdgsdgq</p>`, not an empty `<p>`). The × pill passes
  // '' for the default, so without this the text would vanish.
  const def = (defaultValue && defaultValue.trim()) ? defaultValue : (readPropDefaultString(ast, propName) ?? '');

  // Replace any `propName` reference with its default literal — recursing through a per-variant ternary
  // so `{initialVariant === 'v2' ? 'lit' : content}` becomes `{… : 'default'}` instead of leaving a
  // dangling `content` once the prop is dropped (the "References undefined identifier" crash).
  const inlineId = (expr: t.Expression): t.Expression => {
    if (t.isIdentifier(expr) && expr.name === propName) return t.stringLiteral(def);
    if (t.isConditionalExpression(expr)) {
      if (t.isExpression(expr.test)) expr.test = inlineId(expr.test);
      expr.consequent = inlineId(expr.consequent);
      expr.alternate = inlineId(expr.alternate);
      return expr;
    }
    if (t.isTemplateLiteral(expr)) {
      expr.expressions = expr.expressions.map(e => (t.isExpression(e) ? inlineId(e) : e));
      return expr;
    }
    if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
      if (t.isExpression(expr.left)) expr.left = inlineId(expr.left);
      if (t.isExpression(expr.right)) expr.right = inlineId(expr.right);
      return expr;
    }
    return expr;
  };

  findFirstElementByDataId(ast, nodeId, (path) => {
    const el = path.node;
    el.children = el.children.map((child: any) => {
      if (!t.isJSXExpressionContainer(child) || !t.isExpression(child.expression)) return child;
      // Bare `{propName}` → clean JSXText. Anything else (e.g. the per-variant ternary) → inline the
      // identifier in place so the surrounding expression survives.
      if (t.isIdentifier(child.expression) && child.expression.name === propName) {
        return t.jsxText(def);
      }
      child.expression = inlineId(child.expression);
      return child;
    });
  });

  if (deleteProp) removePropFromFunction(ast, propName);

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:remove-text', { nodeId, propName, deleteProp });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:removeTextVariable-generate-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

// ─── Remove Variable ────────────────────────────────────────────────────────

/**
 * Is a component PROP still referenced anywhere in the component body? Used by the "remove at source"
 * cascade to detect the LAST binding: after `removeVariableInCode` unbinds a node (inlining the
 * conditional/identifier to a literal), the param has zero references → safe to drop it + strip every
 * instance project-wide. CONSERVATIVE: returns true (KEEP the prop) when the code can't be parsed or the
 * param isn't found, so we never strip a prop that might still be in use.
 */
export function isComponentPropUsed(code: string, propName: string): boolean {
  const ast = parseJSX(code);
  if (!ast) return true;
  let result = true;   // conservative default
  let found = false;
  traverse(ast, {
    Function(path: any) {
      if (found) return;
      const binding = path.scope.getOwnBinding(propName); // the prop's own param binding in THIS function
      if (binding) {
        found = true;
        result = binding.referencePaths.length > 0;
        path.stop();
      }
    },
  });
  return result;
}

/**
 * Inline a variable back to its default value.
 * Replaces the Identifier in the style with a StringLiteral of the default value.
 * Removes the prop from the function signature.
 */
export function removeVariableInCode(
  code: string,
  nodeId: string,
  styleProperty: string,
  propName: string,
  defaultValue: string,
  /**
   * When true (variable-modal "delete"), also drop the prop from the component signature —
   * a FULL delete of the variable. When false (the default — the ControlLabel/pill × "remove"),
   * only UNBIND this node (identifier → literal, or overlay `var(--X)` → literal) and KEEP the
   * prop declared so the variable stays available in the modal / for re-binding on other nodes.
   */
  deleteProp = false,
): string {
  // ── SPLIT per-variant variable (the conditional-element form `setInlineVariableForVariant` emits) ──
  // `{variant === V && <A data-id=X …whole-value var…>}` + `{variant !== V && <B data-id=X-base …>}`.
  // The inverse is a MERGE: drop the variant-only gate, unwrap the base gate, and rename `X-base` → `X` so
  // the plain variant-object element returns. Detected by the presence of a `<nodeId>-base` sibling.
  {
    const baseId = `${nodeId}-base`;
    const astS = parseJSX(code);
    if (astS) {
      let hasBase = false;
      findFirstElementByDataId(astS, baseId, () => { hasBase = true; });
      if (hasBase) {
        let variantGate: any = null;
        let baseGate: any = null;
        let baseEl: t.JSXElement | null = null;
        traverse(astS, {
          JSXExpressionContainer(p: any) {
            const ex = p.node.expression;
            if (!t.isLogicalExpression(ex) || ex.operator !== '&&' || !t.isJSXElement(ex.right)) return;
            const idAttr = findAttribute(ex.right.openingElement, 'data-id');
            const id = idAttr?.value && t.isStringLiteral(idAttr.value) ? idAttr.value.value : null;
            if (id === nodeId) variantGate = p;
            else if (id === baseId) { baseGate = p; baseEl = ex.right; }
          },
        });
        if (variantGate && baseGate && baseEl) {
          const baseClone = t.cloneNode(baseEl, true, true) as t.JSXElement;
          const idAttr = findAttribute(baseClone.openingElement, 'data-id') as t.JSXAttribute | null;
          if (idAttr) idAttr.value = t.stringLiteral(nodeId);
          // Drop the AnimatePresence `key` — the merged element is no longer inside an AnimatePresence.
          baseClone.openingElement.attributes = baseClone.openingElement.attributes.filter((a) =>
            !(t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'key'));
          if (deleteProp) {
            traverse(astS, {
              ObjectPattern(pp: { node: t.ObjectPattern; stop: () => void }) {
                const i = pp.node.properties.findIndex((pr) => t.isObjectProperty(pr) && t.isIdentifier(pr.key) && pr.key.name === propName);
                if (i >= 0) { pp.node.properties.splice(i, 1); pp.stop(); }
              },
            });
          }
          // The gates are wrapped in `<AnimatePresence>` — remove/replace the WHOLE wrapper, not just the
          // inner `{cond && el}` container (which would leave a dangling AnimatePresence). Falls back to the
          // bare container for a legacy un-wrapped split.
          const unit = (g: any) => {
            const par = g.parentPath;
            return (par?.node && t.isJSXElement(par.node) && t.isJSXIdentifier(par.node.openingElement?.name)
              && par.node.openingElement.name.name === 'AnimatePresence') ? par : g;
          };
          unit(variantGate).remove();
          unit(baseGate).replaceWith(baseClone);
          try {
            const out = generate(astS, { retainLines: true }, code);
            trace.action('variable-ops:remove-variant-split', { nodeId, styleProperty, propName, deleteProp });
            return out.code;
          } catch (err) {
            trace.error('variable-ops:remove-variant-split-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
            // fall through to the generic paths below
          }
        }
      }
    }
  }
  // ── Overlay-border binding (`'--X': prop` + `::after { border: var(--X) }`) ──
  // The variable isn't an inline `border` value, so the inline swap below would miss it and the
  // overlay would keep resolving `var(--X)`. Unbind by restoring a LITERAL border in the `::after`
  // (the variable's current value) and dropping the `'--X': prop` inline. Detect from the code.
  const nidEsc = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cssVar = `--${propName}`;
  const afterRe = new RegExp(`\\[data-(?:node-)?id="${nidEsc}"\\]::after\\s*\\{([^}]*)\\}`, 's');
  const afterM = afterRe.exec(code);
  const isOverlayBinding = styleProperty === 'border'
    && !!afterM
    && new RegExp(`border\\s*:\\s*var\\(\\s*${cssVar}\\b`).test(afterM[1]);

  if (isOverlayBinding) {
    const ast0 = parseJSX(code);
    if (!ast0) return code;
    // Is the inline `--X` a per-variant CONDITIONAL binding (`… ? X : 'none'`) rather than a plain
    // `'--X': X`? If so the variable lived only on one variant — removing it should leave NO border
    // (strip the `::after` border), not paint a literal on every variant.
    let isConditionalInline = false;
    findFirstElementByDataId(ast0, nodeId, (path) => {
      const styleAttr = findAttribute(path.node.openingElement, 'style') as t.JSXAttribute | null;
      if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
      for (const p of styleAttr.value.expression.properties) {
        if (!t.isObjectProperty(p)) continue;
        const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
        if (k === cssVar && t.isConditionalExpression(p.value)) isConditionalInline = true;
      }
    });
    // Literal to restore: for a plain binding, the prop's current value; for a variant-only
    // conditional binding, NONE (strip — the border belonged to that one variant).
    const literal = isConditionalInline ? ''
      : (defaultValue && defaultValue.trim()) ? defaultValue : (readPropDefaultString(ast0, propName) ?? '');
    // Rewrite the `::after` body: `border: var(--X)` → `border: <literal>` (or drop the line if empty).
    const newBody = afterM![1]
      .replace(new RegExp(`([ \\t]*)border\\s*:\\s*var\\(\\s*${cssVar}\\s*\\)\\s*;?`),
        literal ? `$1border: ${literal};` : '')
      .replace(/\n[ \t]*\n/g, '\n')
      .trimEnd();
    const result = updateBorderOverlayStyle(code, nodeId, newBody);
    // Drop the `'--X': prop` inline binding (keep everything else).
    const ast = parseJSX(result);
    if (!ast) return code;
    findFirstElementByDataId(ast, nodeId, (path) => {
      const styleAttr = findAttribute(path.node.openingElement, 'style') as t.JSXAttribute | null;
      if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || !t.isObjectExpression(styleAttr.value.expression)) return;
      const expr = styleAttr.value.expression;
      expr.properties = expr.properties.filter((p) => {
        if (!t.isObjectProperty(p)) return true;
        const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
        return k !== cssVar;
      });
    });
    if (deleteProp) removePropFromFunction(ast, propName);
    try {
      const out = generate(ast, { retainLines: true }, result);
      trace.action('variable-ops:remove-border-overlay', { nodeId, propName, deleteProp, literal });
      return out.code;
    } catch (err) {
      trace.error('variable-ops:removeVariable-overlay-generate-failed', { nodeId, propName, error: err instanceof Error ? err.message : String(err) });
      return code;
    }
  }

  const ast = parseJSX(code);
  if (!ast) return code;

  // Replace Identifier with StringLiteral
  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer') return;

    const expr = styleAttr.value.expression;
    if (!t.isObjectExpression(expr)) return;

    for (const prop of expr.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
      if (key !== styleProperty) continue;

      if (t.isIdentifier(prop.value) && prop.value.name === propName) {
        // Inject the variable's OWN default (from its function-signature param,
        // e.g. `joijoijoi = '#1E3C1B'`) when the caller didn't pass an explicit
        // value — so removing a Fill/colour/etc. variable KEEPS the default value
        // in the property instead of clearing it and losing the styling. The ×
        // pill passes '' deliberately; the default lives in the signature. Same
        // fallback the overlay-border + boolean-visibility paths already use.
        const resolved = (defaultValue && defaultValue.trim())
          ? defaultValue
          : (readPropDefaultString(ast, propName) ?? '');
        prop.value = t.stringLiteral(resolved);
      } else if (
        t.isConditionalExpression(prop.value)
        && t.isIdentifier(prop.value.test) && prop.value.test.name === propName
      ) {
        // Boolean visibility binding (`cssProp: hideVar ? 'none' : ''`): inline to the branch the
        // variable's BOOLEAN default selects (true → consequent, false → alternate) so unbinding
        // preserves the on-canvas state. The default lives in the signature, not the passed value.
        const consequent = t.isStringLiteral(prop.value.consequent) ? prop.value.consequent.value : '';
        const alternate = t.isStringLiteral(prop.value.alternate) ? prop.value.alternate.value : '';
        const boolDef = readPropDefaultBool(ast, propName);
        prop.value = t.stringLiteral(boolDef === true ? consequent : alternate);
      } else if (t.isConditionalExpression(prop.value)) {
        // Per-variant conditional binding (`cssProp: variant === 'v' ? prop : 'else'`): drop the
        // branch whose consequent is this prop, collapsing to the remaining ternary / else literal.
        prop.value = removeIdentBranchFromTernary(prop.value, propName);
      }
      break;
    }
  });

  // Remove prop from the function signature ONLY on a full delete (variable modal). The × in the
  // controls panel keeps the prop so the variable persists for re-binding.
  if (deleteProp) removePropFromFunction(ast, propName);

  try {
    const output = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:remove', { nodeId, styleProperty, propName, deleteProp });
    return output.code;
  } catch (err) {
    trace.error('variable-ops:removeVariable-generate-failed', { nodeId, styleProperty, propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Update a component prop's DEFAULT value in the function signature (`{ X = 'old' }` → `{ X = 'new' }`).
 * Used by the Variables modal to edit a variable's default. Sets a string-literal default; if the prop
 * has no default yet (`{ X }`), adds one. No-op if the prop isn't in the signature.
 */
export function setComponentPropDefaultInCode(
  code: string,
  propName: string,
  newDefault: string,
  /** Literal kind for the default — number/boolean write `5`/`true` (unquoted) for typed variables;
   *  `identifier` writes a BARE identifier (`= Pointer`) for a component-valued default, e.g. a hoisted
   *  component cursor whose value is an imported component, not a string. */
  literalKind: 'string' | 'number' | 'boolean' | 'identifier' = 'string',
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  let changed = false;
  const makeLit = (): t.Expression => {
    if (literalKind === 'number') { const n = parseFloat(newDefault); return t.numericLiteral(Number.isFinite(n) ? n : 0); }
    if (literalKind === 'boolean') return t.booleanLiteral(newDefault === 'true');
    if (literalKind === 'identifier') return t.identifier(newDefault);
    return t.stringLiteral(newDefault);
  };
  const apply = (params: t.Node[]) => {
    const first = params[0];
    if (!first) return;
    const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
    if (!t.isObjectPattern(target)) return;
    for (const prop of target.properties) {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key) || prop.key.name !== propName) continue;
      const lit = makeLit();
      if (t.isAssignmentPattern(prop.value)) {
        prop.value.right = lit;             // replace existing default
      } else if (t.isIdentifier(prop.value)) {
        prop.value = t.assignmentPattern(prop.value, lit);  // add a default to a bare prop
      } else continue;
      changed = true;
    }
  };
  traverse(ast, {
    // Module-scope only — don't touch nested arrows' params (see addPropToFunction).
    FunctionDeclaration(path: any) { if (!path.getFunctionParent()) apply(path.node.params); },
    ArrowFunctionExpression(path: any) { if (!path.getFunctionParent()) apply(path.node.params); },
  });
  if (!changed) return code;
  try {
    const out = generate(ast, { retainLines: true }, code);
    trace.action('variable-ops:set-prop-default', { propName, newDefault });
    return out.code;
  } catch (err) {
    trace.error('variable-ops:setComponentPropDefault-failed', { propName, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Read a destructured prop's string default from the component signature (`{ X = 'val' }`). */
function readPropDefaultString(ast: t.File, propName: string): string | null {
  let out: string | null = null;
  const read = (params: t.Node[]) => {
    const first = params[0];
    if (!first) return;
    const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
    if (!t.isObjectPattern(target)) return;
    for (const prop of target.properties) {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key) || prop.key.name !== propName) continue;
      if (t.isAssignmentPattern(prop.value) && t.isStringLiteral(prop.value.right)) out = prop.value.right.value;
    }
  };
  traverse(ast, {
    // Module-scope only — read the COMPONENT's default, never a nested arrow's.
    FunctionDeclaration(path: any) { if (!path.getFunctionParent()) read(path.node.params); },
    ArrowFunctionExpression(path: any) { if (!path.getFunctionParent()) read(path.node.params); },
  });
  return out;
}

/** Read a prop's BooleanLiteral signature default (`hidden = true`). null when absent / not a boolean. */
function readPropDefaultBool(ast: t.File, propName: string): boolean | null {
  let out: boolean | null = null;
  const read = (params: t.Node[]) => {
    const first = params[0];
    if (!first) return;
    const target = t.isAssignmentPattern(first) && t.isObjectPattern(first.left) ? first.left : first;
    if (!t.isObjectPattern(target)) return;
    for (const prop of target.properties) {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key) || prop.key.name !== propName) continue;
      if (t.isAssignmentPattern(prop.value) && t.isBooleanLiteral(prop.value.right)) out = prop.value.right.value;
    }
  };
  traverse(ast, {
    // Module-scope only — read the COMPONENT's default, never a nested arrow's.
    FunctionDeclaration(path: any) { if (!path.getFunctionParent()) read(path.node.params); },
    ArrowFunctionExpression(path: any) { if (!path.getFunctionParent()) read(path.node.params); },
  });
  return out;
}

/**
 * Drop the branch whose CONSEQUENT is `propName` from a per-variant style ternary chain
 * (`variant === 'a' ? propName : variant === 'b' ? '…' : 'else'`), collapsing to the remaining
 * ternary or — if only the final else literal is left — that literal. Used to unbind a variant-only
 * variable: removing its branch returns the property to what the OTHER variants had.
 */
function removeIdentBranchFromTernary(node: t.ConditionalExpression, propName: string): t.Expression {
  const branches: { test: t.Expression; cons: t.Expression }[] = [];
  let cursor: t.Expression = node;
  while (t.isConditionalExpression(cursor)) {
    branches.push({ test: cursor.test, cons: cursor.consequent });
    cursor = cursor.alternate;
  }
  const fallback = cursor; // the final else
  const kept = branches.filter((b) => !(t.isIdentifier(b.cons) && b.cons.name === propName));
  // Rebuild right-to-left: else, then each kept branch wraps it.
  let result: t.Expression = fallback;
  for (let i = kept.length - 1; i >= 0; i--) {
    result = t.conditionalExpression(kept[i].test, kept[i].cons, result);
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Add a destructured prop with default to the component's function params.
 * Handles: function Foo({ existing = 'val' }: Props) → function Foo({ existing = 'val', newProp = 'default' }: Props)
 */
/** Literal kind for a prop's signature default. 'number'/'boolean' write an unquoted NumericLiteral /
 *  BooleanLiteral (`opacity = 0.5`, `hidden = true`) — the reference's model where a Number variable is a real
 *  number (React re-appends px to px-properties, leaves unitless props raw, so one number var works on
 *  any single-number control). 'string' is the default for everything else (color/border/text/…). */
export type PropLiteralKind = 'string' | 'number' | 'boolean';

/** Build the signature-default literal for `value` in the given kind. Number strips units via parseFloat
 *  ('16px' → 16); non-finite → 0. Boolean is the literal `value === 'true'`. */
function literalForKind(kind: PropLiteralKind, value: string): t.Expression {
  if (kind === 'number') {
    const n = parseFloat(value);
    return t.numericLiteral(Number.isFinite(n) ? n : 0);
  }
  if (kind === 'boolean') return t.booleanLiteral(value === 'true');
  return t.stringLiteral(value);
}

function addPropToFunction(ast: t.File, propName: string, defaultValue: string, literalKind: PropLiteralKind = 'string'): boolean {
  let added = false;

  traverse(ast, {
    FunctionDeclaration(path: any) {
      // ONLY module-scope functions are component candidates. Skipping nested
      // functions is critical: a helper like `useMediaQuery` contains
      // `useState(() => …)` — that EMPTY-param initializer arrow would otherwise
      // be the first "addable" target (addPropToParams turns `()` into
      // `({ prop = … })`), corrupting the helper instead of the component and
      // crashing the render with `Cannot destructure undefined`.
      if (path.getFunctionParent()) return;
      if (addPropToParams(path.node.params, propName, defaultValue, literalKind)) {
        added = true;
        path.stop();
      }
    },
    ArrowFunctionExpression(path: any) {
      if (path.getFunctionParent()) return; // skip nested arrows (see above)
      if (addPropToParams(path.node.params, propName, defaultValue, literalKind)) {
        added = true;
        path.stop();
      }
    },
  });

  return added;
}

function addPropToParams(params: t.Node[], propName: string, defaultValue: string, literalKind: PropLiteralKind = 'string'): boolean {
  const newProp = () => t.objectProperty(
    t.identifier(propName),
    t.assignmentPattern(t.identifier(propName), literalForKind(literalKind, defaultValue)),
    false, true,
  );

  if (params.length === 0) {
    // No params — create destructured pattern: ({ propName = 'default' })
    params.push(t.objectPattern([newProp()]));
    return true;
  }

  const firstParam = params[0];
  // The first param may be an ObjectPattern wrapped in an AssignmentPattern
  // (when `props = {}` style is used). Strip the wrapper so we operate on
  // the actual ObjectPattern.
  const target = t.isAssignmentPattern(firstParam) && t.isObjectPattern(firstParam.left)
    ? firstParam.left
    : firstParam;
  if (!t.isObjectPattern(target)) return false;

  // If the prop is already in the destructured params, REPLACE its default
  // value instead of pushing a duplicate (which would crash at parse time
  // with "Identifier has already been declared"). This is what makes the
  // "create variable a second time with a new default" path work — e.g.
  // applying a color preset to an already-existing variable should update
  // the function-signature default to `var(--color-brand)`.
  for (let i = 0; i < target.properties.length; i++) {
    const p = target.properties[i];
    if (!t.isObjectProperty(p)) continue;
    const k = t.isIdentifier(p.key) ? p.key.name : null;
    if (k !== propName) continue;
    target.properties[i] = newProp();
    return true;
  }

  // Not already present — insert BEFORE any `...rest` element (a rest element MUST
  // be last; a plain push emitted invalid `{ …, ...rest, newProp }` →
  // "Rest element must be last element", crashing every later parse/mutation).
  insertParamPropBeforeRest(target, newProp());
  return true;
}

/**
 * CMS COMPONENT — hoist a collection item's field bindings into component props.
 *
 * When a node that lived inside a `.map()` collection list is made into a component,
 * every `itemVar.field` reference in the extracted subtree must become a PROP of the new
 * component so the master is data-agnostic:
 *   - text  `{item.name}`            → `{name}`
 *   - style `url(${item.photo})`     → `url(${photo})`   (and `item.color` → `color`)
 *   - attr  `prop={item.x}`          → `prop={x}`
 * Each unique field is added to the component's destructured params (via addPropToFunction,
 * inserted before `...rest`). `item.a.b` hoists only the top-level `a` (the inner member's
 * object is `item`; the outer's object isn't) → `a.b`. The map `key={idx}` is stripped off
 * the component root (idx is undefined inside the component) and returned so the caller can
 * re-add it to the INSTANCE, which lives in the map scope.
 *
 * Returns the rewritten code, the unique field names (first-seen order) so the caller can
 * emit matching `field={itemVar.field}` instance attributes, and the relocated key expr.
 * This is the reference "create component from the first collection item" wiring.
 */
export function hoistMapBindingsToProps(
  componentCode: string,
  itemVar: string,
  /** field → seeded prop default (from the collection's FIRST item). For an image
   *  field this is the full `url(...)` wrapper. Missing fields default to ''. */
  fieldDefaults: Record<string, string> = {},
  /** Field ids that are IMAGE-typed — their `backgroundImage: \`url(${item.x})\`` value
   *  is collapsed to a bare `x` identifier so the parser sees a real Fill image var. */
  imageFields: Set<string> = new Set(),
  /** The map callback's INDEX param (`.map((item, index) =>`), when present. A bare
   *  value reference to it in the subtree (the stagger pattern `delay: index * 0.1`)
   *  is hoisted as a NUMBER prop (default 0) — the identifier only exists inside the
   *  page's map callback, so leaving it made the master crash with "undefined index".
   *  The caller passes `index={index}` on the instance (in map scope) so the
   *  per-row stagger keeps working. Returned as `indexField` when hoisted. */
  indexVar?: string | null,
): { code: string; fields: string[]; keyExpr: string | null; wholeValueImageFields: string[]; indexField: string | null } {
  trace.fn('variable-ops:hoistMapBindings', { itemVar, indexVar });
  const ast = parseJSX(componentCode);
  if (!ast) return { code: componentCode, fields: [], keyExpr: null, wholeValueImageFields: [], indexField: null };
  const fields: string[] = [];
  let keyExpr: string | null = null;
  // Hoist `item.field` AND `item?.field` (optional chaining — e.g. a data-cms-nav
  // href's `item?._slug`) into a bare `field` identifier (a prop reference).
  const hoistMember = (path: any) => {
    const n = path.node;
    if (n.computed) return;                                   // skip item['x'] — keep dynamic access intact
    if (!t.isIdentifier(n.object) || n.object.name !== itemVar) return;
    if (!t.isIdentifier(n.property)) return;
    const field = n.property.name;
    if (!fields.includes(field)) fields.push(field);
    path.replaceWith(t.identifier(field));
    path.skip();
  };
  traverse(ast, {
    MemberExpression: hoistMember,
    OptionalMemberExpression: hoistMember,
    JSXAttribute(path: any) {
      // Relocate the map `key={idx}` (root-only — the first one seen depth-first).
      if (path.node.name.name !== 'key' || keyExpr) return;
      const v = path.node.value;
      if (v && t.isJSXExpressionContainer(v)) keyExpr = generate(v.expression as any).code;
      path.remove();
    },
  });
  // IMAGE fields → the WHOLE-VALUE convention. A wrapped master binding
  // (`backgroundImage: \`url(${image})\``) renders, but the editor reads it as
  // a URL-TEXT variable — the instance panel shows a plain text field instead
  // of the image picker (live find 2026-07-08), and the oracle's
  // IMAGE_VARIABLE_URL_WRAPPED bounces the same shape when MCP-authored. The
  // control-friendly shape is a BARE binding (`backgroundImage: image`) with
  // the `url(...)` wrapper carried IN THE VALUE: the prop default becomes
  // `url(<first-item-url>)` and the caller must bind instances WRAPPED —
  // `image={\`url(${item.image})\`}` (see `wholeValueImageFields` in the
  // return). Only converted when EVERY use of the field is exactly a
  // `\`url(${field})\`` template — a field that also feeds an `<img src>`
  // needs the plain URL and keeps the wrapped-template form (text control,
  // but nothing breaks).
  const wholeValueImageFields: string[] = [];
  const isUrlWrapOf = (tpl: t.TemplateLiteral, field: string): boolean =>
    tpl.expressions.length === 1
    && t.isIdentifier(tpl.expressions[0] as t.Node, { name: field })
    && tpl.quasis.length === 2
    && tpl.quasis[0].value.raw === 'url('
    && tpl.quasis[1].value.raw === ')';
  for (const field of imageFields) {
    if (!fields.includes(field)) continue;
    const tplPaths: any[] = [];
    let otherUses = 0;
    traverse(ast, {
      Identifier(p: any) {
        if (p.node.name !== field) return;
        // Skip the (not-yet-added) param destructure and object KEYS.
        if (p.parentPath?.isObjectProperty() && p.parent.key === p.node && !p.parent.computed) return;
        if (p.findParent((pp: any) => pp.isObjectPattern())) return;
        const tpl = p.findParent((pp: any) => pp.isTemplateLiteral());
        if (tpl && isUrlWrapOf(tpl.node, field)) {
          if (!tplPaths.some((x) => x.node === tpl.node)) tplPaths.push(tpl);
          return;
        }
        otherUses++;
      },
    });
    if (tplPaths.length > 0 && otherUses === 0) {
      for (const tp of tplPaths) tp.replaceWith(t.identifier(field));
      wholeValueImageFields.push(field);
    }
  }
  // Stagger-index hoist: a bare VALUE reference to the map's index param (skip
  // object keys, `foo.index` member props, and param patterns). Only when the
  // name isn't already a hoisted item FIELD (a field literally named like the
  // index var would double-add the param + emit conflicting instance attrs).
  let indexField: string | null = null;
  if (indexVar && indexVar !== itemVar && !fields.includes(indexVar)) {
    traverse(ast, {
      Identifier(p: any) {
        if (indexField || p.node.name !== indexVar) return;
        if (p.parentPath?.isObjectProperty() && p.parent.key === p.node && !p.parent.computed) return;
        if (p.parentPath?.isMemberExpression() && p.parent.property === p.node && !p.parent.computed) return;
        if (p.findParent((pp: any) => pp.isObjectPattern())) return;
        indexField = indexVar;
      },
    });
  }
  if (!fields.length && !keyExpr && !indexField) return { code: componentCode, fields: [], keyExpr, wholeValueImageFields: [], indexField: null };
  for (const field of fields) {
    const plainDefault = fieldDefaults[field] ?? '';
    const def = wholeValueImageFields.includes(field) && plainDefault !== '' && !/^url\(/i.test(plainDefault)
      ? `url(${plainDefault})`
      : plainDefault;
    addPropToFunction(ast, field, def, 'string');
  }
  if (indexField) addPropToFunction(ast, indexField, '0', 'number');
  const code = generate(ast, { retainLines: false }, componentCode).code;
  trace.action('variable-ops:hoistMapBindings:done', { itemVar, fields, hasKey: !!keyExpr, wholeValueImageFields, indexField });
  return { code, fields, keyExpr, wholeValueImageFields, indexField };
}

function removePropFromFunction(ast: t.File, propName: string): void {
  traverse(ast, {
    // Module-scope only — same reason as addPropToFunction. Without the guard
    // this would strip the prop out of a nested arrow's params that addProp had
    // wrongly injected, leaving `({}) =>` (the empty-destructure crash).
    FunctionDeclaration(path: any) {
      if (path.getFunctionParent()) return;
      removePropFromParams(path.node.params, propName);
    },
    ArrowFunctionExpression(path: any) {
      if (path.getFunctionParent()) return;
      removePropFromParams(path.node.params, propName);
    },
  });
}

function removePropFromParams(params: t.Node[], propName: string): void {
  if (params.length === 0) return;
  const firstParam = params[0];
  if (!t.isObjectPattern(firstParam)) return;

  firstParam.properties = firstParam.properties.filter(prop => {
    if (!t.isObjectProperty(prop)) return true;
    if (t.isIdentifier(prop.key) && prop.key.name === propName) return false;
    return true;
  });
}

// ─── Value Source Detection ─────────────────────────────────────────────────

export type ValueSource = 'inline' | 'prop' | 'token';

/**
 * Detect the source of a style value from the parsed styles map.
 *
 * The parser used to encode prop references as `var:propName` strings inside
 * `node.styles[prop]`. That made the canvas un-renderable on a master file
 * (invalid CSS), so the parser now resolves to the actual default and tracks
 * the binding in a separate `node.styleVariables` field. This function
 * accepts either form:
 *
 *   - call as `detectValueSource(styleValue)` for legacy callers / instance
 *     styles where the parser hasn't post-processed `var:` away;
 *   - call as `detectValueSource(styleValue, variableName)` to surface a
 *     `node.styleVariables[prop]` binding when the value itself is already
 *     resolved.
 */
export function detectValueSource(
  styleValue: string,
  styleVariableRef?: string | undefined,
): { source: ValueSource; ref: string | null } {
  // Prefer the explicit binding ref (resolved-value path) over the legacy
  // `var:` prefix detection — both should agree, but the explicit ref is
  // what's set on the master file after the parser's resolve pass.
  if (styleVariableRef) {
    return { source: 'prop', ref: styleVariableRef };
  }
  if (styleValue.startsWith('var:')) {
    return { source: 'prop', ref: styleValue.slice(4) };
  }
  if (styleValue.startsWith('token:')) {
    return { source: 'token', ref: styleValue.slice(6) };
  }
  return { source: 'inline', ref: null };
}
