/**
 * page-effects-config.ts — data model + parse/serialize for Page Effects
 * (standard per-page enter/exit transitions over the View Transitions API).
 *
 * The whole config lives in a generated module `app/<group>/page-effects.ts`:
 *   export const PAGE_EFFECTS = { __default?, pages: {…} } as const;
 * This file owns the TYPES + the pure parse/serialize of that module string.
 * CSS generation, presets and resolution live in
 * `src/code/generation/view-transition-css.ts`.
 */

import { trace } from '@/shared/debug-trace';

export type RotateMode = '2d' | '3d';
export type OffsetUnit = 'fixed' | 'relative'; // px | %
export type OriginUnit = 'rel' | 'abs'; // % | px
export type MaskType = 'circle' | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down';

export interface TransitionConfig {
  kind: 'ease' | 'spring';
  // ease:
  ease?: string; // preset name e.g. 'easeInOut' | 'custom'
  bezier?: [number, number, number, number];
  // spring:
  stiffness?: number;
  damping?: number;
  mass?: number;
  // common:
  duration: number; // seconds (the reference "Time")
  delay: number; // seconds
}

export interface MaskConfig {
  type: MaskType;
  originX: number;
  originXUnit: OriginUnit; // circle only
  originY: number;
  originYUnit: OriginUnit;
}

/** One side of a transition: This Page (exit) OR Next Page (enter). Stores the
 *  NON-identity target state; the CSS builder fills the other keyframe with
 *  identity (exit: identity→state, enter: state→identity). */
export interface SideConfig {
  opacity: number; // 0..1 (default 1 = no change)
  scale: number; // default 1
  rotate: RotateMode; // '2d' | '3d'
  rotateZ: number; // deg (2D uses this; 3D = the Z field)
  rotateX: number; // deg (3D)
  rotateY: number; // deg (3D)
  offsetX: number;
  offsetXUnit: OffsetUnit;
  offsetY: number;
  offsetYUnit: OffsetUnit;
  mask?: MaskConfig; // optional clip-path reveal
  transition: TransitionConfig; // each side has its OWN transition (design-tool parity)
}

export interface PageEffect {
  preset: string; // 'crossfade' | 'fade-out-in' | 'slide-left' | … | 'custom'
  target: string; // destination route ('/team'), or 'all'
  exit?: SideConfig; // This Page  (omit = page leaves with no animation)
  enter?: SideConfig; // Next/Any Page (omit = page enters with no animation)
}

/** Per-source-page bucket. */
interface PageEffectBucket {
  all?: PageEffect; // this page's default (Target = All Pages on this page)
  byTarget: Record<string, PageEffect>; // route → effect (Target = a specific page)
}

