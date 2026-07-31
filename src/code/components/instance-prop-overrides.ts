// Shared write helpers for per-VARIANT and per-VIEWPORT overrides of a component
// INSTANCE prop (e.g. a design component's `initialVariant`, or an icon-set's
// `name`). Extracted from ComponentPropsTool so IconSetTool routes the icon
// switch through the exact same code paths — the difference between "design
// component" and "vector set" is only WHICH prop is being overridden.
//
//   - per master variant → JSX ternary `prop={variant === 'v' ? a : b}`
//   - per replica viewport → `data-responsive='{"768":{prop:val},…,"_bp":[…]}'`
//
// Both forms are parsed by the parser (attrConditional / data-responsive) and
// resolved on the canvas (resolveVariantProps for the conditional, withResponsiveProps
// for data-responsive).

import { parseExpression } from '@babel/parser';
import { findStyleObjectEnd, findTagClose } from '../generation/generator-utils';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { parseJSXToNodes } from '@/code/parsing/parser';
import {
  parseConditionalPropExpression,
  setConditionalPropEntry,
  hasVariantOverrides,
  formatConditionalPropExpression,
  parseRichConditionalProp,
  formatRichConditionalProp,
  classifyCondBranch,
  type RichConditionalPropMap,
  type RichCondBranch,
} from './instance-conditional-prop';

export interface InstanceTagRange { tagStart: number; tagEnd: number }

/** Locate a component-instance's opening tag in `code` — by `data-id` (preferred,
 *  unambiguous) else by the first `<ComponentName` occurrence. Returns the
 *  [tagStart, tagEnd) span of the opening tag (including the closing `>`). */
export function findInstanceTag(code: string, nodeId: string, componentName: string): InstanceTagRange | null {
  // Prefer data-id — must be a real JSX attribute (preceded by whitespace), not
  // a CSS selector `[data-id="…"]` or a string.
  const idPattern = `data-id="${nodeId}"`;
  let idSearchFrom = 0;
  while (idSearchFrom < code.length) {
    const idIdx = code.indexOf(idPattern, idSearchFrom);
    if (idIdx === -1) break;
    const charBefore = idIdx > 0 ? code[idIdx - 1] : '';
    if (charBefore === ' ' || charBefore === '\n' || charBefore === '\t') {
      let tagStart = idIdx;
      while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
      // Scan from tagStart (not idIdx) so brace depth is counted from the tag's real beginning,
      // and via findTagClose so a `>` inside an earlier attr value can't end the tag early.
      const tagEnd = findTagClose(code, tagStart);
      if (tagEnd !== -1) return { tagStart, tagEnd: tagEnd + 1 };
    }
    idSearchFrom = idIdx + idPattern.length;
  }

  // Fall back to the first `<ComponentName` tag boundary.
  const tagPattern = `<${componentName}`;
  let searchFrom = 0;
  const occurrences: number[] = [];
  while (searchFrom < code.length) {
    const idx = code.indexOf(tagPattern, searchFrom);
    if (idx === -1) break;
    const nextChar = code[idx + tagPattern.length];
    if (nextChar === ' ' || nextChar === '/' || nextChar === '>') occurrences.push(idx);
    searchFrom = idx + tagPattern.length;
  }
  if (occurrences.length === 0) return null;
  const tagStart = occurrences[0];
  // findTagClose, not indexOf('>') — a `>` inside an attr value (an arrow function, a template
  // literal, a comparison in a ternary) would otherwise end the tag early and every downstream
  // slice would write into the middle of the JSX. Same failure class as the brace scan below.
  const tagEnd = findTagClose(code, tagStart);
  if (tagEnd === -1) return null;
  return { tagStart, tagEnd: tagEnd + 1 };
}

/** Remove a prop (string, single-quoted, or `{expr}`) from an instance tag.
 *
 *  The `{expr}` value is delimited by a BALANCED brace scan, never a regex. `\{[^}]*\}` stops at the
 *  FIRST `}`, so a value holding a nested object — e.g. a cursor's
 *  `cursorOpts={{"mode":"follow","transition":{"type":"spring"}}}` — was cut at the inner object's
 *  close, deleting `cursorOpts={{…"spring"}` and leaving a stray `}}` that broke the file
 *  (live find 2026-07-30: `<ZoGaCo}} key={idx}` after removing a cursor variable). Nested objects are
 *  normal in prop values (transitions, style, responsive config), so depth counting is the floor. */
