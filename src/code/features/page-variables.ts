// page-variables.ts — Per-page variables (standard typed primitives).
//
// Variables are page-level state declared in a /** @pageVariables { ... } */
// annotation block. Each variable has a name, primitive type (number / text /
// boolean / color), default value, and optional queryParam (for ?param=value
// URL binding).
//
// Variables are CONSUMED by:
//   - Property bindings on style values (Phase 2): a property reads a variable
//     directly OR through a conditional expression that maps the variable's
//     value to a property-typed output.
//   - "Set Variable" interactions (Phase 3): an event handler calls setX(value)
//     to mutate the variable at runtime.
//
// This file owns the storage layer only — serialization to/from the annotation
// block. It does NOT emit useState() or useSearchParams() into the function
// body; that lives in the generator (Phase 2 once at least one binding exists,
// because emitting a React hook for an unused variable would create a lint
// warning).

import { trace } from '@/shared/debug-trace';
import { removePropMetaInCode } from '../components/prop-meta';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PageVariableType = 'number' | 'text' | 'boolean' | 'color' | 'image' | 'componentCursor';

export interface PageVariable {
  /** camelCase identifier — used both as the React state name and the binding key. */
  name: string;
  type: PageVariableType;
  /**
   * Default value as a string. Coerced to the appropriate runtime type:
   *   number  → parseFloat
   *   boolean → 'true' | 'false'
   *   color   → kept as-is (CSS color string)
   *   text    → kept as-is
   */
  default: string;
  /**
   * Optional URL query parameter name. When set, the variable's initial value
   * is read from `?<queryParam>=...` on page load (URL → state) and the URL
   * is updated when the variable changes (state → URL).
   */
  queryParam?: string;
  /** Optional human-readable note shown in the Variable modal. Authoring-only metadata. */
  description?: string;
}

export interface PageVariablesConfig {
  variables: PageVariable[];
}

// ─── Annotation block ───────────────────────────────────────────────────────

const PAGE_VARS_REGEX = /\/\*\*\s*@pageVariables\s*(\{[\s\S]*?\})\s*\*\/\s*\n?/;

/**
 * Parse the /** @pageVariables { ... } *​/ block from code. Returns null when
 * the block is absent — callers should treat this as "no variables defined."
 *
 * Robust against malformed JSON: we log + return null rather than throwing,
 * so a typo in one block doesn't break the whole canvas.
 */
export function parsePageVariables(code: string): PageVariablesConfig | null {
  const match = code.match(PAGE_VARS_REGEX);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const variables = Array.isArray(parsed.variables) ? parsed.variables.map(normalizeVariable) : [];
    trace.fn('page-variables:parse', { count: variables.length });
    return { variables };
  } catch {
    trace.error('page-variables:parse-failed', { raw: match[1].slice(0, 100) });
    return null;
  }
}

/** Coerce a parsed JSON variable to a typed PageVariable, dropping invalid entries. */
function normalizeVariable(raw: unknown): PageVariable | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : null;
  const type = typeof r.type === 'string' ? r.type : null;
  if (!name || !type || !isPageVariableType(type)) return null;
  const def: PageVariable = {
    name,
    type: type,
    default: r.default == null ? defaultForType(type) : String(r.default),
  };
  if (typeof r.queryParam === 'string' && r.queryParam) def.queryParam = r.queryParam;
  if (typeof r.description === 'string' && r.description) def.description = r.description;
  return def;
  // (TS narrowing is happy via the runtime check; the `null` filter happens at the call site.)
}

function isPageVariableType(t: string): t is PageVariableType {
  return t === 'number' || t === 'text' || t === 'boolean' || t === 'color' || t === 'image' || t === 'componentCursor';
}

/** Sensible default value for a fresh variable of the given type. */
export function defaultForType(type: PageVariableType): string {
  switch (type) {
    case 'number': return '1';
    case 'text': return '';
    case 'boolean': return 'false';
    case 'color': return '#000000';
    // Image variables are stored as the full CSS background-image string so
    // that `style={{ backgroundImage: imageVar }}` renders directly without
    // a runtime wrap. Empty default = no image yet.
    case 'image': return '';
    // Component-cursor variables hold a component identifier name (e.g.
    // "Pointer"). Empty default means "no cursor configured yet" — the
    // wrapping component instance must supply one at the page level.
    case 'componentCursor': return '';
  }
}

// ─── Serialization ──────────────────────────────────────────────────────────

