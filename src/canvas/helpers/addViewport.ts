// addViewport.ts — Extracted from the inline onAdd callback in AddViewportMenu.
// Computes position, creates the viewport config, initialises width/position atoms,
// and copies @container rules from the source viewport to the new one.

import type { ViewportConfig } from '@/shared/types';
import { VIEWPORT_GAP } from '@/shared/constants';
import { syncViewportWidths, getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { modifyProjectFile } from '@/code/project/modify-file';
import { copyContainerRulesToNewWidth, addResponsiveBreakpoint } from '@/code/generation/generator-styles';
import { trace } from '@/shared/debug-trace';

export interface AddViewportOpts {
  vpId: string;
  label: string;
  width: number;
  sourceVpId: string;
  activeViewports: ViewportConfig[];
  vpWidths: Record<string, number>;
  vpPositions: Record<string, { x: number; y: number }>;
  activeFilePath: string;
  setVpConfigs: (fn: (prev: ViewportConfig[]) => ViewportConfig[]) => void;
  setViewportWidths: (fn: (prev: Record<string, number>) => Record<string, number>) => void;
  setVpPositions: (fn: (prev: Record<string, { x: number; y: number }>) => Record<string, { x: number; y: number }>) => void;
}

export function addViewport(opts: AddViewportOpts): void {
  const {
    vpId, label, width, sourceVpId, activeViewports, vpWidths, vpPositions,
    activeFilePath, setVpConfigs, setViewportWidths, setVpPositions,
  } = opts;

  trace.action('canvas:add-viewport', { vpId, label, width, sourceVpId });

  // 1. Find the source viewport to copy rules from + compute position
  const sourceVp = activeViewports.find(v => v.id === sourceVpId);
  const sourceWidth = sourceVp ? (vpWidths[sourceVp.id] ?? sourceVp.width) : 0;

  // Position: to the right of the rightmost existing viewport
  const rightmost = activeViewports.reduce((max, v) => {
    const pos = vpPositions[v.id] || { x: v.x };
    const vw = vpWidths[v.id] ?? v.width;
    return Math.max(max, (pos.x || v.x) + vw);
  }, 0);
  const newX = rightmost + VIEWPORT_GAP;

  // 2. Add to viewport configs atom — inherit `height` from the source viewport
  //    so a replica matches the master's fixed-pixel height. Without this the
  //    new viewport ships with no height and collapses to its content (0px on
  //    an empty starter page).
  const newOrder = activeViewports.length;
  const newVp: ViewportConfig = {
    id: vpId, label, width, isPrimary: false, order: newOrder, x: newX, y: 0,
    ...(typeof sourceVp?.height === 'number' && sourceVp.height > 0
      ? { height: sourceVp.height }
      : {}),
  };
  setVpConfigs(prev => [...prev, newVp]);

  // 3. Initialize width + position atoms
  setViewportWidths(prev => {
    const updated = { ...prev, [vpId]: width };
    syncViewportWidths(updated);
    return updated;
  });
  setVpPositions(prev => ({ ...prev, [vpId]: { x: newX, y: 0 } }));

  // 4. Copy @container rules from the source viewport AND register the new breakpoint in every
  //    component instance's `data-responsive` (refresh `_bp` so the width shows up INSTANTLY, and
  //    inherit the source replica's per-viewport variant when it has one). `getSortedBreakpointWidths()`
  //    reflects the just-synced widths (step 3). Runs even when there's nothing to copy so `_bp`
  //    always tracks the live viewport set.
  const newWidths = getSortedBreakpointWidths();
  // WHICH band do the new viewport's rules come from? Not the tile whose "+"
  // was clicked — the band that was ALREADY styling this width. Bands don't
  // cascade, and the smallest one is emitted open (`@media (max-width: 430px)`,
  // no min-width), so every width beneath it renders with its rules. Adding a
  // viewport below installs a floor on that band and revokes the coverage; seed
  // from the next-LARGER breakpoint and the new tile opens looking exactly like
  // what the user was already seeing. Clicking "+" on Desktop used to copy
  // nothing at all (the primary's styles are inline, it has no band), so the
  // new tile silently fell back to the desktop base (live find 2026-08-10).
  // Falls back to the clicked source when there is no larger breakpoint.
  const nextLarger = [...newWidths].sort((a, b) => a - b).find(w => w > width);
  const seedWidth = nextLarger ?? sourceWidth;
  modifyProjectFile(activeFilePath, code => {
    let next = code;
    if (seedWidth > 0 && seedWidth !== width) next = copyContainerRulesToNewWidth(next, seedWidth, width);
    next = addResponsiveBreakpoint(next, width, sourceWidth, newWidths);
    return next;
  });
  trace.action('canvas:add-viewport-seed', { vpId, width, seedWidth, clickedSource: sourceWidth });
}
