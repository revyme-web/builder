// container-query-store.ts — Parse @media CSS rules into a structured override map.
// Source code uses real @media queries (like any normal project).
// Canvas transforms @media → @container at render time for side-by-side viewports.
// Controls use this to detect responsive overrides (blue dot indicator).
//
// Map structure: nodeId → maxWidth → property (kebab-case) → value
// Example: "hero" → 768 → "font-size" → "36px"

import { atom } from 'jotai';
import { codeAtom } from './store';
import { extractStyleCSS } from '../parsing/parser';
import { toCamel, SHORTHAND_LONGHANDS } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Map<nodeId, Map<maxWidth, Map<property (camelCase), value>>> */
export type ContainerOverrideMap = Map<string, Map<number, Map<string, string>>>;

// ─── Parser (reusable — also used by generator.ts) ──────────────────────────

/**
 * Parse @media CSS rules from a CSS string into a structured map.
 * Source code uses real @media queries. Canvas converts to @container at render time.
 * This is the READ side. generator.ts updateContainerQueryStyle does the WRITE side.
 *
 * Returns: Map<maxWidth, Map<nodeId, Map<property (kebab), value>>>
 * (Same structure as generator's internal `rules` map)
 */
export function parseContainerRules(css: string): Map<number, Map<string, Map<string, string>>> {
  const rules = new Map<number, Map<string, Map<string, string>>>();

  // Match @media queries: @media (max-width: 768px) and optionally (min-width: 376px)
  // Also matches legacy @container for migration compatibility
  const containerRegex = /@(?:media|container)\s*\(max-width:\s*(\d+)px\)(?:\s*and\s*\(min-width:\s*[\d.]+px\))?\s*\{/g;
  let cMatch;

  while ((cMatch = containerRegex.exec(css)) !== null) {
    const width = parseInt(cMatch[1]);
    const blockStart = cMatch.index + cMatch[0].length;

    // Find matching closing brace
    let depth = 1;
    let blockEnd = blockStart;
    while (depth > 0 && blockEnd < css.length) {
      if (css[blockEnd] === '{') depth++;
      if (css[blockEnd] === '}') depth--;
      blockEnd++;
    }

    const blockContent = css.slice(blockStart, blockEnd - 1);
    const selectors = new Map<string, Map<string, string>>();

    // Parse individual selectors: [data-id="x"] { prop: val !important; }
    const selectorRegex = /\[data-id="([^"]+)"\]\s*\{([^}]*)\}/g;
    let selMatch;
    while ((selMatch = selectorRegex.exec(blockContent)) !== null) {
      // SKIP :lang()-scoped rules — those are LOCALE overrides, not regular
      // responsive overrides. Without this, a banded `:lang(fr) [data-id]`
      // rule suffix-matched here and its per-locale values polluted the
      // replica's regular effective styles (control values, override chips,
      // and the popup's Fallback "syncing" with Set — user report).
      const before = blockContent.slice(Math.max(0, selMatch.index - 80), selMatch.index);
      if (/:lang\([^)]*\)\s*(?:\[data-variant="[^"]*"\]\s*)?$/.test(before)) continue;
      const id = selMatch[1];
      const declarations = selMatch[2];
      const props = selectors.get(id) ?? new Map<string, string>();

      for (const decl of declarations.split(';').filter(d => d.trim())) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const prop = decl.slice(0, colonIdx).trim();
        const val = decl.slice(colonIdx + 1).trim().replace(/\s*!important\s*$/, '').trim();
        props.set(prop, val);
      }
      selectors.set(id, props);
    }

    // Handle grouped selectors: [data-id="a"], [data-id="b"] { ... }
    const groupedRegex = /((?:\[data-id="[^"]+"\]\s*,\s*)+\[data-id="[^"]+"\])\s*\{([^}]*)\}/g;
    let gMatch;
    while ((gMatch = groupedRegex.exec(blockContent)) !== null) {
      const ids = [...gMatch[1].matchAll(/\[data-id="([^"]+)"\]/g)].map(m => m[1]);
      const props = new Map<string, string>();
      for (const decl of gMatch[2].split(';').filter(d => d.trim())) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const prop = decl.slice(0, colonIdx).trim();
        const val = decl.slice(colonIdx + 1).trim().replace(/\s*!important\s*$/, '').trim();
        props.set(prop, val);
      }
      for (const id of ids) {
        const existing = selectors.get(id) ?? new Map<string, string>();
        for (const [k, v] of props) existing.set(k, v);
        selectors.set(id, existing);
      }
    }

    rules.set(width, selectors);
  }

  return rules;
}

