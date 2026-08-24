// PaddingHandles.tsx — Blue handles on padded sides of auto/fit-sized elements.
// Ported from old builder: auto/fit visibility logic, child content bounds,
// bidirectional drag, hover overlays, scale-aware sizing.

import React, { useState, useMemo, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { isComponentFileAtom, getNodesSnapshot } from '@/code/stores/store';
import { useLiveNode } from '@/code/stores/node-family';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { resolveOverlaySize, resolveOverlaySpacing } from './overlay-size';
import { findNodeRect, findNodeComputedStyles, updateNodeStyles, getContentRoot } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { nodeOrAncestorHasRotationOrSkewById } from '@/canvas/resize/geometry-utils';
import { SELECTION_COLOR, isFitSize } from '@/shared/constants';
import { styleHelperOps } from './style-helper-store';
import { displayEstablishesLayout } from './handle-gates';
import { useRafForceRenderTick } from '@/canvas/hooks/useRafForceRenderTick';
import { trace } from '@/shared/debug-trace';

type Side = 'top' | 'bottom' | 'left' | 'right';

const parsePadding = (v: string | undefined): number => {
  if (!v) return 0;
  const match = v.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
};

// Delegates to the shared Fit detector so `min-content` (the editor's canonical
// "Fit" value) shows padding handles just like legacy auto/fit-content.
const isAutoOrFit = (v: string | undefined): boolean => isFitSize(v);

/**
 * Padding-band thickness per side, taken straight from the element's RESOLVED
 * computed padding.
 *
 * Padding handles only ever show on an auto/fit-sized dimension (see
 * `handleVisibility`), and an auto/fit box HUGS its content on that axis — so the
 * CSS padding value IS exactly the gap between the content and the edge. Reading
 * it from `getComputedStyle` is both exact and robust, where measuring child rects
 * is not: a `.map()` repeater lists only its template node in the NodeMap (so the
 * bridge sees just the FIRST repeated item — e.g. a grid's row 1 — and the bottom
 * handle docks mid-element), and component-instance (`display:contents`) wrappers
 * and glide wrappers further muddy per-child rects. Padding is the source of truth.
 *
 * Returns CSS/canvas px — the caller must multiply by the canvas zoom to convert to
 * the screen-space `frameRect` lives in.
 */
function getPaddingBands(
  computedStyles: Record<string, string>,
): { top: number; bottom: number; left: number; right: number } {
  const px = (camel: string, kebab: string) =>
    Math.max(0, parseFloat(computedStyles[camel] ?? computedStyles[kebab] ?? '') || 0);
  return {
    top: px('paddingTop', 'padding-top'),
    bottom: px('paddingBottom', 'padding-bottom'),
    left: px('paddingLeft', 'padding-left'),
    right: px('paddingRight', 'padding-right'),
  };
}

interface Props {
  nodeId: string;
  vpId: string;
  onInteracting: (v: boolean) => void;
}

export default function PaddingHandles({ nodeId, vpId, onInteracting }: Props) {
  // Per-node subscription — the handles only depend on the selected node;
  // commits elsewhere no longer re-render this overlay. The drag callback
  // below reads a fresh snapshot at pointer-down instead.
  // LIVE, not `useNode`: whether the padding handles show at all is decided by
  // `isAutoOrFit(width/height)`, and a drop that bakes auto → px only reaches
  // the parsed `nodesAtom` after the deferred fan-out (~90ms on a mid-size
  // page). Reading the parsed map painted the auto-state handles on the mouseup
  // frame and pulled them a tenth of a second later (user report 2026-08-09).
  // `useLiveNode` reads the imperative cache, which `exit-commit` writes
  // synchronously, and its gesture gate keeps this from re-rendering per frame
  // mid-drag. Same reason ControlProvider uses it.
  const node = useLiveNode(nodeId);
  const viewportConfigs = useAtomValue(viewportsConfigAtom);
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const [hoveredHandle, setHoveredHandle] = useState<Side | null>(null);
  // Bumped on every RAF tick during a padding drag to force a re-
  // render so the handles re-read fresh `frameRect` / child bounds
  // from the bridge rectCache. Without this, `domOnly: true` patches
  // update the cache but no React render fires until mouseup's full
  // commit — handles visually stayed at the pre-drag position the
  // entire drag, then jumped on mouseup. Same RAF-tick approach
  // GapHandles uses for its handles. (Shared pump: useRafForceRenderTick.)
  const { start: startRafTick, stop: stopRafTick } = useRafForceRenderTick();
  // Determine which handles to show based on auto/fit dimensions
  const handleVisibility = useMemo(() => {
    if (!node) return { top: false, bottom: false, left: false, right: false };
    // Resolve the size for THIS artboard's variant — a replica whose height is
    // overridden to a fixed px (base is min-content/auto) must NOT show padding
    // handles; it hugs nothing on that axis. Reading raw node.styles saw the
    // base 'min-content' and wrongly drew padding handles on the px replica.
    const s = resolveOverlaySize(node, vpId, viewportConfigs, isComponentFile);
    const widthAuto = isAutoOrFit(s.width);
    const heightAuto = isAutoOrFit(s.height);
    return {
      top: heightAuto,
      bottom: heightAuto,
      left: widthAuto,
      right: widthAuto,
    };
  }, [node, vpId, viewportConfigs, isComponentFile]);

  const shouldShow = Object.values(handleVisibility).some(Boolean);

  const startAdjustingPadding = useCallback((side: Side) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const contentEl = getContentRoot();
    if (!contentEl) return;

    const scale = transformManager.getTransform().scale;
    const startX = e.clientX;
    const startY = e.clientY;

    // Read current padding from node styles (code source of truth) — fresh
    // imperative snapshot at pointer-down (no subscription needed).
    const snapNode = getNodesSnapshot().get(nodeId);
    // Effective sides for THIS artboard, not the base object: order-aware (a
    // legacy mix of longhands + a trailing `padding` shorthand RENDERS the
    // shorthand) AND replica/variant-aware. Reading the base made a drag on a
    // replica start from the PRIMARY's padding — inline `58px` under a mobile
    // band of `12px` began at 58 and jumped on the first move. Same resolver
    // family as the handle-visibility read above, so both agree with the panel.
    const effSides = snapNode
      ? resolveOverlaySpacing(snapNode, vpId, viewportConfigs, isComponentFile, 'padding')
      : ['', '', '', ''] as [string, string, string, string];
    const pTop = parsePadding(effSides[0]);
    const pRight = parsePadding(effSides[1]);
    const pBottom = parsePadding(effSides[2]);
    const pLeft = parsePadding(effSides[3]);

    // Bidirectional: use average of both sides
    const isVertical = side === 'top' || side === 'bottom';
    const currentValue = isVertical ? (pTop + pBottom) / 2 : (pLeft + pRight) / 2;

    trace.action('padding-handle:start', {
      nodeId, side, currentValue, vpId, isComponentFile,
      effSides, baseStyles: { padding: snapNode?.styles?.padding, paddingTop: snapNode?.styles?.paddingTop },
    });
    onInteracting(true);

    // Spin up a RAF loop that re-renders this component every frame
    // so the handles re-read fresh rects from the bridge rectCache.
    // The bridge emits rectUpdate / cornersUpdate events on every
    // patchStyles call (single + batched paths after the recent fix
    // to bridge-sandbox.ts), so by the time the RAF runs the cache
    // already has fresh rects — handles track the padding edge as
    // it grows/shrinks instead of staying pinned at mousedown coords.
    startRafTick();

    // Track last committed value for onUp
    let lastStyles: Record<string, string> = {};

    styleHelperOps.show({
      type: 'padding',
      position: { x: e.clientX, y: e.clientY },
      value: currentValue,
      unit: 'px',
    });

    const onMove = (me: PointerEvent) => {
      me.preventDefault();
      const deltaX = (me.clientX - startX) / scale;
      const deltaY = (me.clientY - startY) / scale;

      let newValue: number;
      const styles: Record<string, string> = {};

      if (isVertical) {
        const vertDelta = side === 'top' ? -deltaY : deltaY;
        newValue = Math.max(0, Math.round(currentValue + vertDelta));
        styles.paddingTop = `${newValue}px`;
        styles.paddingBottom = `${newValue}px`;
      } else {
        const horizDelta = side === 'left' ? -deltaX : deltaX;
        newValue = Math.max(0, Math.round(currentValue + horizDelta));
        styles.paddingLeft = `${newValue}px`;
        styles.paddingRight = `${newValue}px`;
      }

      // Imperative DOM update via bridge — sync to all variant copies
      lastStyles = styles;
      updateNodeStyles({ id: nodeId, styles, contentEl, domOnly: true });

      styleHelperOps.show({
        type: 'padding',
        position: { x: me.clientX, y: me.clientY },
        value: newValue,
        unit: 'px',
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Stop the RAF poll. The final re-render below from the commit
      // path uses the now-stable rectCache, so the handles land
      // cleanly on the new padding position with no visible "jump"
      // on release.
      stopRafTick();

      // Commit last known styles to code
      if (Object.keys(lastStyles).length > 0) {
        updateNodeStyles({ id: nodeId, styles: lastStyles, contentEl });
      }
      styleHelperOps.hide();
      onInteracting(false);
      trace.action('padding-handle:end', { nodeId });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [nodeId, onInteracting, vpId, viewportConfigs, isComponentFile, startRafTick, stopRafTick]);

  // ─── Early returns ──────────────────────────────────────────────────────

  const scale = transformManager.getTransform().scale;
  const frameRect = findNodeRect(nodeId, vpId);
  if (!frameRect || !node || !shouldShow || scale < 0.2) return null;
  if (node.children.length === 0 && !node.textContent?.trim()) return null;

  // Hide padding handles when the frame or any ancestor has rotation/skew —
  // the handles are screen-aligned (`position:fixed` in screen space) and
  // would land off the visible padding edge once the parent's transform
  // tilts the children away from the AABB axes the handle math assumes.
  if (nodeOrAncestorHasRotationOrSkewById(nodeId, vpId)) return null;

  const computedStyles = findNodeComputedStyles(nodeId, vpId, ['display', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']);
  // LAYOUT ONLY — the panel's PaddingControl lives inside the Layout section
  // and only renders when the node has one, so the canvas handles were the sole
  // surface disagreeing with it. See displayEstablishesLayout for the reasoning.
  if (!displayEstablishesLayout(computedStyles['display'] || '')) {
    trace.fn('padding-handles:no-layout', { nodeId, display: computedStyles['display'] || '' });
    return null;
  }
  // `getPaddingBands` returns the padding in CSS/canvas px, but `frameRect` (and all
  // the handle/overlay geometry below) is SCREEN px — already multiplied by the
  // canvas zoom. Scale the padding to screen px so they match; otherwise at any
  // zoom ≠ 100% the handle drifts toward the element centre and the hover band is
  // drawn taller than the real padding region (bleeding over the content).
  const padCss = getPaddingBands(computedStyles);
  const contentBounds = {
    top: padCss.top * scale,
    bottom: padCss.bottom * scale,
    left: padCss.left * scale,
    right: padCss.right * scale,
  };
  const minPaddingArea = 8;

  const paddingAreas = {
    top: Math.max(contentBounds.top, minPaddingArea),
    bottom: Math.max(contentBounds.bottom, minPaddingArea),
    left: Math.max(contentBounds.left, minPaddingArea),
    right: Math.max(contentBounds.right, minPaddingArea),
  };

  // Fixed screen-space sizes, clamped to container
  let handleW = 28;
  const handleH = 4;

  const maxH = frameRect.width * 0.8;
  const maxV = frameRect.height * 0.8;
  handleW = Math.min(handleW, maxH, maxV);
  if (handleW < 4) return null;

  // ─── Build elements ─────────────────────────────────────────────────────

  const elements: React.ReactNode[] = [];

  const addSide = (side: Side, show: boolean) => {
    if (!show) return;

    const isVert = side === 'top' || side === 'bottom';
    const area = paddingAreas[side];
    const hasRealPadding = area > minPaddingArea;

    // Background overlay position (screen-space)
    let bgStyle: React.CSSProperties;
    if (side === 'top') {
      bgStyle = { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: area };
    } else if (side === 'bottom') {
      bgStyle = { left: frameRect.left, top: frameRect.bottom - area, width: frameRect.width, height: area };
    } else if (side === 'left') {
      bgStyle = { left: frameRect.left, top: frameRect.top, width: area, height: frameRect.height };
    } else {
      bgStyle = { left: frameRect.right - area, top: frameRect.top, width: area, height: frameRect.height };
    }

    elements.push(
      <div
        key={`pad-bg-${side}`}
        style={{
          position: 'fixed',
          ...bgStyle,
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          opacity: hoveredHandle === side ? 1 : 0,
          transition: 'opacity 150ms',
          pointerEvents: 'none',
          zIndex: 3,
        }}
      />
    );

    // Handle position (centered in padding area or on edge)
    let hx: number, hy: number;
    if (side === 'top') {
      hx = frameRect.left + frameRect.width / 2;
      hy = hasRealPadding ? frameRect.top + area / 2 : frameRect.top;
    } else if (side === 'bottom') {
      hx = frameRect.left + frameRect.width / 2;
      hy = hasRealPadding ? frameRect.bottom - area / 2 : frameRect.bottom;
    } else if (side === 'left') {
      hx = hasRealPadding ? frameRect.left + area / 2 : frameRect.left;
      hy = frameRect.top + frameRect.height / 2;
    } else {
      hx = hasRealPadding ? frameRect.right - area / 2 : frameRect.right;
      hy = frameRect.top + frameRect.height / 2;
    }

    const w = isVert ? handleW : handleH;
    const h = isVert ? handleH : handleW;

    elements.push(
      <div
        key={`pad-handle-${side}`}
        onPointerDown={startAdjustingPadding(side)}
        onPointerEnter={() => setHoveredHandle(side)}
        onPointerLeave={() => setHoveredHandle(null)}
        style={{
          position: 'fixed',
          left: hx - w / 2,
          top: hy - h / 2,
          width: w,
          height: h,
          borderRadius: Math.min(w, h) / 2,
          backgroundColor: SELECTION_COLOR,
          cursor: isVert ? 'ns-resize' : 'ew-resize',
          pointerEvents: 'all',
          zIndex: 4,
        }}
      />
    );
  };

  addSide('top', handleVisibility.top);
  addSide('bottom', handleVisibility.bottom);
  addSide('left', handleVisibility.left);
  addSide('right', handleVisibility.right);

  return <>{elements}</>;
}
