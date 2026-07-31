// prop-meta.ts — Authoring-only metadata for component props (type + description).
//
// Component props are function params (`{ zefzef = "54px solid #b84242" }`), which can't carry a type
// tag or a description. Rather than inject per-prop JSDoc comments (fragile to parse/edit), we keep a
// single JSON block at the top of the file — the same pattern as `@pageVariables` and `@canvas`:
//
//   /** @propMeta {"zefzef":{"type":"border","description":"Card border"}} */
//
// The block maps propName → { type?, description? }. It's stripped from the live render (comment) and
// only read by the Variable modal. `type` is the picker type id ('number' | 'option' | 'color' | …);
// without it, a prop's type is only inferable from its value's shape (ambiguous for number/text/etc.).
// Back-compat: an older string value (`"zefzef":"Card border"`) is read as a description-only entry.
// Pure string functions: code in → code out.

import { trace } from '@/shared/debug-trace';

export interface PropMetaEntry {
  type?: string;
  description?: string;
  /** Choice list for Option (enum) variables. The variable's defaultValue must be one of these. */
  options?: string[];
  /** When true, the Option list is LOCKED — the Variable modal renders a plain select (no add/edit/
   *  remove). Set for variables that drive a CSS enum (justify/align/wrap/…) whose values are fixed,
   *  so the user can't type an arbitrary value that would break the property. */
  optionsLocked?: boolean;
  /** Friendly display name shown in the Variable modal/list (e.g. "Overflow 2"). The prop identifier
   *  itself stays a valid camelCase JS name; this is the human label, decoupled (standard). */
  label?: string;
  /** For a VARIANT variable (hoisted off a component instance's `initialVariant`): the component TAG it
   *  is typed against (e.g. "StartTrialButton"). Persists the "this variable is that component's variant"
   *  identity so that AFTER the instance is unbound (X) the modal still shows the variant SELECT (not a
   *  bare text box) and "Set Variable" can re-offer it on that component. Resolved via the host's imports
   *  → the component file → its variantConfig. design-tool parity: a variant var is tied to its component. */
  variantOf?: string;
  // ── Number-variable metadata (the reference's ControlType.Number knobs) ──
  /** Lower bound for the slider/stepper. */
  min?: number;
  /** Upper bound for the slider/stepper. */
  max?: number;
  /** Increment for the slider/stepper. */
  step?: number;
  /** Display suffix appended in the input (e.g. 'px', '%', 'deg'); '' / 'None' = unitless. */
  unit?: string;
  /** Editor display: a drag slider (default) or a − / + stepper. */
  control?: 'slider' | 'stepper';
}

/** Subset of PropMetaEntry that holds the Number-variable knobs. */
export type PropNumberMeta = Pick<PropMetaEntry, 'min' | 'max' | 'step' | 'unit' | 'control'>;

const PROP_META_REGEX = /\/\*\*\s*@propMeta\s*(\{[\s\S]*?\})\s*\*\/\s*\n?/;

// Cache the EXPENSIVE part — the `[\s\S]*?` whole-file regex scan — keyed by code. `getPropLabel`/`getPropType`
// call `parsePropMeta` per bound control per panel render, and ON A TEMPLATE (isComponentFile=true) the bound
// pill / ControlLabel resolve labels+types through here EVERY drag frame (a Page skips it: it returns the raw
// ref with no parse — which is exactly why a populated Page drags smooth but a variable-heavy TEMPLATE doesn't).
// The scan is O(file size); a real page file is large, so re-scanning it 60×/sec × N pills tanks FPS. We cache
// only the matched JSON STRING (or null) and still `JSON.parse` it per call below → callers get a FRESH object
// each time, so the write helpers (setPropMeta/removePropMeta) that mutate the result can't corrupt the cache.
// Bounded FIFO — a few entries cover the active file + within-render dupes; any code edit is a new key.
const _propMetaScanCache = new Map<string, string | null>();
const PROP_META_CACHE_MAX = 8;

