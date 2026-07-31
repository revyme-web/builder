// id-renames.ts — Shared id-rename helpers for paste-engine.
//
// Two places need the same rewriting logic:
//   1. effects-injector: rewriting raw source slices that the
//      extractor captured at copy-time (function-scope refs, hooks,
//      useEffect blocks, effect consts).
//   2. node-creator: rewriting `var:<prefix><Suffix>` strings sitting
//      in copied node styles — the JSX style values that reference
//      function-scope motion values. Without renaming these, the
//      pasted node's style points at the SOURCE page's variable
//      names, and the destination's freshly-injected hooks (named
//      after the NEW pasted id) never connect to it.
//
// Both call-sites share the same logic and the same edge cases:
//   - Identifier-name boundary: `<prefix>` must be followed by an
//     uppercase letter (the start of the suffix word; the generator
//     ALWAYS emits `<prefix>Suffix` form). Defensive against
//     accidental matches inside string literals (`"prefix"` → `"`
//     after the prefix isn't uppercase → no match).
//   - Both lowercase-first (`prefix`) and capitalised-first (`Prefix`)
//     forms get renamed — the generator emits `setPrefixSecPositions`
//     style names too.
//   - data-id literal renames are inside quotes only: `"<id>"` /
//     `'<id>'` → safe to swap byte-for-byte.

import { nodeIdToVarName, nodeIdToVarNameCapitalised } from '@/shared/id-utils';
import { escapeRegExp } from '@/shared/regex-utils';

// ─── Public ─────────────────────────────────────────────────────────────────

export interface IdRenamePairs {
  /** Source-id → destination-id, raw (unprocessed) forms. */
  raw: Array<[string, string]>;
  /** Lowercase-first var-name prefix renames, derived from `raw`. */
  prefixLower: Array<[string, string]>;
  /** Capitalised-first var-name prefix renames, derived from `raw`. */
  prefixUpper: Array<[string, string]>;
}

/**
 * Build the rename pair lists from an id-map. Sorted longest-first so
 * an id like `frame-mpoaahpp-2` doesn't get partially renamed by a
 * shorter `frame-mpoa` pair that happens to share a prefix.
 */
export function buildIdRenamePairs(idMap: Map<string, string>): IdRenamePairs {
  const raw: Array<[string, string]> = [];
  const prefixLower: Array<[string, string]> = [];
  const prefixUpper: Array<[string, string]> = [];

  for (const [srcId, dstId] of idMap) {
    if (srcId === dstId) continue;
    raw.push([srcId, dstId]);

    const lowerSrc = nodeIdToVarName(srcId);
    const lowerDst = nodeIdToVarName(dstId);
    prefixLower.push([lowerSrc, lowerDst]);

    const upperSrc = nodeIdToVarNameCapitalised(srcId);
    const upperDst = nodeIdToVarNameCapitalised(dstId);
    if (upperSrc !== lowerSrc) prefixUpper.push([upperSrc, upperDst]);
  }

  raw.sort((a, b) => b[0].length - a[0].length);
  prefixLower.sort((a, b) => b[0].length - a[0].length);
  prefixUpper.sort((a, b) => b[0].length - a[0].length);

  return { raw, prefixLower, prefixUpper };
}

/**
 * Apply both the raw-id rename (`'<id>'` / `"<id>"` selector strings)
 * AND the prefix renames (lower + upper) to a string. Used for source
 * slices that the effects-injector splices into the destination file.
 */
export function applyAllRenames(text: string, pairs: IdRenamePairs): string {
  let out = text;
  for (const [from, to] of pairs.raw) {
    const single = new RegExp(`'${escapeRegExp(from)}'`, 'g');
    const double = new RegExp(`"${escapeRegExp(from)}"`, 'g');
    out = out.replace(single, `'${to}'`).replace(double, `"${to}"`);
  }
  out = applyPrefixRenames(out, pairs);
  return out;
}

/**
 * Apply ONLY prefix renames to a string. Used for `var:<prefix>X`
 * style values where the value is already inside quotes and we just
 * need to swap the prefix portion. No raw-id rename here because the
 * raw form (`<id>` standalone) doesn't appear in style values.
 */
export function applyPrefixRenames(text: string, pairs: IdRenamePairs): string {
  let out = text;
  // Capitalised-first FIRST. `Frame_a` is a strict superset match of
  // `frame_a` only after the leading `s` of `set…`, so order matters
  // when the lowercase form is a prefix of the capitalised form (it
  // isn't here, but ordering longest-first defensively never hurts).
  for (const [from, to] of pairs.prefixUpper) {
    const re = new RegExp(`${escapeRegExp(from)}(?=[A-Z])`, 'g');
    out = out.replace(re, to);
  }
  for (const [from, to] of pairs.prefixLower) {
    const re = new RegExp(`${escapeRegExp(from)}(?=[A-Z])`, 'g');
    out = out.replace(re, to);
  }
  return out;
}

/**
 * Walk a style map; for every value that starts with `var:`, run the
 * prefix renames on the suffix portion. Returns a new map; never
 * mutates the input.
 *
 * Doesn't touch values that don't start with `var:` — design-token
 * (`token:colors.primary`), conditional-variant (`condvar:foo:a:b`),
 * and ordinary CSS values pass through untouched.
 *
 * Used for BOTH `styles` and `attrs` maps — the `var:` sentinel is the
 * generic "this is an identifier reference, not a string" marker,
 * regardless of whether it lives on a style prop or an attribute like
 * `ref={X}`.
 */
export function renameVarStyleValues(
  styles: Record<string, string>,
  pairs: IdRenamePairs,
): Record<string, string> {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (typeof v === 'string' && v.startsWith('var:')) {
      const newSuffix = applyPrefixRenames(v.slice(4), pairs);
      const newValue = `var:${newSuffix}`;
      out[k] = newValue;
      if (newValue !== v) changed = true;
    } else {
      out[k] = v;
    }
  }
  // Return the same object reference when nothing changed — lets
  // callers do a cheap identity check to know whether to allocate a
  // new mutation payload.
  return changed ? out : styles;
}

// ─── Internals ──────────────────────────────────────────────────────────────

