// generator-crud.ts — Node-level CRUD writes against the JSX source.
// Add / update / move / reorder / remove nodes (page nodes + canvas-fragment nodes).
// Fast string path with AST fallback. Style updates inside add/update flow through
// updateNodeInCode; structural deletes call clearContainerStylesForNode (in
// generator-styles.ts) — both modules import each other inside function bodies
// (resolved by the JS module loader at call time, not at import time).

import * as t from '@babel/types';
import { sanitizeDataName } from '@/shared/id-utils';
import { parseJSX, findFirstElementByDataId, findAttribute, traverse } from '../parsing/ast-utils';
import { toKebab, htmlToJSX, splitStyleProps } from '@/shared/css-utils';
import { cssTransformToMotionProps } from '@/shared/motion-transform';
import { trace } from '@/shared/debug-trace';
import { generate, findTagClose, findJSXDataIdIndex, quoteStyleValue, serializeJSXAttr, findMatchingCloseTagIndex, findStyleObjectEnd } from './generator-utils';
import { moveNodeIntoParentFast } from './move-fast';
import { clearContainerStylesForNode, removeHoverStyleInCode, removeBorderOverlayStyle } from './generator-styles';
import { clearNodeScrollFx, ensureTransformTemplateInCode } from './generator-motion';
import { stripScrollTextHooks } from './text-anim-gen';
import { parseVariantConfig } from '../variants/variant-config';
import { removeSlotHoistedCanvasNodeInCode } from './slot-ops';
import { extractComponentPropDefaults } from '../parsing/parser';

/**
 * Update style properties of a node in JSX code.
 * Uses FAST STRING REPLACEMENT by default — no AST parse/generate.
 * Only falls back to full AST when the fast path can't handle it (e.g., adding a new property).
 */
/** True when the JSX element for `nodeId` is a `<motion.*>` tag. Only motion
 *  elements (inside design components) should carry motion transform props;
 *  plain page elements keep CSS `transform`. */
function isMotionElementAt(code: string, nodeId: string): boolean {
  const idx = findJSXDataIdIndex(code, nodeId);
  if (idx === -1) return false;
  let tagStart = idx;
  while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
  return /^<motion\./.test(code.slice(tagStart, tagStart + 12));
}

export function updateNodeInCode(
  code: string,
  nodeId: string,
  styleChanges: Record<string, string>
): string {
  trace.fn('generator.updateNodeInCode', { nodeId, styles: styleChanges });

  // On a motion.* element (component), a CSS `transform: rotate()/scale()` in
  // the INLINE style fights motion's layout FLIP projection (both write the
  // same CSS property) → the "animates then reverts" bug. Convert it to the
  // independent motion props motion composes with the projection; the canvas
  // Renderer folds them back to CSS. Also clear the old `transform` so the two
  // forms never coexist. Plain page elements are left as CSS transform.
  if (typeof styleChanges.transform === 'string' && isMotionElementAt(code, nodeId)) {
    const tval = styleChanges.transform;
    if (tval === '' || tval === 'none') {
      // Reset → drop the transform AND any rotation motion prop.
      //
      // `rotate: ''` is seeded BEFORE the spread so an EXPLICIT `rotate` in the
      // caller's map WINS. Spreading it after clobbered a batch that legitimately
      // clears the CSS string while SETTING a motion prop in the same write —
      // `{ transform: '', rotate: '90' }` silently became `rotate: ''` and the
      // whole edit vanished. That's exactly the shape "Paste Style" sends for a
      // transform onto a design-component element (clear the stale CSS form,
      // write the motion form), so pasting a rotation did nothing at all
      // (user report 2026-07-25). Same fix in `updateVariantStyleInCode`.
      const { transform: _t, ...restR } = styleChanges;
      styleChanges = { rotate: '', ...restR, transform: '' };
    } else if (/\b(rotate|scale|skew)/i.test(tval)) {
      // Only animation transforms (rotate/scale/skew) are converted — a pure
      // `translate(...)` (position / centering pin) stays as CSS so the
      // pin/position-utils flows that read it keep working.
      const motion = cssTransformToMotionProps(tval);
      if (Object.keys(motion).length > 0) {
        const { transform: _t, ...restR } = styleChanges;
        styleChanges = { ...restR, ...motion, transform: '' };
      }
    }
  }
  // A `transform` style write must also refresh the element's paired
  // `transformTemplate` (the composer that keeps a static translate alive
  // while motion animates y — see generator-motion-props). The template is
  // DERIVED from `style.transform`; letting a pin/drag write move one without
  // the other re-opens the off-centre-on-live drift silently.
  const touchesTransform = typeof styleChanges.transform === 'string';
  const syncTemplate = (out: string): string =>
    touchesTransform ? ensureTransformTemplateInCode(out, nodeId) : out;

  const fast = updateNodeInCodeFast(code, nodeId, styleChanges);
  if (fast !== null) {
    trace.action('generator:fast-path-success', { nodeId });
    return syncTemplate(fast);
  }
  trace.action('generator:fast-path-fallback-to-ast', { nodeId });
  const astResult = updateNodeInCodeAST(code, nodeId, styleChanges);
  const changed = astResult !== code;
  trace.action('generator:ast-path-result', { nodeId, changed, codeLen: astResult.length });
  return syncTemplate(astResult);
}

/** Index of a TOP-LEVEL `key:` property in a style-object body, or -1.
 *  A plain indexOf matches inside a LONGER property name — `order:` sits at
 *  the tail of `border:` — which made every `order` write on an element with
 *  a bare `border` prop clobber the border's VALUE and never write the order
 *  at all (the Figma-import section-reorder bug: Footer kept snapping back
 *  to the top). A real key starts the body or follows `{`, `,` or
 *  whitespace. */
function findStyleKeyIndex(content: string, key: string): number {
  const needle = `${key}:`;
  let from = 0;
  for (;;) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) return -1;
    const prev = idx === 0 ? '' : content[idx - 1];
    if (prev === '' || prev === ',' || prev === '{' || /\s/.test(prev)) return idx;
    from = idx + 1;
  }
}

/**
 * FAST PATH: Replace style values directly in the string.
 * Works when all properties already exist on the node.
 * Returns null if it can't handle the update (caller should use AST path).
 */
function updateNodeInCodeFast(
  code: string,
  nodeId: string,
  styleChanges: Record<string, string>
): string | null {
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) return null;

  // Find style={{ within THIS element's opening tag (before the closing > or />)
  // Without this check, we might find the NEXT element's style={{
  const tagCloseIdx = (() => {
    let d = 0, i = idIndex;
    while (i < code.length) {
      if (code[i] === '{') d++;
      else if (code[i] === '}') d--;
      else if (code[i] === '>' && d === 0) return i;
      i++;
    }
    return code.length;
  })();
  const styleStart = code.indexOf('style={{', idIndex);
  if (styleStart === -1 || styleStart > tagCloseIdx) return null;

  const objStart = styleStart + 'style={{'.length;
  // Index of the first closing `}` (of `}}`) — styleContent covers everything
  // inside the braces and code.substring(objEnd) starts cleanly with `}}`.
  // Unbalanced → last char, matching the historic walk's `pos - 1` fallout.
  const objEndCandidate = findStyleObjectEnd(code, objStart);
  const objEnd = objEndCandidate === -1 ? code.length - 1 : objEndCandidate;

  const styleContent = code.substring(objStart, objEnd);

  let newStyleContent = styleContent;
  for (const [key, value] of Object.entries(styleChanges)) {
    if (value === '') {
      // Empty string = remove property — find it with paren-aware matching
      const rkIdx = findStyleKeyIndex(newStyleContent, key);
      if (rkIdx !== -1) {
        // Walk backwards to include leading comma/whitespace/newlines
        let rStart = rkIdx;
        while (rStart > 0 && (newStyleContent[rStart - 1] === ' ' || newStyleContent[rStart - 1] === ',' || newStyleContent[rStart - 1] === '\n' || newStyleContent[rStart - 1] === '\r' || newStyleContent[rStart - 1] === '\t')) rStart--;
        // Walk forward past the value (quote-aware, paren-aware)
        const rc = newStyleContent.indexOf(':', rkIdx + key.length);
        let rv = rc + 1;
        while (rv < newStyleContent.length && newStyleContent[rv] === ' ') rv++;
        const rq = newStyleContent[rv];
        if (rq === "'" || rq === '"') {
          let ri = rv + 1, rpd = 0;
          while (ri < newStyleContent.length) {
            if (newStyleContent[ri] === '(') rpd++;
            else if (newStyleContent[ri] === ')') rpd--;
            else if (newStyleContent[ri] === rq && rpd === 0) break;
            ri++;
          }
          let rEnd = ri + 1;
          // Consume trailing comma/whitespace/newlines
          while (rEnd < newStyleContent.length && (newStyleContent[rEnd] === ',' || newStyleContent[rEnd] === ' ' || newStyleContent[rEnd] === '\n' || newStyleContent[rEnd] === '\r' || newStyleContent[rEnd] === '\t')) rEnd++;
          const hadLeading = rStart < rkIdx;
          const hadTrailing = rEnd > ri + 1 && newStyleContent.substring(ri + 1, rEnd).includes(',');
          newStyleContent = newStyleContent.substring(0, hadLeading ? rStart + 1 : rStart) +
            (hadLeading && hadTrailing ? ' ' : '') +
            newStyleContent.substring(rEnd);
        } else {
          // Unquoted value — fall back to AST for safety
          return null;
        }
      }
      continue;
    }
    // Match the property value — handle nested parens (gradients, url(), rgba())
    // by counting parenthesis depth instead of simple [^']* which breaks on url('...')
    const keyIdx = findStyleKeyIndex(newStyleContent, key);
    if (keyIdx === -1) {
      // Property doesn't exist yet — APPEND it in place instead of bailing to a
      // full-file AST parse+regenerate. Adding a prop (flex / order / position
      // when a canvas node drops into a layout parent) is one of the commonest
      // drag commits, and on a big page (hundreds of KB) that AST round-trip is
      // the DOMINANT mouseup cost (the "1s to insert on a big page" report).
      // Insert LAST — but BEFORE any `...spread` (component-instance
      // convention keeps the spread final so instance overrides win). The old
      // insert-FIRST placement put a NEW longhand BEFORE an existing
      // SHORTHAND (`paddingLeft: '87px'` prepended above `padding: '12px'`),
      // and React style objects resolve later-keys-win — the committed value
      // was dead on render. Visible as "padding handles revert on mouseup"
      // inside component masters, whose extracted nodes commonly carry
      // `padding` shorthands (user report 2026-07-29). Appending after every
      // existing key means the new value always wins — the intent of any
      // style write. A `(` in the value → not a plain scalar
      // (gradient/url/calc) → let the AST handle it.
      if (value.includes('(')) return null;
      const useDoubleNew = value.includes("'");
      const quotedNew = useDoubleNew ? `"${value}"` : `'${value}'`;
      const spreadIdx = newStyleContent.search(/\.\.\.[A-Za-z_$]/);
      if (spreadIdx !== -1) {
        newStyleContent = newStyleContent.slice(0, spreadIdx)
          + `${key}: ${quotedNew}, `
          + newStyleContent.slice(spreadIdx);
      } else {
        let end = newStyleContent.length;
        while (end > 0 && /\s/.test(newStyleContent[end - 1])) end--;
        const body = newStyleContent.slice(0, end);
        const tail = newStyleContent.slice(end);
        newStyleContent = body.trim().length === 0
          ? `${key}: ${quotedNew}`
          : body + (body.endsWith(',') ? ' ' : ', ') + `${key}: ${quotedNew}` + tail;
      }
      continue;
    }

    const colonIdx = newStyleContent.indexOf(':', keyIdx + key.length);
    let valStart = colonIdx + 1;
    while (valStart < newStyleContent.length && newStyleContent[valStart] === ' ') valStart++;

    const quoteChar = newStyleContent[valStart];
    if (quoteChar !== "'" && quoteChar !== '"') return null; // Not a quoted value — fall to AST

    // Find matching close quote respecting parenthesis depth
    let i = valStart + 1;
    let parenDepth = 0;
    while (i < newStyleContent.length) {
      const ch = newStyleContent[i];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === quoteChar && parenDepth === 0) break;
      i++;
    }

    // Use double quotes if value contains single quotes (url('...'), font families)
    const useDouble = value.includes("'");
    const quoted = useDouble ? `"${value}"` : `'${value}'`;
    // Splice by INDEX — a `.replace(fullMatch, …)` re-searched from the start
    // and could land on an earlier identical substring (e.g. `order: '7'`
    // inside `border: '7'`), patching the wrong property.
    newStyleContent = newStyleContent.substring(0, valStart) + quoted + newStyleContent.substring(i + 1);
  }

  return code.substring(0, objStart) + newStyleContent + code.substring(objEnd);
}

/**
 * SLOW PATH: Full AST parse/traverse/generate.
 */
