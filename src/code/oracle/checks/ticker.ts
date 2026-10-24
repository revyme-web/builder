// oracle/checks/ticker.ts — `<RevymeTicker>` (the Ticker effect) wraps exactly
// one layout frame, with literal settings, imported from the runtime.
//
// The runtime `RevymeTicker` (runtime/src/ticker.tsx) animates its ONE element
// child — the frame, or the element an `<Override>` inside it wraps — and
// scrolls that frame's own children. With zero, several or non-element
// children it silently renders them still, while the parser hands the Ticker
// to EVERY element child (the panel shows a ticker on each) and the editor's
// lift/restore (element-wrapper.ts) re-wraps only the first one on the next
// edit. The wrapper is carried by the frame's data-id, the panel reads the
// settings back as literals only (parser.ts tickerFromOpening), and the frame
// must be a flex layout for its children to line up into a strip. An
// AI/MCP-authored file bypasses the panel that guarantees all of this, so this
// rule stands in for it.
//
// Tier 3 for what leaves the effect unresolvable or crashes the page (child
// count, a RevymeTicker that is not the runtime's), tier 2 for what the editor
// can't read back or carry (frame data-id, settings, layout).

import * as t from '@babel/types';
import { traverse, jsxTagName, jsxAttrs } from './shared';
import type { OracleViolation } from './shared';
import { TICKER_DEFAULTS, TICKER_RANGES } from '@/shared/ticker-config';

const TAG = 'RevymeTicker';
const DIRECTIONS = new Set(['left', 'right', 'up', 'down']);
/** The ranges normalizeTicker clamps to (ticker-config.ts) — a value outside
 *  one plays as written on the site but reads back clamped in the panel. */
const NUMERIC_PROPS: Record<string, { min: number; max: number }> = TICKER_RANGES;
const ALLOWED_PROPS = new Set(['speed', 'direction', 'hoverSpeed', 'draggable', 'fade', 'disabled', 'responsive', 'variant']);
/** Keys of one `responsive` entry besides `scope`. */
const OVERRIDE_KEYS = new Set(['speed', 'hoverSpeed', 'draggable', 'fade', 'disabled']);
const RESPONSIVE_SHAPE = 'responsive={[{ scope: { query: "(max-width: 767px)" }, speed: 40, fade: 0 }]} — one entry per breakpoint (scope { query: "<the viewport\'s media band>" }) or component variant (scope { variant: "name" }, with variant={variant} on the wrapper), each with only the settings that differ there: speed, hoverSpeed, draggable, fade (number / boolean literals), disabled (true = off there, false = on there while the base is disabled)';

/** Problems in a `responsive={[…]}` value, and whether it has `{ variant }` scopes. */
function responsiveProblems(expr: t.Node | null): { problems: string[]; variantScoped: boolean } {
  if (!t.isArrayExpression(expr)) return { problems: ['responsive must be an array literal'], variantScoped: false };
  const problems: string[] = [];
  let variantScoped = false;
  const seen = new Set<string>();
  expr.elements.forEach((el, i) => {
    const at = `responsive[${i}]`;
    if (!t.isObjectExpression(el)) { problems.push(`${at} is not an object literal`); return; }
    let scopeKey: string | null = null;
    for (const p of el.properties) {
      if (!t.isObjectProperty(p) || p.computed) { problems.push(`${at} has a spread / method / computed key`); continue; }
      const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : '?';
      if (key === 'scope') {
        const sc = p.value;
        const props = t.isObjectExpression(sc) ? sc.properties : null;
        const only = props?.length === 1 && t.isObjectProperty(props[0]) && !props[0].computed ? props[0] : null;
        const sk = only ? (t.isIdentifier(only.key) ? only.key.name : t.isStringLiteral(only.key) ? only.key.value : null) : null;
        if (!only || (sk !== 'query' && sk !== 'variant') || !t.isStringLiteral(only.value) || !only.value.value.trim()) {
          problems.push(`${at}.scope must be { query: "…" } or { variant: "…" } with a string literal`);
        } else {
          scopeKey = `${sk}:${only.value.value}`;
          if (sk === 'variant') variantScoped = true;
        }
        continue;
      }
      if (!OVERRIDE_KEYS.has(key)) { problems.push(`${at} has an unknown key "${key}"`); continue; }
      if (key === 'draggable' || key === 'disabled') {
        if (!t.isBooleanLiteral(p.value)) problems.push(`${at}.${key} must be true or false`);
        continue;
      }
      const n = numericLiteral(p.value);
      const range = NUMERIC_PROPS[key];
      if (n === null) problems.push(`${at}.${key} must be a number literal`);
      else if (n < range.min || n > range.max) problems.push(`${at}.${key}: ${n} is outside ${range.min}–${range.max}`);
    }
    if (!scopeKey) { if (!problems.some((x) => x.startsWith(`${at}.scope`))) problems.push(`${at} has no scope`); }
    else if (seen.has(scopeKey)) problems.push(`${at} repeats the scope ${scopeKey} (one entry per breakpoint / variant)`);
    else seen.add(scopeKey);
  });
  return { problems, variantScoped };
}
const FLEX_DISPLAYS = new Set(['flex', 'inline-flex']);