export function removeInstanceProp(code: string, nodeId: string, componentName: string, propName: string): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  // `(?<![\w-])` so a prop like `name` never matches inside `data-name=`, and `cursor` never
  // matches the `cursor` inside `cursorOpts=` (the `=` anchor already excludes that, but the
  // two props coexist on the same tag so the boundary carries real weight here).
  const at = tagContent.search(new RegExp(`\\s*(?<![\\w-])${propName}=`));
  if (at === -1) return code;
  const eq = tagContent.indexOf('=', at) + 1;
  const open = tagContent[eq];
  let end: number;
  if (open === '"' || open === "'") {
    end = tagContent.indexOf(open, eq + 1);
    if (end === -1) return code;                     // unterminated — leave the file alone
    end += 1;
  } else if (open === '{') {
    const close = findStyleObjectEnd(tagContent, eq + 1);
    if (close === -1) return code;                   // unbalanced — leave the file alone
    end = close + 1;
  } else {
    return code;                                     // bare/shorthand prop — nothing to slice
  }
  const newTag = tagContent.slice(0, at) + tagContent.slice(end);
  return code.slice(0, tag.tagStart) + newTag + code.slice(tag.tagEnd);
}

/**
 * Strip `propName` from EVERY `<componentName …/>` instance in a single file. Used by the cross-file
 * "remove at the source" cascade: when a component's prop is deleted (the variable's last use), no
 * instance should keep passing `prop={…}` to a prop the component no longer accepts (a dangling
 * reference). The cross-file driver calls this per project file; this function is single-file + pure,
 * so it's safe to test in isolation. Reuses the per-instance `removeInstanceProp` (balanced-tag aware)
 * for each instance id found by the parser, so nested `{…}` / `>` inside attrs never trip the strip.
 * ALSO prunes the prop out of each instance's per-viewport `data-responsive` overrides — once the
 * component no longer has the prop, a `data-responsive='{"768":{"hide":true}}'` literal is dead data.
 */
/**
 * The BARE page/template variables that `<componentName …/>` instances pass for `propName`
 * (`content={content}` → 'content'). This is the upward HOIST TRAIL of the prop — the
 * cascade delete uses it to know which page/template variables MIGHT be orphaned once the
 * instances stop passing the prop. Literal values (`content="x"`) and complex expressions
 * (`content={cond ? a : b}`) are intentionally excluded — only a bare identifier is a
 * hoisted-variable binding.
 */
export function collectInstancePropIdentifiers(code: string, componentName: string, propName: string): string[] {
  const out = new Set<string>();
  for (const [id, node] of parseJSXToNodes(code)) {
    if (node.type !== componentName) continue;
    const tag = findInstanceTag(code, id, componentName);
    if (!tag) continue;
    const tagContent = code.slice(tag.tagStart, tag.tagEnd);
    const m = tagContent.match(new RegExp(`(?<![\\w-])${propName}=\\{\\s*([A-Za-z_$][\\w$]*)\\s*\\}`));
    if (m) out.add(m[1]);
  }
  return Array.from(out);
}

export function stripPropFromAllInstancesInCode(code: string, componentName: string, propName: string): string {
  let result = code;
  const ids: string[] = [];
  for (const [id, node] of parseJSXToNodes(code)) {
    if (node.type === componentName) ids.push(id);
  }
  for (const id of ids) {
    result = removeInstanceProp(result, id, componentName, propName);          // the `prop={…}` attr
    result = stripPropFromInstanceResponsive(result, id, componentName, propName); // the per-viewport overrides
  }
  return result;
}

/**
 * Remove `propName` from an instance's `data-responsive` per-viewport overrides (both the string and
 * computed forms). A viewport object left empty is dropped by `serializeResponsiveAttr`; when NO
 * overrides remain, `writeResponsiveModel` removes the whole `data-responsive` attribute (incl. `_bp`).
 */
