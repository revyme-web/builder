// snap-targets.ts — Shared "find every top-level node painting in
// canvas-space" snap target collector. Used by both drag (CanvasDragStrategy)
// and resize (ResizeManager) when the moving element has no parent —
// canvas nodes, variant roots, container-set variant cards.
//
// Why: a canvas-node's resize handle was inert WRT snap guides because
// `ResizeManager.snapResizeEdges` early-returned on `!parentId` and the
// fallback used `findChildRects(parentId, vpId)` which doesn't apply
// when there is no parent. The drag side already had a "walk the
// rectCache for parentless entries" branch for exactly this case;
// extracting it lets resize reuse the same logic without copy-pasting
// the bridge plumbing or risking divergence.
//
// Returned rects are in CANVAS SPACE (CSS px, post-iframe-offset,
// post-pan/zoom). Each entry's `id` carries the source viewport prefix
// so a same-dataId rendering in another viewport doesn't collide with
// the dragged element's painting.

import type { Rect, Transform } from '@/shared/types';
import type { CanvasNode } from '@/code/parsing/parser';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getActiveFilePath, parseRectCacheKey } from '@/canvas/node-ops';
import { isIconSetFilePath } from '@/code/project/active-file-store';
import { isOverlayNode } from '@/code/parsing/overlay-parser';

export interface TopLevelSnapTarget {
  id: string;
  rect: Rect;
}

/**
 * Walk the bridge's rectCache and return canvas-space rects for every
 * parentless node painting OTHER than the moving element's own
 * cache entry.
 *
 * Container-set masters (icon-set) loosen the
 * "parentless" filter to also accept direct children of `root` because
 * variant cards sit at the same visual top level as free canvas nodes
 * on those file types.
 *
 * @param movingDataIds  data-ids being dragged/resized in the active
 *                       viewport. Excluded from snap targets to prevent
 *                       self-snap.
 * @param movingPrefix   viewport prefix of the moving element (e.g.
 *                       `''` for desktop, `'tablet-'`). Same-prefix
 *                       paintings of the moving dataId are excluded;
 *                       cross-prefix paintings of the same dataId
 *                       remain valid snap targets (default-vp painting
 *                       while resizing the variant-1 painting).
 * @param transform      current camera transform.
 * @param nodes          parsed-node map; used to check `parentId` for
 *                       top-level qualification.
 */
export function collectTopLevelSnapTargets(
  movingDataIds: ReadonlySet<string>,
  movingPrefix: string,
  transform: Transform,
  nodes: ReadonlyMap<string, CanvasNode>,
): TopLevelSnapTarget[] {
  const bridge = getCanvasBridge() as any;
  const cache = bridge.rectCache as Map<string, DOMRect> | undefined;
  if (!cache) return [];

  const offset = bridge.getIframeOffset ? bridge.getIframeOffset() : { x: 0, y: 0 };
  const t = transform;
  const toCanvas = (r: DOMRect): Rect => ({
    left: (r.left - offset.x - t.x) / t.scale,
    top: (r.top - offset.y - t.y) / t.scale,
    width: r.width / t.scale,
    height: r.height / t.scale,
  });

  const ap = getActiveFilePath();
  const isContainerMaster = isIconSetFilePath(ap);

  const out: TopLevelSnapTarget[] = [];
  for (const key of cache.keys()) {
    const parsed = parseRectCacheKey(key);
    if (!parsed) continue;
    const { vpPrefix: prefix, nodeId: dataId } = parsed;
    // Same prefix + same dataId == the moving element's own painting.
    if (prefix === movingPrefix && movingDataIds.has(dataId)) continue;
    const node = nodes.get(dataId);
    if (!node) continue;
    if (isOverlayNode(node)) continue; // overlays are never snap targets
    const isTopLevel =
      !node.parentId ||
      (isContainerMaster && node.parentId === 'root');
    if (!isTopLevel) continue;
    const screenRect = bridge.getRect(dataId, prefix);
    if (!screenRect) continue;
    out.push({ id: `${prefix}${dataId}`, rect: toCanvas(screenRect) });
  }
  return out;
}