const SHAPE = `<${TAG} speed={${TICKER_DEFAULTS.speed}} direction="left"><motion.div data-id="logos" style={{ display: 'flex', gap: '24px', … }}>…items…</motion.div></${TAG}>`;

/** `{80}` / `{-4}` → the number; anything else → null. */
function numericLiteral(expr: t.Node | null | undefined): number | null {
  if (t.isNumericLiteral(expr)) return expr.value;
  if (t.isUnaryExpression(expr) && expr.operator === '-' && t.isNumericLiteral(expr.argument)) return -expr.argument.value;
  return null;
}

/** Element children only, and whether anything else (text, expressions) is there. */
function elementChildren(el: t.JSXElement): { elements: t.JSXElement[]; other: number } {
  const elements: t.JSXElement[] = [];
  let other = 0;
  for (const c of el.children) {
    if (t.isJSXElement(c)) elements.push(c);
    else if (t.isJSXText(c) && !c.value.trim()) continue;
    // `{/* … */}` compiles away — React never sees it.
    else if (t.isJSXExpressionContainer(c) && t.isJSXEmptyExpression(c.expression)) continue;
    else other++;
  }
  return { elements, other };
}

function checkProps(opening: t.JSXOpeningElement, line: number | undefined, v: OracleViolation[]): void {
  const unknown: string[] = [];
  let variantScoped = false;
  let hasVariantProp = false;
  for (const attr of opening.attributes) {
    if (t.isJSXSpreadAttribute(attr)) { unknown.push('{...spread}'); continue; }
    const name = t.isJSXIdentifier(attr.name) ? attr.name.name : `${attr.name.namespace.name}:${attr.name.name.name}`;
    if (!ALLOWED_PROPS.has(name)) { unknown.push(name); continue; }
    const value = attr.value;
    const expr = t.isJSXExpressionContainer(value) && !t.isJSXEmptyExpression(value.expression) ? value.expression : null;
    let problem: string | null = null;
    if (name === 'direction') {
      const dir = t.isStringLiteral(value) ? value.value : t.isStringLiteral(expr) ? expr.value : null;
      if (dir === null) problem = `direction must be a string literal (direction="left"), not ${value ? 'an expression' : 'a bare attribute'}`;
      else if (!DIRECTIONS.has(dir)) problem = `direction "${dir}" is not one of "left" | "right" | "up" | "down"`;
    } else if (name === 'draggable' || name === 'disabled') {
      if (value != null && !t.isBooleanLiteral(expr)) problem = `${name} is a bare attribute (${name}) or a boolean literal (${name}={false})`;
    } else if (name === 'responsive') {
      const r = responsiveProblems(expr);
      variantScoped = r.variantScoped;
      if (r.problems.length) problem = `${r.problems.join('; ')}. Shape: ${RESPONSIVE_SHAPE}`;
    } else if (name === 'variant') {
      if (!t.isIdentifier(expr)) problem = 'variant must be the component\'s variant identifier (variant={variant} or variant={initialVariant})';
      else hasVariantProp = true;
    } else {
      const range = NUMERIC_PROPS[name];
      const n = numericLiteral(expr);
      if (n === null) problem = `${name} must be a number literal (${name}={${TICKER_DEFAULTS[name as 'speed' | 'hoverSpeed' | 'fade']}}), not ${t.isStringLiteral(value) ? 'a string' : value == null ? 'a bare attribute' : 'an expression'}`;
      else if (n < range.min || n > range.max) problem = `${name}={${n}} is outside ${range.min}–${range.max}`;
    }
    if (problem) {
      v.push({
        code: 'TICKER_PROP_INVALID',
        tier: 2,
        line: attr.loc?.start.line ?? line,
        message: `<${TAG}>: ${problem}. The Animation panel reads the Ticker's settings back as LITERALS only — speed={px per second, 0-2000}, direction="left" | "right" | "up" | "down", hoverSpeed={multiplier while hovered, 0-4 (1 = unchanged, 0 = pause)}, draggable (bare, or ={true|false}), fade={edge fade in px, 0-1000}, disabled (bare, or ={true|false}), per breakpoint ${RESPONSIVE_SHAPE}; anything else reads back as the default and the next edit through the panel overwrites it.`,
      });
    }
  }
  if (variantScoped && !hasVariantProp) {
    v.push({
      code: 'TICKER_PROP_INVALID',
      tier: 2,
      line,
      message: `<${TAG}> has { variant } overrides in responsive but no variant prop, so the runtime never knows which variant is showing and those overrides never apply. Add variant={variant} (or variant={initialVariant} in a component without connections).`,
    });
  }
  if (unknown.length) {
    v.push({
      code: 'TICKER_PROP_UNKNOWN',
      tier: 2,
      line,
      message: `<${TAG}> takes only speed, direction, hoverSpeed, draggable, fade, disabled, responsive and variant — remove ${unknown.join(', ')}. The wrapper renders no element of its own (data-id, style, className on it do nothing; the frame inside carries those), and a spread or any other prop is invisible to the Animation panel.`,
    });
  }
}