function stripPropFromInstanceResponsive(code: string, nodeId: string, componentName: string, propName: string): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const model = readResponsiveModel(tagContent);
  let changed = false;
  for (const vpKey of Object.keys(model.overrides)) {
    if (propName in model.overrides[vpKey]) { delete model.overrides[vpKey][propName]; changed = true; }
  }
  if (!changed) return code;
  const newTag = writeResponsiveModel(tagContent, model);
  return code.slice(0, tag.tagStart) + newTag + code.slice(tag.tagEnd);
}

// ─── data-responsive override model (shared) ─────────────────────────────────
// A per-viewport override value is either a JSON LITERAL (string/number/bool)
// or a LIVE CMS field expression (`item.shortTitle`) that must stay UNQUOTED in
// source so it resolves per-row inside the `.map()`. Any field-ref upgrades the
// whole attr from the static string form (`data-responsive='{…}'`) to the
// COMPUTED form (`data-responsive={JSON.stringify({…})}`) — withResponsiveProps
// already accepts either, so the runtime needs no change; the computed object is
// evaluated per row (where `item` is in scope) and merged at the breakpoint.
export type RespOverrideValue =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'field'; expr: string };

interface RespModel {
  // vpKey (string width) → propName → value.
  overrides: Record<string, Record<string, RespOverrideValue>>;
  bp: number[];
}

function babelKeyName(node: any): string | null {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'NumericLiteral') return String(node.value);
  return null;
}

/** Locate the `data-responsive` attribute in an opening tag — either the static
 *  string form (`='…'`/`="…"`) or the computed form (`={JSON.stringify({…})}`),
 *  scanning balanced braces + strings so a nested `${…}` / object never trips it. */
function findResponsiveAttr(tagContent: string): { start: number; end: number; kind: 'string' | 'computed'; inner: string } | null {
  const marker = 'data-responsive=';
  const idx = tagContent.indexOf(marker);
  if (idx === -1) return null;
  const valStart = idx + marker.length;
  const q = tagContent[valStart];
  if (q === "'" || q === '"') {
    const close = tagContent.indexOf(q, valStart + 1);
    if (close === -1) return null;
    return { start: idx, end: close + 1, kind: 'string', inner: tagContent.slice(valStart + 1, close) };
  }
  if (q === '{') {
    let depth = 0, strCh = '', i = valStart;
    for (; i < tagContent.length; i++) {
      const c = tagContent[i];
      if (strCh) { if (c === '\\') { i++; continue; } if (c === strCh) strCh = ''; continue; }
      if (c === "'" || c === '"' || c === '`') { strCh = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return null;
    return { start: idx, end: i + 1, kind: 'computed', inner: tagContent.slice(valStart + 1, i) };
  }
  return null;
}

/** Parse the existing `data-responsive` (either form) into the shared model. */
function readResponsiveModel(tagContent: string): RespModel {
  const found = findResponsiveAttr(tagContent);
  if (!found) return { overrides: {}, bp: [] };
  return parseFoundToModel(found);
}

/** Build the model from a located `data-responsive` (string or computed form). */
function parseFoundToModel(found: { kind: 'string' | 'computed'; inner: string }): RespModel {
  const model: RespModel = { overrides: {}, bp: [] };
  if (found.kind === 'string') {
    try {
      const obj = JSON.parse(found.inner);
      for (const [k, v] of Object.entries(obj)) {
        if (k === '_bp') { model.bp = (v as number[]) ?? []; continue; }
        const entry: Record<string, RespOverrideValue> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, any>)) entry[pk] = { kind: 'literal', value: pv };
        model.overrides[k] = entry;
      }
    } catch { /* ignore malformed */ }
    return model;
  }
  // Computed: `inner` is `JSON.stringify({…})` (or a bare object literal).
  try {
    const expr: any = parseExpression(found.inner, { plugins: ['jsx', 'typescript'] });
    const objExpr = expr.type === 'CallExpression' ? expr.arguments[0] : expr.type === 'ObjectExpression' ? expr : null;
    if (!objExpr || objExpr.type !== 'ObjectExpression') return model;
    for (const prop of objExpr.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = babelKeyName(prop.key);
      if (key == null) continue;
      if (key === '_bp') {
        if (prop.value.type === 'ArrayExpression') {
          model.bp = prop.value.elements
            .map((e: any) => (e && e.type === 'NumericLiteral' ? e.value : null))
            .filter((n: any) => n != null);
        }
        continue;
      }
      if (prop.value.type !== 'ObjectExpression') continue;
      const entry: Record<string, RespOverrideValue> = {};
      for (const sub of prop.value.properties) {
        if (sub.type !== 'ObjectProperty') continue;
        const pk = babelKeyName(sub.key);
        if (pk == null) continue;
        const v: any = sub.value;
        if (v.type === 'NumericLiteral' || v.type === 'StringLiteral' || v.type === 'BooleanLiteral') {
          entry[pk] = { kind: 'literal', value: v.value };
        } else {
          // Any non-literal (a `item.field` member expression) → keep its source.
          entry[pk] = { kind: 'field', expr: found.inner.slice(v.start, v.end) };
        }
      }
      model.overrides[key] = entry;
    }
  } catch { /* ignore malformed */ }
  return model;
}