export function serializePageVariables(config: PageVariablesConfig): string {
  const variables = config.variables
    .filter((v): v is PageVariable => v != null)
    .map(v => {
      const o: Record<string, unknown> = { name: v.name, type: v.type, default: v.default };
      if (v.queryParam) o.queryParam = v.queryParam;
      if (v.description) o.description = v.description;
      return o;
    });
  const json = JSON.stringify({ variables }, null, 2);
  trace.fn('page-variables:serialize', { count: variables.length });
  return `/** @pageVariables ${json} */\n`;
}

/**
 * Insert or replace the @pageVariables block in code. Insertion order:
 *   1. After an existing @canvas block (so per-page metadata stays grouped)
 *   2. After 'use client'
 *   3. At the top
 */
export function updatePageVariablesInCode(code: string, config: PageVariablesConfig): string {
  const block = serializePageVariables(config);
  const match = code.match(PAGE_VARS_REGEX);
  if (match) {
    trace.action('page-variables:update', 'replace-existing');
    return code.replace(PAGE_VARS_REGEX, block);
  }

  // Try to insert after @canvas block first
  const canvasMatch = code.match(/\/\*\*\s*@canvas\s*\{[\s\S]*?\}\s*\*\/\s*\n?/);
  if (canvasMatch && canvasMatch.index !== undefined) {
    const insertIdx = canvasMatch.index + canvasMatch[0].length;
    trace.action('page-variables:update', 'insert-after-canvas');
    return code.slice(0, insertIdx) + block + code.slice(insertIdx);
  }

  // Then after 'use client'
  const useClientMatch = code.match(/^['"]use client['"];?\s*\n/m);
  if (useClientMatch && useClientMatch.index !== undefined) {
    const insertIdx = useClientMatch.index + useClientMatch[0].length;
    trace.action('page-variables:update', 'insert-after-use-client');
    return code.slice(0, insertIdx) + '\n' + block + code.slice(insertIdx);
  }

  trace.action('page-variables:update', 'insert-at-top');
  return block + code;
}

/** Strip the annotation (used for preview/publish builds). */
export function stripPageVariables(code: string): string {
  const had = PAGE_VARS_REGEX.test(code);
  if (had) trace.action('page-variables:strip', 'removed');
  return code.replace(PAGE_VARS_REGEX, '');
}

// ─── CRUD helpers (operate on code string) ──────────────────────────────────

/**
 * Add a new variable. If a variable with the same name already exists, this
 * is a no-op — the caller is expected to validate uniqueness via the modal.
 */
export function addPageVariableInCode(code: string, variable: PageVariable): string {
  const config = parsePageVariables(code) ?? { variables: [] };
  if (config.variables.some(v => v.name === variable.name)) {
    trace.error('page-variables:add-duplicate', { name: variable.name });
    return code;
  }
  trace.action('page-variables:add', { name: variable.name, type: variable.type });
  return updatePageVariablesInCode(code, { variables: [...config.variables, variable] });
}

/** Remove a variable by name. */
export function removePageVariableInCode(code: string, name: string): string {
  const config = parsePageVariables(code);
  if (!config) return code;
  const next = config.variables.filter(v => v.name !== name);
  if (next.length === config.variables.length) return code; // no-op
  trace.action('page-variables:remove', { name });
  // If removing the last variable, drop the whole block to keep the file clean.
  const out = next.length === 0 ? stripPageVariables(code) : updatePageVariablesInCode(code, { variables: next });
  // Strip the matching @propMeta entry too (a typed page variable carries one — label/type) so the deleted
  // variable doesn't linger in the panel.
  return removePropMetaInCode(out, name);
}

/**
 * Update a variable in place. The `name` field of `updates` may rename it;
 * other variables referencing the old name are NOT rewritten here (that's
 * the binding layer's job, Phase 2). For now we just rewrite the annotation.
 */
export function updatePageVariableInCode(
  code: string,
  oldName: string,
  updates: Partial<PageVariable>,
): string {
  const config = parsePageVariables(code);
  if (!config) return code;
  const idx = config.variables.findIndex(v => v.name === oldName);
  if (idx === -1) return code;
  const merged: PageVariable = { ...config.variables[idx], ...updates };
  // Drop queryParam when explicitly emptied
  if (updates.queryParam === '') delete merged.queryParam;
  const next = [...config.variables];
  next[idx] = merged;
  trace.action('page-variables:update', { oldName, newName: merged.name });
  return updatePageVariablesInCode(code, { variables: next });
}

// ─── Read helpers ───────────────────────────────────────────────────────────

/** Convenience accessor — returns [] when no block / no variables. */
export function getPageVariables(code: string): PageVariable[] {
  return parsePageVariables(code)?.variables ?? [];
}

// ─── Property → variable-type mapping ───────────────────────────────────────

/**
 * Which type of variable can be CREATED from a given style property's "+
 * Create Variable" entry. Returns null when the property doesn't have a
 * sensible variable type (e.g. enum-like `overflow`, `cursor`, `display`).
 *
 * Phase 2 scope is intentionally narrow — these are the properties where a
 * direct binding makes immediate sense. Length-based properties like `width`
 * or `padding` are deferred because their values mix unit strings (`100px`,
 * `50%`) and won't slot cleanly into a `number` variable; we'll add a `length`
 * variable type for them in a follow-up.
 *
 * Note: this only affects CREATION. Existing variables of any type can still
 * be BOUND to any property via the conditional expression layer (Phase 2.5).
 */
export function pageVariableTypeForProperty(property: string): PageVariableType | null {
  // Plain numeric (no units)
  if (property === 'opacity') return 'number';
  if (property === 'fontWeight') return 'number';
  if (property === 'lineHeight') return 'number';
  if (property === 'zIndex') return 'number';
  if (property === 'order') return 'number';
  if (property === 'flexGrow' || property === 'flexShrink') return 'number';
  if (property === 'rotate' || property === 'scale') return 'number';
  // Layout gap is a single number (px auto-applied). Padding/margin/radius stay their own multi-value
  // types — only genuinely-single-number controls become Number variables (the reference's model).
  if (property === 'gap' || property === 'columnGap' || property === 'rowGap') return 'number';
  // Typography sizes are single numbers (px auto-applied) → Number variables.
  if (property === 'fontSize' || property === 'letterSpacing') return 'number';

  // Color-bearing properties — picker output is a CSS color string, fits
  // neatly into a `color` variable.
  if (
    property === 'color' ||
    property === 'backgroundColor' ||
    property === 'borderColor' ||
    property === 'borderTopColor' ||
    property === 'borderRightColor' ||
    property === 'borderBottomColor' ||
    property === 'borderLeftColor' ||
    property === 'outlineColor' ||
    property === 'textDecorationColor' ||
    property === 'caretColor' ||
    property === 'accentColor' ||
    property === 'fill' ||
    property === 'stroke' ||
    property === 'stopColor' ||
    property === 'floodColor'
  ) return 'color';

  // Text content — the JSX text children, not a CSS property.
  if (property === 'textContent') return 'text';

  // Image-bearing properties get the dedicated `image` type so the modal
  // and the interactions form render the proper image picker (Unsplash /
  // upload / URL paste) instead of a bare text input.
  // The stored value is a CSS-ready string (e.g. `url(https://…)`) so the
  // generated JSX (`style={{ backgroundImage: imageVar }}`) just works at
  // runtime — no wrap/unwrap layer needed.
  if (
    property === 'background' ||
    property === 'backgroundImage' ||
    property === 'maskImage' ||
    property === 'src'
  ) return 'image';

  // Plain string properties get the text type.
  if (property === 'alt' || property === 'href') return 'text';

  // Visibility-style properties → boolean variable. The binding generator
  // wraps the bare identifier in a ternary (`hideVar ? 'none' : ''`)
  // because `style={{ display: someBool }}` isn't valid CSS — see
  // `isConditionalDisplayProperty` and the special-case in
  // `bindStyleToPageVariableInCode`.
  if (property === 'display' || property === 'visibility') return 'boolean';
  // Flex wrap is a yes/no toggle (`wrap` / `nowrap`) → boolean variable, same conditional-ternary
  // binding shape as display/visibility.
  if (property === 'flexWrap') return 'boolean';

  return null;
}

/**
 * Properties whose boolean variable bindings render as a CSS ternary
 * (consequent / alternate) rather than a bare identifier — the JSX shape
 * is `style={{ display: x ? 'none' : '' }}` not `style={{ display: x }}`.
 *
 * Parser, bind generator, and unbind generator all consult this so the
 * three sides agree on the JSX shape they expect.
 */
export function isConditionalDisplayProperty(property: string): boolean {
  return property === 'display' || property === 'visibility' || property === 'flexWrap';
}

/**
 * Consequent/alternate strings for a conditional binding to a CSS
 * visibility-style property. Picked so:
 *   - var = true  → element is hidden  (display: 'none' / visibility: 'hidden')
 *   - var = false → no inline override (display: '' / visibility: '')
 * which matches the canonical Hide-control behaviour on the canvas.
 */
export function conditionalBranchesFor(property: string): { consequent: string; alternate: string } | null {
  if (property === 'display') return { consequent: 'none', alternate: '' };
  if (property === 'visibility') return { consequent: 'hidden', alternate: '' };
  // var = true → wrapping ON; var = false → nowrap. Matches the Wrap control's Yes/No.
  if (property === 'flexWrap') return { consequent: 'wrap', alternate: 'nowrap' };
  return null;
}
