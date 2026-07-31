// generator-motion-props.ts — framer-motion prop writes (whileHover/whileTap/…)
// plus per-scope (viewport/variant) value overrides on those props.
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { trace } from '@/shared/debug-trace';
import { findTagClose, findJSXDataIdIndex, findMatchingCloseTagIndex, findStyleObjectEnd, insertAfterLastImportLine } from './generator-utils';
import { convertToMotionLinkInCode } from './generator-attrs';
import { scopeMotionValueResolved, type ResolvedScope } from '@/code/animations/animation-scope';
import { scopeTest, testToScope, ensureMediaQueryHook, ensureMediaGate, detectVariantVar, type SerScope } from './scoped-expr';
import { wrapInstanceWithMotionConfig } from './generator-motion-transition';
import { parseObjLiteral } from './generator-motion-loop';
import { type FxScopeOverride } from './generator-motion-scroll-fx';

// ─── Motion Props Manipulation ────────────────────────────────────────

/**
 * Add or update a Motion prop (whileHover, whileTap, etc.) on a node.
 * Handles:
 * 1. If prop exists → update/add properties inside the object
 * 2. If prop missing → add the JSX attribute
 * 3. If element is not motion.* → convert tag + add import
 */
export function updateMotionPropInCode(
  code: string,
  nodeId: string,
  propName: string,
  props: Record<string, string>,
): string {
  trace.fn('generator.updateMotionPropInCode', { nodeId, propName, props });

  const idPattern = `data-id="${nodeId}"`;
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  // Find opening tag boundaries
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart === -1) return code;
  // Find the actual closing > of the opening tag (skip over {{ }} expressions)
  const tagEnd = findTagClose(code, idIdx);
  if (tagEnd === -1) return code;

  const isSelfClosing = code[tagEnd - 1] === '/';
  const tagMatch = code.slice(tagStart + 1).match(/^([\w.]+)/);
  if (!tagMatch) return code;
  const tagName = tagMatch[1];

  // Next.js `<Link>` is the one component instance that CAN carry motion props
  // — via the documented `motion.create(Link)` wrapper (our `MotionLink`).
  // Convert the link in place (declaring the const once), then re-run: the tag
  // is now `MotionLink`, which the routing below treats as a motion element and
  // the prop applies normally. Same escape hatch design components use, now
  // available for a `<Link>` on a plain page. syncImports (updateMotionProp is
  // import-affecting) adds `import Link from 'next/link'` + `motion`.
  if (tagName === 'Link') {
    const converted = convertToMotionLinkInCode(code, nodeId);
    if (converted !== code) {
      trace.action('generator:link-to-motionlink-for-motion-prop', { nodeId, propName });
      return updateMotionPropInCode(converted, nodeId, propName, props);
    }
  }

  // Component-instance routing. PascalCase tags are React components, not
  // HTML elements — `motion.<ComponentName>` does NOT exist in framer-motion's
  // proxy (only HTML tag names work), and the legacy lowercasing hack
  // (`motion.${tagName.toLowerCase()}`) produces something like
  // `motion.mojiba` which renders as a literal `<mojiba>` HTML element and
  // disappears from the DOM. Worse, framer-motion props like `transition`,
  // `whileHover`, etc. are silently ignored on a regular React component
  // anyway — adding them to the JSX has no effect at runtime.
  //
  // For `transition` we have a usable workaround: wrap the instance in
  // `<MotionConfig transition={...}>`. MotionConfig propagates transitions
  // to all motion descendants via React context, including the master
  // root inside the component's expansion. For other motion props
  // (whileHover/whileTap/etc.) MotionConfig doesn't apply — silently
  // skip rather than break the JSX.
  const isComponentInstanceTag = tagName.length > 0
    && tagName[0] === tagName[0].toUpperCase()
    && tagName[0] !== tagName[0].toLowerCase()
    && !tagName.startsWith('motion.')
    && tagName !== 'LayoutGroup'
    && tagName !== 'MotionConfig'
    // MotionLink IS a motion component (`motion.create(Link)`) — motion props
    // apply directly. Treat it like a motion.* element, not an inert instance.
    && tagName !== 'MotionLink';

  if (isComponentInstanceTag) {
    if (propName === 'transition') {
      return wrapInstanceWithMotionConfig(code, nodeId, props);
    }
    trace.action('generator:motion-prop-skipped-on-component-instance', { nodeId, tagName, propName });
    return code;
  }

  let result = code;

  // Step 1: Convert to motion.* if needed. `MotionLink` is already a motion
  // component (`motion.create(Link)`) — leave the tag as-is and just apply the
  // prop (turning it into `motion.motionlink` would render a broken element).
  if (!tagName.startsWith('motion.') && tagName !== 'MotionLink') {
    const baseTag = tagName.toLowerCase();
    const motionTag = `motion.${baseTag}`;
    result = result.slice(0, tagStart + 1) + motionTag + result.slice(tagStart + 1 + tagName.length);

    if (!isSelfClosing) {
      // Find the MATCHING closing tag by balancing same-name opens/closes (a plain
      // indexOf grabs a child's closer first). Self-close-aware, so self-closing
      // children (e.g. logo-dot `<div … />`) don't desync the depth count — the bug
      // that made "add Appear to a section with self-closing descendants" emit a
      // mismatched `<motion.div> … </div>` and bounce validation.
      const closePattern = `</${tagName}>`;
      const closeIdx = findMatchingCloseTagIndex(result, tagName, tagStart + motionTag.length + 1);
      if (closeIdx !== -1) {
        result = result.slice(0, closeIdx) + `</motion.${baseTag}>` + result.slice(closeIdx + closePattern.length);
      }
    }

    if (!result.includes("from 'framer-motion'") && !result.includes('from "framer-motion"')) {
      const importLine = "import { motion } from 'framer-motion';";
      result = insertAfterLastImportLine(result, importLine) ?? (importLine + '\n' + result);
    }
    trace.action('generator:converted-to-motion', { nodeId, from: tagName, to: motionTag });
  }

  // Step 2: Format prop value.
  //
  // Values arrive as strings from the mutation layer. We need to emit them
  // as JSX-literal source — most are unquoted (numbers, arrays, booleans,
  // Infinity), while CSS/string values are wrapped in single quotes.
  //
  // The previous detection only treated numbers as unquoted; everything
  // else (including arrays like `[0, 360]` for loop keyframes and
  // `Infinity` for transition.repeat) got single-quoted and landed in
  // JSX as a CSS-like string that framer-motion silently ignores.
  const isJsxLiteral = (v: string): boolean => {
    if (v === '') return false;
    // Number or Infinity / -Infinity (Number('Infinity') === Infinity, isNaN(Infinity) === false).
    if (!isNaN(Number(v))) return true;
    // Array literal — `[0, 360]`, `[1, 1.1, 1]`. Loop keyframes.
    if (v.startsWith('[') && v.endsWith(']')) return true;
    // Object literal — `{ stiffness: 170 }`. Reserved for callers that
    // already format their own nested objects (motion variants config).
    if (v.startsWith('{') && v.endsWith('}')) return true;
    // Boolean.
    if (v === 'true' || v === 'false') return true;
    return false;
  };
  const propEntries = Object.entries(props)
    // Skip internal markers (e.g. `_scope`, `_variantName`) — they're parser
    // annotations, never real animated props, and must not be written back.
    .filter(([k, v]) => v !== '' && v !== undefined && !k.startsWith('_'))
    .map(([k, v]) => `${k}: ${isJsxLiteral(v) ? v : `'${v}'`}`)
    .join(', ');
  const propValue = `{{ ${propEntries} }}`;

  // Step 3: Find element again (indices shifted from tag conversion)
  const newIdIdx = findJSXDataIdIndex(result, nodeId);
  if (newIdIdx === -1) return result;
  const newTagStart = result.lastIndexOf('<', newIdIdx);
  const newTagEnd = findTagClose(result, newIdIdx);
  if (newTagStart === -1 || newTagEnd === -1) return result;

  // Find an existing `propName={ … }` — tolerant of a per-scope ternary wrapper
  // (`propName={variant === 'x' ? { … } : undefined}`). We replace only the
  // OBJECT literal, preserving any wrapper, so re-editing a scoped hover's props
  // doesn't duplicate the attribute. `findMotionPropExpr` returns the content
  // range between the `={` and its matching `}`.
  const expr = findMotionPropExpr(result, nodeId, propName);
  if (expr) {
    const exprText = result.slice(expr.start, expr.end);
    const obj = objectFromExpr(exprText);
    if (obj) {
      // Replace just the `{ … }` object inside the (possibly wrapped) expression.
      const objIdx = exprText.indexOf(obj.text);
      const newExprText = exprText.slice(0, objIdx) + `{ ${propEntries} }` + exprText.slice(objIdx + obj.text.length);
      result = result.slice(0, expr.start) + newExprText + result.slice(expr.end);
    } else {
      result = result.slice(0, expr.start) + `{ ${propEntries} }` + result.slice(expr.end);
    }
  } else {
    const insertPos = newTagEnd - (result[newTagEnd - 1] === '/' ? 1 : 0);
    result = result.slice(0, insertPos) + `\n          ${propName}=${propValue}\n          ` + result.slice(insertPos);
  }

  // A transform-animating value prop landed → if the element also carries a
  // static `style.transform` (the pin's translate), pair it with the composing
  // transformTemplate so motion doesn't drop it. See the helper's header.
  if (propName === 'initial' || propName === 'whileInView' || propName === 'animate') {
    result = ensureTransformTemplateInCode(result, nodeId);
  }

  return result;
}