// ─── Derived Atom ───────────────────────────────────────────────────────────

/**
 * Derived atom: parse the active file's <style> blocks into a per-node override map.
 * Controls read this to detect responsive overrides.
 *
 * Output: Map<nodeId, Map<maxWidth, Map<property (camelCase), value>>>
 * Indexed by nodeId first (controls look up by node), then by breakpoint.
 */
// Memoize by the CSS string (identity, via the cached extractStyleCSS). A
// position drag commits inline left/top — the `<style>` @container block is
// unchanged, so returning the SAME Map reference lets every consumer
// (ControlProvider, SizeTool, …) bail its re-render AND skips the
// parseContainerRules re-scan (traced at ~73ms on a 470KB page, the single
// biggest parent-side drop-settle cost).
let _coCss: string | null = null;
let _coResult: ContainerOverrideMap = new Map();
export const containerOverridesAtom = atom<ContainerOverrideMap>((get) => {
  const code = get(codeAtom);
  const css = extractStyleCSS(code);
  if (css === _coCss) return _coResult;
  if (!css) { _coCss = css; _coResult = new Map(); return _coResult; }

  const rawRules = parseContainerRules(css);

  // Restructure: width→node→props  →  node→width→props (camelCase keys)
  const result: ContainerOverrideMap = new Map();

  for (const [maxWidth, selectors] of rawRules) {
    for (const [nodeId, props] of selectors) {
      if (!result.has(nodeId)) result.set(nodeId, new Map());
      const nodeMap = result.get(nodeId)!;
      if (!nodeMap.has(maxWidth)) nodeMap.set(maxWidth, new Map());
      const widthProps = nodeMap.get(maxWidth)!;

      for (const [kebabProp, value] of props) {
        widthProps.set(toCamel(kebabProp), value);
      }
    }
  }

  trace.fn('containerOverridesAtom', { nodeCount: result.size, breakpoints: rawRules.size });
  _coCss = css;
  _coResult = result;
  return result;
});

// ─── Query Helpers ──────────────────────────────────────────────────────────

/** A spacing/radius SHORTHAND control is overridden by any of its longhands.
 *  Responsive blocks are routinely authored as pure longhands
 *  (`padding-top: 28px !important; padding-right: 0px !important; …`), and an
 *  exact-key lookup on 'padding' left the control label unlit and Reset
 *  Override a no-op on those tiles (the CTA tablet-padding report) — while a
 *  sibling breakpoint that happened to include the shorthand DID light up. */
const SHORTHAND_OVERRIDE_ALIASES: Record<string, string[]> = {
  padding: ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  borderRadius: ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'],
};

/** Keys that count as overriding a given control property (camelCase, the
 *  map's key format). `[property]` itself for everything non-shorthand. */
export function overrideAliasKeys(property: string): string[] {
  return SHORTHAND_OVERRIDE_ALIASES[property] ?? [property];
}

/** Check if a specific property on a node has any responsive overrides */
export function hasOverride(
  overrides: ContainerOverrideMap,
  nodeId: string,
  property: string,
): boolean {
  const nodeMap = overrides.get(nodeId);
  if (!nodeMap) return false;
  const keys = overrideAliasKeys(property);
  for (const [, props] of nodeMap) {
    if (keys.some((k) => props.has(k))) return true;
  }
  return false;
}

/** Get override value for a specific node + property + breakpoint */
export function getOverrideValue(
  overrides: ContainerOverrideMap,
  nodeId: string,
  property: string,
  maxWidth: number,
): string | null {
  return overrides.get(nodeId)?.get(maxWidth)?.get(property) ?? null;
}

/** Get all breakpoints that override a specific property on a node */
export function getOverrideBreakpoints(
  overrides: ContainerOverrideMap,
  nodeId: string,
  property: string,
): { maxWidth: number; value: string }[] {
  const nodeMap = overrides.get(nodeId);
  if (!nodeMap) return [];

  const result: { maxWidth: number; value: string }[] = [];
  const keys = overrideAliasKeys(property);
  for (const [maxWidth, props] of nodeMap) {
    // Exact key first; else any longhand alias counts (its value shown so
    // the breakpoint list isn't silently missing the tile).
    const value = props.get(property) ?? keys.map((k) => props.get(k)).find((v) => v != null);
    if (value) result.push({ maxWidth, value });
  }
  return result.sort((a, b) => b.maxWidth - a.maxWidth);
}

