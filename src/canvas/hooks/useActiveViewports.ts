// src/canvas/hooks/useActiveViewports.ts
//
// Derives the active viewport list for the current file:
//   - Component files: one viewport per variant, root width.
//   - Icon-set masters: a single anonymous master viewport
//     sized to enclose the variant grid.
//   - Page files: vpConfigs merged with writable widths.
//
// EQUALITY-GATED: the computation re-runs on every code/nodes commit (cheap),
// but subscribers are only NOTIFIED when the resulting viewport list actually
// differs (deepEqualPlain via selectAtom). On a page file the list depends
// only on vpConfigs + widths, so a drag commit — which changes code + nodes
// but not the viewports — no longer re-renders the hosting component
// (Canvas!) at all. Before this gating, Canvas re-rendered its entire
// subtree on every commit just because this hook subscribed to the raw
// nodesAtom/codeAtom.

import { atom, useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { codeAtom, nodesAtom } from '@/code/stores/store';
import {
  activeFilePathAtom, isComponentFilePath, isIconSetFilePath,
} from '@/code/project/active-file-store';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { viewportsConfigAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { deepEqualPlain } from '@/shared/deep-equal';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ViewportConfig } from '@/shared/types';

/** Pure derivation — exactly the logic the hook body used to run inline. */
export function computeActiveViewports(
  activeFilePath: string,
  code: string,
  nodes: Map<string, CanvasNode>,
  vpConfigs: ViewportConfig[],
  vpWidths: Record<string, number>,
): ViewportConfig[] {
  const isComponentFile = isComponentFilePath(activeFilePath);
  // Icon-set masters render with a single anonymous master viewport
  // that sizes itself to the variant grid (NOT to root.style.width,
  // which is `'100%'` in the template — parseInt would yield 100 and
  // clamp the viewport to 100 px). The width-from-grid fallback below
  // handles it cleanly.
  const isIconSetMaster = isIconSetFilePath(activeFilePath);

  if (isComponentFile) {
    const variants = parseVariantConfig(code);
    const rootNode = [...nodes.values()].find(n => !n.parentId);
    const rootWidth = parseInt(rootNode?.styles.width || String(DEFAULT_VIEWPORT_WIDTH)) || DEFAULT_VIEWPORT_WIDTH;
    return variants.map((v, i) => ({
      id: v.name === 'default' ? 'desktop' : v.name,
      label: v.label || v.name,
      width: rootWidth,
      isPrimary: v.isPrimary ?? i === 0,
      order: i,
      x: v.x,
      y: v.y,
    }));
  }

  if (isIconSetMaster) {
    // Icon-set master canvas: ONE
    // viewport sized to enclose the variant grid. Reading
    // `root.styles.width` directly is unsafe — the template
    // emits `width: '100%'`, which parseInt yields `100` for and
    // collapses the master viewport to 100 px (variants then
    // render off-canvas). Compute extent from absolute children
    // instead: take the max (left + width) across every node
    // whose parent IS the root. Falls back to root.styles.width
    // (when literal pixels) for back-compat with hand-edited
    // master files, then `0` (let content size itself) as a last
    // resort.
    const rootNode = [...nodes.values()].find(n => !n.parentId);
    const rootRawWidth = rootNode?.styles.width ?? '';
    const explicitRootWidth = rootRawWidth.endsWith('%') ? 0 : (parseInt(rootRawWidth) || 0);
    let extentWidth = 0;
    if (rootNode) {
      for (const child of nodes.values()) {
        if (child.parentId !== rootNode.id) continue;
        const left = parseInt(child.styles.left || '0') || 0;
        const width = parseInt(child.styles.width || '0') || 0;
        const right = left + width;
        if (right > extentWidth) extentWidth = right;
      }
    }
    // Add a touch of padding so the rightmost variant's edge
    // doesn't kiss the viewport border in the master view.
    const masterWidth = Math.max(explicitRootWidth, extentWidth ? extentWidth + 40 : 0);
    return [{
      id: 'desktop',
      label: 'Master',
      width: masterWidth,
      isPrimary: true,
      order: 0,
      x: 0,
      y: 0,
    }];
  }

  return vpConfigs.map(v => ({ ...v, width: vpWidths[v.id] ?? v.width }));
}

// Recomputes on every input change (cheap)…
const activeViewportsComputedAtom = atom((get) => computeActiveViewports(
  get(activeFilePathAtom),
  get(codeAtom),
  get(nodesAtom),
  get(viewportsConfigAtom),
  get(viewportWidthsAtom),
));

// …but only notifies subscribers when the LIST actually changed.
const activeViewportsStableAtom = selectAtom(activeViewportsComputedAtom, (v) => v, deepEqualPlain);

export function useActiveViewports(): ViewportConfig[] {
  return useAtomValue(activeViewportsStableAtom);
}