// ─── Per-scope wrapping for motion props (whileHover, etc.) ──────────────────

/** Locate the JSX expression value of `propName={ … }` on a node — the content
 *  range between the opening `={` and its matching `}`. Null if absent. */
function findMotionPropExpr(code: string, nodeId: string, propName: string): { start: number; end: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return null;
  const at = code.slice(tagStart, tagEnd + 1).indexOf(`${propName}={`);
  if (at === -1) return null;
  const start = tagStart + at + propName.length + 2; // just after `={`
  const endIdx = findStyleObjectEnd(code, start);
  const i = endIdx === -1 ? code.length : endIdx;
  return { start, end: i }; // code[end] === the closing '}'
}

/** The object literal `{ … }` inside a prop expression (bare or ternary-wrapped). */
function objectFromExpr(expr: string): { text: string } | null {
  const m = expr.match(/\{[\s\S]*\}/); // the object is the only brace pair in these exprs
  return m ? { text: m[0] } : null;
}

/**
 * Wrap (or unwrap) a motion prop value for a per-breakpoint / per-variant scope.
 * Run AFTER updateMotionPropInCode wrote the bare `{{ … }}`.
 *   variant  → `propName={variant === 'x' ? { … } : undefined}`
 *   viewport → `propName={<gateVar> ? { … } : undefined}` (caller injected gateVar)
 *   null     → bare `propName={{ … }}` (unwraps)
 */