/** Serialize the model back to an attribute string — `''` when there are no
 *  overrides (caller removes the attr). Emits the static STRING form when every
 *  value is a literal (byte-identical to the legacy output), else the COMPUTED
 *  form so live `item.field` refs reach withResponsiveProps. */
function serializeResponsiveAttr(model: RespModel): string {
  const vpKeys = Object.keys(model.overrides).filter(k => k !== '_bp' && Object.keys(model.overrides[k]).length > 0);
  if (vpKeys.length === 0) return '';
  const ordered = [...vpKeys].sort((a, b) => Number(a) - Number(b));
  const hasField = ordered.some(k => Object.values(model.overrides[k]).some(v => v.kind === 'field'));
  if (!hasField) {
    const obj: Record<string, any> = {};
    for (const k of ordered) {
      const e: Record<string, any> = {};
      for (const [pk, pv] of Object.entries(model.overrides[k])) e[pk] = (pv as { kind: 'literal'; value: any }).value;
      obj[k] = e;
    }
    obj._bp = model.bp;
    return `data-responsive='${JSON.stringify(obj)}'`;
  }
  const vpParts = ordered.map(k => {
    const props = Object.entries(model.overrides[k])
      .map(([pk, pv]) => `${JSON.stringify(pk)}:${pv.kind === 'field' ? pv.expr : JSON.stringify(pv.value)}`)
      .join(',');
    return `${JSON.stringify(k)}:{${props}}`;
  });
  vpParts.push(`"_bp":[${model.bp.join(',')}]`);
  return `data-responsive={JSON.stringify({${vpParts.join(',')}})}`;
}

/** Replace / insert / remove the `data-responsive` attribute in an opening tag. */
function writeResponsiveModel(tagContent: string, model: RespModel): string {
  const newAttr = serializeResponsiveAttr(model);
  const found = findResponsiveAttr(tagContent);
  if (found) {
    if (newAttr === '') {
      let s = found.start;
      while (s > 0 && (tagContent[s - 1] === ' ' || tagContent[s - 1] === '\n' || tagContent[s - 1] === '\t')) s--;
      return tagContent.slice(0, s) + tagContent.slice(found.end);
    }
    return tagContent.slice(0, found.start) + newAttr + tagContent.slice(found.end);
  }
  if (newAttr === '') return tagContent;
  const nameEnd = tagContent.indexOf(' ', 1); // after `<ComponentName`
  return tagContent.slice(0, nameEnd) + ` ${newAttr}` + tagContent.slice(nameEnd);
}

/**
 * Apply `mutate` to EVERY `data-responsive` attribute in `code` (string OR
 * computed form), re-serializing each in place. The viewport add/remove/resize
 * breakpoint rewriters use this so CMS field-refs (`item.field`) survive re-keying
 * — a plain `code.replace(/data-responsive='…'/)` would skip the computed form and
 * leave its `_bp`/keys stale. `mutate` receives the parsed model (re-key
 * `overrides`, set `bp`) and mutates it in place.
 */