/** Parse the `@propMeta` block → { propName: { type?, description? } }. Returns {} when absent/malformed. */
export function parsePropMeta(code: string): Record<string, PropMetaEntry> {
  let json = _propMetaScanCache.get(code);
  if (json === undefined) {
    const m = code.match(PROP_META_REGEX);
    json = m ? m[1] : null;
    _propMetaScanCache.set(code, json);
    if (_propMetaScanCache.size > PROP_META_CACHE_MAX) {
      const oldest = _propMetaScanCache.keys().next().value;
      if (oldest !== undefined) _propMetaScanCache.delete(oldest);
    }
  }
  if (json === null) return {};
  const match: [string, string] = ['', json];
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, PropMetaEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') {
        // Legacy form: bare string == description.
        if (v) out[k] = { description: v };
      } else if (v && typeof v === 'object') {
        const entry: PropMetaEntry = {};
        const r = v as Record<string, unknown>;
        if (typeof r.type === 'string' && r.type) entry.type = r.type;
        if (typeof r.description === 'string' && r.description) entry.description = r.description;
        if (Array.isArray(r.options)) {
          const opts = r.options.filter((o): o is string => typeof o === 'string');
          if (opts.length) entry.options = opts;
        }
        if (r.optionsLocked === true) entry.optionsLocked = true;
        if (typeof r.label === 'string' && r.label) entry.label = r.label;
        if (typeof r.variantOf === 'string' && r.variantOf) entry.variantOf = r.variantOf;
        // Number knobs — `Number.isFinite` so 0 is kept (a valid min/step), NaN/strings dropped.
        if (Number.isFinite(r.min as number)) entry.min = r.min as number;
        if (Number.isFinite(r.max as number)) entry.max = r.max as number;
        if (Number.isFinite(r.step as number)) entry.step = r.step as number;
        if (typeof r.unit === 'string' && r.unit) entry.unit = r.unit;
        if (r.control === 'slider' || r.control === 'stepper') entry.control = r.control;
        if (Object.keys(entry).length > 0) out[k] = entry;
      }
    }
    return out;
  } catch {
    trace.error('prop-meta:parse-failed', { raw: match[1].slice(0, 100) });
    return {};
  }
}

/** One prop's description (or '' when none). */
export function getPropDescription(code: string, propName: string): string {
  return parsePropMeta(code)[propName]?.description ?? '';
}

/** One prop's type id (or '' when none). */
export function getPropType(code: string, propName: string): string {
  return parsePropMeta(code)[propName]?.type ?? '';
}

/** One prop's Option choices (or [] when none). */
export function getPropOptions(code: string, propName: string): string[] {
  return parsePropMeta(code)[propName]?.options ?? [];
}

/** Whether a prop's Option list is LOCKED (CSS-enum variable) → the modal shows a plain select, no edit. */
export function getPropOptionsLocked(code: string, propName: string): boolean {
  return parsePropMeta(code)[propName]?.optionsLocked === true;
}

/** One prop's display label (or '' when none — callers fall back to the prop name). */
export function getPropLabel(code: string, propName: string): string {
  return parsePropMeta(code)[propName]?.label ?? '';
}