/** The frame's inline `display`, when the style is a literal object; `undefined`
 *  when the style can't be read statically (skip), `null` when it has none. */
function inlineDisplay(frame: t.JSXElement): string | null | undefined {
  const styleAttr = jsxAttrs(frame.openingElement).find((a) => a.name.name === 'style');
  if (!styleAttr) return null;
  const expr = t.isJSXExpressionContainer(styleAttr.value) ? styleAttr.value.expression : null;
  if (!t.isObjectExpression(expr)) return undefined;
  let display: string | null | undefined = null;
  for (const p of expr.properties) {
    if (t.isSpreadElement(p)) { if (display === null) display = undefined; continue; }
    if (!t.isObjectProperty(p)) continue;
    const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
    if (key !== 'display') continue;
    display = t.isStringLiteral(p.value) ? p.value.value : undefined;
  }
  return display;
}

export function checkTickers(ast: t.File, v: OracleViolation[]): void {
  // Where `RevymeTicker` comes from: the runtime import, another import, or a
  // local declaration (both of which collide with the runtime import the
  // builder's import sync writes for the wrapper).
  let source: 'runtime' | 'other' | 'local' | null = null;
  for (const stmt of ast.program.body) {
    if (t.isImportDeclaration(stmt)) {
      for (const s of stmt.specifiers) {
        if (s.local.name !== TAG) continue;
        const fromRuntime = stmt.source.value === '@revyme/runtime' && t.isImportSpecifier(s)
          && (t.isIdentifier(s.imported) ? s.imported.name : s.imported.value) === TAG;
        source = fromRuntime ? 'runtime' : 'other';
      }
    } else if ((t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) && stmt.id?.name === TAG) {
      source = source ?? 'local';
    } else if (t.isVariableDeclaration(stmt)) {
      for (const d of stmt.declarations) if (t.isIdentifier(d.id) && d.id.name === TAG) source = source ?? 'local';
    }
  }
  let importReported = false;

  traverse(ast, {
    JSXElement(path: { node: t.JSXElement }) {
      const opening = path.node.openingElement;
      if (jsxTagName(opening.name) !== TAG) return;
      const line = opening.loc?.start.line;

      if (source !== 'runtime' && !importReported) {
        importReported = true;
        v.push({
          code: 'TICKER_NOT_IMPORTED',
          tier: 3,
          line,
          message: source === null
            ? `<${TAG}> is used but never imported, so the page throws a ReferenceError when it renders. Add: import { ${TAG} } from '@revyme/runtime';`
            : `<${TAG}> must be the runtime's Ticker effect — import { ${TAG} } from '@revyme/runtime' — not ${source === 'local' ? 'a component declared in this file' : 'an import from another module'}. The builder writes the runtime import for every <${TAG}>, so a second binding of the name breaks the file; delete it and import the runtime one.`,
        });
      }

      checkProps(opening, line, v);

      const { elements, other } = elementChildren(path.node);
      if (elements.length !== 1 || other > 0) {
        v.push({
          code: 'TICKER_CHILD_COUNT',
          tier: 3,
          line,
          message: `<${TAG}> must wrap exactly ONE layout frame (found ${elements.length} element(s)${other ? ' plus other content' : ''}). The Ticker scrolls the CHILDREN of that one frame — with anything else it renders its content still, and the editor re-wraps only the first element on the next edit. Put the items inside one flex frame and wrap that frame: ${SHAPE}`,
        });
        return;
      }

      // The frame: the child, or — when the frame also has a code override,
      // which sits INSIDE the ticker — the one element that override wraps
      // (an Override with the wrong child count is OVERRIDE_CHILD_COUNT's).
      let frame: t.JSXElement | null = elements[0];
      if (jsxTagName(frame.openingElement.name) === 'Override') {
        const inner = elementChildren(frame);
        frame = inner.elements.length === 1 && inner.other === 0 ? inner.elements[0] : null;
      }
      if (!frame) return;
      const frameTag = jsxTagName(frame.openingElement.name);
      const frameLine = frame.openingElement.loc?.start.line ?? line;
      const dataId = jsxAttrs(frame.openingElement).find((a) => a.name.name === 'data-id');
      const frameId = dataId && t.isStringLiteral(dataId.value) ? dataId.value.value : undefined;
      if (!frameId) {
        v.push({
          code: 'TICKER_FRAME_NO_DATA_ID',
          tier: 2,
          line: frameLine,
          message: `The frame inside <${TAG}> has no literal data-id. The editor attaches the Ticker to the frame by its data-id and carries the wrapper through every edit by it: without one the Animation panel can't show or change this ticker, and the next edit re-wraps the first element INSIDE that has an id (one item instead of the strip). Give the wrapped frame a data-id="…".`,
        });
      }

      const isInstance = /^[A-Z]/.test(frameTag) && !frameTag.startsWith('motion.');
      const display = isInstance ? null : inlineDisplay(frame);
      if (isInstance || (display !== undefined && !FLEX_DISPLAYS.has(display ?? ''))) {
        v.push({
          code: 'TICKER_FRAME_NOT_FLEX',
          tier: 2,
          line: frameLine,
          ...(frameId ? { elementId: frameId } : {}),
          message: isInstance
            ? `<${TAG}> wraps a component instance (<${frameTag}>). The Ticker scrolls the children of a LAYOUT FRAME on the page — wrap the instances in a flex frame and put the ticker around that frame: ${SHAPE}`
            : `The frame inside <${TAG}> is not a flex layout (${display ? `display: '${display}'` : 'no display in its style'}). The Ticker effect is for a layout frame: its children are the items, lined up by the frame's flex direction and gap, and the Animation panel only offers it on one. Give the frame display: 'flex' (flexDirection 'row' scrolls left/right, 'column' up/down) and a gap.`,
        });
      }
    },
  });
}