export function transformAllResponsiveAttrs(code: string, mutate: (model: RespModel) => void): string {
  const marker = 'data-responsive=';
  let out = '';
  let cursor = 0;
  while (true) {
    const idx = code.indexOf(marker, cursor);
    if (idx === -1) { out += code.slice(cursor); break; }
    const found = findResponsiveAttr(code.slice(idx)); // marker sits at offset 0 of the slice
    if (!found) { out += code.slice(cursor, idx + marker.length); cursor = idx + marker.length; continue; }
    const model = parseFoundToModel(found);
    mutate(model);
    const newAttr = serializeResponsiveAttr(model);
    let pre = code.slice(cursor, idx);
    if (newAttr === '') pre = pre.replace(/\s+$/, ' '); // collapse the now-orphaned leading space
    out += pre + newAttr;
    cursor = idx + found.end;
  }
  return out;
}

/** Core: set/clear one (vpWidth, propName) override and rewrite the attr. */
function applyResponsiveOverride(
  code: string, nodeId: string, componentName: string,
  vpWidth: number, propName: string,
  override: RespOverrideValue | { kind: 'clear' },
): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const model = readResponsiveModel(tagContent);
  const vpKey = String(vpWidth);
  if (!model.overrides[vpKey]) model.overrides[vpKey] = {};
  if (override.kind === 'clear') {
    delete model.overrides[vpKey][propName];
    if (Object.keys(model.overrides[vpKey]).length === 0) delete model.overrides[vpKey];
  } else {
    model.overrides[vpKey][propName] = override;
  }
  // `_bp` carries every breakpoint width so the HOC computes non-cascading ranges.
  const realKeys = Object.keys(model.overrides).filter(k => Object.keys(model.overrides[k]).length > 0);
  model.bp = realKeys.length > 0 ? Object.values(getViewportWidths()).sort((a, b) => a - b) : [];
  const newTag = writeResponsiveModel(tagContent, model);
  if (newTag === tagContent) return code;
  return code.slice(0, tag.tagStart) + newTag + code.slice(tag.tagEnd);
}

/**
 * Set or clear a per-viewport prop override in the instance's `data-responsive`
 * attribute: `data-responsive='{"768":{"name":"icon-2"},"_bp":[1440,768,375]}'`.
 * `withResponsiveProps` reads this at render and merges the matching breakpoint.
 * Writing the default value (or empty) clears the override for that viewport.
 */
export function setResponsiveOverride(
  code: string, nodeId: string, componentName: string,
  vpWidth: number, propName: string, value: string, defaultValue: string | null,
): string {
  let override: RespOverrideValue | { kind: 'clear' };
  if (value === (defaultValue ?? '') || value === '') {
    override = { kind: 'clear' };
  } else if (/^-?\d+(\.\d+)?$/.test(value)) {
    override = { kind: 'literal', value: parseFloat(value) };
  } else if (value === 'true') {
    override = { kind: 'literal', value: true };
  } else if (value === 'false') {
    override = { kind: 'literal', value: false };
  } else {
    override = { kind: 'literal', value };
  }
  return applyResponsiveOverride(code, nodeId, componentName, vpWidth, propName, override);
}

/**
 * Per-viewport CMS-binding override of an instance prop. `override` is either a
 * LIVE field-ref (`{kind:'field', expr:'item.shortTitle'}` → rebind that viewport
 * to a different field), a LITERAL (`{kind:'literal', value}` → unbind→default for
 * that viewport), or `{kind:'clear'}` (reset override → fall back to the base
 * binding). The presence of any field-ref upgrades the attr to the computed form.
 */
export function setResponsiveBindingOverride(
  code: string, nodeId: string, componentName: string,
  vpWidth: number, propName: string,
  override: RespOverrideValue | { kind: 'clear' },
): string {
  return applyResponsiveOverride(code, nodeId, componentName, vpWidth, propName, override);
}

/**
 * Read ONE instance's per-viewport overrides at `vpWidth` as a Map<prop, display>.
 * Handles BOTH the static string form and the computed form: a field-ref surfaces
 * as its full expression (`item.shortTitle`) so the UI's CMS-bound-pill detection
 * (`startsWith(itemVar + '.')`) lights up; a literal as its string value. Used by
 * ComponentPropsTool's per-viewport override indicator.
 */
