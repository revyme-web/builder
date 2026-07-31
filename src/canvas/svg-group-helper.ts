// svg-group-helper.ts — bridge-aware options for grouping SVG shapes.
//
// `groupSvgs` is a PURE source transform: it reads inline left/top to position
// the grouped shapes. LAYOUT (flex/grid) children carry NO inline left/top —
// their position comes from the layout — so grouping them needs the RENDERED
// rects. This helper derives parent-relative px boxes from the rect cache and
// flags whether the parent is a layout (so the resulting group is emitted as a
// flex/flow child, not an absolute box).

import { getNodeFromCache } from '@/code/stores/store';
import { findNodeComputedStyle } from '@/canvas/node-ops';
import { getAbsoluteCanvasRectById } from '@/canvas/canvas-math';
import { transformManager } from '@/canvas/transform/TransformManager';
import type { GroupSvgsOpts, BoundingBox } from '@/code/svg/group-svgs';

export function buildGroupSvgsOpts(ids: string[], vpId: string): GroupSvgsOpts {
  const transform = transformManager.getTransform();
  const first = getNodeFromCache(ids[0]);
  const parentId = first?.parentId ?? null;

  const boxOverrides = new Map<string, BoundingBox>();
  const parentRect = parentId ? getAbsoluteCanvasRectById(parentId, vpId, transform) : null;
  if (parentRect) {
    for (const id of ids) {
      const r = getAbsoluteCanvasRectById(id, vpId, transform);
      if (r) boxOverrides.set(id, {
        left: r.left - parentRect.left,
        top: r.top - parentRect.top,
        width: r.width,
        height: r.height,
      });
    }
  }

  let asFlexChild = false;
  if (parentId) {
    const disp = findNodeComputedStyle(parentId, vpId, 'display') || '';
    asFlexChild = disp.includes('flex') || disp.includes('grid');
  }

  return { boxOverrides, asFlexChild };
}
