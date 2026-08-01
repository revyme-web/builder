// CanvasRulers.tsx — Top + left rulers with px ticks.
// Ported from `builder/src/builder/view/canvas/CanvasRulers.tsx` and
// trimmed to Revyme's setup:
//   - LEFT_MENU_WIDTH (52) + LEFT_PANEL_WIDTH (256) is the fixed left
//     chrome width. The left panel is always open in Revyme (default
//     `pages-layers`), so we don't bother with the panel-open detection
//     the builder version did.
//   - No DYNAMIC_TOOLBAR_HEIGHT — Revyme's header sits above the
//     canvas at y=0..52 already; rulers start under it.
//   - Selection-bounds rendering on rulers (the highlighted spans showing
//     the current selection's extent) is dropped from this v1; can be
//     added back if useful.
//
// Drag from a ruler → creates a new guide via `rulerGuideOps.addGuide`
// (live preview line follows the cursor while dragging; commits on
// mouseup ≥ 10px below the ruler edge).

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { transformManager } from '@/canvas/transform';
import { showRulersAtom } from '@/code/stores/user-preferences-store';
import { activeFilePathAtom, isMasterFilePath } from '@/code/project/active-file-store';
import { rulerGuideOps, draggingGuidePreviewAtom } from '@/code/stores/ruler-guides-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { shapeEditingIdAtom } from '@/code/stores/shape-edit-store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeRect } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

const RULER_SIZE = 28;
const LEFT_MENU_WIDTH = 52;
const LEFT_PANEL_WIDTH = 256;
const RIGHT_PANEL_WIDTH = 260;
const BREADCRUMB_HEIGHT = 52;
const LEFT_OFFSET = LEFT_MENU_WIDTH + LEFT_PANEL_WIDTH; // 308 — left edge of canvas area
// Right offset stops the top ruler before it reaches the right panel /
// RightHeader. Both share the same 260 px width, so a single value
// keeps the ruler clear of both the panel and the header chrome and
// makes the visible ruler region == the visible canvas region.
const RIGHT_OFFSET = RIGHT_PANEL_WIDTH;
// Top offset is dynamic — 0 when on a regular page (no breadcrumb,
// rulers reach the top of the browser), or BREADCRUMB_HEIGHT (52) when
// editing a master file (component / icon-set / vector master) so the
// rulers sit BELOW the ComponentBreadcrumb bar that mounts at top:0
// only on those files. Same conditional `isMasterFilePath` check
// `ComponentBreadcrumb.tsx:29` uses to decide whether to render itself.

// Color tokens — pixel-match the builder repo's `CanvasRulers.tsx`:
//   bg     = `--bg-canvas` (lighter than `--bg-surface`, reads as a
//            ruler strip distinct from both the canvas content area
//            and the chrome panels around it)
//   border = `--border-default` (more contrast than `--border-light`,
//            so the ruler's edge against the canvas is actually visible)
//   ticks  = `--text-secondary` (low-contrast tick marks + numbers)
const RULER_BG = 'var(--bg-canvas)';
const RULER_BORDER = 'var(--border-default)';
const TICK_COLOR = 'var(--text-secondary)';
const TEXT_COLOR = 'var(--text-secondary)';
const GUIDE_COLOR = '#0d9488'; // teal — same as builder
// Accent color used for the selection-on-ruler highlight bands +
// position-indicator labels. Matches the canvas selection border so
// the user can visually link the selection on canvas with its measured
// extent on the rulers.
const SELECTION_ACCENT = 'var(--selection)';

// ─── Position indicator ──────────────────────────────────────────────────
// Tiny pill-shaped label that floats on a ruler at a given canvas-space
// coordinate, showing its rounded value. Used for both edges of the
// selection bounds (top ruler: left/right; left ruler: top/bottom).

interface PositionIndicatorProps {
  position: number;
  isHorizontal: boolean; // true → top ruler (X coord); false → left ruler (Y coord)
  transform: { x: number; y: number; scale: number };
  topOffset: number;
}