export function getResponsiveOverridesAtViewport(
  code: string, nodeId: string, componentName: string, vpWidth: number,
): Map<string, string> {
  const result = new Map<string, string>();
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return result;
  const model = readResponsiveModel(code.slice(tag.tagStart, tag.tagEnd));
  const entry = model.overrides[String(vpWidth)];
  if (!entry) return result;
  for (const [prop, v] of Object.entries(entry)) {
    result.set(prop, v.kind === 'field' ? v.expr : String(v.value));
  }
  return result;
}

/**
 * Set a per-parent-variant prop value on a component instance using a JSX
 * ternary (`variant === 'X' ? 'A' : …` / `initialVariant === …`). Used inside a
 * component file when the editor is on a non-default master variant — the prop
 * change applies to that parent variant only. Reads any existing ternary,
 * updates the entry, re-formats; collapses to a plain string when no overrides
 * remain; removes the prop entirely if the result is empty/'default'.
 */
export function setConditionalInstanceProp(
  code: string,
  nodeId: string,
  componentName: string,
  propName: string,
  parentVariantName: string,
  value: string,
  removeDefaultValue = 'default',
): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;

  const tagContent = code.slice(tag.tagStart, tag.tagEnd);

  // `(?<![\w-])` so `name` doesn't match inside `data-name=`.
  const literalMatch = tagContent.match(new RegExp(`(?<![\\w-])${propName}="([^"]*)"`));
  const exprMatch = tagContent.match(new RegExp(`(?<![\\w-])${propName}=\\{([^}]+)\\}`));
  let currentMap: Record<string, string> | null = null;
  if (exprMatch) currentMap = parseConditionalPropExpression(exprMatch[1]);
  if (!currentMap && literalMatch) currentMap = { default: literalMatch[1] };

  const nextMap = setConditionalPropEntry(currentMap, parentVariantName, value);

  const onlyDefault = !hasVariantOverrides(nextMap);
  const defaultVal = nextMap['default'] ?? '';
  if (onlyDefault && (defaultVal === '' || defaultVal === removeDefaultValue)) {
    return removeInstanceProp(code, nodeId, componentName, propName);
  }

  // `variant` is the live useState when connections are wired (re-renders on
  // toggle); else the frozen `initialVariant` prop. Mirror of generator-styles.
  const parentVarName = code.includes('useState(initialVariant)') ? 'variant' : 'initialVariant';
  const formattedAttr = onlyDefault
    ? `${propName}="${defaultVal}"`
    : `${propName}={${formatConditionalPropExpression(nextMap, parentVarName)}}`;

  const existingRegex = new RegExp(`(?<![\\w-])${propName}=(?:"[^"]*"|'[^']*'|\\{[^}]+\\})`);
  if (existingRegex.test(tagContent)) {
    const newTag = tagContent.replace(existingRegex, formattedAttr);
    return code.slice(0, tag.tagStart) + newTag + code.slice(tag.tagEnd);
  }
  const nameEnd = tag.tagStart + `<${componentName}`.length;
  return code.slice(0, nameEnd) + ` ${formattedAttr}` + code.slice(nameEnd);
}

/**
 * Bind a VARIABLE to a component-instance prop ON A SINGLE PARENT VARIANT — the per-variant twin of the
 * per-viewport `setResponsiveInstancePropVarInCode`. Sets `parentVariantName`'s ternary branch to the bare
 * identifier `varName`; every other branch keeps its literal; the default falls back to `baseDefault` (the
 * pre-hoist literal). Powers HOISTING a nested instance's variant on one parent variant.
 *
 *   initialVariant="default"  +  (variant-6, logoMarkVariant)
 *     → initialVariant={variant === 'variant-6' ? logoMarkVariant : 'default'}
 */