/** Whole project. */
export interface PageEffectsMap {
  __default?: PageEffect; // site-wide default (Home's "All Pages")
  pages: Record<string, PageEffectBucket>; // sourceRoute → bucket
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/** The standard ease (the reference's default "Ease" ≈ easeInOut cubic-bezier). */
export const DEFAULT_BEZIER: [number, number, number, number] = [0.42, 0, 0.58, 1];

export function createDefaultTransition(): TransitionConfig {
  return { kind: 'ease', ease: 'easeInOut', bezier: [...DEFAULT_BEZIER], duration: 0.4, delay: 0 };
}

/** A side at IDENTITY (no visual change) — the base every control edits from. */
export function createDefaultSide(): SideConfig {
  return {
    opacity: 1,
    scale: 1,
    rotate: '2d',
    rotateZ: 0,
    rotateX: 0,
    rotateY: 0,
    offsetX: 0,
    offsetXUnit: 'relative',
    offsetY: 0,
    offsetYUnit: 'relative',
    transition: createDefaultTransition(),
  };
}

/** The exported const name in the generated data module. */
const PAGE_EFFECTS_CONST = 'PAGE_EFFECTS';

const EMPTY_MAP: PageEffectsMap = { pages: {} };

/**
 * Parse the `export const PAGE_EFFECTS = {…} as const;` object out of a generated
 * `page-effects.ts` module. The object literal is JSON-compatible (the serializer
 * emits pure JSON), so we slice the balanced `{…}` and JSON.parse it. Returns an
 * empty map on any failure (module absent / being edited).
 */
export function parsePageEffects(code: string): PageEffectsMap {
  if (!code) return { pages: {} };
  const marker = `${PAGE_EFFECTS_CONST} =`;
  const at = code.indexOf(marker);
  if (at === -1) return { pages: {} };
  const braceStart = code.indexOf('{', at);
  if (braceStart === -1) return { pages: {} };
  // Balanced-brace scan (string-aware) to find the matching close.
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  let end = -1;
  for (let i = braceStart; i < code.length; i++) {
    const ch = code[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return { pages: {} };
  try {
    const obj = JSON.parse(code.slice(braceStart, end + 1)) as PageEffectsMap;
    if (!obj || typeof obj !== 'object') return { pages: {} };
    if (!obj.pages || typeof obj.pages !== 'object') obj.pages = {};
    return obj;
  } catch {
    trace.error('page-effects-config:parse', 'failed to JSON.parse PAGE_EFFECTS');
    return { pages: {} };
  }
}

/** Serialize a map into the full generated module source. */
export function serializePageEffects(map: PageEffectsMap): string {
  const normalized: PageEffectsMap = { pages: map.pages ?? {} };
  if (map.__default) normalized.__default = map.__default;
  const json = JSON.stringify(normalized, null, 2);
  return `// @generated by Revyme — Page Effects. Edit via the editor's Effects panel.\n`
    + `export const ${PAGE_EFFECTS_CONST} = ${json} as const;\n`;
}

/** A route is the home page (its "All Pages" promotes to the site-wide default). */
export function isHomeRoute(route: string): boolean {
  return route === '/' || route === 'home' || route === '';
}

/** Insert/replace an effect into the map at the right bucket (pure; returns a
 *  new map). target 'all' on Home → `__default` (site-wide); 'all' elsewhere →
 *  that page's `all`; a specific target → `byTarget[target]`. See §2. */
export function upsertEffectInMap(map: PageEffectsMap, sourceRoute: string, effect: PageEffect): PageEffectsMap {
  const next: PageEffectsMap = { ...map, pages: { ...(map.pages ?? {}) } };
  if (next.__default) next.__default = { ...next.__default };
  if (effect.target === 'all') {
    if (isHomeRoute(sourceRoute)) {
      next.__default = effect;
      return next;
    }
    const existing = next.pages[sourceRoute] ?? { byTarget: {} };
    next.pages[sourceRoute] = { ...existing, byTarget: { ...(existing.byTarget ?? {}) }, all: effect };
    return next;
  }
  const bucket = { ...(next.pages[sourceRoute] ?? { byTarget: {} }) };
  bucket.byTarget = { ...(bucket.byTarget ?? {}), [effect.target]: effect };
  next.pages[sourceRoute] = bucket;
  return next;
}

/** Remove an effect (pure). `target` 'all' on Home removes `__default`. */
export function removeEffectFromMap(map: PageEffectsMap, sourceRoute: string, target: string): PageEffectsMap {
  const next: PageEffectsMap = { ...map, pages: { ...(map.pages ?? {}) } };
  if (target === 'all' && isHomeRoute(sourceRoute)) {
    delete next.__default;
    return next;
  }
  const bucket = next.pages[sourceRoute];
  if (!bucket) return next;
  const nb: PageEffectBucket = { all: bucket.all, byTarget: { ...(bucket.byTarget ?? {}) } };
  if (target === 'all') delete nb.all;
  else delete nb.byTarget[target];
  if (!nb.all && Object.keys(nb.byTarget).length === 0) delete next.pages[sourceRoute];
  else next.pages[sourceRoute] = nb;
  return next;
}

/** The effects authored ON `sourceRoute` (what the editor's Effects list shows):
 *  the page's own `all` (or `__default` for Home) + each `byTarget` entry. */
export function listEffectsForPage(map: PageEffectsMap, sourceRoute: string): PageEffect[] {
  const out: PageEffect[] = [];
  if (isHomeRoute(sourceRoute) && map.__default) out.push(map.__default);
  const bucket = map.pages?.[sourceRoute];
  if (bucket?.all) out.push(bucket.all);
  if (bucket?.byTarget) for (const k of Object.keys(bucket.byTarget)) out.push(bucket.byTarget[k]);
  return out;
}

/** True when a map has no effects at all (controller can no-op). */
export function isEmptyPageEffects(map: PageEffectsMap): boolean {
  if (map.__default) return false;
  return Object.keys(map.pages ?? {}).every((k) => {
    const b = map.pages[k];
    return !b.all && Object.keys(b.byTarget ?? {}).length === 0;
  });
}