function PositionIndicator({ position, isHorizontal, transform, topOffset }: PositionIndicatorProps) {
  if (isHorizontal) {
    const screenX = position * transform.scale + transform.x;
    return (
      <div
        style={{
          position: 'fixed',
          top: topOffset,
          left: screenX,
          transform: 'translateX(-50%)',
          height: RULER_SIZE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 4902,
          pointerEvents: 'none',
        }}
      >
        <span style={{
          color: SELECTION_ACCENT,
          fontSize: 10,
          fontWeight: 600,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          backgroundColor: RULER_BG,
          padding: '0 4px',
        }}>
          {Math.round(position)}
        </span>
      </div>
    );
  }
  const screenY = position * transform.scale + transform.y;
  return (
    <div
      style={{
        position: 'fixed',
        left: LEFT_OFFSET,
        top: screenY,
        transform: 'translateY(-50%)',
        width: RULER_SIZE,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 4902,
        pointerEvents: 'none',
      }}
    >
      <span style={{
        color: SELECTION_ACCENT,
        fontSize: 10,
        fontWeight: 600,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backgroundColor: RULER_BG,
        padding: '2px 0',
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
        transform: 'rotate(180deg)',
      }}>
        {Math.round(position)}
      </span>
    </div>
  );
}

// Minimum cursor distance from the ruler edge (in screen px) before a
// drag commits a new guide. Below this, the user dragged from the ruler
// but never crossed the threshold, so we treat it as a no-op.
const MIN_CREATE_DISTANCE = 10;

// ─── Tick interval (zoom-aware) ────────────────────────────────────────────

/** Pick a ruler tick interval that gives ~50–100px between major ticks
 *  at the current zoom. As you zoom OUT, ticks coarsen (10 → 50 → 100
 *  → 500 → 1000…); as you zoom IN, they refine. Same scale ladder the
 *  builder rulers used. */
function getTickInterval(scale: number): number {
  const baseInterval = 100;
  const intervals = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const ideal = baseInterval / scale;
  for (const i of intervals) if (i >= ideal * 0.5) return i;
  return intervals[intervals.length - 1];
}

interface RulerTicksProps {
  start: number;
  end: number;
  scale: number;
  isHorizontal: boolean;
}

