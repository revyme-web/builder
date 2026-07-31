// RulerGuides.tsx — Renders the persistent guide lines from the
// active file's `/** @rulerGuides [...] */` annotation. Each guide is
// a thin teal line spanning the canvas at its canvas-space position;
// drag to reposition, right-click for the Delete menu, Backspace to
// remove the selected one.
//
// Ported from `builder/src/builder/view/canvas/RulerGuides.tsx` and
// trimmed to Revyme's setup (no panel-open detection, no master-
// page filter — guide scoping is handled by per-file annotation
// persistence: each page / component / icon-set master gets its own
// guides because they live in that file's source).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { transformManager } from '@/canvas/transform';
import { showRulersAtom } from '@/code/stores/user-preferences-store';
import { activeFilePathAtom, isMasterFilePath } from '@/code/project/active-file-store';
import {
  activeRulerGuidesAtom,
  selectedGuideIdAtom,
  snappedRulerGuideIdsAtom,
  rulerGuideOps,
  type RulerGuide,
} from '@/code/stores/ruler-guides-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

const RULER_SIZE = 28;
const LEFT_MENU_WIDTH = 52;
const LEFT_PANEL_WIDTH = 256;
const RIGHT_PANEL_WIDTH = 260;
const BREADCRUMB_HEIGHT = 52;
const LEFT_OFFSET = LEFT_MENU_WIDTH + LEFT_PANEL_WIDTH;
const RIGHT_OFFSET = RIGHT_PANEL_WIDTH;
// `topOffset` is dynamic at the component level (depends on whether
// `isMasterFilePath(activeFile)` is true). See CanvasRulers.tsx for
// the matching rationale — the two components must use the same
// offset or guides won't line up with ruler ticks.

const GUIDE_COLOR = '#0d9488';
const GUIDE_COLOR_SELECTED = 'var(--accent)';
const GUIDE_HIT_AREA = 8;

// Drop a guide back ONTO the ruler (within this many screen px) →
// delete it. Same gesture Figma uses for "drag guide back to ruler
// to remove". Mirrors `MIN_CREATE_DISTANCE` from CanvasRulers.tsx.
const RULER_DROP_DELETE_THRESHOLD = 10;

// ─── Single guide line ────────────────────────────────────────────────────

interface GuideLineProps {
  guide: RulerGuide;
  isSelected: boolean;
  transform: { x: number; y: number; scale: number };
  topOffset: number;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onStartDrag: (id: string, type: 'horizontal' | 'vertical') => void;
}

const GuideLine: React.FC<GuideLineProps> = ({
  guide, isSelected, transform, topOffset, onSelect, onContextMenu, onStartDrag,
}) => {
  // Convert canvas position → window position (these guides are
  // `position: fixed`, so we need window coords). MUST match the formula
  // the snap-line overlay uses, since users put a guide down expecting
  // elements to snap onto it pixel-perfectly.
  //
  // Snap-line SVG sits at `position: absolute, left: 0, top: 0` inside the
  // canvas container — the container starts at window-x = `LEFT_OFFSET` and
  // window-y = 0. A snap line at canvas-coord `c` is drawn at SVG-x =
  // `c * scale + transform.x`, which lands at:
  //   - vertical:   window-x = `LEFT_OFFSET + c * scale + transform.x`
  //   - horizontal: window-y = `c * scale + transform.y`
  // We mirror that here so the guide tracks the snap line exactly.
  //
  // Earlier this formula added `+ RULER_SIZE` (and `+ topOffset` on Y).
  // Together with the matching addition in the create/drag math, that
  // visually dropped the guide at the cursor — but stored a canvas-coord
  // shifted by `RULER_SIZE / scale`. Snap fired at the TRUE canvas-coord,
  // so the snap line sat `RULER_SIZE` pixels off the guide. Removing the
  // additions in both places makes the stored canvas-coord = the cursor's
  // actual canvas position (and aligns the visible guide with the snap).
  const screenPos = guide.type === 'horizontal'
    ? guide.position * transform.scale + transform.y
    : guide.position * transform.scale + transform.x + LEFT_OFFSET;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left-click only; right-click → context menu
    e.preventDefault();
    e.stopPropagation();
    onSelect(guide.id);
    onStartDrag(guide.id, guide.type);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, guide.id);
  };

  if (guide.type === 'horizontal') {
    return (
      <div
        data-ruler-guide
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        style={{
          position: 'fixed',
          left: LEFT_OFFSET + RULER_SIZE,
          right: RIGHT_OFFSET,
          top: screenPos,
          height: 1,
          backgroundColor: isSelected ? GUIDE_COLOR_SELECTED : GUIDE_COLOR,
          pointerEvents: 'auto',
          cursor: 'row-resize',
          zIndex: 4895,
        }}
      >
        {/* Wider hit area centered on the line so the user can grab it
            without pixel-perfect aim. */}
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: -GUIDE_HIT_AREA / 2, height: GUIDE_HIT_AREA, cursor: 'row-resize',
        }} />
      </div>
    );
  }
  return (
    <div
      data-ruler-guide
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      style={{
        position: 'fixed',
        top: topOffset + RULER_SIZE,
        bottom: 0,
        left: screenPos,
        width: 1,
        backgroundColor: isSelected ? GUIDE_COLOR_SELECTED : GUIDE_COLOR,
        pointerEvents: 'auto',
        cursor: 'col-resize',
        zIndex: 4895,
      }}
    >
      <div style={{
        position: 'absolute', top: 0, bottom: 0,
        left: -GUIDE_HIT_AREA / 2, width: GUIDE_HIT_AREA, cursor: 'col-resize',
      }} />
    </div>
  );
};