export function scopeMotionPropInCode(
  code: string,
  nodeId: string,
  propName: string,
  scope: ResolvedScope,
  opts: { variantVar?: string } = {},
): string {
  // Page viewport scope → ensure a REACTIVE useMediaQuery gate (hook + const) so
  // the prop re-evaluates on resize. Variant scope (component) needs neither.
  let gateVar: string | undefined;
  if (scope && 'query' in scope) {
    code = ensureMediaQueryHook(code);
    const g = ensureMediaGate(code, scope.query);
    code = g.code;
    gateVar = g.gateVar;
  }
  const expr = findMotionPropExpr(code, nodeId, propName);
  if (!expr) return code;
  const exprText = code.slice(expr.start, expr.end);
  const obj = objectFromExpr(exprText);
  if (!obj) return code;
  const newExpr = scopeMotionValueResolved(obj.text, scope, {
    variantVar: opts.variantVar ?? detectVariantVar(code), gateVar, off: 'undefined',
  });
  return code.slice(0, expr.start) + newExpr + code.slice(expr.end);
}

// ─── Per-viewport / per-variant VALUE overrides (responsive animation) ───────
//
// A prop value can be a base PLUS per-scope overrides, expressed as a ternary
// chain: `gate1 ? {override1} : gate2 ? {override2} : {base}`. Editing on a
// replica updates THAT scope's branch (keeping the base); editing on primary
// updates the base. This is the animation analogue of base + @media style
// overrides. When there's no base (a scoped-only effect), the tail is
// `undefined` (true removal off-scope).

/** Parse a prop expression into its base (tail) + per-test override branches.
 *  A branch value is an object (`{…}` — a per-scope VALUE override) or the
 *  PRESENCE sentinels `false` / `undefined` (effect turned off on that scope). */