const RulerTicks: React.FC<RulerTicksProps> = ({ start, end, scale, isHorizontal }) => {
  const ticks = useMemo(() => {
    const interval = getTickInterval(scale);
    const list: { value: number; major: boolean }[] = [];
    const firstTick = Math.floor(start / interval) * interval;
    for (let v = firstTick; v <= end; v += interval) {
      list.push({ value: v, major: v % (interval * 5) === 0 || interval >= 1000 });
    }
    return list;
  }, [start, end, scale]);

  return (
    <>
      {ticks.map(({ value, major }) => {
        const screenPos = value * scale;
        if (isHorizontal) {
          return (
            <React.Fragment key={value}>
              <line
                x1={screenPos} y1={RULER_SIZE}
                x2={screenPos} y2={major ? RULER_SIZE - 6 : RULER_SIZE - 4}
                stroke={TICK_COLOR} strokeWidth={1}
              />
              {major && (
                <text
                  x={screenPos} y={16}
                  fill={TEXT_COLOR} fontSize="10"
                  fontFamily="system-ui, -apple-system, sans-serif"
                  textAnchor="middle"
                >
                  {value}
                </text>
              )}
            </React.Fragment>
          );
        }
        return (
          <React.Fragment key={value}>
            <line
              x1={RULER_SIZE} y1={screenPos}
              x2={major ? RULER_SIZE - 6 : RULER_SIZE - 4} y2={screenPos}
              stroke={TICK_COLOR} strokeWidth={1}
            />
            {major && (
              <text
                x={12} y={screenPos}
                fill={TEXT_COLOR} fontSize="10"
                fontFamily="system-ui, -apple-system, sans-serif"
                textAnchor="middle" dominantBaseline="middle"
                transform={`rotate(-90, 12, ${screenPos})`}
              >
                {value}
              </text>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};

// ─── Component ─────────────────────────────────────────────────────────────

/** Hook: subscribe to transformManager so the rulers re-render on every
 *  pan/zoom. Mirrors the `useDisplayTransform` pattern from the builder
 *  but tied to Revyme's transformManager. */
function useTransform() {
  const [transform, setTransform] = useState(transformManager.getTransform());
  useEffect(() => transformManager.subscribe(() => setTransform(transformManager.getTransform())), []);
  return transform;
}

export default function CanvasRulers() {
  const showRulers = useAtomValue(showRulersAtom);
  const transform = useTransform();
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const draggingPreview = useAtomValue(draggingGuidePreviewAtom);
  const store = useStore();

  // Dynamic top offset — 52 px when the ComponentBreadcrumb is visible
  // (editing a component / icon-set master), 0 otherwise. Mirrors the
  // breadcrumb's own `if (!isMasterFilePath(activeFile)) return null;`
  // check so the ruler offset stays in lockstep with the breadcrumb's
  // visibility. Keep this in a stable closure so the drag handlers
  // below see the latest value via the transformRef pattern.
  const topOffset = isMasterFilePath(activeFilePath) ? BREADCRUMB_HEIGHT : 0;

  // Container dimensions — track viewport size so the rulers extend to
  // the right edge of the screen. We avoid SSR (`window` access) by
  // reading on mount + on resize.
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1920,
    h: typeof window !== 'undefined' ? window.innerHeight : 1080,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ─── Drag from ruler → create guide ───────────────────────────────────
  const isDraggingRef = useRef(false);
  const dragTypeRef = useRef<'horizontal' | 'vertical' | null>(null);
  const transformRef = useRef(transform);
  const filePathRef = useRef(activeFilePath);
  // topOffset can change mid-drag (rare: user navigates to/from a master
  // file via breadcrumb while still holding the cursor). Keep it in a
  // ref so the window-level mouseup handler reads the live value.
  const topOffsetRef = useRef(topOffset);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { filePathRef.current = activeFilePath; }, [activeFilePath]);
  useEffect(() => { topOffsetRef.current = topOffset; }, [topOffset]);

  const handleHorizontalRulerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    dragTypeRef.current = 'horizontal';
    store.set(draggingGuidePreviewAtom, { type: 'horizontal', screenPosition: e.clientY });
    document.body.style.cursor = 'row-resize';
  }, [store]);

  const handleVerticalRulerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    dragTypeRef.current = 'vertical';
    store.set(draggingGuidePreviewAtom, { type: 'vertical', screenPosition: e.clientX });
    document.body.style.cursor = 'col-resize';
  }, [store]);

  // Window-level mousemove + mouseup so the drag continues even when
  // the cursor leaves the ruler's tiny strip.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragTypeRef.current) return;
      const screenPos = dragTypeRef.current === 'horizontal' ? e.clientY : e.clientX;
      store.set(draggingGuidePreviewAtom, { type: dragTypeRef.current, screenPosition: screenPos });
    };
    const onUp = (e: MouseEvent) => {
      if (!isDraggingRef.current || !dragTypeRef.current) return;
      const t = transformRef.current;
      const type = dragTypeRef.current;
      const tOff = topOffsetRef.current;
      // Convert screen → canvas-space using the canvas transform.
      // Same math the click handler in Canvas.tsx uses.
      const cursorScreenPos = type === 'horizontal' ? e.clientY : e.clientX;
      // Inverse of `RulerGuides.tsx` `GuideLine.screenPos`. Must NOT add
      // `tOff + RULER_SIZE` / `LEFT_OFFSET + RULER_SIZE` to compensate
      // for the cursor crossing the ruler edge — those would store a
      // shifted canvas-x and break snap alignment.
      const offset = type === 'horizontal' ? t.y : t.x + LEFT_OFFSET;
      const canvasPos = (cursorScreenPos - offset) / t.scale;

      // Distance check — only commit if the user pulled the cursor
      // past `MIN_CREATE_DISTANCE` past the ruler. Otherwise treat
      // it as a misclick and bail.
      const distance = type === 'horizontal'
        ? e.clientY - tOff - RULER_SIZE
        : e.clientX - LEFT_OFFSET - RULER_SIZE;
      if (distance > MIN_CREATE_DISTANCE) {
        rulerGuideOps.addGuide(filePathRef.current, type, canvasPos);
      }
      isDraggingRef.current = false;
      dragTypeRef.current = null;
      store.set(draggingGuidePreviewAtom, null);
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [store]);

  // ─── Selection bounds (highlight bands on rulers) ─────────────────
  // For each selected node, read its viewport-space rect from the
  // bridge cache, convert to canvas-space, and aggregate to a union
  // bounding box. RAF-poll so the bands track the selection live
  // through resize / drag (the rectCache updates on every patchStyles,
  // so this poll naturally stays in sync).
  const selectedIds = useAtomValue(selectedIdsAtom);
  // While shape-editing / drawing a path, the selected node is the
  // viewport-sized seed — its bounds would paint the ruler bands across the
  // whole ruler. Suppress the bands entirely during shape-edit.
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  const [selectionBounds, setSelectionBounds] = useState<
    | { left: number; right: number; top: number; bottom: number }
    | null
  >(null);
  const selectedIdsRef = useRef(selectedIds);
  const interactingVpIdRef = useRef(interactingVpId);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { interactingVpIdRef.current = interactingVpId; }, [interactingVpId]);

  useEffect(() => {
    if (selectedIds.length === 0 || shapeEditingId) {
      setSelectionBounds(null);
      return;
    }
    let raf = 0;
    const rectState = new Map<string, string>(); // DIAGNOSTIC: track rect availability transitions
    const compute = () => {
      const ids = selectedIdsRef.current;
      const vpId = interactingVpIdRef.current || 'desktop';
      const t = transformRef.current;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let any = false;
      for (const id of ids) {
        const rect = findNodeRect(id, vpId);
        // DIAGNOSTIC (temporary): when does the ruler first get a usable rect
        // for a freshly-selected node? Logs only on state change to avoid spam.
        const st = rect ? (rect.width > 0 ? 'valid' : 'zero') : 'null';
        if (st !== rectState.get(id)) {
          rectState.set(id, st);
          trace.action('ruler:selrect-state', { id, vpId, state: st, w: rect?.width ?? -1, left: rect?.left ?? -1 });
        }
        if (!rect) continue;
        // findNodeRect returns viewport coords (bridge already applied
        // toParentSpace + transform-delta adjust). Convert to canvas-
        // space using the same `(viewport_x - transform.x) / scale`
        // formula the SVG-tick render uses → guarantees the
        // selection band aligns with the ruler ticks.
        const cl = (rect.left - t.x) / t.scale;
        const cr = (rect.left + rect.width - t.x) / t.scale;
        const ct = (rect.top - t.y) / t.scale;
        const cb = (rect.top + rect.height - t.y) / t.scale;
        if (cl < minX) minX = cl;
        if (cr > maxX) maxX = cr;
        if (ct < minY) minY = ct;
        if (cb > maxY) maxY = cb;
        any = true;
      }
      const next = any
        ? { left: minX, right: maxX, top: minY, bottom: maxY }
        : null;
      // Bail out of state updates when bounds are stable so the RAF
      // loop doesn't churn React renders during static selection.
      setSelectionBounds((prev) => {
        if (!prev && !next) return prev;
        if (prev && next
            && Math.abs(prev.left - next.left) < 0.5
            && Math.abs(prev.right - next.right) < 0.5
            && Math.abs(prev.top - next.top) < 0.5
            && Math.abs(prev.bottom - next.bottom) < 0.5) return prev;
        return next;
      });
      raf = requestAnimationFrame(compute);
    };
    // Run the FIRST compute SYNCHRONOUSLY (don't defer to the next animation
    // frame). On a fresh selection the node's rect is already in the cache (the
    // creator seeds it), but `requestAnimationFrame` pushes the first read behind
    // the React selection work, so the ruler's selection band appeared ~90ms
    // after the resize handles. Computing inline lands it in the same beat;
    // `compute` then schedules the live RAF loop for subsequent frames.
    compute();
    return () => cancelAnimationFrame(raf);
  }, [selectedIds, shapeEditingId]);

  if (!showRulers) return null;

  // Visible canvas-coord range for tick generation.
  const visibleStartX = (LEFT_OFFSET - transform.x) / transform.scale;
  const visibleEndX = (viewport.w - RIGHT_OFFSET - transform.x) / transform.scale;
  const visibleStartY = (topOffset - transform.y) / transform.scale;
  const visibleEndY = (viewport.h - transform.y) / transform.scale;

  trace.fn('CanvasRulers:render', {
    scale: Math.round(transform.scale * 100) / 100,
    interval: getTickInterval(transform.scale),
  });

  return (
    <>
      {/* Top ruler — right edge stops at the right panel boundary
          (`right: RIGHT_OFFSET`) so the ruler never reaches the panel
          chrome. No z-index dance needed: the ruler simply doesn't
          extend into the panel's region.
          z-index 4900 sits BELOW the right panel (z-5000) and above
          canvas content; in practice the geometry already keeps them
          apart, but the lower z keeps RightHeader (z-9999) on top
          when the ruler is visible at y=0 on a non-master file. */}
      <div
        data-ruler
        onMouseDown={handleHorizontalRulerMouseDown}
        style={{
          position: 'fixed',
          top: topOffset,
          left: LEFT_OFFSET + RULER_SIZE,
          right: RIGHT_OFFSET,
          height: RULER_SIZE,
          backgroundColor: RULER_BG,
          borderBottom: `1px solid ${RULER_BORDER}`,
          zIndex: 4900,
          cursor: 'row-resize',
          userSelect: 'none',
          overflow: 'hidden',
        }}
      >
        <svg width="100%" height={RULER_SIZE} style={{ position: 'absolute', left: 0, top: 0 }}>
          <g transform={`translate(${transform.x - LEFT_OFFSET - RULER_SIZE}, 0)`}>
            <RulerTicks start={visibleStartX} end={visibleEndX} scale={transform.scale} isHorizontal />
          </g>
        </svg>
      </div>

      {/* Left ruler */}
      <div
        data-ruler
        onMouseDown={handleVerticalRulerMouseDown}
        style={{
          position: 'fixed',
          top: topOffset + RULER_SIZE,
          left: LEFT_OFFSET,
          bottom: 0,
          width: RULER_SIZE,
          backgroundColor: RULER_BG,
          borderRight: `1px solid ${RULER_BORDER}`,
          zIndex: 4900,
          cursor: 'col-resize',
          userSelect: 'none',
          overflow: 'hidden',
        }}
      >
        <svg width={RULER_SIZE} height="100%" style={{ position: 'absolute', left: 0, top: 0 }}>
          <g transform={`translate(0, ${transform.y - topOffset - RULER_SIZE})`}>
            <RulerTicks start={visibleStartY} end={visibleEndY} scale={transform.scale} isHorizontal={false} />
          </g>
        </svg>
      </div>

      {/* Corner square — covers the L-intersection with a tinted glass
          panel: semi-transparent ruler-bg + backdrop-filter blur so any
          canvas content peeking through reads as soft chrome (matches
          the old `../../builder` corner treatment).
          z-index 4910 sits ABOVE every ruler-internal layer (bands at
          4903, drag preview at 4905, position indicators at 4902) so
          selection bands and indicator pills cleanly hide BEHIND the
          corner instead of painting over it — but stays below the
          right panel chrome (5000+) so it never covers UI panels. */}
      <div
        data-ruler
        style={{
          position: 'fixed',
          top: topOffset,
          left: LEFT_OFFSET,
          width: RULER_SIZE,
          height: RULER_SIZE,
          backgroundColor: 'color-mix(in srgb, var(--bg-canvas) 70%, transparent)',
          backdropFilter: 'blur(8px) saturate(1.1)',
          WebkitBackdropFilter: 'blur(8px) saturate(1.1)',
          borderRight: `1px solid ${RULER_BORDER}`,
          borderBottom: `1px solid ${RULER_BORDER}`,
          zIndex: 4910,
          pointerEvents: 'none',
        }}
      />

      {/* Selection bounds — highlight bands on both rulers showing the
          width / height of the current selection in canvas-space.
          Ports the builder's "selectionBounds" feature: opaque accent
          band between the selection's edges + 1 px edge line on the
          inner ruler edge + 8 px tick marks at each edge + a position-
          indicator pill showing the canvas-space coord. Mirrored on the
          left ruler for vertical extent.
          screen_x for canvas_x = canvas_x * transform.scale + transform.x */}
      {selectionBounds && (() => {
        const sb = selectionBounds;
        const screenLeft   = sb.left   * transform.scale + transform.x;
        const screenRight  = sb.right  * transform.scale + transform.x;
        const screenTop    = sb.top    * transform.scale + transform.y;
        const screenBottom = sb.bottom * transform.scale + transform.y;
        const widthScreen  = Math.max(1, screenRight - screenLeft);
        const heightScreen = Math.max(1, screenBottom - screenTop);
        return (
          <>
            {/* Top ruler — opaque accent band between selection edges */}
            <div style={{
              position: 'fixed', top: topOffset, left: screenLeft,
              width: widthScreen, height: RULER_SIZE,
              backgroundColor: SELECTION_ACCENT, opacity: 0.12,
              pointerEvents: 'none', zIndex: 4901,
            }} />
            {/* Top ruler — 1 px edge line at the bottom (against canvas) */}
            <div style={{
              position: 'fixed', top: topOffset + RULER_SIZE - 1, left: screenLeft,
              width: widthScreen, height: 1,
              backgroundColor: SELECTION_ACCENT,
              pointerEvents: 'none', zIndex: 4903,
            }} />
            {/* Top ruler — 8 px tick marks at each edge */}
            <div style={{
              position: 'fixed', top: topOffset + RULER_SIZE - 8, left: screenLeft,
              width: 1, height: 8, backgroundColor: SELECTION_ACCENT,
              pointerEvents: 'none', zIndex: 4903,
            }} />
            <div style={{
              position: 'fixed', top: topOffset + RULER_SIZE - 8, left: screenRight,
              width: 1, height: 8, backgroundColor: SELECTION_ACCENT,
              pointerEvents: 'none', zIndex: 4903,
            }} />
            {/* Left ruler — accent band */}
            <div style={{
              position: 'fixed', left: LEFT_OFFSET, top: screenTop,
              width: RULER_SIZE, height: heightScreen,
              backgroundColor: SELECTION_ACCENT, opacity: 0.12,
              pointerEvents: 'none', zIndex: 4901,
            }} />
            {/* Left ruler — 1 px edge line at the right (against canvas) */}
            <div style={{
              position: 'fixed', left: LEFT_OFFSET + RULER_SIZE - 1, top: screenTop,
              width: 1, height: heightScreen,
              backgroundColor: SELECTION_ACCENT,
              pointerEvents: 'none', zIndex: 4903,
            }} />
            {/* Left ruler — 8 px tick marks at each edge */}
            <div style={{
              position: 'fixed', left: LEFT_OFFSET + RULER_SIZE - 8, top: screenTop,
              width: 8, height: 1, backgroundColor: SELECTION_ACCENT,
              pointerEvents: 'none', zIndex: 4903,
            }} />
            <div style={{
              position: 'fixed', left: LEFT_OFFSET + RULER_SIZE - 8, top: screenBottom,
              width: 8, height: 1, backgroundColor: SELECTION_ACCENT,
              pointerEvents: 'none', zIndex: 4903,
            }} />
            {/* Position-indicator labels at each edge — canvas-space coords */}
            <PositionIndicator position={sb.left}   isHorizontal transform={transform} topOffset={topOffset} />
            <PositionIndicator position={sb.right}  isHorizontal transform={transform} topOffset={topOffset} />
            <PositionIndicator position={sb.top}    isHorizontal={false} transform={transform} topOffset={topOffset} />
            <PositionIndicator position={sb.bottom} isHorizontal={false} transform={transform} topOffset={topOffset} />
          </>
        );
      })()}

      {/* Drag preview line — follows cursor while dragging from ruler.
          Right edge also stops at RIGHT_OFFSET so the preview doesn't
          paint over the right panel. */}
      {draggingPreview && draggingPreview.type === 'horizontal' && (
        <div
          style={{
            position: 'fixed',
            left: LEFT_OFFSET + RULER_SIZE,
            right: RIGHT_OFFSET,
            top: draggingPreview.screenPosition,
            height: 1,
            backgroundColor: GUIDE_COLOR,
            pointerEvents: 'none',
            zIndex: 4905,
          }}
        />
      )}
      {draggingPreview && draggingPreview.type === 'vertical' && (
        <div
          style={{
            position: 'fixed',
            top: topOffset + RULER_SIZE,
            bottom: 0,
            left: draggingPreview.screenPosition,
            width: 1,
            backgroundColor: GUIDE_COLOR,
            pointerEvents: 'none',
            zIndex: 4905,
          }}
        />
      )}
    </>
  );
}