// ─── Right-click context menu ─────────────────────────────────────────────

interface GuideContextMenuProps {
  x: number;
  y: number;
  guideId: string;
  filePath: string;
  onClose: () => void;
}

const GuideContextMenu: React.FC<GuideContextMenuProps> = ({ x, y, guideId, filePath, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const handleDelete = () => {
    rulerGuideOps.removeGuide(filePath, guideId);
    onClose();
  };
  return (
    <div
      ref={menuRef}
      data-ruler-guide-menu
      className="fixed py-2 min-w-[160px] bg-[var(--bg-surface)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-lg"
      style={{ left: x, top: y, zIndex: 99999 }}
    >
      <div
        onClick={handleDelete}
        className="group flex items-center gap-3 mx-1.5 px-2 py-2 cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--accent)]"
      >
        <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-white flex-1">
          Delete Guide
        </span>
        <span className="text-[10px] text-[var(--text-secondary)] group-hover:text-white ml-8">⌫</span>
      </div>
    </div>
  );
};

// ─── Hook: subscribe to transform manager (same pattern CanvasRulers uses) ─

function useTransform() {
  const [t, setT] = useState(transformManager.getTransform());
  useEffect(() => transformManager.subscribe(() => setT(transformManager.getTransform())), []);
  return t;
}

// ─── Component ────────────────────────────────────────────────────────────

export default function RulerGuides() {
  const showRulers = useAtomValue(showRulersAtom);
  const guides = useAtomValue(activeRulerGuidesAtom);
  const selectedId = useAtomValue(selectedGuideIdAtom);
  // Guides whose id appears here are currently being snapped against —
  // hide them so the pink snap line is unobstructed. They reappear the
  // moment the snap breaks (set drops the id) or the drag/resize ends
  // (set goes empty).
  const snappedIds = useAtomValue(snappedRulerGuideIdsAtom);
  const setSelectedId = useSetAtom(selectedGuideIdAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const setSelectedNodeIds = useSetAtom(selectedIdsAtom);
  const transform = useTransform();
  // Same dynamic offset rationale as CanvasRulers — see that file.
  const topOffset = isMasterFilePath(activeFilePath) ? BREADCRUMB_HEIGHT : 0;

  // Refs so the window-level mousemove/up handlers always read the
  // latest values without re-binding the listeners on every render.
  const transformRef = useRef(transform);
  const filePathRef = useRef(activeFilePath);
  const topOffsetRef = useRef(topOffset);
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { filePathRef.current = activeFilePath; }, [activeFilePath]);
  useEffect(() => { topOffsetRef.current = topOffset; }, [topOffset]);

  // ─── Right-click context menu ──────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; guideId: string } | null
  >(null);
  // Close the menu when its target guide gets deselected (Escape, etc.).
  useEffect(() => {
    if (!selectedId && contextMenu) setContextMenu(null);
  }, [selectedId, contextMenu]);

  const handleSelect = useCallback((guideId: string) => {
    setSelectedId(guideId);
    // Clear any node selection — guides + node selection compete for
    // the same selection-overlay highlight color, and Figma exits node
    // selection when you click a guide.
    setSelectedNodeIds([]);
  }, [setSelectedId, setSelectedNodeIds]);

  const handleContextMenu = useCallback((e: React.MouseEvent, guideId: string) => {
    setSelectedId(guideId);
    setContextMenu({ x: e.clientX, y: e.clientY, guideId });
  }, [setSelectedId]);

  // ─── Drag existing guide ───────────────────────────────────────────
  const handleStartDrag = useCallback((guideId: string, type: 'horizontal' | 'vertical') => {
    rulerGuideOps.beginDragExisting(guideId, type);
    document.body.style.cursor = type === 'horizontal' ? 'row-resize' : 'col-resize';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = rulerGuideOps.getActiveDrag();
      if (!drag) return;
      const t = transformRef.current;
      // Inverse of the GuideLine render formula above — keep these two in
      // lock-step. Canvas-x = (cursor_window_x - LEFT_OFFSET - transform.x) / scale,
      // canvas-y = (cursor_window_y - transform.y) / scale.
      const cursorScreen = drag.type === 'horizontal' ? e.clientY : e.clientX;
      const offset = drag.type === 'horizontal' ? t.y : t.x + LEFT_OFFSET;
      const canvasPos = (cursorScreen - offset) / t.scale;
      rulerGuideOps.updateGuidePosition(filePathRef.current, drag.guideId, canvasPos, true);
    };
    const onUp = (e: MouseEvent) => {
      const drag = rulerGuideOps.getActiveDrag();
      if (!drag) return;
      const tOff = topOffsetRef.current;
      // Drop back onto the ruler → delete (Figma gesture). Distance
      // matches CanvasRulers' MIN_CREATE_DISTANCE so the two gestures
      // (create from ruler / drop back to ruler) feel symmetric.
      const dist = drag.type === 'horizontal'
        ? e.clientY - tOff - RULER_SIZE
        : e.clientX - LEFT_OFFSET - RULER_SIZE;
      if (dist < RULER_DROP_DELETE_THRESHOLD) {
        rulerGuideOps.removeGuide(filePathRef.current, drag.guideId);
        trace.action('ruler-guide:drop-delete', { guideId: drag.guideId });
      }
      rulerGuideOps.endDragExisting();
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ─── Click-elsewhere to deselect ───────────────────────────────────
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't deselect when clicking a guide, ruler, or guide menu —
      // those have their own selection semantics.
      if (target.closest('[data-ruler-guide]')) return;
      if (target.closest('[data-ruler]')) return;
      if (target.closest('[data-ruler-guide-menu]')) return;
      setSelectedId(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [setSelectedId]);

  // ─── Keyboard: Backspace/Delete removes, Esc deselects ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return;
      // Skip when typing in an input / contenteditable / TipTap editor.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        rulerGuideOps.removeGuide(filePathRef.current, selectedId);
        setSelectedId(null);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedId, setSelectedId]);

  if (!showRulers) return null;

  return (
    <>
      {guides.map((g) => {
        // Hide while the dragged element is locked onto this guide so
        // the pink snap line shows alone (otherwise they overlap and
        // the user can't tell whether the snap fired). See
        // `snappedRulerGuideIdsAtom` in `ruler-guides-store.ts`.
        if (snappedIds.has(g.id)) return null;
        return (
          <GuideLine
            key={g.id}
            guide={g}
            isSelected={selectedId === g.id}
            transform={transform}
            topOffset={topOffset}
            onSelect={handleSelect}
            onContextMenu={handleContextMenu}
            onStartDrag={handleStartDrag}
          />
        );
      })}
      {contextMenu && (
        <GuideContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          guideId={contextMenu.guideId}
          filePath={activeFilePath}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