function parseScopedExpr(expr: string): { base: string; overrides: Map<string, string> } {
  const overrides = new Map<string, string>();
  let rest = expr.trim();
  // Peel `TEST ? {OBJ}|false|undefined :` segments off the front (the object has no nested braces).
  while (true) {
    const m = rest.match(/^(.+?)\s*\?\s*(\{[^{}]*\}|false|undefined)\s*:\s*([\s\S]+)$/);
    if (!m) break;
    overrides.set(m[1].trim(), m[2]);
    rest = m[3].trim();
  }
  return { base: rest, overrides }; // base is `{ … }` or `undefined`
}

/** Rebuild a ternary chain from base (tail) + override branches. */
function rebuildScopedExpr(base: string, overrides: Map<string, string>): string {
  let expr = base;
  for (const [test, obj] of [...overrides].reverse()) expr = `${test} ? ${obj} : ${expr}`;
  return expr;
}

/** Format an animation props map as a `{ k: v, … }` object literal (numbers,
 *  arrays, booleans unquoted; strings single-quoted; `_`-markers dropped). */
function formatMotionPropObject(props: Record<string, string>): string {
  const lit = (v: string) => v !== '' && (!isNaN(Number(v)) || /^\[.*\]$/.test(v) || v === 'true' || v === 'false');
  const entries = Object.entries(props)
    .filter(([k, v]) => v !== '' && v !== undefined && !k.startsWith('_'))
    .map(([k, v]) => `${k}: ${lit(v) ? v : `'${v}'`}`)
    .join(', ');
  return `{ ${entries} }`;
}

/**
 * Write `props` as the value for `scope` on a motion prop, KEEPING the base and
 * any other-scope branches. scope=null → set the base; scope=viewport/variant →
 * set/add that branch (base preserved → "responsive"). Creates the prop if absent.
 */
export function setMotionPropScopedValue(
  code: string, nodeId: string, propName: string,
  props: Record<string, string>, scope: ResolvedScope,
): string {
  const t = scopeTest(code, scope); code = t.code;
  const objStr = formatMotionPropObject(props);
  const expr = findMotionPropExpr(code, nodeId, propName);

  if (!expr) {
    // No existing prop → create. updateMotionPropInCode handles motion.*
    // conversion + import + a bare `{{…}}`; then re-wrap if this is a scope.
    const created = updateMotionPropInCode(code, nodeId, propName, props);
    if (!t.test) return created;
    const e2 = findMotionPropExpr(created, nodeId, propName);
    if (!e2) return created;
    return created.slice(0, e2.start) + `${t.test} ? ${objStr} : undefined` + created.slice(e2.end);
  }

  const { base, overrides } = parseScopedExpr(code.slice(expr.start, expr.end));
  if (t.test) overrides.set(t.test, objStr);          // viewport/variant branch
  const newBase = t.test ? base : objStr;              // primary → set base
  return code.slice(0, expr.start) + rebuildScopedExpr(newBase, overrides) + code.slice(expr.end);
}

/** Read a motion prop's responsive ternary chain into `{ base, responsive }` — the
 *  capture side of the per-scope spec (inverse of re-emitting via
 *  `setMotionPropScopedValue`). base/overrides come from `parseScopedExpr`; each
 *  override TEST is mapped back to a serializable scope via `testToScope`. */
function readMotionPropResponsive(
  code: string, nodeId: string, propName: string,
): { base: Record<string, string>; responsive: FxScopeOverride[]; hiddenOn: SerScope[] } | null {
  const expr = findMotionPropExpr(code, nodeId, propName);
  if (!expr) return null;
  const { base, overrides } = parseScopedExpr(code.slice(expr.start, expr.end));
  const baseProps = base.trim() === 'undefined' ? {} : parseObjLiteral(base);
  const responsive: FxScopeOverride[] = [];
  const hiddenOn: SerScope[] = [];
  for (const [test, obj] of overrides) {
    const scope = testToScope(code, test);
    if (!scope) continue;
    // PRESENCE sentinel branch (`false`/`undefined`) = effect turned OFF on
    // that scope (the gateMotionPropHidden form), not a value override.
    if (obj === 'false' || obj === 'undefined') hiddenOn.push(scope);
    else responsive.push({ scope, props: parseObjLiteral(obj) });
  }
  return { base: baseProps, responsive, hiddenOn };
}

/** Drop a scope's override branch (Reset Override). Collapses to the base, or
 *  removes the prop entirely when nothing's left (base undefined, no branches). */
