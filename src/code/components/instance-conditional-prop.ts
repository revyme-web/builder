// instance-conditional-prop.ts — Per-variant prop overrides on component instances.
//
// When a child component instance is selected on a non-default parent variant
// and the user changes one of its props (e.g. `initialVariant` via the variant
// tool), the new value should ONLY affect that parent variant — not all
// variants. We encode this as a ternary expression on the JSX prop, keyed off
// the parent component's variant prop:
//
//   <KuLeKu initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'} />
//
// At runtime (production) the ternary evaluates against the parent's actual
// `initialVariant` prop (or `variant` when there are connections), giving
// independent per-parent-variant child variant choices.
//
// This module provides the parser+formatter pair so the same shape is read
// back into a per-variant map for the canvas + Properties Panel.

import { trace } from '@/shared/debug-trace';

/**
 * Parsed conditional prop: parent variant name → value for that parent variant.
 * Always includes a `default` entry (the fallback branch of the ternary).
 *
 * Examples:
 *   "default"                                              → { default: 'default' }
 *   initialVariant === 'v1' ? 'a' : 'b'                    → { 'v1': 'a', default: 'b' }
 *   initialVariant === 'v1' ? 'a' : initialVariant === 'v2' ? 'b' : 'c'
 *                                                          → { v1: 'a', v2: 'b', default: 'c' }
 */
export type ConditionalPropMap = Record<string, string>;

const PARENT_VARIANT_VARS = ['initialVariant', 'variant'] as const;

/**
 * Try to parse a JSX expression value as a conditional prop ternary
 * (initialVariant === 'X' ? 'A' : ...). Returns the parsed map, or null when
 * the expression doesn't match the variant-conditional shape.
 */
export function parseConditionalPropExpression(expr: string): ConditionalPropMap | null {
  const trimmed = expr.trim();
  if (!trimmed.includes('?') || !trimmed.includes('===')) return null;

  const map: ConditionalPropMap = {};
  let remaining = trimmed;

  // Match: <var> === '<variant>' ? '<value>' : <rest>
  // <var> must be one of PARENT_VARIANT_VARS so we don't capture unrelated ternaries.
  // <value> must be a string literal (single or double quoted).
  // Branch values: quoted strings OR raw number/boolean literals (per-variant
  // code-component props — a quoted "false" toggle would be truthy at runtime).
  const branchRegex = new RegExp(
    `^\\s*(?:${PARENT_VARIANT_VARS.join('|')})\\s*===\\s*['"]([^'"]+)['"]\\s*\\?\\s*(?:['"]([^'"]*)['"]|(-?\\d+(?:\\.\\d+)?|true|false))\\s*:\\s*(.+)$`,
    's',
  );

  while (true) {
    const m = remaining.match(branchRegex);
    if (!m) break;
    const variantName = m[1];
    const value = m[2] !== undefined ? m[2] : m[3];
    map[variantName] = value;
    remaining = m[4].trim();
  }

  // Final fallback: a string literal `'...'`/`"..."` or a raw number/boolean.
  const fallbackMatch = remaining.match(/^(?:['"]([^'"]*)['"]|(-?\d+(?:\.\d+)?|true|false))\s*$/);
  if (!fallbackMatch) {
    trace.fn('instance-conditional-prop:parse:fallback-not-string', { expr, remaining });
    return null;
  }
  map['default'] = fallbackMatch[1] !== undefined ? fallbackMatch[1] : fallbackMatch[2];

  if (Object.keys(map).length === 0) return null;
  trace.fn('instance-conditional-prop:parsed', { expr, map });
  return map;
}

/**
 * Format a conditional prop map back into a JSX expression value (NO braces).
 * If the map only has the `default` entry, returns just the literal string
 * value; otherwise builds a chained ternary keyed off `parentVarName`.
 */
export function formatConditionalPropExpression(
  map: ConditionalPropMap,
  parentVarName: 'initialVariant' | 'variant' = 'initialVariant',
): string {
  // An empty default branch is INVALID for a variant prop — `initialVariant={…
  // : ''}` makes framer-motion resolve variant `''` (nonexistent), so the child
  // instance renders broken / invisible in the parent's default variant. Fall
  // back to the child's primary variant `'default'`.
  const defaultVal = map['default'] || 'default';
  const branches = Object.entries(map).filter(([k]) => k !== 'default');

  if (branches.length === 0) {
    return defaultVal;
  }

  // Raw number/boolean values stay UNQUOTED (typed props: sliders, toggles —
  // a quoted "false" is truthy at runtime); everything else is quoted.
  const emit = (v: string) => (/^(-?\d+(?:\.\d+)?|true|false)$/.test(v) ? v : `'${v}'`);
  // Chain: var === 'v1' ? 'a' : var === 'v2' ? 'b' : 'default'
  const chain = branches
    .map(([variantName, value]) => `${parentVarName} === '${variantName}' ? ${emit(value)}`)
    .join(' : ');
  return `${chain} : ${emit(defaultVal)}`;
}

/**
 * Resolve which value applies for a given parent variant name. Falls back to
 * `default` when the variant has no explicit override.
 */
export function resolveConditionalPropValue(
  map: ConditionalPropMap,
  parentVariantName: string,
): string {
  return map[parentVariantName] ?? map['default'] ?? '';
}

