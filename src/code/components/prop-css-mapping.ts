// prop-css-mapping.ts — Resolve which CSS property a component prop drives, from the component code.
//
// This is the LOCAL (single-file, non-recursive) part of prop→cssProp detection, shared by
// `ComponentPropsTool.detectPropCSSMapping` (which adds forwarded-child recursion on top) and the
// VariableModal (which resolves the right control for a browsed variable). Keeping it here avoids
// duplicating the three binding-shape regexes AND the ComponentPropsTool↔VariableModal circular import.

import { toCamel } from '@/shared/css-utils';

/**
 * Given a prop/variable name and the component's source, return the CSS property it drives — or '' if
 * none found locally. Handles the three binding shapes:
 *   1. Direct:       `cssProp: varName`
 *   2. Overlay:      `'--X': varName`  +  `<cssProp>: var(--X)`  (e.g. `::after { border: var(--X) }`)
 *   3. Per-variant:  `cssProp: initialVariant === 'v' ? varName : '…'`  (direct OR via `'--X'` overlay)
 */
// Single-slot memo keyed by code. localCssPropForVar runs up to 4 WHOLE-FILE regexes, and it's called ONCE
// PER component variable (ControlLabel.componentVariables, ComponentPropsTool, VariableModal). An UNUSED
// variable matches none → all 4 regexes scan the entire source → O(file size) × 4 PER var. With a panel
// re-rendering every drag frame on a template, that was the profiler's #1 self-time hotspot (138ms / 20.6%),
// and it scaled with TOTAL variable count (used or not) — exactly the reported "more variables = slower".
// Single slot (not a Map<code>) so the `code !== last` guard is an O(1) reference check while the same
// codeAtom string is reused across frames; the loop over all vars then reuses one cached sub-map. A real
// edit (new code reference) resets it. Pure function of (varName, code) → fully safe to memoise.
let _lccpvCode: string | null = null;
let _lccpvMap = new Map<string, string>();

export function localCssPropForVar(varName: string, code: string): string {
  if (code !== _lccpvCode) { _lccpvCode = code; _lccpvMap = new Map(); }
  const cached = _lccpvMap.get(varName);
  if (cached !== undefined) return cached;
  const result = computeLocalCssPropForVar(varName, code);
  _lccpvMap.set(varName, result);
  return result;
}

