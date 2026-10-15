// src/ai/agent/tools/instance-prop-write.ts
//
// set_component_prop's write, done the way the instance properties panel does
// it (ComponentPropsTool.handlePropChange) instead of through the generic
// element-attribute writer.
//
// The generic writer (updateHtmlAttrs) only recognised an existing value in
// quotes, so a prop that was already an expression (`count={3}`,
// `items={[…]}`, a bare `featured`) was "not found" and appended AGAIN — a
// duplicate attribute whose later copy wins at runtime, so the agent's write
// looked ignored — and removing such a prop did nothing. Every value was also
// written as a string literal: `"false"` is truthy, `"60"` is not a number, and
// a JS expression arrived as its own source text (agent report 2026-10-15).
//
// Two pure halves, tested without the store:
//   resolveInstancePropWrite — WHAT to write: the value's JSX form from the
//     prop's declared type (number / toggle / transition / list / formatted
//     text / link booleans), or an explicit, parse-checked expression.
//   writeInstancePropInCode — WHERE: the panel's own writers (in-place
//     replace, duplicates collapsed, per-viewport and per-variant branches
//     preserved).

import { parseExpression } from '@babel/parser';
import type { ComponentInfo } from '@/code/components/component-registry';
import { formatTransitionObj } from '@/code/generation/generator-motion-transition';
import { getInstancePropBaseValue, setInstancePropBaseInCode } from '@/code/generation/responsive-instance-prop-vars-gen';
import { currentConditionalMap, hasVariantOverrides } from '@/code/components/instance-conditional-prop';
import { readTagAttr, findTagAttrs } from '@/code/components/jsx-tag-attrs';
import { findInstanceTag, removeConditionalInstancePropBranchInCode } from '@/code/components/instance-prop-overrides';
import { setInstanceProp, removeInstanceProp, setConditionalInstanceProp } from '@/editor/tools/ComponentPropsTool/instance-props';
import { trace } from '@/shared/debug-trace';

export type LinkAttrKind = 'href' | 'newTab' | 'smooth' | 'tracking' | 'rel' | 'params' | null;

export interface InstancePropWrite {
  /** The JSX value: a string's TEXT (expression false) or JS source (true). */
  value: string;
  expression: boolean;
}

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function parsesAsExpression(src: string): string | null {
  try {
    parseExpression(src, { plugins: ['jsx', 'typescript'] });
    return null;
  } catch (err) {
    return (err as Error).message.replace(/\s*\(\d+:\d+\)\s*$/, '');
  }
}

/**
 * The JSX form for setting `prop` to `value`. `value` is never '' here — ''
 * means remove and is handled before. An explicit `expression` is written as
 * code after a parse check; otherwise the prop's DECLARED type decides,
 * exactly as the properties panel does:
 *   number / slider control / Number variable → `{60}` (must be numeric)
 *   toggle control / Toggle variable / New Tab, Smooth Scroll, Keep Params
 *     link booleans → `{true}` / `{false}` (must be true|false)
 *   transition → an object expression (`{ type: 'spring', … }`)
 *   object list → a real array (`{[…]}`)
 *   formatted text → an escaped JS string (`{"<strong>Hi</strong>"}`)
 *   everything else → a string attribute.
 */
export function resolveInstancePropWrite(args: {
  prop: string;
  value: string;
  expression?: boolean;
  info?: ComponentInfo;
  linkKind?: LinkAttrKind;
}): { ok: true; write: InstancePropWrite } | { ok: false; error: string } {
  const { prop, value, info, linkKind } = args;
  const trimmed = value.trim();
  const declared = info?.props.find((p) => p.name === prop);
  const varType = declared?.varType;
  const control = info?.controlsMeta?.controls?.[prop];
  const controlType = control?.type as string | undefined;

  if (args.expression) {
    const bad = parsesAsExpression(trimmed);
    if (bad) return { ok: false, error: `"${prop}": the expression does not parse (${bad}). Pass valid JavaScript, e.g. {count + 1} is written as value "count + 1" with expression: true.` };
    return { ok: true, write: { value: trimmed, expression: true } };
  }

  const isNumber = controlType === 'number' || controlType === 'slider' || varType === 'number';
  if (isNumber) {
    if (!NUMBER_RE.test(trimmed)) {
      return { ok: false, error: `"${prop}" is a NUMBER prop — pass a number like "60" (written as ${prop}={60}), or set expression: true to pass a JavaScript expression.` };
    }
    return { ok: true, write: { value: trimmed, expression: true } };
  }

  const isBoolean = controlType === 'toggle' || varType === 'toggle'
    || linkKind === 'newTab' || linkKind === 'smooth' || linkKind === 'params';
  if (isBoolean) {
    const b = trimmed.toLowerCase();
    if (b !== 'true' && b !== 'false') {
      return { ok: false, error: `"${prop}" is a TOGGLE (boolean) prop — pass "true" or "false" (written as ${prop}={true}; the STRING "false" would be truthy), or set expression: true for a JavaScript expression.` };
    }
    return { ok: true, write: { value: b, expression: true } };
  }

  if (varType === 'transition' || controlType === 'transition') {
    // A JSON object from the agent → the canonical transition object; an
    // object literal that is already JS passes through after a parse check.
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const flat = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)]));
        const normalized = flat.type === 'instant' ? { duration: '0' } : flat;
        return { ok: true, write: { value: formatTransitionObj(normalized), expression: true } };
      }
    } catch { /* not JSON — maybe a JS object literal */ }
    const bad = parsesAsExpression(trimmed);
    if (bad) return { ok: false, error: `"${prop}" is a TRANSITION prop — pass an object like {"type":"spring","duration":0.5}.` };
    return { ok: true, write: { value: trimmed, expression: true } };
  }

  if (controlType === 'objectList') {
    try {
      const arr = JSON.parse(trimmed || '[]');
      if (!Array.isArray(arr)) throw new Error('not an array');
      return { ok: true, write: { value: JSON.stringify(arr), expression: true } };
    } catch {
      return { ok: false, error: `"${prop}" is a LIST prop — pass a JSON array of items, e.g. [{"title":"A"},{"title":"B"}].` };
    }
  }

  if (varType === 'formattedText') {
    return { ok: true, write: { value: JSON.stringify(value), expression: true } };
  }

  return { ok: true, write: { value, expression: false } };
}

