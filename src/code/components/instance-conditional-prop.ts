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

/** `'…'` or `"…"` with backslash escapes — two capture groups (single, double). */
const STRING_LITERAL_SRC = `'((?:[^'\\\\\\n]|\\\\.)*)'|"((?:[^"\\\\\\n]|\\\\.)*)"`;

function unescapeSingle(body: string): string {
  return body.replace(/\\(.)/g, '$1');
}

function unescapeDouble(body: string): string {
  try { return JSON.parse(`"${body}"`) as string; } catch { return body.replace(/\\(.)/g, '$1'); }
}

/** A JS string literal for `v`: `'v'` when that is safe, else an escaped
 *  double-quoted literal (an apostrophe in `'…'` ends the string early). */
function quoteLiteral(v: string): string {
  return /['\\\n]/.test(v) ? JSON.stringify(v) : `'${v}'`;
}

/**
 * The conditional map behind an instance prop's CURRENT value (as read by the
 * JSX attribute scanner): a string attr is the default branch; an expression is
 * a parent-variant ternary, a raw number/boolean, or an escaped string literal.
 * Null when absent or not a shape the map can carry (a variable, a call…).
 */
export function currentConditionalMap(
  value: { kind: 'string'; text: string } | { kind: 'expr'; source: string } | { kind: 'bare' } | null,
): ConditionalPropMap | null {
  if (!value) return null;
  if (value.kind === 'string') return { default: value.text };
  if (value.kind === 'bare') return { default: 'true' };
  const src = value.source.trim();
  const parsed = parseConditionalPropExpression(src);
  if (parsed) return parsed;
  // Expression form that isn't a ternary yet (`prop={18}`, `prop={true}`)
  // — seed the default branch from the raw literal so the first per-variant
  // write keeps the base value instead of dropping it.
  if (/^(-?\d+(?:\.\d+)?|true|false)$/.test(src)) return { default: src };
  const lit = new RegExp(`^(?:${STRING_LITERAL_SRC})$`, 's').exec(src);
  if (lit) return { default: lit[1] !== undefined ? unescapeSingle(lit[1]) : unescapeDouble(lit[2]) };
  return null;
}

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
  // A string branch may carry ESCAPED quotes (`'Let\\'s go'`, `"say \\"hi\\""`) —
  // the formatter escapes them (a bare `'` inside `'…'` ended the literal and
  // broke the page), so the parser must read them back or the next write
  // would rebuild the map from scratch and drop every other variant's value.
  const branchRegex = new RegExp(
    `^\\s*(?:${PARENT_VARIANT_VARS.join('|')})\\s*===\\s*['"]([^'"]+)['"]\\s*\\?\\s*(?:${STRING_LITERAL_SRC}|(-?\\d+(?:\\.\\d+)?|true|false))\\s*:\\s*(.+)$`,
    's',
  );

  while (true) {
    const m = remaining.match(branchRegex);
    if (!m) break;
    const variantName = m[1];
    const value = m[2] !== undefined ? unescapeSingle(m[2]) : m[3] !== undefined ? unescapeDouble(m[3]) : m[4];
    map[variantName] = value;
    remaining = m[5].trim();
  }

  // Final fallback: a string literal `'...'`/`"..."` or a raw number/boolean.
  const fallbackMatch = remaining.match(new RegExp(`^(?:${STRING_LITERAL_SRC}|(-?\\d+(?:\\.\\d+)?|true|false))\\s*$`, 's'));
  if (!fallbackMatch) {
    trace.fn('instance-conditional-prop:parse:fallback-not-string', { expr, remaining });
    return null;
  }
  map['default'] = fallbackMatch[1] !== undefined
    ? unescapeSingle(fallbackMatch[1])
    : fallbackMatch[2] !== undefined ? unescapeDouble(fallbackMatch[2]) : fallbackMatch[3];

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
  const emit = (v: string) => (/^(-?\d+(?:\.\d+)?|true|false)$/.test(v) ? v : quoteLiteral(v));
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

/**
 * The same ternary, but for branches that are VARIABLE references rather than
 * literals — a per-variant prop bound to the master's own variables, which is
 * how a pricing card drives one number from two prices:
 *
 *   value={variant === 'variant-1' ? priceYearly : priceMonthly}
 *
 * `parseConditionalPropExpression` deliberately only accepts literal branches
 * (it feeds the value editors), so the panel saw a raw ternary and showed the
 * expression instead of the binding (live find 2026-09-17). Returns parent
 * variant name → variable name, always including `default`, or null.
 */
export function parseConditionalPropVarRefs(expr: string): Record<string, string> | null {
  const trimmed = expr.trim();
  if (!trimmed.includes('?') || !trimmed.includes('===')) return null;
  const IDENT = '[A-Za-z_$][\\w$]*';
  const branchRegex = new RegExp(
    `^\\s*(?:${PARENT_VARIANT_VARS.join('|')})\\s*===\\s*['"]([^'"]+)['"]\\s*\\?\\s*(${IDENT})\\s*:\\s*(.+)$`,
    's',
  );
  const out: Record<string, string> = {};
  let remaining = trimmed;
  for (;;) {
    const m = remaining.match(branchRegex);
    if (!m) break;
    // `undefined` is the "no value on this variant" sentinel, not a variable.
    if (m[2] === 'undefined') return null;
    out[m[1]] = m[2];
    remaining = m[3].trim();
  }
  if (Object.keys(out).length === 0) return null;
  const fallback = remaining.match(new RegExp(`^(${IDENT})\\s*$`));
  if (!fallback || fallback[1] === 'undefined') return null;
  out.default = fallback[1];
  return out;
}

/** The variable a per-variant binding uses on `variant` (or its default branch). */
export function conditionalPropVarForVariant(expr: string, variant: string | null): string | null {
  const refs = parseConditionalPropVarRefs(expr);
  if (!refs) return null;
  return (variant && refs[variant]) ?? refs.default ?? null;
}