function updateNodeInCodeAST(
  code: string,
  nodeId: string,
  styleChanges: Record<string, string>
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  findFirstElementByDataId(ast, nodeId, (path) => {
    const opening = path.node.openingElement;
    let styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;

    // If no style attribute exists, create one: style={{}}
    if (!styleAttr) {
      const emptyObj = t.objectExpression([]);
      const jsxExpr = t.jsxExpressionContainer(emptyObj);
      styleAttr = t.jsxAttribute(t.jsxIdentifier('style'), jsxExpr);
      opening.attributes.push(styleAttr);
    }

    if (styleAttr.value?.type !== 'JSXExpressionContainer') return;
    const expr = styleAttr.value.expression;
    if (expr.type !== 'ObjectExpression') return;

    for (const [key, value] of Object.entries(styleChanges)) {
      const existingIdx = expr.properties.findIndex(
        (p): p is t.ObjectProperty =>
          p.type === 'ObjectProperty' &&
          ((p.key.type === 'Identifier' && p.key.name === key) ||
           (p.key.type === 'StringLiteral' && p.key.value === key))
      );

      if (value === '') {
        // Empty string = remove property from JSX
        if (existingIdx !== -1) expr.properties.splice(existingIdx, 1);
      } else if (existingIdx !== -1) {
        (expr.properties[existingIdx] as t.ObjectProperty).value = t.stringLiteral(value);
      } else {
        // Insert BEFORE any SpreadElement (e.g. ...style) so spreads stay last
        const spreadIdx = expr.properties.findIndex(p => p.type === 'SpreadElement');
        const newProp = t.objectProperty(t.identifier(key), t.stringLiteral(value));
        if (spreadIdx !== -1) {
          expr.properties.splice(spreadIdx, 0, newProp);
        } else {
          expr.properties.push(newProp);
        }
      }
    }

    // Ensure SpreadElements stay at the end (in case properties were reordered)
    const spreads = expr.properties.filter(p => p.type === 'SpreadElement');
    const nonSpreads = expr.properties.filter(p => p.type !== 'SpreadElement');
    expr.properties = [...nonSpreads, ...spreads];

    path.stop();
  });

  try {
    return generate(ast, { retainLines: true, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:updateNodeInCodeAST-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Update the text content of a JSX element by data-id.
 */
export function updateNodeTextInCode(code: string, nodeId: string, newText: string): string {
  trace.fn('generator.updateNodeTextInCode', { nodeId, text: newText });
  const ast = parseJSX(code);
  if (!ast) return code;

  findFirstElementByDataId(ast, nodeId, (path) => {
    const newChildren: (t.JSXText | t.JSXElement | t.JSXExpressionContainer)[] = [];
    let replacedText = false;

    // Write the text INLINE (not `\n      ${newText}\n    `). Newline-wrapping
    // for pretty-printing puts a user's trailing/leading space at a LINE EDGE,
    // where JSX whitespace rules strip it — so `Time - ` lost its trailing
    // space on every commit (it was present here, gone after the round-trip).
    // Inline preserves same-line edge spaces; the parser reads them back via
    // cleanJsxText (React/Babel's real JSX-whitespace algorithm).
    for (const child of path.node.children) {
      if (child.type === 'JSXText' && child.value.trim()) {
        if (!replacedText) {
          newChildren.push(t.jsxText(newText));
          replacedText = true;
        }
      } else {
        newChildren.push(child as any);
      }
    }

    if (!replacedText) {
      newChildren.push(t.jsxText(newText));
    }

    path.node.children = newChildren;
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:updateNodeTextInCode-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Set the text of one element FOR A SPECIFIC VARIANT.
 *
 * Per-variant text is stored as a ternary text child:
 *   {variant === 'annual' ? '15' : '19'}
 * Non-primary variants are explicit `=== ` branches; the PRIMARY variant is
 * the trailing fallback — so the parser never sees an explicit `=== 'default'`
 * test that would collide with its own `default` fallback key. When every
 * variant ends up with the same text the ternary collapses back to plain text.
 *
 * Mirrors how `conditionalStyles` encodes per-variant style; the read side is
 * `node.conditionalText` (parser) + the Renderer's per-variant resolution.
 */
export function updateVariantTextInCode(
  code: string,
  nodeId: string,
  variantName: string,
  newText: string,
): string {
  trace.fn('generator.updateVariantTextInCode', { nodeId, variantName, text: newText });
  const variants = parseVariantConfig(code);
  const primaryName = (variants.find(v => v.isPrimary) ?? variants[0])?.name ?? 'default';

  const ast = parseJSX(code);
  if (!ast) return code;

  findFirstElementByDataId(ast, nodeId, (path) => {
    // GENERAL read: each variant branch (and the fallback) may be a string LITERAL or an IDENTIFIER (a
    // text variable bound on that variant). Preserving variable branches is critical — editing the
    // PRIMARY text must NOT clobber a variant's variable binding, and we must NOT reference an undefined
    // `variant` identifier (connection-less components only define `initialVariant`).
    const literals: Record<string, string> = {};
    const vars: Record<string, string> = {};
    // The variant identifier to read/write. Connected components switch via a `variant` useState;
    // connection-less ones only have the `initialVariant` prop — using the wrong one crashes at runtime
    // ("undefined identifier: variant"). Capture it from the existing ternary; else detect the useState.
    let variantId: string | null = null;

    const significant = path.node.children.filter(
      (c: t.Node) =>
        c.type === 'JSXElement' ||
        c.type === 'JSXExpressionContainer' ||
        (c.type === 'JSXText' && (c as t.JSXText).value.trim() !== ''),
    );
    const only = significant.length === 1 ? significant[0] : null;

    if (only && only.type === 'JSXExpressionContainer' && (only as t.JSXExpressionContainer).expression.type === 'ConditionalExpression') {
      let cursor: any = (only as t.JSXExpressionContainer).expression;
      while (
        cursor?.type === 'ConditionalExpression' &&
        cursor.test?.type === 'BinaryExpression' && cursor.test.operator === '===' &&
        cursor.test.left?.type === 'Identifier' &&
        (cursor.test.left.name === 'initialVariant' || cursor.test.left.name === 'variant') &&
        cursor.test.right?.type === 'StringLiteral'
      ) {
        variantId = cursor.test.left.name; // reuse the component's existing identifier
        const k = cursor.test.right.value;
        // 'desktop' is the PRIMARY's viewport id, never a real variant name — an `=== 'desktop'` branch is
        // dead code (initialVariant is 'default'/'variant-1'/… , never 'desktop'). Drop it so the bad
        // state self-heals on the next edit.
        if (k === 'desktop') { cursor = cursor.alternate; continue; }
        if (cursor.consequent?.type === 'StringLiteral') literals[k] = cursor.consequent.value;
        else if (cursor.consequent?.type === 'Identifier') vars[k] = cursor.consequent.name;
        cursor = cursor.alternate;
      }
      if (cursor?.type === 'StringLiteral') literals['default'] = cursor.value;
      else if (cursor?.type === 'Identifier') vars['default'] = cursor.name;
    } else {
      let txt = '';
      for (const c of path.node.children) {
        if (c.type === 'JSXText') txt += (c as t.JSXText).value.trim();
        else if (c.type === 'JSXExpressionContainer' && (c as t.JSXExpressionContainer).expression.type === 'StringLiteral') {
          txt += ((c as t.JSXExpressionContainer).expression as t.StringLiteral).value;
        }
      }
      literals['default'] = txt;
    }

    // Apply the edit to the TARGET variant only (primary = the `default` fallback). Callers may pass the
    // primary as its variant name OR as the 'desktop' viewport id — both map to the fallback, so editing
    // the primary text updates the trailing literal instead of minting a dead `=== 'desktop'` branch.
    const key = (variantName === primaryName || variantName === 'desktop') ? 'default' : variantName;
    literals[key] = newText;
    delete vars[key];

    // Drop literal branches equal to the fallback literal (collapse) — but only when that variant has no
    // variable binding, and never drop variable branches.
    const fallbackLiteral = vars['default'] !== undefined ? undefined : literals['default'];
    for (const k of Object.keys(literals)) {
      if (k !== 'default' && !vars[k] && fallbackLiteral !== undefined && literals[k] === fallbackLiteral) delete literals[k];
    }

    const keys = [...new Set([...Object.keys(literals), ...Object.keys(vars)])].filter(k => k !== 'default');
    if (keys.length === 0 && Object.keys(vars).length === 0) {
      // Pure literal, no branches → plain text.
      path.node.children = [t.jsxText(`\n      ${literals['default'] ?? ''}\n    `)];
    } else {
      // Use the captured identifier; for from-plain-text edits detect a `variant` useState, else the
      // always-defined `initialVariant` prop (so we never emit an undefined `variant` reference).
      const idName = variantId ?? (/\bconst\s*\[\s*variant\b/.test(code) ? 'variant' : 'initialVariant');
      let expr: t.Expression = vars['default']
        ? t.identifier(vars['default'])
        : t.stringLiteral(literals['default'] ?? '');
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        const branch = vars[k] ? t.identifier(vars[k]) : t.stringLiteral(literals[k] ?? '');
        expr = t.conditionalExpression(
          t.binaryExpression('===', t.identifier(idName), t.stringLiteral(k)),
          branch, expr,
        );
      }
      path.node.children = [t.jsxExpressionContainer(expr)];
    }
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:updateVariantTextInCode-generate-failed', {
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return code;
  }
}

/**
 * Set / clear a per-VARIANT CMS-FIELD binding on an element's TEXT inside a design
 * component master's `.map()`. The text becomes a ternary on the variant discriminator
 * whose branches are CMS field member-expressions (`item.field`) or literals
 * (unbind→default), e.g.:
 *   {initialVariant === 'variant-1' ? item.title : item.role}   // rebind variant-1 to a different field
 *   {initialVariant === 'variant-1' ? '' : item.role}           // unbind variant-1 → literal default
 * `clear` removes the variant's branch (revert to the base binding). The PRIMARY
 * variant is the trailing fallback (no `=== 'desktop'` branch). Mirrors
 * updateVariantTextInCode but for member-expression (CMS) branches. `itemVar` is the
 * `.map()` iterator used to rebuild `item.field` member expressions.
 */
export function setVariantTextBindingInCode(
  code: string,
  nodeId: string,
  variantName: string,
  override: { kind: 'field'; field: string } | { kind: 'literal'; value: string } | { kind: 'clear' },
  itemVar: string,
): string {
  trace.fn('generator.setVariantTextBindingInCode', { nodeId, variantName, override });
  const variants = parseVariantConfig(code);
  const primaryName = (variants.find(v => v.isPrimary) ?? variants[0])?.name ?? 'default';
  const ast = parseJSX(code);
  if (!ast) return code;

  type Branch = { kind: 'field'; field: string } | { kind: 'literal'; value: string } | { kind: 'var'; name: string };
  const readExpr = (n: any): Branch | null => {
    if (!n) return null;
    if (n.type === 'StringLiteral') return { kind: 'literal', value: n.value };
    if (n.type === 'Identifier') return { kind: 'var', name: n.name };
    if (n.type === 'MemberExpression' && n.property?.type === 'Identifier' && !n.computed) return { kind: 'field', field: n.property.name };
    return null;
  };

  findFirstElementByDataId(ast, nodeId, (path) => {
    const branches: Record<string, Branch> = {}; // variant name → branch
    let base: Branch | null = null;
    let variantId: string | null = null;

    const significant = path.node.children.filter((c: t.Node) =>
      c.type === 'JSXElement' || c.type === 'JSXExpressionContainer' ||
      (c.type === 'JSXText' && (c as t.JSXText).value.trim() !== ''));
    const only = significant.length === 1 ? significant[0] : null;

    if (only && only.type === 'JSXExpressionContainer') {
      const expr = (only as t.JSXExpressionContainer).expression;
      if (expr.type === 'ConditionalExpression') {
        let cursor: any = expr;
        while (cursor?.type === 'ConditionalExpression'
          && cursor.test?.type === 'BinaryExpression' && cursor.test.operator === '==='
          && cursor.test.left?.type === 'Identifier'
          && (cursor.test.left.name === 'initialVariant' || cursor.test.left.name === 'variant')
          && cursor.test.right?.type === 'StringLiteral') {
          variantId = cursor.test.left.name;
          const k = cursor.test.right.value;
          const b = readExpr(cursor.consequent);
          if (b && k !== 'desktop') branches[k] = b;
          cursor = cursor.alternate;
        }
        base = readExpr(cursor);
      } else {
        base = readExpr(expr); // plain {item.field} | {prop} | {'literal'}
      }
    } else {
      let txt = '';
      for (const c of path.node.children) if (c.type === 'JSXText') txt += (c as t.JSXText).value.trim();
      base = { kind: 'literal', value: txt };
    }

    const isPrimary = variantName === primaryName || variantName === 'desktop';
    if (override.kind === 'clear') {
      if (!isPrimary) delete branches[variantName];
    } else {
      const b: Branch = override.kind === 'field' ? { kind: 'field', field: override.field } : { kind: 'literal', value: override.value };
      if (isPrimary) base = b; else branches[variantName] = b;
    }

    const idName = variantId ?? (/\bconst\s*\[\s*variant\b/.test(code) ? 'variant' : 'initialVariant');
    const toExpr = (b: Branch): t.Expression =>
      b.kind === 'field' ? t.memberExpression(t.identifier(itemVar), t.identifier(b.field))
        : b.kind === 'var' ? t.identifier(b.name)
          : t.stringLiteral(b.value);

    const keys = Object.keys(branches);
    if (keys.length === 0) {
      const b = base ?? { kind: 'literal', value: '' };
      path.node.children = b.kind === 'literal'
        ? [t.jsxText(b.value)]
        : [t.jsxExpressionContainer(toExpr(b))];
    } else {
      let expr: t.Expression = base ? toExpr(base) : t.stringLiteral('');
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        expr = t.conditionalExpression(
          t.binaryExpression('===', t.identifier(idName), t.stringLiteral(k)),
          toExpr(branches[k]), expr,
        );
      }
      path.node.children = [t.jsxExpressionContainer(expr)];
    }
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:setVariantTextBindingInCode-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Set / clear a per-VARIANT CMS-FIELD binding on a STYLE PROPERTY (the style analogue of
 * setVariantTextBindingInCode). The `styleProp` value becomes a ternary on the variant
 * discriminator whose branches are CMS field expressions or literals (unbind→default):
 *   backgroundImage: initialVariant === 'variant-1' ? `url(${item.photo})` : `url(${item.image})`  // rebind
 *   backgroundImage: initialVariant === 'variant-1' ? 'none' : `url(${item.image})`                 // unbind
 * An IMAGE field-ref is wrapped in `url(${item.field})` (a template literal); a non-image
 * field-ref is a bare `item.field` member expression; `clear` removes the variant's branch.
 */
export function setVariantStyleBindingInCode(
  code: string,
  nodeId: string,
  styleProp: string,
  variantName: string,
  override: { kind: 'field'; field: string; isImage?: boolean } | { kind: 'literal'; value: string } | { kind: 'clear' },
  itemVar: string,
): string {
  trace.fn('generator.setVariantStyleBindingInCode', { nodeId, styleProp, variantName, override });
  const variants = parseVariantConfig(code);
  const primaryName = (variants.find(v => v.isPrimary) ?? variants[0])?.name ?? 'default';
  const ast = parseJSX(code);
  if (!ast) return code;

  type Branch = { kind: 'field'; field: string; isImage: boolean } | { kind: 'literal'; value: string };
  const readVal = (n: any): Branch | null => {
    if (!n) return null;
    if (n.type === 'StringLiteral') return { kind: 'literal', value: n.value };
    if (n.type === 'MemberExpression' && !n.computed && n.property?.type === 'Identifier') return { kind: 'field', field: n.property.name, isImage: false };
    if (n.type === 'TemplateLiteral' && n.expressions.length === 1) {
      const e = n.expressions[0];
      if (e.type === 'MemberExpression' && !e.computed && e.property?.type === 'Identifier') return { kind: 'field', field: e.property.name, isImage: true };
    }
    return null;
  };
  const toExpr = (b: Branch): t.Expression => {
    if (b.kind === 'literal') return t.stringLiteral(b.value);
    const member = t.memberExpression(t.identifier(itemVar), t.identifier(b.field));
    return b.isImage
      ? t.templateLiteral([t.templateElement({ raw: 'url(', cooked: 'url(' }), t.templateElement({ raw: ')', cooked: ')' }, true)], [member])
      : member;
  };

  findFirstElementByDataId(ast, nodeId, (path) => {
    const styleAttr = (path.node.openingElement.attributes as any[]).find(a => a.type === 'JSXAttribute' && a.name?.name === 'style');
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || styleAttr.value.expression.type !== 'ObjectExpression') return;
    const obj = styleAttr.value.expression;
    const prop = (obj.properties as any[]).find(p => p.type === 'ObjectProperty' && !p.computed && (p.key.name === styleProp || p.key.value === styleProp));

    const branches: Record<string, Branch> = {};
    let base: Branch | null = null;
    let variantId: string | null = null;
    if (prop) {
      let cursor: any = prop.value;
      while (cursor?.type === 'ConditionalExpression'
        && cursor.test?.type === 'BinaryExpression' && cursor.test.operator === '==='
        && cursor.test.left?.type === 'Identifier'
        && (cursor.test.left.name === 'initialVariant' || cursor.test.left.name === 'variant')
        && cursor.test.right?.type === 'StringLiteral') {
        variantId = cursor.test.left.name;
        const b = readVal(cursor.consequent);
        if (b && cursor.test.right.value !== 'desktop') branches[cursor.test.right.value] = b;
        cursor = cursor.alternate;
      }
      base = readVal(cursor);
    }

    const isPrimary = variantName === primaryName || variantName === 'desktop';
    if (override.kind === 'clear') {
      if (!isPrimary) delete branches[variantName];
    } else {
      const b: Branch = override.kind === 'field'
        ? { kind: 'field', field: override.field, isImage: !!override.isImage }
        : { kind: 'literal', value: override.value };
      if (isPrimary) base = b; else branches[variantName] = b;
    }

    const idName = variantId ?? (/\bconst\s*\[\s*variant\b/.test(code) ? 'variant' : 'initialVariant');
    const keys = Object.keys(branches);
    let valueExpr: t.Expression = base ? toExpr(base) : t.stringLiteral('');
    for (let i = keys.length - 1; i >= 0; i--) {
      valueExpr = t.conditionalExpression(t.binaryExpression('===', t.identifier(idName), t.stringLiteral(keys[i])), toExpr(branches[keys[i]]), valueExpr);
    }
    if (prop) prop.value = valueExpr;
    else (obj.properties as any[]).push(t.objectProperty(t.identifier(styleProp), valueExpr));
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:setVariantStyleBindingInCode-failed', { nodeId, styleProp, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * DETACH a text-content variable FOR ONE VARIANT — the per-variant analogue of detaching a style
 * variable. The element's text is `{varName}` (the variable binding). Removing it on a non-primary
 * variant must NOT drop the prop or wipe the binding everywhere; instead it pins THIS variant to a
 * literal while keeping `{varName}` as the fallback for every other variant:
 *
 *   <p>{content}</p>
 *     → detach 'variant-2' to "Hi"  →  <p>{initialVariant === 'variant-2' ? 'Hi' : content}</p>
 *
 * Uses `initialVariant` (the component's prop param, always defined) so it's also valid at runtime for
 * connection-less variant components. Re-running for another variant extends the ternary chain; the
 * `varName` identifier always stays the final fallback. Pure string → string.
 */
export function detachTextVariableForVariantInCode(
  code: string,
  nodeId: string,
  variantName: string,
  varName: string,
  literal: string,
): string {
  trace.fn('generator.detachTextVariableForVariant', { nodeId, variantName, varName });
  const ast = parseJSX(code);
  if (!ast) return code;

  findFirstElementByDataId(ast, nodeId, (path) => {
    // GENERAL read: each branch/fallback may be a string literal OR an identifier (variable), so detach
    // works whether the variable was the fallback (`… : content`) or in a branch (`'v1' ? content : …`).
    const literals: Record<string, string> = {};
    const vars: Record<string, string> = {};
    let variantId: string | null = null;
    const significant = path.node.children.filter(
      (c: t.Node) => c.type === 'JSXElement' || c.type === 'JSXExpressionContainer'
        || (c.type === 'JSXText' && (c as t.JSXText).value.trim() !== ''),
    );
    const only = significant.length === 1 ? significant[0] : null;
    if (only && only.type === 'JSXExpressionContainer' && (only as t.JSXExpressionContainer).expression.type === 'ConditionalExpression') {
      let cursor: any = (only as t.JSXExpressionContainer).expression;
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
    } else if (only && only.type === 'JSXExpressionContainer' && (only as t.JSXExpressionContainer).expression.type === 'Identifier') {
      vars['default'] = ((only as t.JSXExpressionContainer).expression as t.Identifier).name;
    }

    // Detach THIS variant → it becomes a literal; drop any variable binding on it.
    literals[variantName] = literal;
    delete vars[variantName];

    // If no variable bindings remain, the whole thing is literals — collapse to plain text when they're
    // all equal, else an all-literal ternary.
    const keys = [...new Set([...Object.keys(literals), ...Object.keys(vars)])].filter(k => k !== 'default');
    const noVarsLeft = Object.keys(vars).length === 0;
    if (noVarsLeft && keys.every(k => literals[k] === (literals['default'] ?? literal))) {
      path.node.children = [t.jsxText(`\n      ${literals['default'] ?? literal}\n    `)];
      path.stop();
      return;
    }
    const idName = variantId ?? (/\bconst\s*\[\s*variant\b/.test(code) ? 'variant' : 'initialVariant');
    let expr: t.Expression = vars['default']
      ? t.identifier(vars['default'])
      : t.stringLiteral(literals['default'] ?? literal);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i];
      const branch = vars[k] ? t.identifier(vars[k]) : t.stringLiteral(literals[k] ?? '');
      expr = t.conditionalExpression(
        t.binaryExpression('===', t.identifier(idName), t.stringLiteral(k)),
        branch, expr,
      );
    }
    path.node.children = [t.jsxExpressionContainer(expr)];
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:detachTextVariableForVariant-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Convert TipTap's serialized HTML (typically `<p>line1</p><p>line2</p>` or
 * `line1<br/>line2`) to a single multi-line plain string. `<br>` and `</p><p>`
 * boundaries mark line breaks; every other tag is dropped. The browser HTML
 * parser decodes entities (`&lt;` → `<` etc.) so pasted source code
 * round-trips faithfully. Shared by the literal-text branch below and the
 * mutation-queue's text-anim edit path (a text-effect node's re-split needs
 * PLAIN text — feeding it paragraph HTML baked the tags in as characters).
 */
export function htmlToPlainTextLines(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '');
  return tmp.textContent ?? '';
}

/**
 * FULL-replace a node's children with plain multi-line text — line breaks
 * become real `<br />` elements, text is written inline (same edge-space
 * contract as updateNodeTextInCode) with JSX-unsafe characters entity-escaped.
 *
 * Unlike updateNodeTextInCode — which PRESERVES element children so a mixed-
 * content node keeps its inline marks — this wipes everything. It exists for
 * the text-anim edit path: after the spans collapse, the incoming text is the
 * node's complete content, and the preserve-elements merge was exactly what
 * kept stale `<p>` children alive (old text re-baked in front of every edit).
 */
export function replaceNodeTextContent(code: string, nodeId: string, text: string): string {
  trace.fn('generator.replaceNodeTextContent', { nodeId, text: text.slice(0, 60) });
  const ast = parseJSX(code);
  if (!ast) return code;

  const escapeJsxText = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

  findFirstElementByDataId(ast, nodeId, (path) => {
    const kids: (t.JSXText | t.JSXElement)[] = [];
    text.split('\n').forEach((line, i) => {
      if (i > 0) kids.push(t.jsxElement(t.jsxOpeningElement(t.jsxIdentifier('br'), [], true), null, [], true));
      if (line) kids.push(t.jsxText(escapeJsxText(line)));
    });
    path.node.children = kids;
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:replaceNodeTextContent-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Update node children from TipTap HTML output.
 * Converts HTML inline styles to JSX and replaces the node's children in the code.
 */
export function updateNodeChildrenFromHTML(code: string, nodeId: string, html: string): string {
  trace.fn('generator.updateNodeChildrenFromHTML', { nodeId });

  const ast = parseJSX(code);
  if (!ast) return code;

  // Decide whether the edit should land as literal-text or as JSX.
  // Two reasons to use literal-text:
  //   1. The existing children are already in literal-text shape
  //      (a single JSXExpressionContainer wrapping a StringLiteral —
  //      our text-paste output). Edits MUST stay in that form so
  //      `textIsLiteral` survives across rounds.
  //   2. The decoded text the user wants to write contains JSX-
  //      unsafe characters (`{` / `}` — `<` is HTML-escaped by
  //      TipTap, so it shows up as `&lt;` here, but `{` is not).
  //      Without literal-text wrapping, `{className}` would become
  //      a JSX expression referencing an undefined identifier.
  //      This branch heals legacy nodes that were created BEFORE
  //      the text-paste fix landed.
  let isLiteralTextNode = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    const significant = path.node.children.filter((c: t.Node) =>
      c.type === 'JSXElement' || c.type === 'JSXExpressionContainer',
    );
    if (
      significant.length === 1 &&
      significant[0].type === 'JSXExpressionContainer' &&
      (significant[0] as t.JSXExpressionContainer).expression.type === 'StringLiteral'
    ) {
      isLiteralTextNode = true;
    }
  });

  // Quick char-level peek at the post-strip content to catch
  // case (2) above. Cheap regex — no DOM parse needed yet.
  const decodedHasUnsafeChars = /\{|\}/.test(
    html.replace(/<[^>]+>/g, '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'),
  );

  if (isLiteralTextNode || decodedHasUnsafeChars) {
    const plain = htmlToPlainTextLines(html);

    // Replace the element's children with a fresh
    // JSXExpressionContainer wrapping a StringLiteral. Babel's
    // generator emits the literal back as `{"..."}` source, which
    // re-parses to the same shape — preserving `textIsLiteral`
    // across this edit cycle.
    findFirstElementByDataId(ast, nodeId, (path) => {
      path.node.children = [
        t.jsxText('\n      '),
        t.jsxExpressionContainer(t.stringLiteral(plain)),
        t.jsxText('\n    '),
      ];
      path.stop();
    });

    try {
      return generate(ast, { retainLines: false, concise: false }, code).code;
    } catch (err) {
      trace.error('generator:updateNodeChildrenFromHTML-literal-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
      return code;
    }
  }

  // PLAIN TEXT (no tags), safe, non-literal → FULL-replace the children with a
  // single inline JSXText. TipTap collapses a uniform single-`<span>` rich-text
  // node to bare text on commit, so this IS the whole new content. The old code
  // routed this to `updateNodeTextInCode`, which PRESERVES element children and
  // only swaps the first bare JSXText — a `<span>`-wrapped node has no bare text,
  // so it APPENDED the new text after the span → the text DOUBLED
  // (`<span>OLD</span>NEW`, live find 2026-07-24). Full-replace removes the span.
  // Inline JSXText (no `\n` wrapping) so trailing/leading edge spaces survive the
  // round-trip (same reason updateNodeTextInCode writes inline).
  if (!/<[^>]+>/.test(html)) {
    findFirstElementByDataId(ast, nodeId, (path) => {
      path.node.children = [t.jsxText(html)];
      path.stop();
    });
    try {
      return generate(ast, { retainLines: false, concise: false }, code).code;
    } catch (err) {
      trace.error('generator:updateNodeChildrenFromHTML-plain-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
      return code;
    }
  }

  const jsxStr = htmlToJSX(html);

  let newChildren: t.JSXElement['children'] = [];
  try {
    const wrapperAst = parseJSX(`<_>${jsxStr}</_>`);
    if (wrapperAst) {
      traverse(wrapperAst, {
        JSXElement(path) {
          if (path.parentPath?.parentPath?.isProgram()) {
            newChildren = [...path.node.children];
            path.stop();
          }
        }
      });
    }
  } catch (err) {
    trace.error('generator:text-update-ast-failed', err);
    return updateNodeTextInCode(code, nodeId, html.replace(/<[^>]+>/g, ''));
  }

  // SAFETY NET: never WIPE the text. `parseJSX` returns null (does NOT throw) on
  // a malformed conversion, so the try/catch above can't catch it and
  // `newChildren` stays empty — committing an empty element. If the HTML had real
  // text but produced no children, fall back to the plain (tag-stripped) text so
  // the content survives (worst case: a per-span style is dropped, never the text).
  if (newChildren.length === 0 && html.replace(/<[^>]+>/g, '').trim().length > 0) {
    trace.error('generator:text-update-empty-children-fallback', { nodeId, htmlLen: html.length });
    return updateNodeTextInCode(code, nodeId, html.replace(/<[^>]+>/g, ''));
  }

  findFirstElementByDataId(ast, nodeId, (path) => {
    path.node.children = [
      t.jsxText('\n      '),
      ...newChildren,
      t.jsxText('\n    '),
    ];
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:updateNodeChildrenFromHTML-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Text-MARK style properties that live as inline `<span style={{…}}>` overrides
 * inside a rich-text node's content (created when the user selects a text run in
 * edit mode and styles it). Changing one of these on the WHOLE node must FLATTEN
 * the per-span overrides so the node's new value wins (design-tool parity) — see
 * `stripInlineSpanStyleInCode`. Paragraph props (textAlign / lineHeight /
 * textTransform) are NOT here: they live on the `<p>` and can't be overridden
 * per-span, so they never need flattening.
 */
export const TEXT_MARK_SPAN_PROPS = new Set<string>([
  'color',
  'WebkitTextFillColor',
  'backgroundImage',   // gradient text fill
  'backgroundClip',
  'WebkitBackgroundClip',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'fontSize',
  'letterSpacing',
  'textDecoration',
  'textDecorationLine',
  'textDecorationColor',
]);

/** A `<span>` or `<motion.span>` element (the inline run shape rich text uses). */
function isInlineSpanElement(el: t.JSXElement): boolean {
  const name = el.openingElement?.name;
  if (!name) return false;
  if (name.type === 'JSXIdentifier') return name.name === 'span';
  if (name.type === 'JSXMemberExpression') {
    return (name.property as t.JSXIdentifier)?.name === 'span';
  }
  return false;
}

/** The kebab-cased key name of an inline-style ObjectProperty, or null. */
function styleObjectPropKey(p: t.Node): string | null {
  if (p.type !== 'ObjectProperty' || (p as t.ObjectProperty).computed) return null;
  const k = (p as t.ObjectProperty).key;
  if (k.type === 'Identifier') return toKebab(k.name);
  if (k.type === 'StringLiteral') return toKebab(k.value);
  return null;
}

/**
 * Core transform: strip one inline-style `property` from every `<span>` in a
 * JSX children array, returning a NEW children array.
 *   1. Remove the property from each span's `style={{…}}` object.
 *   2. If the style object becomes EMPTY, drop the `style` attribute.
 *   3. If the span then has NO attributes left, UNWRAP it (splice in its own
 *      — recursively stripped — children).
 *   4. Any other per-span formatting is left intact.
 * Recurses into non-span elements and surviving spans so nested runs are caught.
 */
function stripPropFromInlineChildren(
  children: t.JSXElement['children'],
  property: string,
): t.JSXElement['children'] {
  const target = toKebab(property);
  const out: t.JSXElement['children'] = [];

  for (const child of children) {
    if (child.type !== 'JSXElement') {
      out.push(child);
      continue;
    }

    if (!isInlineSpanElement(child)) {
      // Not a span — keep it but still strip nested spans inside it.
      child.children = stripPropFromInlineChildren(child.children, property);
      out.push(child);
      continue;
    }

    const opening = child.openingElement;
    const styleAttr = opening.attributes.find(
      (a): a is t.JSXAttribute => a.type === 'JSXAttribute' && a.name?.name === 'style',
    );
    if (
      styleAttr
      && styleAttr.value?.type === 'JSXExpressionContainer'
      && styleAttr.value.expression.type === 'ObjectExpression'
    ) {
      const obj = styleAttr.value.expression;
      obj.properties = obj.properties.filter(p => styleObjectPropKey(p) !== target);
      if (obj.properties.length === 0) {
        opening.attributes = opening.attributes.filter(a => a !== styleAttr);
      }
    }

    const inner = stripPropFromInlineChildren(child.children, property);
    if (opening.attributes.length === 0) {
      // Bare span → unwrap, keeping (stripped) text children.
      out.push(...inner);
    } else {
      child.children = inner;
      out.push(child);
    }
  }

  return out;
}

/**
 * PURE helper (testable in isolation): strip one inline-style `property` from
 * every `<span>` in a raw JSX content fragment — e.g. the literal
 * `<span style={{ color: 'rgb(48,57,94)' }}>Hi</span><span …>there</span>`
 * that a rich-text node stores as `node.textContent`. Returns the rewritten
 * fragment (empty spans unwrapped). Falls back to the input on parse failure.
 */
export function stripInlineSpanProperty(fragment: string, property: string): string {
  trace.fn('generator.stripInlineSpanProperty', { property, len: fragment.length });
  if (!fragment.trim()) return fragment;

  const ast = parseJSX(`<_>${fragment}</_>`);
  if (!ast) return fragment;

  let wrapper: t.JSXElement | null = null;
  traverse(ast, {
    JSXElement(path) {
      if (path.parentPath?.parentPath?.isProgram()) {
        path.node.children = stripPropFromInlineChildren(path.node.children, property);
        wrapper = path.node;
        path.stop();
      }
    },
  });
  if (!wrapper) return fragment;

  try {
    const rendered = generate(wrapper, { retainLines: false, concise: false }).code;
    return rendered.replace(/^<_>/, '').replace(/<\/_>$/, '').trim();
  } catch (err) {
    trace.error('generator:stripInlineSpanProperty-failed', { property, error: err instanceof Error ? err.message : String(err) });
    return fragment;
  }
}

/**
 * In-code path: flatten a per-span text mark on a rich-text node. Finds the node
 * by data-id and strips `property` from every inline `<span>` in its children
 * (unwrapping bare spans), so the node's own `style.{property}` is no longer
 * overridden run-by-run. Used by the `stripInlineSpanStyle` mutation when the
 * Color (etc.) control is changed on the whole node out of text-edit mode.
 */
export function stripInlineSpanStyleInCode(code: string, nodeId: string, property: string): string {
  trace.fn('generator.stripInlineSpanStyleInCode', { nodeId, property });
  const ast = parseJSX(code);
  if (!ast) return code;

  let changed = false;
  findFirstElementByDataId(ast, nodeId, (path) => {
    path.node.children = stripPropFromInlineChildren(path.node.children, property);
    changed = true;
    path.stop();
  });
  if (!changed) return code;

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:stripInlineSpanStyleInCode-failed', { nodeId, property, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Read the effective string value of `property` from one span's inline-style
 *  object, or null when the span doesn't set it. Kebab-aware key match —
 *  mirrors `stripPropFromInlineChildren` so reads and writes stay symmetric. */
function readSpanStylePropValue(el: t.JSXElement, property: string): string | null {
  const target = toKebab(property);
  const styleAttr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute => a.type === 'JSXAttribute' && a.name?.name === 'style',
  );
  if (
    !styleAttr
    || styleAttr.value?.type !== 'JSXExpressionContainer'
    || styleAttr.value.expression.type !== 'ObjectExpression'
  ) {
    return null;
  }
  for (const p of styleAttr.value.expression.properties) {
    if (styleObjectPropKey(p) !== target) continue;
    const v = (p as t.ObjectProperty).value;
    if (v.type === 'StringLiteral') return v.value;
    if (v.type === 'NumericLiteral') return String(v.value);
    try { return generate(v).code; } catch { return null; }
  }
  return null;
}

/**
 * READ side of the rich-text flatten (symmetric to `stripInlineSpanProperty`):
 * inspect a rich-text node's raw content fragment and report whether a TEXT-MARK
 * `property` is MIXED across the per-portion `<span>` runs, given the node's own
 * `baseValue` (its `<p>` style for that property — the value bare text inherits).
 *
 * Walks the inline children carrying the "value flowing in" (start = baseValue):
 *   - bare (non-whitespace) text / dynamic `{…}` → painted with the inherited value
 *   - a `<span>`/`<motion.span>` that SETS the prop → its value flows to its text
 *   - a span WITHOUT the prop (or a non-span inline el) → inherits the value in
 * The DISTINCT effective values actually painted on visible text are collected.
 * `baseValue` is only ever counted when some visible text genuinely inherits it
 * (bare text, or a span lacking the prop) — if every character sits inside a
 * prop-setting span, the base value is never painted, so it never inflates to a
 * phantom "Mixed".
 *
 *   distinct > 1 → { isMixed: true,  value: '',       mixedValues: [...] }
 *   distinct = 1 → { isMixed: false, value: theValue }
 *   distinct = 0 → { isMixed: false, value: baseValue }   (no visible text)
 */
export function getInlineSpanPropertyState(
  fragment: string,
  property: string,
  baseValue: string,
): { isMixed: boolean; value: string; mixedValues?: string[] } {
  trace.fn('generator.getInlineSpanPropertyState', { property, len: fragment.length });
  const fallback = { isMixed: false, value: baseValue };
  if (!fragment.trim()) return fallback;

  const ast = parseJSX(`<_>${fragment}</_>`);
  if (!ast) return fallback;

  let wrapper: t.JSXElement | null = null;
  traverse(ast, {
    JSXElement(path) {
      if (path.parentPath?.parentPath?.isProgram()) {
        wrapper = path.node;
        path.stop();
      }
    },
  });
  if (!wrapper) return fallback;

  const used: string[] = [];
  const seen = new Set<string>();
  const record = (v: string) => { if (!seen.has(v)) { seen.add(v); used.push(v); } };

  const walk = (children: t.JSXElement['children'], inherited: string): void => {
    for (const child of children) {
      if (child.type === 'JSXText') {
        if (child.value.trim()) record(inherited);
      } else if (child.type === 'JSXExpressionContainer') {
        // Dynamic visible content (e.g. a CMS `{item.title}`) is painted with
        // the inherited value — but an empty `{}`/comment paints nothing.
        if (child.expression.type !== 'JSXEmptyExpression') record(inherited);
      } else if (child.type === 'JSXElement') {
        if (isInlineSpanElement(child)) {
          const own = readSpanStylePropValue(child, property);
          walk(child.children, own !== null ? own : inherited);
        } else {
          // Non-span inline element (br / strong / em / …) — doesn't set the
          // mark, so its text inherits the value flowing in.
          walk(child.children, inherited);
        }
      }
    }
  };
  walk((wrapper as t.JSXElement).children, baseValue);

  if (used.length === 0) return fallback;
  if (used.length === 1) return { isMixed: false, value: used[0] };
  return { isMixed: true, value: '', mixedValues: used.filter(v => v !== '') };
}

/**
 * Reorder a node within its parent (or move to a new parent) at a specific index.
 */
export function reorderNodeInCode(
  code: string,
  nodeId: string,
  targetParentId: string,
  newIndex: number,
): string {
  trace.fn('generator.reorderNodeInCode', { nodeId, targetParentId, newIndex });
  const ast = parseJSX(code);
  if (!ast) return code;

  // Step 1: Find and remove the node
  let removedNode: t.JSXElement | null = null;

  findFirstElementByDataId(ast, nodeId, (path) => {
    removedNode = t.cloneNode(path.node, true);

    const parent = path.parentPath;
    if (parent?.isJSXElement()) {
      const idx = parent.node.children.indexOf(path.node);
      if (idx !== -1) {
        parent.node.children.splice(idx, 1);
        if (idx > 0 && idx <= parent.node.children.length) {
          const prev = parent.node.children[idx - 1];
          if (prev?.type === 'JSXText' && prev.value.trim() === '') {
            parent.node.children.splice(idx - 1, 1);
          }
        }
      }
    }
    path.stop();
  });

  if (!removedNode) return code;

  // Step 2: Insert at new index in target parent
  findFirstElementByDataId(ast, targetParentId, (path) => {
    // Reorderable CONTENT slots = data-id'd elements + expressions ({children}
    // occupies the placeholder slot on canvas). ANCHORS = elements WITHOUT a
    // data-id (e.g. a leading <style> media-query block injected into a layout
    // root) — chrome the node cache does NOT track, so the drag system's
    // newIndex does NOT count them. If an anchor consumed a slot index, every
    // target index would shift by one and the move would silently land one slot
    // short (a CTA dropped "after {children}" stays before it). So keep anchors
    // pinned at their content offset and index only over the content slots.
    const content: t.JSXElement['children'][number][] = [];
    const anchors: { node: t.JSXElement['children'][number]; after: number }[] = [];

    for (const child of path.node.children) {
      if (child.type === 'JSXElement') {
        const hasDataId = child.openingElement.attributes.some(
          (a: any) => t.isJSXAttribute(a) && a.name.name === 'data-id'
        );
        if (hasDataId) content.push(child);
        else anchors.push({ node: child, after: content.length });
      } else if (child.type === 'JSXExpressionContainer') {
        content.push(child);
      }
    }

    // Remove the moved node from the content slots (matched by data-id; it may
    // already be gone if Step 1 removed it from this same parent).
    const removeIdx = content.findIndex(n => t.isJSXElement(n) && n.openingElement.attributes.some(
      (a: any) => t.isJSXAttribute(a) && a.name.name === 'data-id' &&
        t.isStringLiteral(a.value) && a.value.value === nodeId
    ));
    if (removeIdx >= 0) content.splice(removeIdx, 1);

    // Insert at the target CONTENT slot index.
    let targetIdx = newIndex;
    if (targetIdx > content.length) targetIdx = content.length;
    content.splice(targetIdx, 0, removedNode!);

    // Rebuild: weave anchors back in at their original content offsets so a
    // leading <style> stays first and never absorbs a reorder slot.
    const ordered: t.JSXElement['children'][number][] = [];
    let ai = 0;
    for (let i = 0; i <= content.length; i++) {
      while (ai < anchors.length && anchors[ai].after === i) { ordered.push(anchors[ai].node); ai++; }
      if (i < content.length) ordered.push(content[i]);
    }
    while (ai < anchors.length) { ordered.push(anchors[ai].node); ai++; }

    const newChildren: t.JSXElement['children'] = [t.jsxText('\n    ')];
    for (const node of ordered) {
      newChildren.push(node as any);
      newChildren.push(t.jsxText('\n    '));
    }

    if (newChildren.length > 0) {
      const last = newChildren[newChildren.length - 1];
      if (last.type === 'JSXText') {
        (last as t.JSXText).value = '\n  ';
      }
    }

    path.node.children = newChildren;
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:reorderNodeInCode-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Move a node from its current parent to a new parent (or to root level).
 */
const VARIANT_COND_RE = /(?:^|[^A-Za-z0-9_$])(?:variant|initialVariant)\s*===/;

/** Replace every Identifier in `expr` that names a component prop (`propDefaults` key) with the prop's
 *  default literal. Recurses through ternaries / binary / logical / template expressions so a
 *  per-variant style ternary (`initialVariant === 'v' ? prop : 'none'`) ALSO becomes all-literals.
 *  Mutates and returns `expr`. Used on canvas exit — see `inlineComponentPropRefsInStyleObject`. */
function inlineComponentPropRefExpr(expr: t.Expression, propDefaults: Record<string, string>): t.Expression {
  if (t.isIdentifier(expr) && Object.prototype.hasOwnProperty.call(propDefaults, expr.name)) {
    return t.stringLiteral(propDefaults[expr.name]);
  }
  if (t.isConditionalExpression(expr)) {
    if (t.isExpression(expr.test)) expr.test = inlineComponentPropRefExpr(expr.test, propDefaults);
    expr.consequent = inlineComponentPropRefExpr(expr.consequent, propDefaults);
    expr.alternate = inlineComponentPropRefExpr(expr.alternate, propDefaults);
    return expr;
  }
  if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
    if (t.isExpression(expr.left)) expr.left = inlineComponentPropRefExpr(expr.left, propDefaults);
    if (t.isExpression(expr.right)) expr.right = inlineComponentPropRefExpr(expr.right, propDefaults);
    return expr;
  }
  if (t.isTemplateLiteral(expr)) {
    expr.expressions = expr.expressions.map(e => (t.isExpression(e) ? inlineComponentPropRefExpr(e, propDefaults) : e));
    return expr;
  }
  return expr;
}

/** Inline component-prop refs in one element's inline `style` object (in place). */
function inlineComponentPropRefsInStyleObject(el: t.JSXElement, propDefaults: Record<string, string>): void {
  const styleAttr = el.openingElement.attributes.find(
    (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
  ) as t.JSXAttribute | undefined;
  if (
    !styleAttr ||
    styleAttr.value?.type !== 'JSXExpressionContainer' ||
    styleAttr.value.expression.type !== 'ObjectExpression'
  ) return;
  for (const prop of styleAttr.value.expression.properties) {
    if (t.isObjectProperty(prop) && t.isExpression(prop.value)) {
      prop.value = inlineComponentPropRefExpr(prop.value, propDefaults);
    }
  }
}

/** Heal EVERY node in the module-scope `canvasNodes` fragment by inlining component-prop refs in their
 *  inline styles to literals. `canvasNodes` lives outside the component function, so a style value that
 *  references a component prop (`boxShadow: zegzegzegezg`, `'--border': zefzef`, or a per-variant
 *  ternary) is an undefined identifier there and the validator rejects ANY mutation that regenerates the
 *  file ("References undefined identifier: … — would crash at runtime"). moveNodeInCode inlines the node
 *  it moves, but a node dragged out earlier (before this guard, or in a separate gesture) leaves a stale
 *  broken ref that blocks all later edits — so this sweeps the whole fragment, not just one node.
 *  No-op when there's no `canvasNodes` fragment or nothing references a prop. */
export function inlineCanvasNodePropRefsInCode(code: string): string {
  if (!code.includes('canvasNodes')) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  const propDefaults = extractComponentPropDefaults(ast);
  if (Object.keys(propDefaults).length === 0) return code;
  let changed = false;
  traverse(ast, {
    VariableDeclarator(path) {
      if (path.node.id.type !== 'Identifier' || path.node.id.name !== 'canvasNodes' || !path.node.init) return;
      path.traverse({
        JSXElement(elPath) {
          const before = elPath.node.openingElement.attributes.length;
          inlineComponentPropRefsInStyleObject(elPath.node, propDefaults);
          if (before >= 0) changed = true; // walked at least one element
        },
      });
      path.stop();
    },
  });
  if (!changed) return code;
  try {
    const out = generate(ast).code;
    trace.action('generator:inline-canvas-node-prop-refs', { props: Object.keys(propDefaults).length });
    return out;
  } catch (err) {
    trace.error('generator:inline-canvas-node-prop-refs-failed', { error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Sweep EVERY node inside module-scope `canvasNodes` and strip the framer-motion VARIANT/ANIMATION props whose
 *  values reference the component's FUNCTION scope — `animate={['default', variant]}`, `initial={['default',
 *  initialVariant]}`, `transition={variant === 'v' ? transitionN : …}`, `variants={…}`, `exit`, `layout`,
 *  `data-replica-solo` — and UNWRAP per-variant conditional children `{variant === 'v' && <el>}` → `<el>`. A
 *  canvas node lives at MODULE scope (no `variant`/`initialVariant`/transition-param in scope), so any such ref
 *  is undefined at runtime ("References undefined identifier: variant/initialVariant/transitionN") and the
 *  pre-flush validator blocks the drag-OUT. A canvas node is a STATIC free element (never variant-animates), so
 *  dropping these is safe. Complements flattenVariantConditionalStylesInCode (STYLE conditionals) +
 *  inlineCanvasNodePropRefsInCode (prop refs in styles) — neither touches JSX attrs / child conditionals. */
const CANVAS_STRIP_ATTRS = new Set(['initial', 'animate', 'variants', 'exit', 'layout', 'data-replica-solo']);
export function stripCanvasNodeMotionRefsInCode(code: string): string {
  if (!code.includes('canvasNodes')) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  let changed = false;
  traverse(ast, {
    VariableDeclarator(path) {
      if (path.node.id.type !== 'Identifier' || path.node.id.name !== 'canvasNodes' || !path.node.init) return;
      path.traverse({
        // `{variant === 'v' && <el>}` → `<el>` — the gate identifier is out of scope at module level.
        JSXExpressionContainer(p) {
          const e = p.node.expression;
          if (
            e.type === 'LogicalExpression' && e.operator === '&&' &&
            e.left.type === 'BinaryExpression' && e.left.left.type === 'Identifier' &&
            (e.left.left.name === 'variant' || e.left.left.name === 'initialVariant') &&
            (e.right.type === 'JSXElement' || e.right.type === 'JSXFragment')
          ) {
            p.replaceWith(e.right);
            changed = true;
          }
        },
        JSXOpeningElement(p) {
          const before = p.node.attributes.length;
          p.node.attributes = p.node.attributes.filter((attr) => {
            if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') return true;
            const name = attr.name.name;
            if (CANVAS_STRIP_ATTRS.has(name)) return false; // variant machinery — never valid for a free element
            // `transition` FOLLOWS THE NODE: keep its OWN literal object (`transition={{ … }}` — defined at module
            // scope), but strip a variant/identifier/ternary ref (`variant === 'v' ? transitionN : …`, `transition5`)
            // which is undefined here. So a dragged-out node keeps the transition it actually had, not the
            // inherited MotionConfig.
            if (name === 'transition') {
              const v = attr.value;
              return v != null && v.type === 'JSXExpressionContainer' && v.expression.type === 'ObjectExpression';
            }
            return true;
          });
          if (p.node.attributes.length !== before) changed = true;
        },
      });
      path.stop();
    },
  });
  if (!changed) return code;
  try {
    const out = generate(ast).code;
    trace.action('generator:strip-canvas-node-motion-refs', {});
    return out;
  } catch (err) {
    trace.error('generator:strip-canvas-node-motion-refs-failed', { error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Map a framer-motion event-prop name to a connection trigger keyword (the arrow renderer reads the trigger). */
function triggerForEventAttr(name: string): string | null {
  switch (name) {
    case 'onTap': case 'onClick': case 'onTapStart': return 'click';
    case 'onHoverStart': case 'onMouseEnter': return 'mouseEnter';
    case 'onHoverEnd': case 'onMouseLeave': return 'mouseLeave';
    default: return null;
  }
}

/** A variant connection on a node is an event handler `on*={() => setVariant('<to>')}` that CALLS the
 *  function-scoped `setVariant`. Dragged out to module-scope `canvasNodes`, that ref is undefined → crash. Sweep
 *  every canvas node: pull the target variant out of such a handler, STASH it on the node as
 *  `data-conn-target="<to>:<trigger>"` (the source of truth for rendering the arrow on the canvas + restoring the
 *  live handler on drag-back), and STRIP the handler. Idempotent; no-op when no canvas node carries a setVariant
 *  handler. Runs in the same canvasNode move pipeline as the other strippers. */
export function stashCanvasNodeConnectionsInCode(code: string): string {
  if (!code.includes('canvasNodes') || !code.includes('setVariant')) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  let changed = false;
  traverse(ast, {
    VariableDeclarator(path) {
      if (path.node.id.type !== 'Identifier' || path.node.id.name !== 'canvasNodes' || !path.node.init) return;
      path.traverse({
        JSXOpeningElement(p) {
          let target: string | null = null;
          let trigger: string | null = null;
          const keep = p.node.attributes.filter((attr) => {
            if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') return true;
            const trig = triggerForEventAttr(attr.name.name);
            if (!trig || attr.value?.type !== 'JSXExpressionContainer') return true;
            // Handler shape: `() => setVariant('<to>')`. Pull the literal target.
            const fn = attr.value.expression;
            const call = fn.type === 'ArrowFunctionExpression' && fn.body.type === 'CallExpression' ? fn.body : null;
            if (
              call && call.callee.type === 'Identifier' && call.callee.name === 'setVariant' &&
              call.arguments[0]?.type === 'StringLiteral'
            ) {
              target = call.arguments[0].value;
              trigger = trig;
              return false; // strip the crashing handler
            }
            return true;
          });
          if (target) {
            p.node.attributes = keep.filter(
              (a) => !(a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'data-conn-target'),
            );
            p.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-conn-target'), t.stringLiteral(`${target}:${trigger}`)));
            changed = true;
          }
        },
      });
      path.stop();
    },
  });
  if (!changed) return code;
  try {
    const out = generate(ast).code;
    trace.action('generator:stash-canvas-node-connections', {});
    return out;
  } catch (err) {
    trace.error('generator:stash-canvas-node-connections-failed', { error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** Create/replace a CANVAS NODE's variant connection: write `data-conn-target="<to>:<trigger>"` on the node. A
 *  canvas node can't run a live `setVariant` (module scope), so the connection is stored as this attr — the arrow
 *  renderer draws it to the target variant, and drag-back restores the live handler. Used by the connection
 *  modal when the source is a canvas node (instead of addConnection's onTap + connections-array path). */
export function setCanvasNodeConnectionInCode(code: string, nodeId: string, to: string, trigger: string): string {
  trace.fn('generator.setCanvasNodeConnectionInCode', { nodeId, to, trigger });
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  let tag = code.slice(idIdx, tagEnd);
  const val = `${to}:${trigger}`;
  if (/\bdata-conn-target=/.test(tag)) {
    tag = tag.replace(/\bdata-conn-target="[^"]*"/, `data-conn-target="${val}"`);
  } else {
    const dataId = `data-id="${nodeId}"`;
    const di = tag.indexOf(dataId);
    if (di === -1) return code;
    tag = tag.slice(0, di + dataId.length) + ` data-conn-target="${val}"` + tag.slice(di + dataId.length);
  }
  trace.action('generator:set-canvas-node-connection', { nodeId, to, trigger });
  return code.slice(0, idIdx) + tag + code.slice(tagEnd);
}

/** Flatten any `variant`/`initialVariant` CONDITIONAL style on a node to its DEFAULT branch.
 *  A node moved into module-scope `canvasNodes` loses the component's `initialVariant` prop, so a
 *  `display: initialVariant === 'variant-2' ? 'none' : ''` style references an undefined identifier
 *  and crashes ("References undefined identifier: initialVariant"). On the canvas there's no variant
 *  context → resolve each conditional to its default (primary) branch; an empty default removes the
 *  prop. Idempotent + no-op when the node has no such conditional. (The clone-based exit paths bake
 *  the fallback into flat styles already; this covers the id-preserving MOVE path, which carries the
 *  node's raw JSX — ternary and all — verbatim.) */
export function flattenVariantConditionalStylesInCode(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const styleStart = code.indexOf('style={{', idIdx);
  if (styleStart === -1) return code;
  const objStart = styleStart + 'style={{'.length;
  const posEnd = findStyleObjectEnd(code, objStart);
  const pos = posEnd === -1 ? code.length : posEnd;
  const inner = code.slice(objStart, pos);
  if (!VARIANT_COND_RE.test(inner)) return code;
  const out: string[] = [];
  for (const raw of splitStyleProps(inner)) {
    const entry = raw.trim();
    if (!entry) continue;
    const ci = entry.indexOf(':');
    if (ci === -1) { out.push(entry); continue; }
    const key = entry.slice(0, ci).trim();
    const val = entry.slice(ci + 1).trim();
    if (!VARIANT_COND_RE.test(val)) { out.push(entry); continue; }
    // Resolve to the default branch: strip every `X === 'v' ? consequent :` prefix (consequent is a
    // quoted string or a bare number/keyword). What remains is the final fallback literal.
    const def = val.replace(/(?:variant|initialVariant)\s*===\s*'[^']+'\s*\?\s*(?:'[^']*'|[-\w.]+)\s*:\s*/g, '').trim();
    if (def === '' || def === "''" || def === '""') continue;   // empty default → remove property
    out.push(`${key}: ${def}`);
  }
  const rebuilt = out.join(', ');
  trace.action('generator:flattenVariantConditionalStyles', { nodeId });
  return code.slice(0, objStart) + (rebuilt ? ` ${rebuilt} ` : '') + code.slice(pos);
}

/** Resolve every per-viewport `__mqN ? … : …` gate ternary in a node's subtree to its BASE (else) branch.
 *  Per-viewport link/bool-nav variables write `href={(__mq2 ? var : base)}` / `target={(__mq ? a : b) ? … }`
 *  where `__mqN` are `useMediaQuery` consts DECLARED INSIDE the component fn — module-scope `canvasNodes` has
 *  no such const, so a node dragged out crashes the validator ("References undefined identifiers: __mq2, …").
 *  A canvas node has no viewport context anyway → collapse each `__mq` ternary to the base. Replacing a
 *  ConditionalExpression whose TEST is a `__mq*` identifier with its `alternate` (re-queued by babel, so a
 *  nested `__mq2 ? a : __mq1 ? b : c` fully collapses to `c`, and a bool-nav inner `(__mq ? x : baseVar)`
 *  collapses to `baseVar` — then dormantizeComponentVarBindings can orphan that var). Run BEFORE the orphan
 *  pass. No-op when the node carries no `__mq` gate. */
export function resolveMediaGateTernariesInCode(code: string, nodeId: string): string {
  if (!/__mq\d/.test(code)) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  let changed = false;
  traverse(ast, {
    JSXElement(path) {
      const idAttr = path.node.openingElement.attributes.find(
        (a) => a.type === 'JSXAttribute' && a.name.name === 'data-id'
          && a.value?.type === 'StringLiteral' && a.value.value === nodeId,
      );
      if (!idAttr) return;
      path.traverse({
        ConditionalExpression(c) {
          if (c.node.test.type === 'Identifier' && /^__mq/.test(c.node.test.name)) {
            c.replaceWith(c.node.alternate);
            changed = true;
          }
        },
      });
      path.stop();
    },
  });
  if (!changed) return code;
  try {
    const out = generate(ast).code;
    trace.action('generator:resolve-media-gate-ternaries', { nodeId });
    return out;
  } catch (err) {
    trace.error('generator:resolve-media-gate-ternaries-failed', { error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * When a moved element is the TEMPLATE BODY of a `.map()` collection list —
 * `coll.map((item, idx) => <el/>)` — it isn't a JSX child of any parent
 * element, so the parent-splice removal can't reach it. Leaving it produces a
 * DUPLICATE (the node stays in the map AND lands in canvasNodes, same data-id).
 *
 * Instead, replace the map callback's body with `null`: the `.map()` survives
 * as an EMPTY, refillable collection list (the parser still detects
 * `coll.map((item,idx)=>…)` and keeps `collectionList` — just with no
 * template) — the reference's "Empty State". Returns true if it handled the removal.
 */
function replaceMapTemplateBodyWithNull(path: any): boolean {
  let mw: any = path.parentPath;
  while (mw && !mw.isJSXElement() && !mw.isJSXFragment()) {
    if (mw.isArrowFunctionExpression() || mw.isFunctionExpression()) {
      const callP = mw.parentPath;
      const callee = callP?.isCallExpression() ? (callP.node as t.CallExpression).callee : null;
      const isMapArg = callee?.type === 'MemberExpression'
        && callee.property.type === 'Identifier'
        && callee.property.name === 'map'
        && (callP!.node as t.CallExpression).arguments[0] === mw.node;
      if (isMapArg) {
        // Expression body → `null`; block body → `{ return null; }`.
        mw.node.body = mw.node.body.type === 'BlockStatement'
          ? t.blockStatement([t.returnStatement(t.nullLiteral())])
          : t.nullLiteral();
        trace.action('generator:moveNodeInCode-empty-map-template', {});
        return true;
      }
      return false; // an arrow/fn that isn't a .map() callback — not our case
    }
    mw = mw.parentPath;
  }
  return false;
}

/**
 * REFILL (inverse of {@link replaceMapTemplateBodyWithNull}): if `parentNode`
 * directly holds an EMPTY collection-list `.map()` — `coll.map((item, idx) =>
 * null)`, left behind when its template was dragged out — make `removedNode`
 * the new template body (and add `key={idx}` for React reconciliation) instead
 * of inserting it as a plain sibling. The caller then rehydrates any
 * `data-cms-orphan` bindings to the iterator. Returns true if it refilled.
 */
function fillEmptyMapBody(parentNode: t.JSXElement, removedNode: t.JSXElement): boolean {
  for (const child of parentNode.children) {
    if (child.type !== 'JSXExpressionContainer') continue;
    const expr = child.expression;
    if (expr.type !== 'CallExpression') continue;
    const callee = expr.callee;
    if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier' || callee.property.name !== 'map') continue;
    const fn = expr.arguments[0];
    if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) continue;
    // Empty body = the `null` placeholder from a template drag-out (expression
    // body) or `{ return null; }` (block body).
    const body = fn.body;
    const ret = body.type === 'BlockStatement' && body.body.length === 1 && body.body[0].type === 'ReturnStatement'
      ? (body.body[0] as t.ReturnStatement).argument : undefined;
    const isEmpty = body.type === 'NullLiteral'
      || (body.type === 'BlockStatement' && (ret === null || ret?.type === 'NullLiteral'));
    if (!isEmpty) continue;

    // Add `key={idxParam}` (the map's 2nd param) unless already present.
    const idxParam = fn.params[1];
    if (idxParam?.type === 'Identifier'
      && !removedNode.openingElement.attributes.some((a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'key')) {
      removedNode.openingElement.attributes.unshift(
        t.jsxAttribute(t.jsxIdentifier('key'), t.jsxExpressionContainer(t.identifier(idxParam.name))));
    }
    fn.body = body.type === 'BlockStatement' ? t.blockStatement([t.returnStatement(removedNode)]) : removedNode;
    trace.action('generator:moveNodeInCode-refill-empty-map', {});
    return true;
  }
  return false;
}

/** The outermost JSX element's data-id (the page/component root), read cheaply
 *  by regex from the first `return (` onward. Used to keep the move fast-path
 *  OUT of the root — moving to root with no index is the canvas-exit path,
 *  which needs the AST branch. Heuristic but conservative: a miss just declines
 *  the fast path. */
function cheapOutermostDataId(code: string): string | null {
  const ret = code.search(/return\s*[(<]/);
  const m = /data-id="([^"]+)"/.exec(ret === -1 ? code : code.slice(ret));
  return m ? m[1] : null;
}

export function moveNodeInCode(
  code: string,
  nodeId: string,
  newParentId: string | null,
  styleChanges?: Record<string, string>,
  insertIndex?: number,
  canvasNode?: boolean,
  sourceVpWidth?: number,
  sourceVariant?: string,
  /** Splice the node BEFORE this sibling id (visual anchor). Preferred over
   *  `insertIndex`: the index is visual-space and lands one off whenever CSS
   *  `order` makes JSX order diverge from visual order. Falls back to the
   *  index when the anchor isn't found among the parent's JSX children
   *  (e.g. a template node living in another file). */
  insertBeforeId?: string,
): string {
  trace.fn('generator.moveNodeInCode', { nodeId, newParentId, insertIndex, sourceVpWidth, sourceVariant });
  let result = code;
  if (styleChanges) {
    result = updateNodeInCode(result, nodeId, styleChanges);
  }

  // ── FAST PATH: plain reparent INTO a real, non-root parent ──────────────
  // A structural move is textually just "cut the element's JSX span, splice it
  // into the target parent's children" — no need to parse+regenerate the whole
  // (often 470KB) file, which is a full babel round-trip + heavy GC and the
  // dominant cost of a reparent-drop mouseup on a big page. `moveNodeIntoParentFast`
  // returns null for anything that needs real AST work — exit-to-canvas
  // (null/root parent, canvasNode:true), variant/responsive-text unwraps
  // (sourceVariant), wrapped/`.map()`/self-closing cases — so we fall through
  // to the AST path below exactly as before for those.
  if (
    newParentId != null &&
    canvasNode !== true &&
    sourceVariant == null &&
    // Anchor-id splices need the AST path — the fast path only knows
    // positional indexes and would reintroduce the visual/JSX divergence
    // the anchor exists to fix.
    insertBeforeId == null &&
    newParentId !== cheapOutermostDataId(result)
  ) {
    const fast = moveNodeIntoParentFast(result, nodeId, newParentId, insertIndex ?? null);
    if (fast !== null) {
      trace.action('generator:moveNodeInCode-fast-path', { nodeId, newParentId });
      return fast;
    }
  }
  trace.action('generator:moveNodeInCode-ast-path', { nodeId, newParentId });

  const ast = parseJSX(result);
  if (!ast) return result;

  // Collected variant-const names whose only JSX reference was on the
  // moved subtree (set by the exit-to-canvas strip below). After the
  // subtree is re-inserted into canvasNodes, the post-process pass at
  // the end walks the AST to confirm zero remaining references and
  // deletes the matching `const fooVariants = { … }` declarations.
  // Without this, every node that re-enters the variants system after
  // an exit-to-canvas would crash the parser with `Identifier '…' has
  // already been declared` when the generator re-creates the const.
  const strippedVariantRefs = new Set<string>();

  /**
   * Walk the program body and delete any `const X = { … }` whose name
   * is in `strippedVariantRefs` AND has zero remaining `Identifier`
   * references in the AST. Called from BOTH return paths (final
   * `generate(ast)` AND the create-canvasNodes-block early return),
   * since each emits the output from a different state (AST vs. ast +
   * spliced-in removed-jsx string). Returns true if anything was
   * deleted — caller can use it for tracing.
   */
  const dropOrphanVariantConsts = (): boolean => {
    if (strippedVariantRefs.size === 0) return false;
    const refCounts = new Map<string, number>();
    for (const name of strippedVariantRefs) refCounts.set(name, 0);
    traverse(ast, {
      Identifier(path) {
        const name = path.node.name;
        if (!strippedVariantRefs.has(name)) return;
        const parent = path.parent;
        if (
          parent &&
          parent.type === 'VariableDeclarator' &&
          (parent as t.VariableDeclarator).id === path.node
        ) {
          return;
        }
        refCounts.set(name, (refCounts.get(name) ?? 0) + 1);
      },
    });
    const orphans = new Set<string>();
    for (const [name, count] of refCounts) {
      if (count === 0) orphans.add(name);
    }
    if (orphans.size === 0) return false;
    const body = ast.program.body;
    for (let i = body.length - 1; i >= 0; i--) {
      const stmt = body[i];
      if (stmt.type !== 'VariableDeclaration') continue;
      const decl = stmt as t.VariableDeclaration;
      const keep = decl.declarations.filter(
        (d) => !(d.id.type === 'Identifier' && orphans.has(d.id.name)),
      );
      if (keep.length === 0) {
        body.splice(i, 1);
      } else if (keep.length !== decl.declarations.length) {
        decl.declarations = keep;
      }
    }
    trace.action('generator:moveNodeInCode-drop-orphan-variants', {
      nodeId,
      names: Array.from(orphans),
    });
    return true;
  };

  // Step 1: Find and remove the node
  let removedNode: t.JSXElement | null = null;

  findFirstElementByDataId(ast, nodeId, (path) => {
    removedNode = t.cloneNode(path.node, true);

    const parent = path.parentPath;
    if (parent?.isJSXElement() || parent?.isJSXFragment()) {
      // Plain child of a JSXElement / JSXFragment — splice from parent.children.
      const children = parent.node.children;
      const idx = children.indexOf(path.node);
      if (idx !== -1) {
        children.splice(idx, 1);
        if (idx > 0 && children[idx - 1]?.type === 'JSXText' &&
            (children[idx - 1] as t.JSXText).value.trim() === '') {
          children.splice(idx - 1, 1);
        }
      }
    } else if (replaceMapTemplateBodyWithNull(path)) {
      // Handled: the element was a `.map()` collection-list TEMPLATE body
      // (`coll.map((item, idx) => <el/>)`) — replaced with `null` so the map
      // SURVIVES as an empty, refillable collection list (the reference "Empty State").
      // See the helper for why this is NOT a simple parent-splice.
    } else {
      // Element is wrapped — most commonly inside the AnimatePresence
      // visibility pattern: `<AnimatePresence>{cond && <element/>}</AnimatePresence>`.
      // Walk up to find the AnimatePresence wrapper and REMOVE the
      // whole wrapper (the wrapper exists only to gate this element's
      // visibility; with the element gone the wrapper has no purpose).
      // Without this branch the element stays in the source while ALSO
      // being added to its new location — visible as a duplicate
      // data-id (one in the wrapper, one in canvasNodes), unable to
      // resize, layers panel shows it twice.
      let walker: any = path.parentPath;
      while (walker) {
        if (walker.isJSXElement()) {
          const opening = walker.node.openingElement;
          const isAnimPresence = opening.name.type === 'JSXIdentifier'
            && opening.name.name === 'AnimatePresence';
          if (isAnimPresence) {
            const ancestor = walker.parentPath;
            if (ancestor?.isJSXElement() || ancestor?.isJSXFragment()) {
              const ancestorChildren = ancestor.node.children;
              const idx = ancestorChildren.indexOf(walker.node);
              if (idx !== -1) {
                ancestorChildren.splice(idx, 1);
                if (idx > 0 && ancestorChildren[idx - 1]?.type === 'JSXText'
                    && (ancestorChildren[idx - 1] as t.JSXText).value.trim() === '') {
                  ancestorChildren.splice(idx - 1, 1);
                }
              }
            }
            break;
          }
        }
        walker = walker.parentPath;
      }
    }
    path.stop();
  });

  if (!removedNode) return result;

  // When moving to the file's root element AND canvasNode flag is true (or unspecified for backward compat),
  // add data-canvas-node="true" so Renderer knows not to replicate this node into viewports.
  // Primary viewport exits set canvasNode=false to keep replicas.
  // Check: newParentId is null (append to root), or matches the outermost
  // JSX element's data-id (always `"root"` — both pages and layouts share
  // that convention; the merged tree prefixes layout nodes with `layout::`).
  let fileRootId: string | null = null;
  traverse(ast, {
    JSXElement(path) {
      if (path.parentPath?.isExpressionStatement() || path.parentPath?.isReturnStatement() || path.parentPath?.isParenthesizedExpression()) {
        const attrs = path.node.openingElement.attributes;
        for (const attr of attrs) {
          if (t.isJSXAttribute(attr) && attr.name.name === 'data-id' && t.isStringLiteral(attr.value)) {
            fileRootId = attr.value.value;
          }
        }
        path.stop();
      }
    },
  });
  // Moving to root = canvas exit (absolute positioned, no insertIndex).
  // Moving to root WITH an insertIndex = flex child insert (not a canvas exit).
  const isMovingToRoot = (newParentId === null || newParentId === fileRootId) && insertIndex == null;
  if (isMovingToRoot && removedNode && canvasNode !== false) {
    const rn = removedNode as t.JSXElement;
    const opening = rn.openingElement;
    const hasCanvasAttr = opening.attributes.some(
      (a: t.JSXAttribute | t.JSXSpreadAttribute) => t.isJSXAttribute(a) && a.name.name === 'data-canvas-node'
    );
    if (!hasCanvasAttr) {
      opening.attributes.push(
        t.jsxAttribute(t.jsxIdentifier('data-canvas-node'), t.stringLiteral('true'))
      );
    }
    // Strip variant-family props on exit-to-canvas. The node is leaving
    // its parent variant context (component master child → canvas-rooted
    // standalone), so `variants={...}` / `initial={...}` / `animate={...}` /
    // `layoutId={...}` no longer make sense — they tie the element to a
    // variants animation system it's no longer part of. Without this
    // strip, the canvas clone keeps `variants={...}` referring to an
    // object whose `default` entry hides it (`display: 'none'`), so the
    // canvas-rooted element renders invisible. Also clears the matching
    // inline `display: 'none'` so the canvas node paints; it was the
    // hide-by-default baseline for the variant system the node just
    // left.
    //
    // Walks the entire moved subtree (root + descendants) — every
    // descendant that carries variant-family props gets cleaned too, so
    // moving a parent that had two variant-children produces a fully
    // independent canvas-rooted tree. Collects the `variants` ref names
    // (e.g. `frameMp377d2g1CmwjlbzVariants`) so we can drop any const
    // declaration that's now orphaned (see post-insert cleanup below) —
    // leaving them in produced `Identifier '…' has already been
    // declared` validation failures the next time the same id re-entered
    // the variant system.
    const VARIANT_FAMILY_PROPS = new Set(['variants', 'initial', 'animate', 'layoutId']);

    // Inline component-prop variable refs in style on canvas exit. `canvasNodes` lives at MODULE
    // scope (after `export default`), outside the component function — so a style value that
    // references a component PROP (`boxShadow: zegzegzegezg`, `'--border': zefzef`, or a per-variant
    // ternary `initialVariant === 'v' ? prop : 'none'`) becomes an undefined identifier there and the
    // validator rejects the move ("References undefined identifier: … — would crash at runtime"). The
    // node is LEAVING the component, so the binding can't follow it; resolve each prop reference to the
    // prop's current default literal — the canvas clone keeps the same visual without a dangling
    // reference. Mirrors how variant-family props are stripped on exit.
    const propDefaults = extractComponentPropDefaults(ast);

    // Helper: read inline `display` from a JSXElement's style object.
    // Returns the literal value or null if no display is set / unreadable.
    const readInlineDisplay = (el: t.JSXElement): string | null => {
      const styleAttr = el.openingElement.attributes.find(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
      ) as t.JSXAttribute | undefined;
      if (
        !styleAttr ||
        styleAttr.value?.type !== 'JSXExpressionContainer' ||
        styleAttr.value.expression.type !== 'ObjectExpression'
      ) return null;
      for (const prop of styleAttr.value.expression.properties) {
        if (
          t.isObjectProperty(prop) &&
          ((t.isIdentifier(prop.key) && prop.key.name === 'display') ||
            (t.isStringLiteral(prop.key) && prop.key.value === 'display')) &&
          t.isStringLiteral(prop.value)
        ) {
          return prop.value.value;
        }
      }
      return null;
    };
    // Read `default: { rotate: N }` from a variants const in this file —
    // the PRIMARY'S rotation lives there (unified motion channel). On exit
    // the variants wiring is stripped, so the angle must FOLD into the
    // canvas-node rotation channel: the inline style `rotate` property
    // (paired with the carrier transformBox/transformOrigin the tag
    // already carries). Without the fold a rotated child dragged to the
    // canvas silently loses its rotation.
    const defaultEntryRotate = (refName: string): number | null => {
      let angle: number | null = null;
      for (const stmt of ast.program.body) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const dec of stmt.declarations) {
          if (!t.isIdentifier(dec.id) || dec.id.name !== refName) continue;
          if (!t.isObjectExpression(dec.init)) continue;
          for (const p of dec.init.properties) {
            if (!t.isObjectProperty(p)) continue;
            const k = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '';
            if (k !== 'default' || !t.isObjectExpression(p.value)) continue;
            for (const dp of p.value.properties) {
              if (!t.isObjectProperty(dp)) continue;
              const dk = t.isIdentifier(dp.key) ? dp.key.name : t.isStringLiteral(dp.key) ? dp.key.value : '';
              if (dk !== 'rotate') continue;
              if (t.isNumericLiteral(dp.value)) angle = dp.value.value;
              else if (t.isStringLiteral(dp.value)) angle = parseFloat(dp.value.value);
              else if (t.isUnaryExpression(dp.value) && dp.value.operator === '-' && t.isNumericLiteral(dp.value.argument)) angle = -dp.value.argument.value;
            }
          }
        }
      }
      return angle != null && Number.isFinite(angle) && Math.abs(angle) > 0.001 ? angle : null;
    };
    const setStyleRotate = (el: t.JSXElement, angle: number): void => {
      const openingEl = el.openingElement;
      let styleAttr = openingEl.attributes.find(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
      ) as t.JSXAttribute | undefined;
      if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer'
        || !t.isObjectExpression(styleAttr.value.expression)) {
        const obj = t.objectExpression([]);
        styleAttr = t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(obj));
        openingEl.attributes.push(styleAttr);
      }
      const obj = (styleAttr.value as t.JSXExpressionContainer).expression as t.ObjectExpression;
      const existing = obj.properties.find(
        (p) => t.isObjectProperty(p) && ((t.isIdentifier(p.key) && p.key.name === 'rotate') || (t.isStringLiteral(p.key) && p.key.value === 'rotate')),
      ) as t.ObjectProperty | undefined;
      const value = t.stringLiteral(`${Math.round(angle * 10) / 10}`);
      if (existing) existing.value = value;
      else obj.properties.push(t.objectProperty(t.identifier('rotate'), value));
    };
    const stripVariantFamilyFromElement = (el: t.JSXElement): void => {
      const openingEl = el.openingElement;
      // Resolve any component-prop references in this element's inline style to
      // literals — they'd be undefined at module-scope canvasNodes (see above).
      inlineComponentPropRefsInStyleObject(el, propDefaults);
      for (const a of openingEl.attributes) {
        if (
          t.isJSXAttribute(a) &&
          t.isJSXIdentifier(a.name) &&
          a.name.name === 'variants' &&
          a.value?.type === 'JSXExpressionContainer' &&
          t.isIdentifier(a.value.expression)
        ) {
          strippedVariantRefs.add(a.value.expression.name);
          const foldAngle = defaultEntryRotate(a.value.expression.name);
          if (foldAngle != null) setStyleRotate(el, foldAngle);
        }
      }
      // Distinguish VARIANT bindings (`animate="hidden"`, `animate={variant}`,
      // `initial={initialVariant}`) from STANDALONE animations (`animate={{
      // rotate: 360 }}`, `initial={{ scale: 0 }}`). Variant bindings tie
      // the element to a `variants` object that's about to be stripped —
      // keep them around and framer-motion throws or animates to undefined
      // at canvas root. Standalone object-value animations are
      // self-contained (Loop, simple Animate, etc.) — they MUST survive
      // the exit, otherwise dragging a rotating element onto the canvas
      // kills the rotation. `variants` and `layoutId` are always
      // variant-system props with no standalone meaning — always strip.
      const isVariantBinding = (a: t.JSXAttribute): boolean => {
        const name = t.isJSXIdentifier(a.name) ? a.name.name : '';
        if (name === 'variants' || name === 'layoutId') return true;
        if (name !== 'animate' && name !== 'initial') return false;
        const val = a.value;
        // `animate="foo"` — string literal binding (variant name)
        if (val?.type === 'StringLiteral') return true;
        if (val?.type !== 'JSXExpressionContainer') return false;
        const expr = val.expression;
        // `animate={variant}` / `animate={initialVariant}` — identifier ref
        if (t.isIdentifier(expr)) return true;
        // `animate={"foo"}` — string literal wrapped in expression
        if (t.isStringLiteral(expr)) return true;
        // `animate={['default', variant]}` — the variant-LIST wiring
        // (inheritance dialect): an array of variant names / identifier
        // refs is a binding too. Missing this left function-scoped
        // `initialVariant`/`variant` refs inside module-scope canvasNodes
        // and the validator blocked every later mutation ("References
        // undefined identifiers", live report 2026-06-12).
        if (
          t.isArrayExpression(expr) && expr.elements.length > 0 &&
          expr.elements.every((e) => e != null && (t.isStringLiteral(e) || t.isIdentifier(e)))
        ) return true;
        // `animate={{ rotate: 360 }}` — object literal = standalone, keep
        // Anything else (conditional, call expression, etc.) is preserved
        // by default; the conservative path here is to NOT strip.
        return false;
      };
      openingEl.attributes = openingEl.attributes.filter(
        (a: t.JSXAttribute | t.JSXSpreadAttribute) =>
          !(t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && VARIANT_FAMILY_PROPS.has(a.name.name) && isVariantBinding(a)),
      );

      // Canvas nodes live at MODULE scope, OUTSIDE the component render — a DRAWN
      // canvas shape is a plain `<svg>`, never `<motion.svg>`. A subtree dragged
      // out keeps its `motion.*` tags + `layout`, which (a) makes it inconsistent
      // with drawn nodes and (b) BREAKS svg grouping: group-svgs locates blocks by
      // `<svg`, never matching `<motion.svg`, so cmd+G silently no-ops. Demote
      // `motion.X` → `X` and drop the (now-inert) `layout` prop — but ONLY when no
      // STANDALONE motion animation survives (`animate={{…}}`, whileHover, etc.),
      // since those genuinely need the motion wrapper to keep running at canvas root.
      const MOTION_ANIM_PROPS = new Set([
        'animate', 'initial', 'exit', 'whileHover', 'whileTap',
        'whileFocus', 'whileInView', 'whileDrag', 'drag', 'transition',
      ]);
      const keepsMotion = openingEl.attributes.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && MOTION_ANIM_PROPS.has(a.name.name),
      );
      if (!keepsMotion) {
        const nm = openingEl.name;
        if (
          t.isJSXMemberExpression(nm) &&
          t.isJSXIdentifier(nm.object) && nm.object.name === 'motion' &&
          t.isJSXIdentifier(nm.property)
        ) {
          openingEl.name = t.jsxIdentifier(nm.property.name);
          if (el.closingElement) el.closingElement.name = t.jsxIdentifier(nm.property.name);
        }
        openingEl.attributes = openingEl.attributes.filter(
          (a) => !(t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'layout'),
        );
      }
      // ROOT element only: reset inline `display: 'none'` to ''. The
      // root is what the user is dragging — they SEE it on the source
      // vp (a hidden root wouldn't be draggable). The display:'none'
      // was the hide-by-default baseline for whatever variant /
      // @container override was making it visible on the source vp;
      // at canvas root there's no override, so we clear the hide to
      // keep the element visible.
      if (el === rn) {
        const styleAttrEl = openingEl.attributes.find(
          (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
        ) as t.JSXAttribute | undefined;
        if (
          styleAttrEl &&
          styleAttrEl.value?.type === 'JSXExpressionContainer' &&
          styleAttrEl.value.expression.type === 'ObjectExpression'
        ) {
          const obj = styleAttrEl.value.expression;
          for (const prop of obj.properties) {
            if (
              t.isObjectProperty(prop) &&
              ((t.isIdentifier(prop.key) && prop.key.name === 'display') ||
                (t.isStringLiteral(prop.key) && prop.key.value === 'display')) &&
              t.isStringLiteral(prop.value) &&
              prop.value.value === 'none'
            ) {
              prop.value = t.stringLiteral('');
            }
          }
        }
      }
      // DROP children that have inline `display: 'none'` — they weren't
      // visible on the source vp (no @container override could've
      // flipped them visible without the parent's variant context,
      // which is gone now). Carrying them into the canvas-node would
      // either (a) leak invisible content if we keep display:none, or
      // (b) make them suddenly visible if we strip the hide — both
      // wrong. Skipping them entirely matches the user's intent: "the
      // canvas-node should contain what I saw on the source vp."
      el.children = el.children.filter(child => {
        if (!t.isJSXElement(child)) return true;
        return readInlineDisplay(child) !== 'none';
      });
      // UNWRAP `{useResponsiveText('primary', { 768: 'tablet text' })}`
      // text-content calls into plain text. On canvas root there's no
      // viewport context for the hook to resolve against, so it
      // returns the primary — which is often `​` (zero-width-space
      // placeholder) when the user authored the text on a non-primary
      // vp. The element collapses to width:0 and the visible text is
      // lost. Replace the JSXExpressionContainer with a JSXText node
      // holding the source-vp's actual text (override matching the
      // source vp, fallback to primary).
      // Per-variant ternary `{variant === 'X' ? 'A' : 'B'}` (or
      // `initialVariant === 'X' ? ...`) on a component master: on canvas
      // root the `variant` identifier is undefined and the ternary
      // either throws or falls through to the default branch — often a
      // `​` placeholder that collapses the element. Resolve to the
      // source variant's branch value and emit plain JSXText. Same
      // matcher as the parser's walkVariantConditionalProp.
      const mappedVariantKey = sourceVariant === 'desktop' ? 'default' : sourceVariant;
      el.children = el.children.map(child => {
        if (child.type !== 'JSXExpressionContainer') return child;

        // useResponsiveText call → plain text
        if (
          child.expression.type === 'CallExpression' &&
          child.expression.callee?.type === 'Identifier' &&
          (child.expression.callee as t.Identifier).name === 'useResponsiveText'
        ) {
          const args = (child.expression as t.CallExpression).arguments;
          const primaryArg = args[0];
          const overridesArg = args[1];
          if (!primaryArg || primaryArg.type !== 'StringLiteral') return child;
          let resolved = primaryArg.value;
          if (sourceVpWidth && overridesArg && overridesArg.type === 'ObjectExpression') {
            const overrides: Array<{ w: number; v: string }> = [];
            for (const prop of overridesArg.properties) {
              if (prop.type !== 'ObjectProperty') continue;
              let w: number | null = null;
              if (prop.key.type === 'NumericLiteral') w = prop.key.value;
              else if (prop.key.type === 'StringLiteral') w = parseInt(prop.key.value, 10);
              if (w == null || !Number.isFinite(w)) continue;
              if (prop.value.type === 'StringLiteral') overrides.push({ w, v: prop.value.value });
            }
            overrides.sort((a, b) => a.w - b.w);
            // Mobile-first cascade: lowest key >= sourceVpWidth wins;
            // fall back to highest key if none match (the source vp
            // has no override smaller than itself).
            const matched = overrides.find(o => o.w >= sourceVpWidth) ?? overrides[overrides.length - 1];
            if (matched && matched.v && matched.v.trim() !== '' && matched.v !== '​') {
              resolved = matched.v;
            }
          }
          return t.jsxText(resolved);
        }

        // variant ternary → plain text
        if (child.expression.type === 'ConditionalExpression' && mappedVariantKey) {
          let cursor: any = child.expression;
          let resolved: string | null = null;
          while (cursor && cursor.type === 'ConditionalExpression') {
            const test = cursor.test;
            if (
              test?.type !== 'BinaryExpression' ||
              test.operator !== '===' ||
              test.left?.type !== 'Identifier' ||
              (test.left.name !== 'variant' && test.left.name !== 'initialVariant') ||
              test.right?.type !== 'StringLiteral' ||
              cursor.consequent?.type !== 'StringLiteral'
            ) {
              cursor = null;
              resolved = null;
              break;
            }
            if (test.right.value === mappedVariantKey) {
              resolved = cursor.consequent.value;
              break;
            }
            cursor = cursor.alternate;
          }
          if (resolved === null && cursor && cursor.type === 'StringLiteral') {
            resolved = (cursor as t.StringLiteral).value;
          }
          if (resolved !== null) {
            if (resolved === '​' || resolved.trim() === '') return t.jsxText('');
            return t.jsxText(resolved);
          }
        }

        return child;
      });
      // Recurse into the surviving children.
      for (const child of el.children) {
        if (t.isJSXElement(child)) stripVariantFamilyFromElement(child);
      }
    };
    stripVariantFamilyFromElement(rn);
    trace.action('generator:moveNodeInCode-strip-variant-family', {
      nodeId,
      refs: Array.from(strippedVariantRefs),
    });
  }

  // When moving INTO a parent as a child (not canvas exit), remove data-canvas-node if present
  if (!isMovingToRoot && removedNode) {
    const rn = removedNode as t.JSXElement;
    const opening = rn.openingElement;
    opening.attributes = opening.attributes.filter(
      (a: t.JSXAttribute | t.JSXSpreadAttribute) => !(t.isJSXAttribute(a) && a.name.name === 'data-canvas-node')
    );
  }

  // Step 2: Insert into new parent (or root level)
  if (newParentId === null) {
    // When moving to root AND marked as canvas node, insert into canvasNodes fragment
    let insertedIntoCanvasNodes = false;
    if (isMovingToRoot && canvasNode !== false) {
      traverse(ast, {
        VariableDeclarator(path) {
          if (path.node.id.type === 'Identifier' && path.node.id.name === 'canvasNodes' && path.node.init) {
            let fragment = path.node.init;
            if (fragment.type === 'ParenthesizedExpression') fragment = (fragment as any).expression;
            if (fragment.type === 'JSXFragment') {
              (fragment as t.JSXFragment).children.push(t.jsxText('\n  '));
              (fragment as t.JSXFragment).children.push(removedNode!);
              (fragment as t.JSXFragment).children.push(t.jsxText('\n'));
              insertedIntoCanvasNodes = true;
            }
            path.stop();
          }
        },
      });
    }
    // Fallback: no canvasNodes fragment exists yet — generate the code with the
    // node removed, then splice the already-serialized removed node directly
    // into a fresh canvasNodes block. We cannot route through addCanvasNodeInCode
    // here because that rebuilds the JSX from a flat {id, type, styles, name}
    // descriptor and loses child elements + textContent. The cloned AST node
    // already has the updated styles (via updateNodeInCode above) AND its full
    // subtree, so serializing it whole preserves everything. Make sure
    // data-canvas-node="true" is set on the opening element first.
    if (!insertedIntoCanvasNodes && canvasNode === true) {
      try {
        // Drop orphaned variant consts from the AST BEFORE emitting
        // `resultCode`. This path early-returns the spliced output and
        // bypasses the post-process cleanup at the end of the function,
        // so we have to do the cleanup here too — otherwise creating a
        // brand-new canvasNodes block (the first exit-to-canvas in a
        // file that didn't have a canvasNodes fragment) leaves the
        // orphan `const fooVariants = { … }` declarations in `result`
        // and re-entering the variants system after that hits the
        // "Identifier '…' has already been declared" parser error.
        dropOrphanVariantConsts();
        const resultCode = generate(ast, { retainLines: false, concise: false }, result).code;
        const rn = removedNode! as t.JSXElement;
        const opening = rn.openingElement;
        const hasCanvasAttr = opening.attributes.some(
          (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-canvas-node',
        );
        if (!hasCanvasAttr) {
          opening.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-canvas-node'), t.stringLiteral('true')));
        }
        const removedAst = t.file(t.program([t.expressionStatement(rn)]));
        const removedJsx = generate(removedAst, { retainLines: false, concise: false }).code.replace(/;\s*$/, '');
        const exportInsertIdx = findExportDefaultEndIdx(resultCode);
        if (exportInsertIdx !== -1) {
          trace.action('generator:moveNodeInCode-create-canvasNodes-block', { nodeId, insertIdx: exportInsertIdx });
          const block = `\n\nconst canvasNodes = (<>\n  ${removedJsx}\n</>);\n`;
          return resultCode.slice(0, exportInsertIdx) + block + resultCode.slice(exportInsertIdx);
        }
        // No `export default` to anchor on — append at end of file
        trace.action('generator:moveNodeInCode-canvasNodes-append-end', { nodeId });
        return resultCode + `\n\nconst canvasNodes = (<>\n  ${removedJsx}\n</>);\n`;
      } catch (err) {
        trace.error('generator:moveNodeInCode-canvasNode-fallback-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Fallback: insert into root JSX element (old behavior for non-canvasNodes files)
    if (!insertedIntoCanvasNodes && canvasNode !== true) {
      traverse(ast, {
        Program(path) {
          const body = path.node.body;
          for (let i = body.length - 1; i >= 0; i--) {
            const stmt = body[i];
            if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'JSXElement') {
              const rootEl = stmt.expression as t.JSXElement;
              rootEl.children.push(t.jsxText('\n  '));
              rootEl.children.push(removedNode!);
              rootEl.children.push(t.jsxText('\n'));
              break;
            }
          }
          path.stop();
        },
      });
    }
  } else {
    // Moving INTO a non-root parent. If the removed node was previously a
    // canvas-fragment node (data-canvas-node="true"), strip that attribute —
    // it's now a regular nested child, not a canvas-root entry. Without this
    // strip, the parser keeps reporting isCanvasNode=true and the Renderer
    // hoists it back to the contentRoot level, ignoring the JSX nesting.
    const rn = removedNode as t.Node | null;
    trace.action('generator:moveNodeInCode-into-parent', {
      nodeId,
      newParentId,
      removedNodeType: rn?.type ?? 'null',
      attrNames: rn && rn.type === 'JSXElement'
        ? (rn as t.JSXElement).openingElement.attributes
            .filter((a: t.JSXAttribute | t.JSXSpreadAttribute) => t.isJSXAttribute(a))
            .map((a: any) => a.name?.name ?? '?')
        : [],
    });
    if (rn && rn.type === 'JSXElement') {
      const opening = (rn as t.JSXElement).openingElement;
      const beforeLen = opening.attributes.length;
      opening.attributes = opening.attributes.filter((a: t.JSXAttribute | t.JSXSpreadAttribute) =>
        !(t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'data-canvas-node')
      );
      if (opening.attributes.length !== beforeLen) {
        trace.action('generator:moveNodeInCode-strip-canvas-node', { nodeId, newParentId });
      } else {
        trace.action('generator:moveNodeInCode-no-canvas-node-attr', { nodeId, newParentId });
      }
    }
    let parentFound = false;
    findFirstElementByDataId(ast, newParentId, (path) => {
      parentFound = true;
      // Drop target may be self-closing (e.g. an empty background layer) — open it
      // so the moved node isn't discarded (which would DELETE it, since it's
      // already been removed from its old location above).
      ensureParentCanHoldChildren(path.node);
      // REFILL: if the parent holds an EMPTY collection-list `.map()` (its
      // template was dragged out → `=> null`), make the dropped node the new
      // template body instead of a plain sibling. The move-path caller then
      // rehydrates its `data-cms-orphan` bindings to the iterator (the reference
      // drag-back-to-refill parity).
      if (fillEmptyMapBody(path.node as t.JSXElement, removedNode as t.JSXElement)) {
        path.stop();
        return;
      }
      // ANCHOR-FIRST: splice before the named sibling. Immune to every
      // index-space divergence (CSS `order` reorders, `<style>` children,
      // siblings the rect walk missed). Falls through to the index logic
      // when the anchor isn't a JSX child here (template node in another
      // file) — and to append when neither resolves.
      if (insertBeforeId) {
        const children = path.node.children;
        let anchorPos = -1;
        for (let i = 0; i < children.length; i++) {
          const c = children[i];
          if (c.type !== 'JSXElement') continue;
          const hit = c.openingElement.attributes.some((a: t.JSXAttribute | t.JSXSpreadAttribute) =>
            a.type === 'JSXAttribute' && a.name.name === 'data-id'
            && a.value?.type === 'StringLiteral' && a.value.value === insertBeforeId);
          if (hit) { anchorPos = i; break; }
        }
        if (anchorPos >= 0) {
          trace.action('generator:moveNodeInCode-anchor-insert', { nodeId, insertBeforeId });
          children.splice(anchorPos, 0, t.jsxText('\n    '), removedNode!);
          path.stop();
          return;
        }
        trace.action('generator:moveNodeInCode-anchor-missing', { nodeId, insertBeforeId });
      }
      if (insertIndex != null && insertIndex >= 0) {
        // Insert at specific index among JSXElement + JSXExpressionContainer children.
        // Expressions like {children} occupy a visual slot on canvas and must be counted.
        // `<style>` elements do NOT: they render no box, so every visual index
        // producer (drop line, reorder, computeLayoutInsertOrderUpdates) is
        // blind to them — counting one here shifted the whole insert a slot
        // early on any page whose root leads with a responsive-override
        // `<style>` block ("line showed below Capabilities, landed above",
        // templated page 2026-08-05).
        const children = path.node.children;
        let slotCount = 0;
        let insertPos = children.length; // fallback: append at end

        for (let i = 0; i < children.length; i++) {
          const c = children[i];
          const isStyleEl = c.type === 'JSXElement'
            && c.openingElement.name.type === 'JSXIdentifier'
            && c.openingElement.name.name === 'style';
          if ((c.type === 'JSXElement' && !isStyleEl) || c.type === 'JSXExpressionContainer') {
            if (slotCount === insertIndex) {
              insertPos = i;
              break;
            }
            slotCount++;
          }
        }

        // Insert whitespace + node at the calculated position
        children.splice(insertPos, 0, t.jsxText('\n    '), removedNode!);
      } else {
        // Append at end (default)
        path.node.children.push(t.jsxText('\n    '));
        path.node.children.push(removedNode!);
        path.node.children.push(t.jsxText('\n  '));
      }
      path.stop();
    });
    if (!parentFound) {
      // ABORT the move — the node was already spliced out of the AST above, so
      // generating from here would DELETE it from the file entirely (the
      // collection-list drag-out data loss, 2026-07-29). Returning the
      // pre-surgery string keeps the node at its old spot (styleChanges from
      // the top of the function intact); the next parse fan-out snaps the DOM
      // back to match. Classify whether the target was inside the moved
      // subtree itself (a self/descendant drop — the cache-side twin is
      // moveNodeInCache's cycle guard) so the trace names the failure mode.
      let targetInsideMovedSubtree = false;
      try {
        traverse(t.file(t.program([t.expressionStatement(t.cloneNode(removedNode!, true))])), {
          JSXAttribute(p) {
            if (
              t.isJSXIdentifier(p.node.name, { name: 'data-id' }) &&
              t.isStringLiteral(p.node.value) && p.node.value.value === newParentId
            ) {
              targetInsideMovedSubtree = true;
              p.stop();
            }
          },
        });
      } catch { /* classification is best-effort — the abort happens either way */ }
      trace.error('generator:moveNodeInCode-parent-not-found', { nodeId, newParentId, targetInsideMovedSubtree });
      return result;
    }
  }

  // Orphan-variants cleanup — the AST already reflects the moved
  // subtree's new home (insert-into-parent / append-to-existing-
  // canvasNodes-fragment). Delegated to the shared helper so the
  // create-canvasNodes-block early-return path can use the same logic.
  dropOrphanVariantConsts();

  try {
    return generate(ast, { retainLines: false, concise: false }, result).code;
  } catch (err) {
    trace.error('generator:moveNodeInCode-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return result;
  }
}

/**
 * Add a new node as a child of parentId at the given index.
 * FAST PATH: string insertion when appending as last child (no Babel, O(1)).
 * SLOW PATH: full AST when inserting at a specific index.
 */
/** Build a JSX string for a node, including children recursively. */
export type AddNodeDef = { id: string; type: string; styles: Record<string, string>; attrs?: Record<string, string>; name?: string; textContent?: string; children?: AddNodeDef[];
  /** motion props to emit on the node (e.g. `{ whileHover: { scale: '1.05' } }`).
   *  Each value is a PLAIN object (already resolved — no responsive `__mqN` markers).
   *  A node with motionProps is emitted as `motion.<tag>` so the props take effect. */
  motionProps?: Record<string, Record<string, string>> };

export function buildNodeJSX(node: AddNodeDef, isComponentFile: boolean, indent: string = '      '): string {
  const styleEntries = Object.entries(node.styles)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${quoteStyleValue(v)}`)
    .join(', ');
  const nameAttr = node.name ? ` data-name="${sanitizeDataName(node.name)}"` : '';
  // Build HTML attributes (src, alt, controls, ref, etc.). `ref` (and
  // any future identifier-valued attr) lives behind the `var:` sentinel
  // — `serializeJSXAttr` emits it as `ref={X}` instead of `ref="X"`.
  const attrsStr = node.attrs
    ? Object.entries(node.attrs).map(([k, v]) => serializeJSXAttr(k, v)).join('')
    : '';
  let tag = node.type || 'div';
  let layoutAttr = '';
  // Wrap with motion.* (and inject `layout={true}`) when this node lives
  // inside a component file — gives the master FLIP animations between
  // variants. EXCEPT for component-instance tags (`<MyCard/>`,
  // `<Header/>`, etc.): framer-motion's `motion` proxy only knows HTML
  // tag names. `motion.MyCard` evaluates to `undefined` at runtime and
  // breaks the JSX. Detect via the first-letter-uppercase rule (same as
  // `isComponentTag`); already-prefixed tags are handled by the
  // !startsWith('motion.') guard.
  const firstChar = tag.charAt(0);
  const isComponentInstanceTag = firstChar.length > 0
    && firstChar === firstChar.toUpperCase()
    && firstChar !== firstChar.toLowerCase();
  if (isComponentFile && !tag.startsWith('motion.') && !isComponentInstanceTag) {
    tag = `motion.${tag}`;
    layoutAttr = ' layout={true}';
  }
  const textContent = node.textContent || '';

  // Has children — build nested JSX
  if (node.children && node.children.length > 0) {
    const childIndent = indent + '  ';
    const childrenJSX = node.children
      .map(child => childIndent + buildNodeJSX(child, isComponentFile, childIndent))
      .join('\n');
    return `<${tag}${layoutAttr} data-id="${node.id}"${nameAttr}${attrsStr} style={{${styleEntries}}}>\n${childrenJSX}\n${indent}</${tag}>`;
  }

  if (textContent) {
    return `<${tag}${layoutAttr} data-id="${node.id}"${nameAttr}${attrsStr} style={{${styleEntries}}}>\n${indent}  ${textContent}\n${indent}</${tag}>`;
  }

  return `<${tag}${layoutAttr} data-id="${node.id}"${nameAttr}${attrsStr} style={{${styleEntries}}}></${tag}>`;
}

/**
 * Make a JSX element able to hold children before pushing any in.
 *
 * A self-closing element (`<div .../>`, `<motion.div .../>`) parses to a
 * JSXElement whose `openingElement.selfClosing` is true and whose
 * `closingElement` is null. Pushing children onto such a node and re-emitting
 * with @babel/generator is silently broken:
 *   - `selfClosing` left true  → the generator prints `<tag .../>` and RETURNS,
 *     dropping every pushed child (the insert becomes a no-op).
 *   - `selfClosing` flipped but `closingElement` still null → it prints
 *     `<tag …>child` with NO `</tag>` → unterminated JSX → the next re-parse
 *     throws and the node tree breaks.
 * Both manifest as "the inserted/dragged node vanishes and the panel crashes"
 * when the drop target is an empty self-closing element (e.g. a full-bleed
 * background/gradient layer). Converting to an open/close pair fixes both.
 *
 * No-op when the element already holds children (not self-closing).
 */
function ensureParentCanHoldChildren(el: t.JSXElement): void {
  const open = el.openingElement;
  if (!open.selfClosing) return;
  open.selfClosing = false;
  el.closingElement = t.jsxClosingElement(t.cloneNode(open.name, true));
  trace.action('generator:self-closing-parent-opened', {
    tag: t.isJSXIdentifier(open.name) ? open.name.name : 'member',
  });
}

export function addNodeInCode(
  code: string,
  parentId: string,
  node: AddNodeDef,
  index?: number,
): string {
  trace.fn('generator.addNodeInCode', { parentId, nodeId: node.id, index });

  // NOTE: an icon-set master is NOT a component file — its shapes
  // must stay plain `<svg>`, never `motion.svg` (motion shapes break thumbnails,
  // shape-edit, and group fill targeting). Guard explicitly because the icon-set
  // template's COMMENT literally contains the word "variantConfig", which would
  // otherwise trip the `code.includes('variantConfig')` heuristic and convert
  // every drawn shape to `motion.svg`.
  const isContainerSetMaster = code.includes('@iconSet');
  const isComponentFile = !isContainerSetMaster
    && (code.includes('withResponsiveProps') || code.includes('variantConfig'));
  const jsxStr = buildNodeJSX(node, isComponentFile);

  // FAST PATH: append as last child (no index = append, no Babel needed)
  if (index === undefined) {
    const fast = addNodeFast(code, parentId, jsxStr);
    if (fast !== null) return fast;
  }

  // SLOW PATH: full AST (for specific index insertion)
  return addNodeAST(code, parentId, jsxStr, index);
}

/** Fast path: find parent's closing tag and insert JSX before it. O(1), no Babel. */
function addNodeFast(code: string, parentId: string, jsxStr: string): string | null {
  // Find parent element by data-id
  const idPattern = `data-id="${parentId}"`;
  const idIdx = findJSXDataIdIndex(code, parentId);
  if (idIdx === -1) return null;

  // Find the closing tag for this element
  // Walk forward to find the matching </tag> or self-closing />
  // Strategy: find the tag name, then search for </tagName> after the opening tag
  const beforeId = code.lastIndexOf('<', idIdx);
  if (beforeId === -1) return null;

  // Extract tag name (e.g., <div data-id="..." → "div")
  const tagMatch = code.slice(beforeId + 1, idIdx).match(/^(\w+)/);
  if (!tagMatch) return null;
  const tagName = tagMatch[1];

  // Find the closing tag </tagName> after the opening tag
  // Need to handle nesting: count open/close tags of same type
  const openingEnd = code.indexOf('>', idIdx);
  if (openingEnd === -1) return null;

  // Self-closing? (e.g., <img ... />)
  if (code[openingEnd - 1] === '/') return null; // can't append children to self-closing

  // Find matching closing tag (nesting + self-closing same-tag children
  // handled by the shared depth matcher from generator-utils).
  const insertPos = findMatchingCloseTagIndex(code, tagName, openingEnd + 1);
  if (insertPos === -1) return null; // malformed / couldn't find matching close
  // Found the matching closing tag — insert before it
  return code.slice(0, insertPos) + '\n    ' + jsxStr + '\n  ' + code.slice(insertPos);
}

/** Slow path: full AST for index-specific insertion. */
function addNodeAST(code: string, parentId: string, jsxStr: string, index?: number): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  let newElement: t.JSXElement | null = null;
  try {
    const wrapperAst = parseJSX(`<_>${jsxStr}</_>`);
    if (wrapperAst) {
      traverse(wrapperAst, {
        JSXElement(path) {
          if (path.parentPath?.parentPath?.isProgram()) {
            for (const child of path.node.children) {
              if (child.type === 'JSXElement') { newElement = child; break; }
            }
            path.stop();
          }
        }
      });
    }
  } catch (err) { trace.error('generator:add-node-ast-failed', err); return code; }

  if (!newElement) return code;

  findFirstElementByDataId(ast, parentId, (path) => {
    // Drop target may be self-closing (e.g. an empty background layer) — open it
    // up so the pushed child isn't discarded / left unterminated by the generator.
    ensureParentCanHoldChildren(path.node);
    const children = path.node.children;

    if (index === undefined) {
      children.push(t.jsxText('\n    '));
      children.push(newElement!);
      children.push(t.jsxText('\n  '));
    } else {
      const elementIndices: number[] = [];
      children.forEach((child: any, i: number) => {
        if (child.type === 'JSXElement') elementIndices.push(i);
      });

      const insertBefore = index < elementIndices.length
        ? elementIndices[index]
        : children.length;

      children.splice(insertBefore, 0,
        t.jsxText('\n    '),
        newElement!,
      );
    }
    path.stop();
  });

  try {
    return generate(ast, { retainLines: false, concise: false }, code).code;
  } catch (err) {
    trace.error('generator:addNodeAST-generate-failed', { parentId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Add a canvas-level node (outside viewports).
 * FAST PATH: string concatenation only — no Babel parse/generate.
 * Writes to `const canvasNodes = (<>...</>)` AFTER the export default statement.
 * Creates the canvasNodes block if it doesn't exist yet.
 */
export function addCanvasNodeInCode(
  code: string,
  node: AddNodeDef,
): string {
  trace.fn('generator.addCanvasNodeInCode', { nodeId: node.id });

  // Build JSX string for the canvas node — inject data-canvas-node manually
  const styleEntries = Object.entries(node.styles)
    .map(([k, v]) => `${k}: ${quoteStyleValue(v)}`)
    .join(', ');
  const nameAttr = node.name ? ` data-name="${sanitizeDataName(node.name)}"` : '';
  const attrsStr = node.attrs
    ? Object.entries(node.attrs).map(([k, v]) => serializeJSXAttr(k, v)).join('')
    : '';
  const textContent = node.textContent || '';

  // Carry framer-motion props (whileHover, etc.) onto the detached canvas node so
  // the animation isn't lost when a node is dragged out of a viewport. A node with
  // motion props must be a `motion.<tag>` for the props to take effect. The values
  // are already resolved to plain objects (the strategy strips the responsive
  // `__mqN ? … : …` wrapper — a free canvas element has no viewport to gate on).
  const fmtMotionVal = (v: string) =>
    (!isNaN(Number(v)) || /^\[.*\]$/.test(v) || v === 'true' || v === 'false') ? v : `'${v}'`;
  const fmtMotionObj = (obj: Record<string, string>) =>
    `{ ${Object.entries(obj).filter(([k, v]) => v !== '' && !k.startsWith('_'))
      .map(([k, v]) => `${k}: ${fmtMotionVal(v)}`).join(', ')} }`;
  let motionPropsAttr = '';
  if (node.motionProps) {
    for (const [propName, obj] of Object.entries(node.motionProps)) {
      if (obj && Object.keys(obj).some(k => !k.startsWith('_') && obj[k] !== '')) {
        motionPropsAttr += ` ${propName}={${fmtMotionObj(obj)}}`;
      }
    }
  }
  let tag = node.type || 'div';
  if (motionPropsAttr && /^[a-z]/.test(tag) && !tag.startsWith('motion.')) tag = `motion.${tag}`;

  let jsxStr: string;
  if (node.children && node.children.length > 0) {
    const childrenJSX = node.children
      .map(child => '    ' + buildNodeJSX(child, false, '    '))
      .join('\n');
    jsxStr = `  <${tag} data-id="${node.id}"${nameAttr}${attrsStr}${motionPropsAttr} data-canvas-node="true" style={{${styleEntries}}}>\n${childrenJSX}\n  </${tag}>`;
  } else if (textContent) {
    jsxStr = `  <${tag} data-id="${node.id}"${nameAttr}${attrsStr}${motionPropsAttr} data-canvas-node="true" style={{${styleEntries}}}>\n    ${textContent}\n  </${tag}>`;
  } else {
    jsxStr = `  <${tag} data-id="${node.id}"${nameAttr}${attrsStr}${motionPropsAttr} data-canvas-node="true" style={{${styleEntries}}}></${tag}>`;
  }

  // Strategy 1: Append to existing `const canvasNodes = (<>...</>)` block
  const canvasNodesCloseIdx = findCanvasNodesFragmentClose(code);
  if (canvasNodesCloseIdx !== -1) {
    trace.action('generator:addCanvasNode-append-to-existing', { nodeId: node.id });
    return code.slice(0, canvasNodesCloseIdx) + '\n' + jsxStr + '\n' + code.slice(canvasNodesCloseIdx);
  }

  // Strategy 2: Create new canvasNodes block after `export default` line
  const exportInsertIdx = findExportDefaultEndIdx(code);
  if (exportInsertIdx !== -1) {
    trace.action('generator:addCanvasNode-create-block', { nodeId: node.id, insertIdx: exportInsertIdx });
    const block = `\n\nconst canvasNodes = (<>\n${jsxStr}\n</>);\n`;
    return code.slice(0, exportInsertIdx) + block + code.slice(exportInsertIdx);
  }

  // Strategy 3: Fallback — append at end of file
  trace.action('generator:addCanvasNode-append-end-of-file', { nodeId: node.id });
  const block = `\n\nconst canvasNodes = (<>\n${jsxStr}\n</>);\n`;
  return code + block;
}

/**
 * Find the index of `</>)` closing the canvasNodes fragment.
 * Returns the index of the `<` in `</>`, or -1 if not found.
 */
export function findCanvasNodesFragmentClose(code: string): number {
  // Look for `const canvasNodes = (<>` or `const canvasNodes = <>` (with or without parens)
  const declMatch = /const\s+canvasNodes\s*=\s*\(?\s*<>/;
  if (!declMatch.test(code)) return -1;

  const match = declMatch.exec(code)!;
  const hasParen = match[0].includes('(');
  const searchFrom = match.index + match[0].length;

  // Find the closing </> — with `)` if opened with `(`, or just `</>` without
  const closePattern = hasParen ? /<\/>\s*\)/g : /<\/>/g;
  closePattern.lastIndex = searchFrom;
  const closeMatch = closePattern.exec(code);
  if (!closeMatch) return -1;

  return closeMatch.index;
}

/**
 * Find the end of the `export default ...` statement (line end).
 * Handles:
 *   - `export default function Name(...) { ... }` — end of closing `}`
 *   - `export default withResponsiveProps(Name);` — end of `;`
 *   - `export default Name;` — end of `;`
 * Returns the index AFTER the statement ends, or -1 if not found.
 */
export function findExportDefaultEndIdx(code: string): number {
  // Try `export default withResponsiveProps(...);\n` first (component pattern)
  const wrpMatch = /export\s+default\s+withResponsiveProps\([^)]*\)\s*;/;
  const wrpResult = wrpMatch.exec(code);
  if (wrpResult) {
    return wrpResult.index + wrpResult[0].length;
  }

  // Try `export default function Name(...)` — find the function body end.
  //
  // Trickier than a plain brace match: with destructured params like
  // `function LayoutClient({ children }: { children: React.ReactNode })`
  // the FIRST `{` after the name is the destructuring pattern, not the
  // body. Same hazard with a TS return-type annotation that contains an
  // object type literal — those `{}`s are part of the signature, not
  // the body.
  //
  // Approach: walk character-by-character starting after the name.
  //   1. Skip the parameter list by matching parens (`(...)`).
  //   2. After the closing `)`, skip the optional return-type annotation.
  //   3. The next `{` at depth 0 (relative to type-literal braces) is
  //      the body.
  const funcMatch = /export\s+default\s+function\s+\w+/;
  const funcResult = funcMatch.exec(code);
  if (funcResult) {
    let i = funcResult.index + funcResult[0].length;
    // Skip whitespace until `(`
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '(') return -1;
    // Walk paren-balanced through the parameter list. Nested braces /
    // brackets inside the list (destructuring patterns, default values)
    // are skipped along with their matching pair so they don't confuse
    // the depth counter.
    let depth = 1;
    i++;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    // After the param list. Skip whitespace, then either we hit `{` (no
    // return type → body) or `:` (return type → walk through until we
    // see a top-level `{` that opens the body).
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === ':') {
      // TS return type. Walk until we hit a `{` that ISN'T inside a
      // type literal (`{ ... }`), generic (`<...>`), or paren group.
      i++;
      let typeBraceDepth = 0;
      let typeAngleDepth = 0;
      let typeParenDepth = 0;
      while (i < code.length) {
        const ch = code[i];
        if (typeBraceDepth === 0 && typeAngleDepth === 0 && typeParenDepth === 0 && ch === '{') break;
        if (ch === '{') typeBraceDepth++;
        else if (ch === '}') typeBraceDepth--;
        else if (ch === '<') typeAngleDepth++;
        else if (ch === '>') typeAngleDepth--;
        else if (ch === '(') typeParenDepth++;
        else if (ch === ')') typeParenDepth--;
        i++;
      }
    }
    if (code[i] !== '{') return -1;
    // i is the body's opening `{` — match its closer.
    let bodyDepth = 1;
    i++;
    while (i < code.length && bodyDepth > 0) {
      if (code[i] === '{') bodyDepth++;
      else if (code[i] === '}') bodyDepth--;
      i++;
    }
    return i; // index right after the closing `}`
  }

  // Try simple `export default Name;`
  const simpleMatch = /export\s+default\s+\w+\s*;/;
  const simpleResult = simpleMatch.exec(code);
  if (simpleResult) {
    return simpleResult.index + simpleResult[0].length;
  }

  return -1;
}

/**
 * Update a style property inside a @media query rule in the <style> block.
 * Source code uses real @media queries. Canvas converts to @container at render time.

// ─── Remove Node ─────────────────────────────────────────────────────────────

/**
 * Remove a node from the JSX code by its data-id.
 * Finds the full element (opening tag → closing tag) and removes it.
 */
/**
 * Remove `const xxxVariants = {...}` declarations that are no longer referenced
 * by any `variants={…}` prop in the JSX. Deleting a variant-controlled element
 * leaves its variant object behind as dead code (`const fooVariants = {...}`
 * referenced by nothing) — this collects it. Also runs when the only reference
 * was the deleted node. Matches both `variants={fooVariants}` and the
 * instance-size-override form `variants={__applyInstanceSize(fooVariants, …)}`.
 */
function removeOrphanedVariantConsts(code: string): string {
  const declRe = /const\s+(\w+Variants)\s*=\s*\{/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(code)) !== null) names.push(m[1]);

  let out = code;
  for (const name of names) {
    // `variantConfig` ends in 'Config', never matched. Skip if still referenced.
    const refRe = new RegExp(`variants=\\{(?:__applyInstanceSize\\()?${name}\\b`);
    if (refRe.test(out)) continue;

    const declMatch = new RegExp(`const\\s+${name}\\s*=\\s*\\{`).exec(out);
    if (!declMatch) continue;
    const start = declMatch.index;
    // Brace-match the object literal.
    let depth = 0, i = start + declMatch[0].length - 1, end = -1;
    for (; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    // Consume the trailing `;` and one blank line.
    let after = end + 1;
    while (after < out.length && (out[after] === ';' || out[after] === ' ' || out[after] === '\t')) after++;
    while (after < out.length && (out[after] === '\n' || out[after] === '\r')) after++;
    out = out.slice(0, start) + out.slice(after);
    trace.fn('generator.removeOrphanedVariantConst', { name });
  }
  return out;
}

/**
 * Variant-solo children are emitted wrapped in a conditional, optionally inside
 * an AnimatePresence:
 *
 *   <AnimatePresence mode="popLayout">{variant === 'X' && <el…>…</el>}</AnimatePresence>
 *   {variant !== 'X' && <el…/>}
 *
 * Removing ONLY the `<el>` leaves a dangling `{cond && }` (and an empty
 * `<AnimatePresence></AnimatePresence>`), which is a syntax error — babel
 * rejects the whole mutation and the delete is silently blocked.
 *
 * Given the element's char range `[start, end)`, this widens it to swallow an
 * enclosing `{ <simple-cond> && … }` and, if that container is the sole child
 * of an `<AnimatePresence>`, the AnimatePresence tags too. Returns the range
 * unchanged when the element isn't wrapped that way.
 */
function expandConditionalWrapperRange(code: string, start: number, end: number): { start: number; end: number } {
  // Walk back over whitespace; expect `&&` immediately before the element.
  let b = start - 1;
  while (b >= 0 && /\s/.test(code[b])) b--;
  if (b < 1 || code[b] !== '&' || code[b - 1] !== '&') return { start, end };

  // The `{` that opens the JSX expression container, and the condition between
  // it and `&&`. Reject anything but a SIMPLE condition (no nested JSX/braces)
  // so we never mis-grab a larger expression.
  const braceIdx = code.lastIndexOf('{', b);
  if (braceIdx === -1) return { start, end };
  const between = code.slice(braceIdx + 1, b - 1);
  if (/[{}<>]/.test(between)) return { start, end };

  // Closing `}` must be the next non-whitespace after the element (the element
  // is the sole content of the conditional).
  let f = end;
  while (f < code.length && /\s/.test(code[f])) f++;
  if (code[f] !== '}') return { start, end };

  let newStart = braceIdx;
  let newEnd = f + 1;

  // Swallow a solo enclosing <AnimatePresence …> … </AnimatePresence>.
  const beforeBrace = code.slice(0, braceIdx).replace(/\s+$/, '');
  const apOpen = beforeBrace.match(/<AnimatePresence\b[^>]*>$/);
  const afterCurly = code.slice(newEnd).replace(/^\s+/, '');
  if (apOpen && afterCurly.startsWith('</AnimatePresence>')) {
    newStart = beforeBrace.length - apOpen[0].length;
    newEnd = code.indexOf('</AnimatePresence>', newEnd) + '</AnimatePresence>'.length;
  }
  return { start: newStart, end: newEnd };
}

/** Data-ids INSIDE `nodeId`'s subtree whose opening tag carries an animation
 *  marker (`data-scroll-fx` / `data-text-anim`) — the descendants whose BODY
 *  hooks must be stripped when the parent is deleted. The per-node strips in
 *  removeNodeInCode only cover the deleted id itself; deleting a section
 *  around an animated child orphaned the child's hooks (live find 2026-07-12:
 *  removing the approach section left the title's 40 Te useTransform decls
 *  dangling — the querySelector ref's `|| document.body` guard kept it from
 *  crashing, so it sat unnoticed until the next AI submit bounced on
 *  SCROLL_UNBOUND_VALUE). */
function collectAnimatedDescendantIds(code: string, nodeId: string): string[] {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return [];
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart < 0) return [];
  const tagNameMatch = code.slice(tagStart).match(/^<(motion\.\w+|[A-Za-z][\w.]*)/);
  if (!tagNameMatch) return [];
  const openEnd = findTagClose(code, tagStart);
  if (openEnd < 0) return [];
  if (code[openEnd - 1] === '/') return [];   // self-closing — no descendants
  const closeIdx = findMatchingCloseTagIndex(code, tagNameMatch[1], openEnd + 1);
  if (closeIdx < 0) return [];
  const inner = code.slice(openEnd + 1, closeIdx);

  const out: string[] = [];
  const seen = new Set<string>();
  const re = /data-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const id = m[1];
    if (id === nodeId || seen.has(id)) continue;
    const dTagStart = inner.lastIndexOf('<', m.index);
    if (dTagStart < 0) continue;               // a CSS selector string, not a tag
    const dTagEnd = findTagClose(inner, dTagStart);
    if (dTagEnd < 0 || dTagEnd < m.index) continue;
    const openTag = inner.slice(dTagStart, dTagEnd + 1);
    if (/\sdata-(?:scroll-fx|text-anim)=/.test(openTag)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function removeNodeInCode(code: string, nodeId: string): string {
  trace.fn('generator.removeNodeInCode', { nodeId });

  // Strip ALL scroll/motion artifacts BEFORE the JSX strip — they live in the
  // component body (useMotionValue / useEffect / useTransform / useInView), so once
  // the element is gone they'd dangle, referencing now-undefined vars. clearNodeScrollFx
  // de-combines the node (appear/loop/gesture/direction), removes the scroll hooks
  // (transform/speed/direction), and sweeps any leftover `const <node>X` decls. It
  // must run while the JSX still exists (the removers parse against the style block).
  // No-op for plain (non-animated) nodes.
  // Descendants first (their ids are only findable while the subtree exists);
  // see collectAnimatedDescendantIds — a deleted PARENT must not orphan an
  // animated child's body hooks.
  for (const descId of collectAnimatedDescendantIds(code, nodeId)) {
    code = clearNodeScrollFx(code, descId);
    code = stripScrollTextHooks(code, descId);
    trace.action('generator:removeNode-descendant-hooks-stripped', { nodeId, descId });
  }
  code = clearNodeScrollFx(code, nodeId);
  // Text Effect "On Scroll" leaves its own isolated body hooks (Te-named useScroll/useTransform/ref) —
  // strip them too so they don't dangle once the element is gone.
  code = stripScrollTextHooks(code, nodeId);

  // Slot-hoisted canvas nodes live inside `const cn_<id> = <jsx/>` decls
  // (see slot-ops.ts). The string-based JSX strip below would null the
  // const's init and leave `const cn_<id> = ;` — a parse error. Detect
  // and route through the slot-aware helper: it removes the const decl
  // AND every `{cn_<id>}` reference across the file, fully unwiring the
  // node before it's gone. No-op when the node isn't slot-hoisted.
  const slotRemoved = removeSlotHoistedCanvasNodeInCode(code, nodeId);
  if (slotRemoved !== code) return slotRemoved;

  // MAP TEMPLATE BODY — deleting the template row of a `.map()` collection
  // list (`coll.slice(…).map((item, idx) => <Card/>)`). The string strip below
  // removes just the JSX and leaves `…map((item, idx) => )}` — a syntax error
  // that blocks the whole batch (live find 2026-07-08: deleting a works-column
  // card → "Unexpected token", nothing deletes). Route through the same
  // handler the MOVE path uses: replace the callback body with `null`, keeping
  // the `.map()` as an EMPTY refillable collection list (the reference's Empty State)
  // — the container div + its Collection List tool survive.
  if (code.includes('.map(')) {
    const ast = parseJSX(code);
    if (ast) {
      let handled = false;
      findFirstElementByDataId(ast, nodeId, (path) => {
        handled = replaceMapTemplateBodyWithNull(path);
      });
      if (handled) {
        try {
          let result = generate(ast, { retainLines: false, concise: false }, code).code;
          result = clearContainerStylesForNode(result, nodeId);
          result = removeHoverStyleInCode(result, nodeId);
          result = removeBorderOverlayStyle(result, nodeId);
          trace.action('generator:removeNode-empty-map-template', { nodeId });
          return removeOrphanedVariantConsts(result);
        } catch (err) {
          trace.error('generator:removeNode-map-template-generate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
          // fall through to the string path (it will bounce in validation
          // rather than silently corrupting)
        }
      }
    }
  }

  // Find data-id="nodeId" in the code — skip CSS occurrences (inside <style> blocks).
  // CSS selectors like [data-id="x"] match the same pattern, so we iterate until
  // we find one that's an actual JSX attribute (preceded by a valid opening tag).
  const idPattern = `data-id="${nodeId}"`;
  let idIdx = -1;
  let searchFrom = 0;
  let openStart = -1;
  let tagName = '';

  while (searchFrom < code.length) {
    idIdx = code.indexOf(idPattern, searchFrom);
    if (idIdx === -1) return code;

    // Find the opening < before data-id
    openStart = code.lastIndexOf('<', idIdx);
    if (openStart === -1) { searchFrom = idIdx + idPattern.length; continue; }

    // Extract tag name — valid JSX tags start with a letter after <
    // Handles member expressions like motion.div, motion.p
    const tagMatch = code.slice(openStart + 1, idIdx).match(/^(\w+(?:\.\w+)?)/);
    if (tagMatch && tagMatch[1] !== 'style') {
      tagName = tagMatch[1];
      break; // Found a real JSX element, not a CSS selector
    }

    // This occurrence is inside CSS — skip and look for the next one
    searchFrom = idIdx + idPattern.length;
  }

  if (!tagName) return code;

  // Check if self-closing (ends with />). Use findTagClose (brace/string aware)
  // NOT indexOf('>') — an attribute value can contain a `>` (e.g. an arrow
  // handler `onChange={(e) => …}` or a JSX expression), and a naive indexOf
  // would stop at that `>`, mis-detect the tag as non-self-closing, hunt for a
  // nonexistent `</input>`, and bail → the node silently fails to delete ("it
  // just comes back"). This bit the CMS Search Field input.
  const afterId = findTagClose(code, idIdx);
  if (afterId === -1) return code;

  if (code[afterId - 1] === '/') {
    // Self-closing: <tag ... />
    // Widen to any `{cond && …}` / <AnimatePresence> wrapper so a variant-solo
    // child doesn't leave a dangling `{cond && }`.
    const { start: rmStart, end: rmEnd } = expandConditionalWrapperRange(code, openStart, afterId + 1);
    // Remove the (possibly widened) range, plus any trailing whitespace/newline
    let endIdx = rmEnd;
    while (endIdx < code.length && (code[endIdx] === '\n' || code[endIdx] === '\r')) endIdx++;
    let selfClosed = code.slice(0, rmStart) + code.slice(endIdx);
    selfClosed = clearContainerStylesForNode(selfClosed, nodeId);
    selfClosed = removeHoverStyleInCode(selfClosed, nodeId);
    selfClosed = removeBorderOverlayStyle(selfClosed, nodeId);
    return removeOrphanedVariantConsts(selfClosed);
  }

  // Find matching closing tag </tagName> — the shared depth matcher SKIPS
  // self-closing same-tag children (`<div … />` has NO matching `</div>`;
  // counting them over-counts depth, the matcher runs past this node's real
  // `</div>` and swallows a PARENT's close (→ "Unterminated JSX contents")
  // or runs off the end (→ delete silently reverts, "nothing happened")).
  const nextClose = findMatchingCloseTagIndex(code, tagName, afterId + 1);
  if (nextClose !== -1) {
    const endIdx = nextClose + `</${tagName}>`.length;
    // Widen to any `{cond && …}` / <AnimatePresence> wrapper so a
    // variant-solo child doesn't leave a dangling `{cond && }`.
    const { start: rmStart, end: rmEnd } = expandConditionalWrapperRange(code, openStart, endIdx);
    // Remove trailing whitespace/newline
    let trimEnd = rmEnd;
    while (trimEnd < code.length && (code[trimEnd] === '\n' || code[trimEnd] === '\r')) trimEnd++;
    let result = code.slice(0, rmStart) + code.slice(trimEnd);
    // Also clean up any @media CSS rules referencing this node
    result = clearContainerStylesForNode(result, nodeId);
    result = removeHoverStyleInCode(result, nodeId);
    result = removeBorderOverlayStyle(result, nodeId);
    // Garbage-collect the deleted element's now-orphaned variant object(s).
    result = removeOrphanedVariantConsts(result);
    return result;
  }

  return code; // Couldn't find matching close — return unchanged
}