export function removeMotionPropScopeBranch(
  code: string, nodeId: string, propName: string, scope: ResolvedScope,
): string {
  const t = scopeTest(code, scope);
  if (!t.test) return code; // nothing to reset on primary
  const expr = findMotionPropExpr(code, nodeId, propName);
  if (!expr) return code;
  const { base, overrides } = parseScopedExpr(code.slice(expr.start, expr.end));
  if (!overrides.delete(t.test)) return code;
  if (overrides.size === 0 && base.trim() === 'undefined') {
    return removeMotionPropFromCode(code, nodeId, propName); // scoped-only → remove
  }
  return code.slice(0, expr.start) + rebuildScopedExpr(base, overrides) + code.slice(expr.end);
}

/**
 * Remove a Motion prop from a node.
 */
export function removeMotionPropFromCode(
  code: string,
  nodeId: string,
  propName: string,
): string {
  trace.fn('generator.removeMotionPropFromCode', { nodeId, propName });

  const idPattern = `data-id="${nodeId}"`;
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = code.indexOf('>', idIdx);
  if (tagStart === -1 || tagEnd === -1) return code;

  // Component-instance routing: `transition` on a PascalCase instance was
  // written as a `<MotionConfig>` wrapper, so removal strips the wrapper
  // rather than searching for an attribute on the JSX.
  const tagNameMatch = code.slice(tagStart + 1).match(/^([A-Za-z][A-Za-z0-9]*)/);
  const tagName = tagNameMatch?.[1] ?? '';
  const isComponentInstanceTag = tagName.length > 0
    && tagName[0] === tagName[0].toUpperCase()
    && tagName[0] !== tagName[0].toLowerCase()
    && !tagName.startsWith('motion.')
    && tagName !== 'LayoutGroup'
    && tagName !== 'MotionConfig'
    // MotionLink carries motion props directly (it's `motion.create(Link)`), so
    // a `transition` on it is a real attribute — strip it like any other prop,
    // not a MotionConfig wrapper.
    && tagName !== 'MotionLink';
  if (isComponentInstanceTag && propName === 'transition') {
    return wrapInstanceWithMotionConfig(code, nodeId, null);
  }

  // Remove the whole `propName={…}` attribute — handles the bare `{{…}}` object
  // AND the per-scope ternary `{__mq0 ? {…} : undefined}` / `{variant === 'x' ?
  // {…} : undefined}`. The old `={{…}}` regex didn't match the ternary, so
  // resetting a scoped hover did nothing.
  const expr = findMotionPropExpr(code, nodeId, propName);
  if (!expr) return code;
  let attrStart = code.lastIndexOf(`${propName}=`, expr.start);
  if (attrStart === -1) return code;
  while (attrStart > 0 && /\s/.test(code[attrStart - 1])) attrStart--;
  let result = code.slice(0, attrStart) + code.slice(expr.end + 1);
  // The removed prop may have been the last transform-animating one — reap the
  // now-sourceless transformTemplate rather than leaving a stale composer.
  if (propName === 'initial' || propName === 'whileInView' || propName === 'animate') {
    result = ensureTransformTemplateInCode(result, nodeId);
  }
  return result;
}



// ─── transformTemplate — compose a static CSS transform with motion's ────────
//
// The moment a motion element animates ANY transform value (x/y/scale/rotate,
// e.g. an Appear's `y`), framer-motion takes ownership of `style.transform` and
// REBUILDS the whole string from its own values — a static authored string like
// the pin's `translate(-50%, -50%)` is silently dropped. On a pinned aura
// (top/left in %, centred by the translate) that shifts the element by half its
// own size the moment the appear runs: correct on the canvas (which paints the
// resting style), broken on the live page (user report 2026-07-27).
//
// `transformTemplate` is framer-motion's own escape hatch: the template
// receives motion's generated string and composes it AFTER our static prefix.
// Verified against framer-motion 12.38 (build-transform.mjs): with a template
// present the generated part is '' at rest — never the "none" that would make
// the composed string invalid CSS — and the template applies even when no
// transform value is animating, so the centring holds unconditionally.
//
// SINGLE WRITER + DERIVED, never authored: the prefix is always re-derived from
// the element's CURRENT `style.transform`, from every path that can change
// either side (motion-prop writes here, `transform` style writes in
// generator-crud). Hand-editing the template independently is exactly the drift
// the MOTION_TRANSFORM_TEMPLATE_DRIFT oracle rule exists to catch.