export interface InstancePropTarget {
  nodeId: string;
  /** The tag as written in the JSX (used only when the node has no data-id). */
  componentName: string;
  prop: string;
}

/**
 * Apply a resolved write (or a removal: `write === null`) to the instance in
 * `code`. `parentVariant` scopes the value to one variant of the component
 * FILE the instance sits in (a per-variant ternary); `defaultSeed` is the
 * value the other variants keep when the prop was absent.
 */
export function writeInstancePropInCode(
  code: string,
  target: InstancePropTarget,
  write: InstancePropWrite | null,
  opts: { parentVariant?: string; defaultSeed?: string } = {},
): string {
  const { nodeId, componentName, prop } = target;
  const tagRange = findInstanceTag(code, nodeId, componentName);
  if (!tagRange) return code;
  const tag = code.slice(tagRange.tagStart, tagRange.tagEnd);
  const current = readTagAttr(tag, prop);

  // Per-variant: the panel's ternary writer (literal values only — the
  // caller refuses expressions there).
  if (opts.parentVariant) {
    // Removing a variant's value drops THAT branch: the variant re-inherits
    // the default (an empty-string branch would be a value, not a removal).
    // A literal map (escaped strings included) drops the branch by setting it
    // to the default — setConditionalPropEntry removes a branch equal to it;
    // a branch bound to a VARIABLE goes through the variable-aware remover.
    if (!write) {
      const literal = currentConditionalMap(current);
      if (literal && literal[opts.parentVariant] !== undefined) {
        return setConditionalInstanceProp(code, nodeId, componentName, prop, opts.parentVariant, literal.default ?? '');
      }
      return removeConditionalInstancePropBranchInCode(code, nodeId, componentName, prop, opts.parentVariant);
    }
    return setConditionalInstanceProp(code, nodeId, componentName, prop, opts.parentVariant, write.value, opts.defaultSeed);
  }

  // A per-VIEWPORT (or per-locale) scoped expression: the agent's base write
  // replaces only the primary/base branch, never the replicas' own values.
  if (getInstancePropBaseValue(code, nodeId, componentName, prop)) {
    const baseExpr = write ? (write.expression ? write.value : JSON.stringify(write.value)) : 'undefined';
    trace.action('agent-tool:set-component-prop:scoped-base', { nodeId, prop });
    return setInstancePropBaseInCode(code, nodeId, componentName, prop, baseExpr);
  }

  // Inside a component master, a prop that already varies per parent variant
  // keeps those branches: a literal write updates the DEFAULT branch only
  // (the panel does the same). An expression cannot live in that literal
  // ternary, so it replaces the prop.
  const map = currentConditionalMap(current);
  if (write && !write.expression && map && hasVariantOverrides(map)) {
    return setConditionalInstanceProp(code, nodeId, componentName, prop, 'default', write.value);
  }

  if (!write) return removeInstanceProp(code, nodeId, componentName, prop);
  return setInstanceProp(code, nodeId, componentName, prop, write.value, write.expression);
}

/** The attribute text now on the instance for `prop` (the copy JSX applies),
 *  plus how many copies the tag carries — for an honest tool reply. */
export function readInstancePropAttr(code: string, target: InstancePropTarget): { text: string | null; copies: number } {
  const tagRange = findInstanceTag(code, target.nodeId, target.componentName);
  if (!tagRange) return { text: null, copies: 0 };
  const tag = code.slice(tagRange.tagStart, tagRange.tagEnd);
  const hits = findTagAttrs(tag, target.prop);
  const last = hits[hits.length - 1];
  return { text: last ? tag.slice(last.start, last.end) : null, copies: hits.length };
}
