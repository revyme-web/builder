// overlay-size.ts — resolve a node's EFFECTIVE width/height for the specific
// artboard (viewport / component-variant) a selection overlay is drawn on.
//
// The resize handles (SelectionOverlay's disableVertical/Horizontal) and the
// PaddingHandles both decide what to show from the width/height STYLE VALUE
// (auto/fit → hug, so padding handles + no size handle on that axis; fixed px →
// resize handles). They used to read the RAW `node.styles.height`, which is the
// BASE branch of a variant conditional: e.g.
//   height: variant === 'variant-1' ? '311px' : 'min-content'
// parses to `styles.height = 'min-content'` + `conditionalStyles.height['variant-1']
// = '311px'`. On the variant-1 artboard the box is really 311px (fixed), yet the
// overlays saw 'min-content' → they hid the vertical resize circles and drew
// padding handles instead. This folds the variant/conditional override back in
// via the SAME resolver the Renderer paints with, so the overlay matches what
// the user actually sees on that artboard.

import { getDefaultStore } from 'jotai';
import type { CanvasNode } from '@/code/parsing/parser';
import { resolveVariantStyles } from '@/canvas/Renderer';
import {
  containerOverridesAtom,
  getOverridesAtWidth,
  type ContainerOverrideMap,
} from '@/code/stores/container-query-store';
import { resolveSpacingSides } from '@/shared/css-utils';
import { trace } from '@/shared/debug-trace';

type VpConfig = { id: string; width?: number; isPrimary?: boolean };

export function resolveOverlaySize(
  node: CanvasNode,
  vpId: string,
  viewportConfigs: VpConfig[],
  isComponentFile: boolean,
  containerOverrides?: ContainerOverrideMap,
): { width: string; height: string } {
  const vp = viewportConfigs.find((v) => v.id === vpId);
  // Mirror Renderer's artboard→variant map (Renderer.ts ~L802): a component
  // master's non-primary artboard IS a variant (its vp.id, e.g. 'variant-1');
  // the primary artboard is 'default'. Page files pass null so vpWidth drives
  // responsiveVariantMap — and a plain page node (no variants/conditionals)
  // resolves right back to its base styles, so this is a no-op there.
  const variantName = isComponentFile ? (vp?.isPrimary ? 'default' : vpId) : null;
  const resolved = resolveVariantStyles(node, variantName, vp?.width);
  let width = resolved.width ?? node.styles.width ?? '';
  let height = resolved.height ?? node.styles.height ?? '';
  // PAGE replicas also paint the @media band for their width — variant
  // resolution can't see those (they live in the page's <style> block, not on
  // the node). A replica whose height is overridden to `auto !important` (base
  // 729px) must read as auto here, or the vertical resize circles show on a
  // box the user can't actually resize (the mobile testimonial-card report).
  // Exact-band lookup on purpose: it matches how the control pills light up
  // (hasOverrideAtWidth), so handles and panel always agree.
  if (!isComponentFile && vp && !vp.isPrimary && typeof vp.width === 'number' && vp.width > 0) {
    const map = containerOverrides ?? getDefaultStore().get(containerOverridesAtom);
    const ov = getOverridesAtWidth(map, node.id, vp.width);
    const w = ov.get('width');
    const h = ov.get('height');
    if (w) width = w;
    if (h) height = h;
    if (w || h) {
      trace.fn('resolveOverlaySize:media-override', { nodeId: node.id, vpId, vpWidth: vp.width, w, h });
    }
  }
  return { width, height };
}

/**
 * The same resolution for a node's EFFECTIVE padding/margin sides on the
 * artboard being edited — `[top, right, bottom, left]`.
 *
 * PaddingHandles took its drag baseline from `resolveSpacingSides(node.styles)`,
 * i.e. the BASE object, so on a replica it started from the PRIMARY's padding:
 * a node with inline `padding: '58px'` and a mobile band of `padding: 12px`
 * began the drag at 58 and jumped ~46px on the first move (user report
 * 2026-07-26, trace `padding-handle:start {currentValue: 58}` against a panel
 * reading 12).
 *
 * Order is the whole game here, in two layers:
 *   · WITHIN one declaration set, a shorthand and its longhands resolve by
 *     ORDER (React key order for inline, source order inside a CSS rule) —
 *     `resolveSpacingSides` already models that.
 *   · ACROSS layers, the replica's `@media` band is `!important`, so it beats
 *     every base declaration regardless of order. Setting an existing key on a
 *     JS object does NOT move it, so an override for a key the base also holds
 *     would keep the base's slot and could be re-overwritten by a later base
 *     shorthand. Each band key is therefore DELETED before being re-set, which
 *     moves it to the end — band declarations land last, in band order.
 */
export function resolveOverlaySpacing(
  node: CanvasNode,
  vpId: string,
  viewportConfigs: VpConfig[],
  isComponentFile: boolean,
  base: 'padding' | 'margin',
  containerOverrides?: ContainerOverrideMap,
): [string, string, string, string] {
  const vp = viewportConfigs.find((v) => v.id === vpId);
  const variantName = isComponentFile ? (vp?.isPrimary ? 'default' : vpId) : null;
  // Folds variant objects + conditional ternaries in; a plain page node
  // resolves straight back to its base styles.
  const merged: Record<string, string> = { ...resolveVariantStyles(node, variantName, vp?.width) as Record<string, string> };

  if (!isComponentFile && vp && !vp.isPrimary && typeof vp.width === 'number' && vp.width > 0) {
    const map = containerOverrides ?? getDefaultStore().get(containerOverridesAtom);
    const ov = getOverridesAtWidth(map, node.id, vp.width);
    const applied: Record<string, string> = {};
    const sideKeys = [`${base}Top`, `${base}Right`, `${base}Bottom`, `${base}Left`];
    for (const [k, v] of ov) {
      if (k !== base && !sideKeys.includes(k)) continue;
      if (v === '') continue;
      delete merged[k];          // re-set moves it LAST — see the doc comment
      merged[k] = v;
      applied[k] = v;
    }
    if (Object.keys(applied).length > 0) {
      trace.fn('resolveOverlaySpacing:media-override', { nodeId: node.id, vpId, vpWidth: vp.width, base, applied });
    }
  }

  return resolveSpacingSides(merged, base);
}
