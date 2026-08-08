// replica-bake.ts — "what does this node actually SHOW on the tile I'm on?"
//
// Every clone the editor builds — alt-drag duplicate, copy/paste — is assembled
// from `node.styles` / `node.textContent` / `node.attrs`. Those are the PRIMARY's
// truth. A replica's real values live in channels the clone CANNOT inherit,
// because each one is addressed by the SOURCE's identity:
//
//   · page replica      → `@media (max-width: N)` rules in the file's <style>
//                          block, selected by `[data-id="<source id>"]`
//   · component variant → the `<id>Variants` object referenced by
//                          `variants={…}`, plus inline `variant === 'x' ? …`
//                          ternaries (conditionalStyles / attrConditional)
//
// A duplicate gets a FRESH data-id and no variants object, so none of it
// follows: duplicating a 100%-wide button on `variant-2` produced an
// auto-width button, and duplicating a text node with a tablet font-size
// override produced desktop type (user report 2026-08-08). The clone wasn't
// "losing" styles — it never had a way to reach them.
//
// The fix is to resolve the tile's PAINTED values first and bake them into the
// clone as flat inline styles. That is exactly right for a duplicate made on a
// replica, because such a duplicate is created SOLO (visible only on the tile
// it was made on — `hideInAllOthers` + the unhide on the source vp), so its
// base styles and its only rendering context are one and the same.
//
// Same class as arrow-nudge's `effectiveStylesFor`, extended from EDITS
// ("current ± delta must read the tile's value") to CLONES ("a copy must carry
// the tile's value"). Style resolution delegates to the Renderer's own
// `resolveVariantStyles` so the bake and the paint can't drift apart.

import { getDefaultStore } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { isPrimaryViewport } from '@/shared/constants';
import { isComponentFilePath } from '@/code/project/active-file-store';
import {
  containerOverridesAtom, resolveEffectiveStylesForViewport,
  type ContainerOverrideMap,
} from '@/code/stores/container-query-store';
import { resolveVariantStyles } from '@/canvas/Renderer';
import type { CanvasNode } from '@/code/parsing/parser';

/**
 * Which tile a clone is being made on. `primary` means "no per-tile channel to
 * resolve" — the node's own fields already are the truth, so the bake is a
 * pass-through. Everything the resolvers need is carried in the object so they
 * stay pure and unit-testable; `tileContextFor` is the impure factory.
 */
export type TileContext =
  | { kind: 'primary' }
  | { kind: 'variant'; variant: string }
  | {
      kind: 'viewport';
      vpWidth: number;
      overrides: ContainerOverrideMap;
      /** Every configured breakpoint width, ASCENDING — the bucket ladder for
       *  `useResponsiveText` / responsive-attr lookups (smallest width ≥ the
       *  tile's width wins, matching the Renderer). */
      allWidths: number[];
    };

/**
 * Build the tile context for the viewport/variant the user is interacting with.
 *
 * A COMPONENT master's tiles are variants, never viewports — its "widths" are
 * canvas layout numbers, and an @media rule keyed to one would never fire in a
 * real browser. The primary tile of a component still resolves as a variant
 * ('default'), because `animate={['default', variant]}` makes the default entry
 * always-on: it is a real paint layer even on the primary, so a clone made
 * there must carry it.
 */
export function tileContextFor(
  vpId: string,
  activeFilePath: string,
  vpWidths: Record<string, number>,
): TileContext {
  if (isComponentFilePath(activeFilePath)) {
    return { kind: 'variant', variant: isPrimaryViewport(vpId) ? 'default' : vpId };
  }
  if (isPrimaryViewport(vpId)) return { kind: 'primary' };
  const vpWidth = vpWidths[vpId] ?? 0;
  if (!vpWidth) return { kind: 'primary' };
  return {
    kind: 'viewport',
    vpWidth,
    overrides: getDefaultStore().get(containerOverridesAtom),
    allWidths: Object.values(vpWidths).filter((w) => w > 0).sort((a, b) => a - b),
  };
}

/** Smallest configured width ≥ the tile width — the responsive bucket both
 *  `useResponsiveText` and the responsive-attr ternaries resolve against. */
function bucketFor(vpWidth: number, ladder: number[]): number | null {
  for (const w of ladder) if (vpWidth <= w) return w;
  return null;
}