/** Motion value keys that live in the transform string. */
const MOTION_TRANSFORM_KEY_RE =
  /[{,]\s*(?:x|y|z|rotate|rotateX|rotateY|rotateZ|scale|scaleX|scaleY|scaleZ|skewX|skewY|transformPerspective)\s*:/;

/** The one canonical serialization this writer emits and recognises. */
const TT_ATTR_RE = /\s*transformTemplate=\{\(_, generated\) => `([^`]*?)\s*\$\{generated\}`\}/;

export function buildTransformTemplateAttr(prefix: string): string {
  return `transformTemplate={(_, generated) => \`${prefix} \${generated}\`}`;
}

/**
 * Make the element's `transformTemplate` agree with its static `style.transform`.
 *  - static transform + an animated transform value → attr present, prefix = the
 *    static transform;
 *  - either side gone → the canonical attr is removed;
 *  - a foreign (hand-written, non-canonical) template is left untouched.
 * Idempotent; returns `code` unchanged when nothing needs to move.
 */
export function ensureTransformTemplateInCode(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return code;
  const tag = code.slice(tagStart, tagEnd + 1);

  // Only motion.* elements (and MotionLink) run motion's transform builder.
  if (!/^<(?:motion\.|MotionLink)/.test(tag)) return code;

  // The static transform: a quoted literal in the style object — either quote
  // style (the AST generator emits double quotes for values containing a
  // single quote; live pages carry both). A ternary / template / variable
  // transform is not a shape we can prefix safely — treat as absent. Caught by
  // the drift oracle rule on a live page: the writer's single-quote-only match
  // skipped a `transform: "translate(-50%, -50%)"` node (2026-07-27).
  const staticT = (tag.match(/[{,\s]transform\s*:\s*'([^']+)'/)?.[1]
    ?? tag.match(/[{,\s]transform\s*:\s*"([^"]+)"/)?.[1])?.trim() ?? '';

  // Does anything animate a transform value? The appear props (initial /
  // whileInView / animate object literals) or a motion shorthand key in the
  // style object itself.
  let animates = false;
  for (const prop of ['initial', 'whileInView', 'animate'] as const) {
    const expr = findMotionPropExpr(code, nodeId, prop);
    if (expr && MOTION_TRANSFORM_KEY_RE.test(code.slice(expr.start, expr.end))) { animates = true; break; }
  }
  if (!animates) {
    const styleStart = tag.indexOf('style={{');
    if (styleStart !== -1) {
      const styleEnd = findStyleObjectEnd(tag, styleStart + 8);
      if (styleEnd !== -1 && MOTION_TRANSFORM_KEY_RE.test(tag.slice(styleStart + 7, styleEnd + 1))) animates = true;
    }
  }

  const existing = tag.match(TT_ATTR_RE);
  const needs = staticT !== '' && !staticT.includes('`') && animates;

  if (!needs) {
    if (!existing) return code;
    // Remove only OUR canonical attr — its prefix no longer has a source.
    trace.action('generator:transform-template-removed', { nodeId, hadPrefix: existing[1] });
    const newTag = tag.replace(TT_ATTR_RE, '');
    return code.slice(0, tagStart) + newTag + code.slice(tagEnd + 1);
  }

  if (existing) {
    if (existing[1].trim() === staticT) return code; // already in sync
    trace.action('generator:transform-template-refreshed', { nodeId, from: existing[1], to: staticT });
    const newTag = tag.replace(TT_ATTR_RE, ` ${buildTransformTemplateAttr(staticT)}`);
    return code.slice(0, tagStart) + newTag + code.slice(tagEnd + 1);
  }

  // A non-canonical template we didn't write — leave the author's code alone.
  if (tag.includes('transformTemplate=')) {
    trace.action('generator:transform-template-foreign-skipped', { nodeId });
    return code;
  }

  trace.action('generator:transform-template-added', { nodeId, prefix: staticT });
  const insertPos = tagEnd - (code[tagEnd - 1] === '/' ? 1 : 0);
  return code.slice(0, insertPos) + ` ${buildTransformTemplateAttr(staticT)} ` + code.slice(insertPos);
}

export { findMotionPropExpr, parseScopedExpr, rebuildScopedExpr, formatMotionPropObject, readMotionPropResponsive };
