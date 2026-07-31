// value-eval.ts — the ONE canonical interpreter for a stored variable/prop value.
//
// Why this exists: stored binding values are bare strings, and ~27 sites across parser / Renderer /
// canvas / sandbox / editor each re-guessed their meaning (the `=== 'true'` vs OFF-state-list
// disagreement, the 3-way number-unit handling, the `"\"46px\""` over-escaping). Centralizing the
// interpretation here retires that whole bug class: a value's meaning is decided in exactly one place,
// optionally keyed off its declared `PageVariableType`.
//
// IMPORTANT — the canvas is fully imperative + DOM-only and `deploy = source`, so these functions must
// match what the SHIPPED runtime evaluates for the same string. `isTruthy` mirrors JS truthiness for a
// toggle (`prop ? a : b`) over the editor's toggle values; `toNumber` mirrors how React/CSS read a
// numeric string. Do NOT add "smart" interpretation that diverges from the runtime.

import type { PageVariableType } from '@/code/features/page-variables';

// ── Truthiness ───────────────────────────────────────────────────────────────
// A toggle is stored as a string. It is OFF iff it is one of these explicit off-states; anything else
// (`'none'`, `'yes'`, `'true'`, `'block'`, …) is ON. This is the single source of the list that used to
// be duplicated inline in project-parser.ts and parser.ts. Matches the live site: `'none' ? a : b` → a.
// Exactly the 7 states the inline lists at project-parser.ts and parser.ts used (kept identical so
// migrating those sites is byte-for-byte parity, not a behavior change).
const OFF_STATES = new Set(['false', '', '0', 'undefined', 'null', 'no', 'No']);

/** Canonical truthiness for a toggle value stored as a string. `null`/`undefined` → OFF. */
export function isTruthy(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  return !OFF_STATES.has(raw);
}

// ── String un-escaping (numeric/scalar path only) ─────────────────────────────
/**
 * Undo source-literal over-escaping that has crept into some stored defaults — e.g. a padding default
 * stored as `"\"46px\""` (JS string: `"46px"`, with literal quote chars) or the double-escaped
 * `\"46px\"`. Returns `46px`.
 *
 * CONSERVATIVE BY DESIGN: only strips quotes that wrap the ENTIRE value (closing quote at the very end),
 * so a legitimate CSS value like `"Helvetica Neue", sans-serif` (closing quote NOT at the end) is left
 * untouched. Even so, callers should reserve this for the NUMERIC/scalar path where a wrapping quote is
 * unambiguously corruption — text/color values may legitimately be quoted, so `evaluate` does not strip
 * those. Idempotent + safe on already-clean input.
 */
export function unquote(raw: string): string {
  let s = raw;
  // Strip at most a few layers of whole-value wrapping quotes (optionally backslash-escaped).
  for (let i = 0; i < 4; i++) {
    const m = /^\s*\\*(["'])([\s\S]*?)\\*\1\s*$/.exec(s);
    if (!m) break;
    s = m[2];
  }
  return s;
}

// ── Numbers ───────────────────────────────────────────────────────────────────
/**
 * Parse a CSS-ish numeric string into its number + unit. Never NaN-leaks — a non-numeric input returns
 * `{ n: 0, unit: '', ok: false }` so callers can branch on `ok` instead of guarding NaN themselves.
 *   '16px'  → { n: 16,  unit: 'px',  ok: true }
 *   '16'    → { n: 16,  unit: '',    ok: true }
 *   '1.5rem'→ { n: 1.5, unit: 'rem', ok: true }
 *   '50%'   → { n: 50,  unit: '%',   ok: true }
 *   ''/'auto'/'calc(…)' → { n: 0, unit: '', ok: false }
 * Returning BOTH the number and the unit is deliberate: it forces each caller to state whether it wants
 * the numeric value (slider math, `t.numericLiteral`) or the original string — the source of the old
 * 3-way disagreement was sites blindly `parseFloat`-ing a value that needed to stay `'16px'`.
 */
export function toNumber(raw: string | null | undefined): { n: number; unit: string; ok: boolean } {
  if (raw == null) return { n: 0, unit: '', ok: false };
  const s = unquote(String(raw)).trim();
  const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(s);
  if (!m) return { n: 0, unit: '', ok: false };
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? { n, unit: m[2] ?? '', ok: true } : { n: 0, unit: '', ok: false };
}

// ── Runtime scalar coercion (no type info available) ──────────────────────────
/**
 * Shape-inferred coercion for a string prop value passed to a live code component, where the declared
 * type is NOT available — the shared body of `coerceValue` (CodeComponentHost) and `coerceProps`
 * (sandbox), which were byte-for-byte equivalent for their gated inputs (`parseFloat` vs `Number` agree
 * on the pure-number regex). Only coerces unambiguous scalars: `'true'`/`'false'` → boolean, a PURE
 * number (no unit) → number; everything else (incl. `'16px'`) stays a string. Non-strings pass through.
 */
export function coerceScalar(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// ── Typed dispatcher ──────────────────────────────────────────────────────────
/**
 * Interpret a stored value using its DECLARED variable type. Use this when the `PageVariableType` is in
 * scope (the type model was declared but ignored by ~26 of 27 sites). Returns the canonical typed value:
 *   'boolean' → boolean (isTruthy)
 *   'number'  → number (parsed; unit dropped — number variables re-append their unit at use site). A
 *               non-numeric value falls back to the raw string so nothing is silently zeroed.
 *   'text' | 'color' | 'image' | 'componentCursor' → the raw string UNCHANGED (quotes may be legitimate).
 */
export function evaluate(raw: string, type: PageVariableType): boolean | number | string {
  switch (type) {
    case 'boolean': return isTruthy(raw);
    case 'number': { const r = toNumber(raw); return r.ok ? r.n : raw; }
    default: return raw;
  }
}