/**
 * The node's EFFECTIVE inline styles on this tile.
 *
 * Variant tiles delegate to the Renderer's `resolveVariantStyles` (base →
 * conditional ternaries → always-on `default` entry → the variant's own entry,
 * then the motion-transform fold) so a bake always equals what the tile paints.
 * Page replicas take that same call for any per-viewport instance variant, then
 * overlay the node's `@media` band.
 */
export function bakeStylesForTile(node: CanvasNode, tile: TileContext): Record<string, string> {
  if (tile.kind === 'primary') return { ...(node.styles ?? {}) };
  if (tile.kind === 'variant') return { ...resolveVariantStyles(node, tile.variant) };
  const painted = { ...resolveVariantStyles(node, null, tile.vpWidth) };
  return resolveEffectiveStylesForViewport(painted, node.id, tile.vpWidth, tile.overrides);
}

/**
 * The text this node shows on the tile. Two independent channels:
 * `conditionalText` (a `{variant === 'x' ? 'a' : 'b'}` child) and
 * `textOverrides` (the `useResponsiveText` map). A resolved entry is
 * AUTHORITATIVE even when empty — a variant that deliberately shows no text
 * must not fall back to the primary's copy.
 */
export function bakeTextForTile(node: CanvasNode, tile: TileContext): string | undefined {
  const base = node.textContent || undefined;
  if (tile.kind === 'variant') {
    const map = node.conditionalText;
    if (!map) return base;
    const resolved = map[tile.variant] ?? map['default'];
    return resolved != null ? (resolved || undefined) : base;
  }
  if (tile.kind === 'viewport') {
    const bucket = bucketFor(tile.vpWidth, tile.allWidths);
    const o = bucket != null ? node.textOverrides?.[String(bucket)] : undefined;
    return typeof o === 'string' ? (o || undefined) : base;
  }
  return base;
}

/**
 * The attrs this node carries on the tile. `attrs` already holds each
 * conditional's DEFAULT branch (the parser stores it there as the static
 * fallback), so an unbaked clone of `initialVariant={variant === 'variant-2' ?
 * 'variant-3' : 'default'}` silently became `initialVariant="default"` — the
 * duplicated Button rendered the wrong variant.
 */
export function bakeAttrsForTile(node: CanvasNode, tile: TileContext): Record<string, string> | undefined {
  if (!node.attrs) return undefined;
  const attrs = { ...node.attrs };
  if (tile.kind === 'variant') {
    for (const [key, map] of Object.entries(node.attrConditional ?? {})) {
      const v = map[tile.variant] ?? map['default'];
      if (v != null) attrs[key] = v;
    }
    for (const [key, r] of Object.entries(node.responsiveAttrs ?? {})) {
      const v = r.variant?.[tile.variant];
      if (v != null) attrs[key] = v;
    }
  } else if (tile.kind === 'viewport') {
    const pickByWidth = (m: Record<string | number, string> | undefined): string | undefined => {
      if (!m) return undefined;
      const widths = Object.keys(m).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
      for (const w of widths) if (tile.vpWidth <= w) return m[w];
      return undefined;
    };
    for (const [key, r] of Object.entries(node.responsiveAttrs ?? {})) {
      const v = pickByWidth(r.viewport);
      if (v != null) attrs[key] = v;
    }
    // Per-viewport instance PROP values, but only for props the parser already
    // recorded as a string attr. A numeric/boolean prop lives in
    // `componentProps` and a clone never carried it anyway — inventing
    // `speed="5"` here would hand the component a string where it wants a
    // number, trading a missing override for a type error.
    for (const [key, m] of Object.entries(node.responsiveAttrPropValues ?? {})) {
      if (!(key in attrs)) continue;
      const v = pickByWidth(m);
      if (v != null) attrs[key] = v;
    }
  }
  return attrs;
}

/** Styles + text + attrs resolved for the tile in one call — what a clone
 *  should be built from instead of the node's raw primary fields. */
export function bakeNodeForTile(node: CanvasNode, tile: TileContext): {
  styles: Record<string, string>;
  textContent: string | undefined;
  attrs: Record<string, string> | undefined;
} {
  const out = {
    styles: bakeStylesForTile(node, tile),
    textContent: bakeTextForTile(node, tile),
    attrs: bakeAttrsForTile(node, tile),
  };
  if (tile.kind !== 'primary') {
    trace.fn('replica-bake:bakeNodeForTile', {
      nodeId: node.id,
      tile: tile.kind === 'variant' ? tile.variant : tile.vpWidth,
      changedStyleKeys: Object.keys(out.styles).filter((k) => out.styles[k] !== node.styles?.[k]),
    });
  }
  return out;
}