/** Internal: upsert one field of a prop's meta entry and re-emit the block. */
function upsertPropMeta(code: string, propName: string, patch: PropMetaEntry, clearKeys: (keyof PropMetaEntry)[] = []): string {
  const meta = parsePropMeta(code);
  const entry: PropMetaEntry = { ...meta[propName] };
  for (const k of clearKeys) delete entry[k];
  if (patch.type) entry.type = patch.type;
  if (patch.description) entry.description = patch.description;
  if (patch.options) entry.options = patch.options;
  if (patch.optionsLocked !== undefined) {
    if (patch.optionsLocked) entry.optionsLocked = true; else delete entry.optionsLocked;
  }
  if (patch.label) entry.label = patch.label;
  if (patch.variantOf) entry.variantOf = patch.variantOf;
  // Number knobs — merge by `!== undefined` so 0 is a valid value (truthy checks would drop min/step 0).
  if (patch.min !== undefined) entry.min = patch.min;
  if (patch.max !== undefined) entry.max = patch.max;
  if (patch.step !== undefined) entry.step = patch.step;
  if (patch.unit !== undefined) entry.unit = patch.unit;
  if (patch.control !== undefined) entry.control = patch.control;
  if (Object.keys(entry).length > 0) meta[propName] = entry;
  else delete meta[propName];

  const hasEntries = Object.keys(meta).length > 0;
  const existing = code.match(PROP_META_REGEX);

  if (!hasEntries) {
    const out = existing ? code.replace(PROP_META_REGEX, '') : code;
    trace.action('prop-meta:clear', { propName });
    return out;
  }

  const block = `/** @propMeta ${JSON.stringify(meta)} */\n`;
  if (existing) {
    trace.action('prop-meta:update', { propName, count: Object.keys(meta).length });
    return code.replace(PROP_META_REGEX, block);
  }
  // Insert after a leading directive (`'use client';`) if present, else at the top.
  const directiveMatch = code.match(/^\s*(['"])use (?:client|server)\1;\s*\n/);
  if (directiveMatch) {
    const idx = directiveMatch[0].length;
    trace.action('prop-meta:insert-after-directive', { propName });
    return code.slice(0, idx) + '\n' + block + code.slice(idx);
  }
  trace.action('prop-meta:insert-top', { propName });
  return block + code;
}

/** Remove a prop's ENTIRE `@propMeta` entry. Used when a variable/prop is DELETED — otherwise the orphaned
 *  entry keeps the deleted variable visible in the panel ("start trial button variant of …" after delete).
 *  Drops the whole `@propMeta` block if it becomes empty. No-op when the prop has no entry. */
export function removePropMetaInCode(code: string, propName: string): string {
  const meta = parsePropMeta(code);
  if (!(propName in meta)) return code;
  delete meta[propName];
  const existing = code.match(PROP_META_REGEX);
  if (Object.keys(meta).length === 0) {
    trace.action('prop-meta:remove-clear', { propName });
    return existing ? code.replace(PROP_META_REGEX, '') : code;
  }
  trace.action('prop-meta:remove', { propName, remaining: Object.keys(meta).length });
  const block = `/** @propMeta ${JSON.stringify(meta)} */\n`;
  return existing ? code.replace(PROP_META_REGEX, block) : code;
}

/** Upsert a prop's description. Empty/whitespace REMOVES the description (and the entry if now empty). */
export function setPropDescriptionInCode(code: string, propName: string, description: string): string {
  const desc = description.trim();
  return upsertPropMeta(code, propName, desc ? { description: desc } : {}, desc ? [] : ['description']);
}

/** Upsert a prop's type id. Empty REMOVES the type (and the entry if now empty). */
export function setPropTypeInCode(code: string, propName: string, type: string): string {
  const t = type.trim();
  return upsertPropMeta(code, propName, t ? { type: t } : {}, t ? [] : ['type']);
}

/** The component TAG a VARIANT variable is typed against (or '' when not a variant variable). */
export function getPropVariantOf(code: string, propName: string): string {
  return parsePropMeta(code)[propName]?.variantOf ?? '';
}

/** Mark a variable as a VARIANT variable of a component tag. Empty REMOVES the tag (entry pruned if now
 *  empty). Lets the modal/Set-Variable keep the variant SELECT after the instance is unbound. */
export function setPropVariantOfInCode(code: string, propName: string, componentTag: string): string {
  const t = componentTag.trim();
  return upsertPropMeta(code, propName, t ? { variantOf: t } : {}, t ? [] : ['variantOf']);
}

/** Replace a prop's Option choice list. Empty array REMOVES the options (and the entry if now empty).
 *  `locked` (optional) marks the list as a fixed CSS enum → the modal shows a plain, non-editable select. */
export function setPropOptionsInCode(code: string, propName: string, options: string[], locked?: boolean): string {
  const clean = options.map(o => o.trim()).filter(Boolean);
  const patch: PropMetaEntry = clean.length ? { options: clean } : {};
  if (locked !== undefined) patch.optionsLocked = locked;
  return upsertPropMeta(code, propName, patch, clean.length ? [] : ['options']);
}

/** Upsert a prop's display label. Empty REMOVES the label (and the entry if now empty). */
export function setPropLabelInCode(code: string, propName: string, label: string): string {
  const l = label.trim();
  return upsertPropMeta(code, propName, l ? { label: l } : {}, l ? [] : ['label']);
}

/** A Number variable's slider/stepper knobs (or {} when none). */
export function getPropNumberMeta(code: string, propName: string): PropNumberMeta {
  const e = parsePropMeta(code)[propName];
  if (!e) return {};
  const out: PropNumberMeta = {};
  if (e.min !== undefined) out.min = e.min;
  if (e.max !== undefined) out.max = e.max;
  if (e.step !== undefined) out.step = e.step;
  if (e.unit !== undefined) out.unit = e.unit;
  if (e.control !== undefined) out.control = e.control;
  return out;
}

/**
 * Patch a Number variable's knobs. Each field: a value SETS it, `null` CLEARS it (Min/Max "Clear"
 * buttons), `undefined` LEAVES it untouched. Other meta fields (type/label/…) are preserved.
 */
export function setPropNumberMetaInCode(
  code: string,
  propName: string,
  patch: { min?: number | null; max?: number | null; step?: number | null; unit?: string | null; control?: 'slider' | 'stepper' | null },
): string {
  const set: PropMetaEntry = {};
  const clear: (keyof PropMetaEntry)[] = [];
  for (const key of ['min', 'max', 'step', 'unit', 'control'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null || v === '') clear.push(key);
    else (set as Record<string, unknown>)[key] = v;
  }
  return upsertPropMeta(code, propName, set, clear);
}