export function setConditionalInstancePropVarInCode(
  code: string, nodeId: string, componentName: string,
  propName: string, parentVariantName: string, varName: string, baseDefault: string,
): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const literalMatch = tagContent.match(new RegExp(`(?<![\\w-])${propName}="([^"]*)"`));
  const exprMatch = tagContent.match(new RegExp(`(?<![\\w-])${propName}=\\{([^}]+)\\}`));
  let map: RichConditionalPropMap | null = null;
  if (exprMatch) map = parseRichConditionalProp(exprMatch[1]);
  // A non-ternary expr base — e.g. an existing GLOBAL variable binding `initialVariant={seJoReVariant}` —
  // becomes the default branch, CLASSIFIED: a bare identifier stays a VARIABLE (`… : seJoReVariant`), never a
  // quoted literal of the variable's name (`… : 'seJoReVariant'`, which resolves to a non-existent variant).
  if (!map && exprMatch) map = { default: classifyCondBranch(exprMatch[1]) };
  if (!map && literalMatch) map = { default: { value: literalMatch[1], isVar: false } };
  if (!map) map = {};
  if (!map['default']) map['default'] = { value: baseDefault || 'default', isVar: false };
  map[parentVariantName] = { value: varName, isVar: true };

  // `variant` = the live useState when connections are wired (re-renders on toggle); else the frozen
  // `initialVariant` prop. Mirror of setConditionalInstanceProp.
  const parentVar = code.includes('useState(initialVariant)') ? 'variant' : 'initialVariant';
  const formattedAttr = `${propName}={${formatRichConditionalProp(map, parentVar)}}`;

  const existingRegex = new RegExp(`(?<![\\w-])${propName}=(?:"[^"]*"|'[^']*'|\\{[^}]+\\})`);
  if (existingRegex.test(tagContent)) {
    const newTag = tagContent.replace(existingRegex, formattedAttr);
    return code.slice(0, tag.tagStart) + newTag + code.slice(tag.tagEnd);
  }
  const nameEnd = tag.tagStart + `<${componentName}`.length;
  return code.slice(0, nameEnd) + ` ${formattedAttr}` + code.slice(nameEnd);
}

/**
 * Read the conditional-prop branch for ONE parent variant → `{ value, isVar }` or null when the prop isn't a
 * ternary / has no branch for that variant. `isVar` distinguishes a per-variant VARIABLE binding (the purple
 * hoist pill on that variant only) from a literal per-variant override.
 */
export function getConditionalInstancePropBranch(
  code: string, nodeId: string, componentName: string, propName: string, parentVariant: string,
): RichCondBranch | null {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return null;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const exprMatch = tagContent.match(new RegExp(`(?<![\\w-])${propName}=\\{([^}]+)\\}`));
  if (!exprMatch) return null;
  const map = parseRichConditionalProp(exprMatch[1]);
  if (!map) return null;
  return map[parentVariant] ?? null;
}

/**
 * Drop ONE parent-variant branch from a conditional prop → that parent variant re-inherits the base/default
 * (the "Reset Override" affordance for a per-variant binding). Rich-aware: a variable default branch
 * (`… : seJoReVariant`) stays a VARIABLE (the literal `setConditionalInstanceProp` would flatten it to
 * `"default"` and clobber the base binding). When only the default remains, collapses to a literal attr — or
 * a `{var}` binding when the default itself is a variable.
 */
export function removeConditionalInstancePropBranchInCode(
  code: string, nodeId: string, componentName: string, propName: string, parentVariant: string,
): string {
  const tag = findInstanceTag(code, nodeId, componentName);
  if (!tag) return code;
  const tagContent = code.slice(tag.tagStart, tag.tagEnd);
  const exprMatch = tagContent.match(new RegExp(`(?<![\\w-])${propName}=\\{([^}]+)\\}`));
  if (!exprMatch) return code;
  const map = parseRichConditionalProp(exprMatch[1]);
  if (!map) return code;
  delete map[parentVariant];
  const parentVar = code.includes('useState(initialVariant)') ? 'variant' : 'initialVariant';
  const branches = Object.keys(map).filter((k) => k !== 'default');
  let formattedAttr: string;
  if (branches.length === 0) {
    const def = map['default'] ?? { value: 'default', isVar: false };
    formattedAttr = def.isVar ? `${propName}={${def.value}}` : `${propName}="${def.value || 'default'}"`;
  } else {
    formattedAttr = `${propName}={${formatRichConditionalProp(map, parentVar)}}`;
  }
  const existingRegex = new RegExp(`(?<![\\w-])${propName}=(?:"[^"]*"|'[^']*'|\\{[^}]+\\})`);
  const newTag = tagContent.replace(existingRegex, formattedAttr);
  return code.slice(0, tag.tagStart) + newTag + code.slice(tag.tagEnd);
}