/**
 * Check whether a property has an explicit override at THIS exact viewport
 * width. The generator scopes each @media rule to its viewport's range
 * (e.g. tablet → `(max-width: 768) and (min-width: 376)`, mobile →
 * `(max-width: 375)`), so an exact-width match mirrors the actual CSS
 * cascade — a tablet rule does NOT count as an "override" for mobile.
 *
 * Used by:
 * - ControlProvider's vpId-aware `hasOverride` (accent label color).
 * - The replica-shielding filter in `updateNodeStyles` (skip primary
 *   fan-out for properties the replica owns).
 */
export function hasOverrideAtWidth(
  overrides: ContainerOverrideMap,
  nodeId: string,
  property: string,
  vpWidth: number,
): boolean {
  const props = overrides.get(nodeId)?.get(vpWidth);
  if (!props) return false;
  return overrideAliasKeys(property).some((k) => props.has(k));
}

/**
 * Get the property→value map for a node at THIS exact viewport width.
 * Returns an empty Map (not undefined) when nothing matches so callers can
 * iterate / spread without null-checking.
 */
export function getOverridesAtWidth(
  overrides: ContainerOverrideMap,
  nodeId: string,
  vpWidth: number,
): Map<string, string> {
  return overrides.get(nodeId)?.get(vpWidth) ?? new Map();
}

/**
 * Resolve a node's EFFECTIVE inline style map for a given SOURCE viewport: the base
 * styles overlaid with that viewport's @media/@container overrides.
 *
 * A canvas node lives OUTSIDE the viewport tree, so the per-viewport @media rules no
 * longer cascade onto it — when a node is dragged out to the canvas FROM A REPLICA,
 * the replica's RESOLVED values must be baked in as the canvas node's own
 * (responsive-free) style. Without this the canvas node would silently revert to the
 * base/desktop values (e.g. a 3-column grid that was 2 columns on tablet).
 *
 *   · `sourceVpWidth` falsy (0/undefined = primary/desktop) → base styles unchanged.
 *   · Each non-empty override REPLACES the base value for that property. CSS shorthand
 *     resolves via the cascade: a `gridTemplateColumns` override replaces the base
 *     track list; `rowGap`/`columnGap` overrides are written AFTER the base `gap`
 *     (object insertion order), so the longhands win at paint. Empty/'auto' override
 *     values are skipped ("empty = not set").
 *
 * Pure (the parsed `overrides` map is passed in) so callers own the store read and
 * it's unit-testable. Override props are already camelCase + `!important`-stripped by
 * `parseContainerRules`.
 */
// CSS shorthands → the longhands they expand to. When a per-viewport @media
// override sets a SHORTHAND (e.g. `border-radius: 26px !important`) and the base
// uses LONGHANDS (`borderTopLeftRadius: '0px'`, …), the `!important` @media
// shorthand wins at paint — so the resolved viewport styles must DROP the base
// longhands the override didn't itself set. Otherwise a control reading the
// longhand (RadiusControl reads `borderTopLeftRadius`…) shows the stale base
// value while the override pill says "overridden" — exactly the radius mismatch.
// One definition, shared with the variant paint path's `mergeStyleLayers` — two
// copies of this map would silently drift and only one of the two resolvers
// would learn about a newly-handled shorthand.

/** Drop base longhands superseded by a shorthand present in `appliedKeys`. A
 *  longhand that is ALSO overridden for this viewport is kept (it's more
 *  specific). Mutates `merged`. */
export function clearShorthandSupersededLonghands(
  merged: Record<string, string>,
  appliedKeys: Iterable<string>,
): void {
  const keys = appliedKeys instanceof Set ? appliedKeys : new Set(appliedKeys);
  for (const k of keys) {
    const longhands = SHORTHAND_LONGHANDS[k];
    if (!longhands) continue;
    for (const lh of longhands) {
      if (!keys.has(lh)) delete merged[lh];
    }
  }
}

export function resolveEffectiveStylesForViewport(
  baseStyles: Record<string, string> | undefined,
  nodeId: string,
  sourceVpWidth: number | undefined,
  overrides: ContainerOverrideMap,
): Record<string, string> {
  const merged: Record<string, string> = { ...(baseStyles ?? {}) };
  if (!sourceVpWidth) return merged;
  const ov = getOverridesAtWidth(overrides, nodeId, sourceVpWidth);
  const appliedKeys = new Set<string>();
  for (const [k, v] of ov) {
    if (v === '' || v === 'auto') continue;
    merged[k] = v;
    appliedKeys.add(k);
  }
  clearShorthandSupersededLonghands(merged, appliedKeys);
  if (ov.size > 0) {
    trace.fn('resolveEffectiveStylesForViewport', { nodeId, sourceVpWidth, overrideKeys: [...ov.keys()] });
  }
  return merged;
}