// ─── Variable-aware conditional prop (the hoist twin) ────────────────────────
// `setConditionalInstanceProp` writes LITERAL per-parent-variant overrides. When
// the user HOISTS a nested instance's variant on ONE parent variant, that branch
// must instead be a bound VARIABLE (a bare identifier, NOT a quoted literal):
//
//   initialVariant={variant === 'variant-6' ? logoMarkVariant : 'default'}
//
// so the new variable drives the child variant ONLY on that parent variant; every
// other variant keeps its literal. This is the per-VARIANT twin of the per-VIEWPORT
// `__mq` variable binding (responsive-instance-prop-vars-gen). The shared
// `ConditionalPropMap` stays literal-only; these rich helpers carry the var flag.

/** A conditional-prop branch: a quoted literal value, or a bound variable (bare identifier). */
export type RichCondBranch = { value: string; isVar: boolean };
export type RichConditionalPropMap = Record<string, RichCondBranch>;

/** Classify a raw ternary-branch token as a VARIABLE (bare identifier) or a LITERAL. `undefined`/`null`
 *  (the absent/empty states) are the empty literal, never a variable named "undefined". */
export function classifyCondBranch(raw: string): RichCondBranch {
  const t = raw.trim();
  if (t === 'undefined' || t === 'null') return { value: '', isVar: false };
  const lit = t.match(/^['"]([^'"]*)['"]$/s);
  if (lit) return { value: lit[1], isVar: false };
  if (/^[a-zA-Z_$][\w$]*$/.test(t)) return { value: t, isVar: true };
  return { value: t, isVar: false };
}

/** Parse a (possibly MIXED literal/variable) conditional-prop ternary into a rich map. Each branch value
 *  is a quoted literal or a bare identifier. Returns null when the expr isn't a parent-variant ternary. */
export function parseRichConditionalProp(expr: string): RichConditionalPropMap | null {
  const trimmed = expr.trim();
  if (!trimmed.includes('?') || !trimmed.includes('===')) return null;
  const map: RichConditionalPropMap = {};
  let remaining = trimmed;
  // <parentVar> === 'v' ? (<'literal'> | <identifier>) : <rest>
  const branchRe = new RegExp(
    `^\\s*(?:${PARENT_VARIANT_VARS.join('|')})\\s*===\\s*['"]([^'"]+)['"]\\s*\\?\\s*(['"][^'"]*['"]|[a-zA-Z_$][\\w$]*)\\s*:\\s*(.+)$`,
    's',
  );
  while (true) {
    const m = remaining.match(branchRe);
    if (!m) break;
    map[m[1]] = classifyCondBranch(m[2]);
    remaining = m[3].trim();
  }
  const fb = remaining.match(/^(['"][^'"]*['"]|[a-zA-Z_$][\w$]*)\s*$/s);
  if (!fb) {
    trace.fn('instance-conditional-prop:parse-rich:fallback-not-value', { expr, remaining });
    return null;
  }
  map['default'] = classifyCondBranch(fb[1]);
  if (Object.keys(map).length === 0) return null;
  return map;
}

/** Format a rich map back into a ternary expr (NO braces): literals quoted, variables bare. An empty
 *  default falls back to the child's primary variant `'default'` (same invariant as the literal formatter). */
export function formatRichConditionalProp(
  map: RichConditionalPropMap,
  parentVarName: 'initialVariant' | 'variant' = 'initialVariant',
): string {
  const fmt = (b: RichCondBranch) => (b.isVar ? b.value : `'${b.value || 'default'}'`);
  const def = map['default'] ?? { value: 'default', isVar: false };
  const branches = Object.entries(map).filter(([k]) => k !== 'default');
  if (branches.length === 0) return fmt(def);
  const chain = branches.map(([v, b]) => `${parentVarName} === '${v}' ? ${fmt(b)}`).join(' : ');
  return `${chain} : ${fmt(def)}`;
}

/**
 * Apply an update to a conditional prop map for a single parent variant.
 *
 * - When `parentVariantName === 'default'`: writes the default branch.
 * - When `value === defaultBranchValue` AND parentVariant !== 'default':
 *   removes that branch (it would be redundant — the default already covers it).
 * - Returns null when the resulting map collapses to a single 'default' that
 *   matches the original `removeWhenEqualsDefault` (caller can then drop the
 *   conditional entirely and write a plain string).
 */
export function setConditionalPropEntry(
  map: ConditionalPropMap | null,
  parentVariantName: string,
  value: string,
): ConditionalPropMap {
  const next: ConditionalPropMap = { ...(map ?? {}) };
  // Seed the fallback with the child's primary variant, never '' — an empty
  // variant name breaks the child instance in the parent's default variant.
  if (!next['default']) next['default'] = 'default';

  if (parentVariantName === 'default') {
    next['default'] = value;
  } else {
    if (value === next['default']) {
      delete next[parentVariantName];
    } else {
      next[parentVariantName] = value;
    }
  }

  trace.fn('instance-conditional-prop:set', { parentVariantName, value, next });
  return next;
}

/**
 * Detect whether a map has any per-variant override (i.e. needs a ternary in
 * the source) vs. just a plain default value.
 */
export function hasVariantOverrides(map: ConditionalPropMap): boolean {
  return Object.keys(map).some(k => k !== 'default');
}