function computeLocalCssPropForVar(varName: string, code: string): string {
  // 1. Direct CSS use. The cssProp must be a real STYLE-OBJECT property — i.e. preceded by `{` or `,`
  // (`{ cssProp: var }`, `…, cssProp: var`). WITHOUT that anchor, a ternary's `consequent : alternate`
  // (`__mq2 ? direction345 : direction5hoisted`) false-matches as `direction345: direction5hoisted`,
  // making a base/alternate VARIABLE resolve to the consequent's NAME as a bogus cssProp.
  const direct = new RegExp(`[{,]\\s*(\\w+)\\s*:\\s*${varName}(?=[,\\s}])`).exec(code);
  if (direct) return direct[1];

  // 2. Overlay custom-property binding (`'--X': varName` consumed by `var(--X)`).
  const varBind = new RegExp(`['"]--([\\w-]+)['"]\\s*:\\s*${varName}(?=[,\\s}])`).exec(code);
  if (varBind) {
    const usage = new RegExp(`([\\w-]+)\\s*:\\s*var\\(--${varBind[1]}\\b`).exec(code);
    if (usage) return toCamel(usage[1]);
  }

  // 3. Per-variant conditional binding (the var is a branch of a variant ternary), direct or overlay. The cssProp
  // MUST be a real STYLE-OBJECT key — anchored by a preceding `{` or `,` (like the direct case). WITHOUT that
  // anchor, a CHAINED ternary's `consequent : variant === …` false-matches the consequent as a cssProp — e.g. a
  // chained MotionConfig `{ … transition2 : variant === 'variant-1' ? transition1 … }` resolved `transition1`'s
  // cssProp to `transition2` (a non-style identifier) → the variable modal / instance editor lost the transition
  // control and showed a raw input.
  const cond = new RegExp(
    `[{,]\\s*(['"]--[\\w-]+['"]|\\w+)\\s*:\\s*(?:initialVariant|variant)\\s*===[^,{}]*?\\?[^,{}]*?\\b${varName}\\b`,
  ).exec(code);
  if (cond) {
    const key = cond[1];
    if (key.startsWith("'") || key.startsWith('"')) {
      const customVar = key.replace(/['"]/g, '').slice(2); // strip quotes + `--`
      const usage = new RegExp(`([\\w-]+)\\s*:\\s*var\\(--${customVar}\\b`).exec(code);
      if (usage) return toCamel(usage[1]);
    } else {
      return key;
    }
  }

  // 4. Per-VIEWPORT conditional binding — the var is a branch of a `__mq` media-query ternary
  // (`transform: (__mq2 ? transform1 : transform)`). Same shape as the variant ternary above but gated by
  // `__mqN` instead of `initialVariant ===`. Without this a per-viewport STYLE variable (the transform var
  // bound on a replica) resolved to no CSS prop → the variable modal's Default editor fell back to a text
  // input instead of the real control (e.g. the Transform popup). `[^,{}]` keeps the match inside one value.
  const vp = new RegExp(
    `[{,]\\s*(['"]--[\\w-]+['"]|\\w+)\\s*:\\s*\\(?\\s*__mq\\d+\\s*\\?[^,{}]*?\\b${varName}\\b`,
  ).exec(code);
  if (vp) {
    const key = vp[1];
    if (key.startsWith("'") || key.startsWith('"')) {
      const customVar = key.replace(/['"]/g, '').slice(2);
      const usage = new RegExp(`([\\w-]+)\\s*:\\s*var\\(--${customVar}\\b`).exec(code);
      if (usage) return toCamel(usage[1]);
    } else {
      return key;
    }
  }

  return '';
}

/** A child component's source + path, returned by the host-injected resolver. */
export interface ChildResolution { code: string; filePath: string; }
/**
 * Resolve a child component instance (`<Tag …/>`) referenced in `parentCode` (at `parentFilePath`) to
 * its source + path. Injected by callers so this pure module needs no `projectFS` / import-resolver
 * import (and no ComponentPropsTool↔VariableModal cycle). Return null when the tag can't be resolved.
 */
export type ResolveChildCode = (childTag: string, parentCode: string, parentFilePath: string) => ChildResolution | null;

/**
 * THE single, shared "which cssProp does this variable/prop ultimately drive?" resolver — used by the
 * VariableModal (control for the Default editor), ComponentPropsTool (control per instance-prop row),
 * and the Template tool (control per hoisted variable). Consolidates the three former copies.
 *
 * Resolution order:
 *   1. LOCAL shapes in `code` — direct / overlay / per-variant ternary (`localCssPropForVar`).
 *   2. FORWARDED into a child instance — `<Child childProp={varName} … />` → recurse into the child's
 *      source for `childProp` (multi-level; needs `filePath` + `resolveChildCode` — omit them to skip).
 * Returns '' when nothing resolves (caller may then `inferPropertyFromValue` the default).
 */
export function resolveVariableCssProp(
  varName: string,
  code: string,
  filePath?: string,
  resolveChildCode?: ResolveChildCode,
  depth = 0,
): string {
  const local = localCssPropForVar(varName, code);
  if (local) return local;
  // Forwarded path. `[^<>]*?` (not `[\s\S]*?`) so the attr pairing can't leak across sibling tags.
  // The value brace matches the var as a DIRECT binding (`prop={var}`) OR anywhere inside a single-brace
  // expression (`prop={__mq2 ? var : base}` — a per-viewport ternary; `prop={cond ? var : x}`), so a
  // hoisted var bound per-viewport resolves the same as a base binding. The `(?<![\w.])`/`(?![\w.])`
  // bounds keep it a STANDALONE identifier (never `foo.var` / `varX`).
  if (filePath && resolveChildCode && depth < 8) {
    const fwd = new RegExp(`<(\\w+)([^<>]*?)\\s(\\w+)=\\{[^{}]*?(?<![\\w.])${varName}(?![\\w.])[^{}]*?\\}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = fwd.exec(code)) !== null) {
      const childTag = m[1];
      const childProp = m[3];
      if (!/^[A-Z]/.test(childTag)) continue; // only PascalCase tags are component instances
      const child = resolveChildCode(childTag, code, filePath);
      if (!child) continue;
      const r = resolveVariableCssProp(childProp, child.code, child.filePath, resolveChildCode, depth + 1);
      if (r) return r;
    }
  }
  return '';
}

/**
 * Fallback when `localCssPropForVar` finds no live binding (an ORPHAN variable — created, then
 * unbound from every node via the × which keeps the prop). Without a usage site there's nothing to
 * infer the control from, so the Variable modal would show a bare text box for what's obviously a
 * color/shadow/border. Infer a representative CSS property from the default VALUE's shape so the
 * right editor still mounts. Returns '' for ambiguous values (a bare `12px` could be width / radius /
 * gap / …) — those legitimately fall back to a text input.
 */
export function inferPropertyFromValue(value: string): string {
  const v = (value ?? '').trim();
  if (!v) return '';
  // Color: #hex, rgb()/rgba(), hsl()/hsla(), or the CSS color keywords we care about.
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|currentcolor\b|transparent\b)/i.test(v)) return 'backgroundColor';
  // Border shorthand: `<width> <style> <color>` (style keyword is the tell).
  if (/^-?[\d.]+\w*\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/i.test(v)) return 'border';
  // Shadow: multiple length offsets (`0px 4px 8px …`) or a color-bearing offset list.
  if (/-?[\d.]+\w*\s+-?[\d.]+\w*\s+-?[\d.]+/.test(v) || (/rgba?\(/.test(v) && v.includes(','))) return 'boxShadow';
  // CSS cursor keyword — so an (orphan) WEB cursor variable like `pointer` resolves to the cursor
  // family. Excludes the super-ambiguous auto/default/none/inherit (could be many properties).
  if (CURSOR_KEYWORDS.has(v.toLowerCase())) return 'cursor';
  return '';
}

const CURSOR_KEYWORDS = new Set([
  'pointer', 'grab', 'grabbing', 'crosshair', 'move', 'wait', 'help', 'not-allowed', 'progress',
  'cell', 'copy', 'alias', 'no-drop', 'zoom-in', 'zoom-out', 'all-scroll', 'col-resize', 'row-resize',
  'context-menu', 'vertical-text', 'text',
  'e-resize', 'n-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
]);

/**
 * Is a variable/prop named `name` ACTUALLY APPLIED somewhere in `code`? Used by BOTH the instance editor
 * (ComponentPropsTool) and the Template tool to hide a variable that was created then never bound (or
 * X-unbound) — it drives nothing, so listing it is noise. Works for EVERY variable type because it matches
 * every binding form the editor writes:
 *   - `prop={…name…}`  — attr / forwarded into a nested instance / per-variant or per-viewport ternary
 *   - `{name}`         — text node (plainText / formattedText / componentCursor display)
 *   - `prop: name`     — style or object value (color / number / image / shadow / radius / …)
 *   - `(name`          — a call argument: withCursor(name, …), setTimeout(name, …)
 *   - `var(--name)`    — CSS custom property (border / shadow overlays)
 * The `(?<![\w$.])name(?![\w$])` guard means `item.name` / `nameFoo` never false-match a variable `name`.
 * Default-to-FALSE (hide) when nothing matches.
 */
export function isVariableAppliedInCode(name: string, code: string): boolean {
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const E = `(?<![\\w$.])${esc}(?![\\w$])`; // the bare identifier, not a member access / longer ident
  return new RegExp(
    // prop={…name…} — a SINGLE-brace expression (direct attr / forward / ternary). EXCLUDE `={{` (style
    // objects): a style PROPERTY KEY like `={{ color: … }}` would otherwise false-match a variable named
    // `color`; the style VALUE case is covered by the `: name` form below instead.
    `=\\{(?!\\{)[^}]*${E}`
    + `|\\{\\s*${E}\\s*\\}`  // {name}      — text node
    + `|:\\s*${E}[\\s,}]`    // prop: name  — style / object value (also a ternary FALSE branch `… : name`)
    + `|(?<!\\?)\\?\\s*${E}`    // ? name      — ternary TRUE branch: a PER-VARIANT style binding inside a
                               // `={{ }}` object (`color: variant === 'v6' ? name : '#000'`) is hidden from
                               // the `={{`-excluded attr form AND the `: name` form (the var sits after `?`,
                               // not `:`), so without this the prop reads as "unused" → never listed/hoistable.
                               // `(?<!\\?)` excludes the NULLISH `?? name` (template boilerplate `x = __tp.x
                               // ?? x` must NOT count as a use). Safe: `a?.name` is excluded by E's
                               // `(?<![\\w$.])` guard; `prop?: T` has `:` (not the ident) right after `?`.
    + `|\\(\\s*${E}`           // (name       — call arg (withCursor / setTimeout)
    + `|--${esc}(?![\\w-])`,   // var(--name) — CSS custom property. `(?![\\w-])` is CRITICAL: a bare `\\b`
                               // makes a DESIGN TOKEN like var(--color-white) false-match a variable `color`
                               // (the hyphen reads as a word boundary) → an unbound var wrongly shows.
  ).test(code);
}
