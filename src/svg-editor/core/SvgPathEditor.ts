/**
 * SvgPathEditor — Main editor class. Supports single path or full SVG with multiple shapes.
 *
 * Multi-shape: parses <svg> with multiple <path>, <line>, <circle>, etc.
 * Single path: wraps a single `d` attribute.
 * All shapes are editable simultaneously — click any anchor on any shape.
 */

import { SvgDocument } from './SvgDocument';
import type { ShapeEntry } from './SvgDocument';
import { PenTool } from './PenTool';
import { hitTestMultiShape, screenToSvg } from './HitTester';
import { pointOnCubic, pointOnLine } from './SegmentMath';
import type {
  Anchor, Point, PathSelection, AnchorRef, HandleMode,
  SvgEditorConfig, SvgEditorAdapter, EditorTool, AnchorInfo, AnchorView,
  EdgeMidpointView, SegmentHoverView, HandleStyle,
} from './types';

/** Resolved (non-optional) handle style — internal use after applying defaults. */
export interface ResolvedHandleStyle {
  size: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

const DEFAULT_ANCHOR_STYLE: ResolvedHandleStyle = {
  size: 8, fill: 'white', stroke: '#2680EB', strokeWidth: 1.5,
};
const DEFAULT_SELECTED_ANCHOR_STYLE: ResolvedHandleStyle = {
  size: 10, fill: '#2680EB', stroke: 'white', strokeWidth: 1.5,
};
const DEFAULT_CONTROL_HANDLE_STYLE: ResolvedHandleStyle = {
  size: 7, fill: '#2680EB', stroke: 'white', strokeWidth: 1,
};

function resolveStyle(
  s: HandleStyle | undefined,
  fallback: ResolvedHandleStyle,
): ResolvedHandleStyle {
  return {
    size: s?.size ?? fallback.size,
    fill: s?.fill ?? fallback.fill,
    stroke: s?.stroke ?? fallback.stroke,
    strokeWidth: s?.strokeWidth ?? fallback.strokeWidth,
  };
}

/**
 * Build the SVG markup string for an anchor circle.
 * Pure — extracted for unit testing.
 *
 * `pxToVb` converts screen pixels to viewBox units.
 * `screenScale` is an additional multiplier (for canvas-zoom compensation).
 */
export function buildAnchorMarkup(
  cx: number,
  cy: number,
  style: ResolvedHandleStyle,
  pxToVb: number,
  screenScale: number = 1,
  /** Per-axis user-units-per-screen-px ratios. Used so anchors render
   *  as visually-circular ellipses in screen space when the overlay SVG
   *  uses `preserveAspectRatio="none"` (asymmetric viewBox→container
   *  scaling). Falls back to the averaged pxToVb when not provided so
   *  legacy callers stay correct on aspect-ratio-preserving overlays. */
  pxToVbX?: number,
  pxToVbY?: number,
): string {
  const screenR = (style.size * screenScale) / 2;
  const screenSw = style.strokeWidth * screenScale;
  const ratioX = pxToVbX ?? pxToVb;
  const ratioY = pxToVbY ?? pxToVb;
  const rx = screenR * ratioX;
  const ry = screenR * ratioY;
  // Stroke-width: average the axes so a 1.5 px stroke reads ~1.5 px on
  // both sides of the ellipse. Pure-X or pure-Y would over/underweight
  // one axis under heavy aspect distortion.
  const sw = screenSw * ((ratioX + ratioY) / 2);
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="${sw}" style="cursor:pointer"/>`;
}

function emptySelection(): PathSelection {
  return { anchors: new Set(), anchorRefs: [], activeShapeIndex: 0, activeHandle: null };
}

export class SvgPathEditor {
  private doc: SvgDocument;
  private adapter: SvgEditorAdapter;
  private penTool: PenTool;
  private multiShapeMode = false;
  private config: {
    anchorHitRadius: number;
    handleHitRadius: number;
    gridSnap: number;
    anchorStyle: ResolvedHandleStyle;
    selectedAnchorStyle: ResolvedHandleStyle;
    controlHandleStyle: ResolvedHandleStyle;
    screenScale: number;
    hostRendersHandles: boolean;
    onChange?: (d: string) => void;
    onSelectionChange?: (selection: PathSelection) => void;
    onToolChange?: (tool: EditorTool) => void;
    onAnchorInfo?: (info: AnchorInfo | null) => void;
    onAnchorsChanged?: (anchors: AnchorView[]) => void;
    onRequestExit?: () => void;
  };

  /** Additional anchors-changed subscribers added via `onAnchorsChanged()`. */
  private _anchorSubs: Set<(anchors: AnchorView[]) => void> = new Set();

  /** Additional midpoint-changed subscribers. Midpoints are derived from
   *  anchors — these fire at exactly the same moments `_anchorSubs` do. */
  private _midpointSubs: Set<(eds: EdgeMidpointView[]) => void> = new Set();

  /** Segment-hover subscribers. Fires on pointermove when the hover state
   *  changes (includes transitions to null when cursor leaves segments). */
  private _segmentHoverSubs: Set<(h: SegmentHoverView | null) => void> = new Set();

  /** Latest hover view — cache so `getSegmentHover()` is O(1) and we can
   *  cheaply diff before emitting. Mirrors `hoveredSegment` but adds the
   *  resolved (x, y) viewBox-space point for the host's follower circle. */
  private _segmentHoverView: SegmentHoverView | null = null;

  private _tool: EditorTool = 'select';
  private selection: PathSelection = emptySelection();
  private overlayEl: SVGSVGElement | null = null;
  private containerEl: HTMLElement | null = null;

  // Segment hover
  private hoveredSegment: { shapeIndex: number; anchorIndex: number; t: number } | null = null;

  // Drag state
  private dragging = false;
  private dragType: 'anchor' | 'handleIn' | 'handleOut' | null = null;
  private dragShapeIndex = -1;
  private dragAnchorIndex = -1;
  private dragStartSvg: Point = { x: 0, y: 0 };

  // Bound handlers
  private _onPointerDown: ((e: PointerEvent) => void) | null = null;
  private _onPointerMove: ((e: PointerEvent) => void) | null = null;
  private _onPointerUp: ((e: PointerEvent) => void) | null = null;
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private _onDblClick: ((e: MouseEvent) => void) | null = null;
  // Manual double-click detection for anchors (native dblclick is unreliable here
  // — the anchor SVG re-renders between the two clicks). Tracks the last anchor
  // clicked + when, to detect a quick repeat on the same one → toggle its curve.
  private _lastAnchorClick: { shapeIndex: number; anchorIndex: number; time: number } | null = null;
  // Delayed "resume pen" timer for a single-click on an endpoint — held briefly so
  // a DOUBLE-click on the endpoint can pre-empt it (to toggle its curve instead).
  private _resumeTimer: ReturnType<typeof setTimeout> | null = null;
  // While drawing, true when the cursor is hovering an existing anchor/handle (so
  // the user is about to select/reshape, not extend). The pen rubber-band preview
  // is hidden while this is true — it only shows over empty canvas where the next
  // point would land.
  private _penOverAnchor = false;
  // True only for a LIVE pen-creation session (set by the host from the path
  // tool). Gates "click the end vertex to resume drawing": after a path is
  // committed and re-opened for editing, clicking a vertex must EDIT it, never
  // re-enter the pen. False by default so plain shape-edit never resumes drawing.
  allowResumePen = false;

  constructor(config: SvgEditorConfig) {
    this.adapter = config.adapter;
    this.config = {
      anchorHitRadius: config.anchorHitRadius ?? 6,
      handleHitRadius: config.handleHitRadius ?? 5,
      gridSnap: config.gridSnap ?? 0,
      anchorStyle: resolveStyle(config.anchorStyle, DEFAULT_ANCHOR_STYLE),
      selectedAnchorStyle: resolveStyle(config.selectedAnchorStyle, DEFAULT_SELECTED_ANCHOR_STYLE),
      controlHandleStyle: resolveStyle(config.controlHandleStyle, DEFAULT_CONTROL_HANDLE_STYLE),
      screenScale: config.screenScale ?? 1,
      hostRendersHandles: config.hostRendersHandles ?? false,
      onChange: config.onChange,
      onSelectionChange: config.onSelectionChange,
      onToolChange: config.onToolChange,
      onAnchorInfo: config.onAnchorInfo,
      onAnchorsChanged: config.onAnchorsChanged,
      onRequestExit: config.onRequestExit,
    };

    this.doc = new SvgDocument();

    // Detect mode: multi-shape if getSvgContent is provided and returns content
    const svgContent = config.adapter.getSvgContent?.();
    if (svgContent) {
      this.doc.parseSvg(svgContent);
      // Single-shape edit policy (see setTool('pen') comment): even though
      // the host serializes/deserializes via getSvgContent (so the wrapper's
      // viewBox / preserveAspectRatio / extra attrs round-trip cleanly), an
      // edit session only operates on ONE shape — the first one inside the
      // SVG. Trim any extras so anchors / handles / pen interactions can
      // never accidentally target a second shape. Multi-shape vectors are
      // handled at a higher layer via the Group operation, which wraps each
      // shape in its own nested SVG so each gets its own edit session.
      while (this.doc.shapes.length > 1) this.doc.removeShape(this.doc.shapes.length - 1);
      this.multiShapeMode = true;
    } else {
      const vb = config.adapter.getViewBox();
      this.doc.parsePath(config.adapter.getPathData(), vb);
      this.multiShapeMode = false;
    }

    // Pen tool operates on the active shape
    const activeShape = this.doc.getShape(0);
    this.penTool = new PenTool(
      activeShape?.path ?? this.doc.shapes[0]?.path,
      () => this._onModelChange(),
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  attach(container: HTMLElement): void {
    this.containerEl = container;
    this.overlayEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // overflow:visible + preserveAspectRatio="none" so anchor handles
    // never get clipped at the SVG's own bounds — they're decoration on
    // top of the path geometry and must paint freely past it. The host
    // SVG these anchors mirror is also rendered with preserveAspectRatio
    // ="none" in the design-tool case (standard stretch on resize),
    // so matching that here keeps anchor positions in lockstep with the
    // painted vertices regardless of viewBox/wrapper aspect mismatches.
    this.overlayEl.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:all;z-index:10;cursor:default;overflow:visible;';
    this.overlayEl.setAttribute('preserveAspectRatio', 'none');
    this.overlayEl.setAttribute('data-svg-editor-overlay', 'true');
    container.appendChild(this.overlayEl);

    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onDblClick = this._handleDblClick.bind(this);

    this.overlayEl.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
    this.overlayEl.addEventListener('dblclick', this._onDblClick);

    this.render();
  }

  detach(): void {
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    if (this.overlayEl) {
      if (this._onPointerDown) this.overlayEl.removeEventListener('pointerdown', this._onPointerDown);
      if (this._onDblClick) this.overlayEl.removeEventListener('dblclick', this._onDblClick);
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    if (this._onPointerMove) window.removeEventListener('pointermove', this._onPointerMove);
    if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    this.containerEl = null;
  }

  reload(): void {
    const svgContent = this.adapter.getSvgContent?.();
    if (svgContent) {
      this.doc.parseSvg(svgContent);
      // Same single-shape policy as the constructor — see init comment.
      while (this.doc.shapes.length > 1) this.doc.removeShape(this.doc.shapes.length - 1);
      this.multiShapeMode = true;
    } else {
      const vb = this.adapter.getViewBox();
      this.doc.parsePath(this.adapter.getPathData(), vb);
      this.multiShapeMode = false;
    }
    this.selection = emptySelection();
    this.render();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  get tool(): EditorTool { return this._tool; }
  get shapes(): readonly ShapeEntry[] { return this.doc.shapes; }
  get shapeCount(): number { return this.doc.shapeCount; }
  get anchors(): readonly Anchor[] { return this.doc.shapes[0]?.path.anchors ?? []; }
  get pathData(): string { return this.doc.shapes[0]?.path.serialize() ?? ''; }
  get currentSelection(): PathSelection { return this.selection; }

  setTool(tool: EditorTool): void {
    if (this._tool === 'pen' && tool !== 'pen') {
      this.penTool.finish();
      // Remove empty shapes created by pen tool that user didn't draw into
      this._cleanupEmptyShapes();
    }
    this._tool = tool;
    if (tool === 'pen') {
      // Single-shape edit only: pen tool extends the EXISTING shape (the
      // first one in the doc). Previously multi-shape mode would
      // `addShape()` here so each pen activation spawned a fresh shape
      // alongside the original — that's the wrong model for our host,
      // where a single edit session is always tied to one element. Adding
      // shapes from inside an edit produced extra anchors that the host's
      // commit path then serialized into the source as orphan paths,
      // looking to the user like "dragging created a new shape". Users
      // who want multiple shapes in one vector use the Group operation
      // upstream and edit each shape individually.
      this.penTool.activate(this.doc.shapes[0]?.path.anchors.length === 0);
      this.selection = emptySelection();
    }
    if (this.overlayEl) this.overlayEl.style.cursor = tool === 'pen' ? 'crosshair' : 'default';
    this.config.onToolChange?.(tool);
    this.render();
  }

  // ── Host-rendered handles API ────────────────────────────────────────────
  //
  // When `hostRendersHandles: true`, the editor skips rendering anchor
  // circles / control handles inside its own SVG overlay. The host calls
  // `getAnchorViews()` (or subscribes via `onAnchorsChanged`) and renders
  // overlay divs itself, forwarding pointerdown through `beginDragAnchor`
  // / `beginDragHandle`. Pointermove / up stay on the window (handled here).

  /**
   * Snapshot of every visible anchor's position (+ its bezier control
   * handles, if any, in absolute viewBox coords). Stable ids:
   *   `${shapeIndex}:${anchorIndex}`.
   *
   * Computed fresh on each call — cheap (O(anchors)).
   */
  getAnchorViews(): AnchorView[] {
    const views: AnchorView[] = [];
    const selectedSet = new Set(
      this.selection.anchorRefs.map(r => `${r.shapeIndex}:${r.anchorIndex}`),
    );
    const activeHandle = this.selection.activeHandle;
    const shapes = this.doc.shapes;
    for (let s = 0; s < shapes.length; s++) {
      if (!shapes[s].visible) continue;
      const anchors = shapes[s].path.anchors;
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const id = `${s}:${i}`;
        const selected = selectedSet.has(id);
        const view: AnchorView = {
          id,
          shapeIndex: s,
          anchorIndex: i,
          x: a.point.x,
          y: a.point.y,
          selected,
        };
        // Show control handles only for selected anchors (matches SVG render).
        if (selected) {
          if (a.handleIn) {
            view.inHandle = { x: a.point.x + a.handleIn.x, y: a.point.y + a.handleIn.y };
          }
          if (a.handleOut) {
            view.outHandle = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y };
          }
          if (activeHandle && activeHandle.shapeIndex === s && activeHandle.anchorIndex === i) {
            if (activeHandle.type === 'in') view.activeInHandle = true;
            else view.activeOutHandle = true;
          }
        }
        views.push(view);
      }
    }
    return views;
  }

  /**
   * Subscribe to anchor changes. Returns an unsubscribe fn.
   * Fires after anchors are added/removed/moved and on selection change.
   * Does NOT fire immediately — call `getAnchorViews()` synchronously if
   * you need the initial snapshot.
   */
  onAnchorsChanged(handler: (anchors: AnchorView[]) => void): () => void {
    this._anchorSubs.add(handler);
    return () => { this._anchorSubs.delete(handler); };
  }

  private _emitAnchorsChanged(): void {
    if (this._anchorSubs.size > 0 || this.config.onAnchorsChanged) {
      const views = this.getAnchorViews();
      this.config.onAnchorsChanged?.(views);
      for (const h of this._anchorSubs) h(views);
    }
    // Midpoints are derived from anchors — emit whenever anchors change.
    if (this._midpointSubs.size > 0) {
      const mids = this.getEdgeMidpoints();
      for (const h of this._midpointSubs) h(mids);
    }
  }

  /**
   * Snapshot of every visible edge midpoint. For each pair of consecutive
   * anchors, emits a midpoint at t=0.5 (true cubic midpoint for curved
   * segments, line midpoint for straight segments). For closed paths, also
   * emits the wrap-around edge (last → first, always straight).
   *
   * Stable ids: `${shapeIndex}:${endAnchorIndex}`. For the wrap edge,
   * endAnchorIndex === anchors.length.
   */
  getEdgeMidpoints(): EdgeMidpointView[] {
    const views: EdgeMidpointView[] = [];
    const shapes = this.doc.shapes;
    for (let s = 0; s < shapes.length; s++) {
      if (!shapes[s].visible) continue;
      const anchors = shapes[s].path.anchors;
      const closed = shapes[s].path.closed;

      for (let i = 1; i < anchors.length; i++) {
        const prevA = anchors[i - 1];
        const currA = anchors[i];
        let mid: Point;
        if (prevA.handleOut || currA.handleIn) {
          const cp1: Point = prevA.handleOut
            ? { x: prevA.point.x + prevA.handleOut.x, y: prevA.point.y + prevA.handleOut.y }
            : prevA.point;
          const cp2: Point = currA.handleIn
            ? { x: currA.point.x + currA.handleIn.x, y: currA.point.y + currA.handleIn.y }
            : currA.point;
          mid = pointOnCubic(prevA.point, cp1, cp2, currA.point, 0.5);
        } else {
          mid = pointOnLine(prevA.point, currA.point, 0.5);
        }
        views.push({
          id: `${s}:${i}`,
          shapeIndex: s,
          endAnchorIndex: i,
          x: mid.x,
          y: mid.y,
        });
      }

      // Wrap edge for closed paths (always a straight Z-line).
      if (closed && anchors.length >= 2) {
        const last = anchors[anchors.length - 1];
        const first = anchors[0];
        const mid = pointOnLine(last.point, first.point, 0.5);
        views.push({
          id: `${s}:${anchors.length}`,
          shapeIndex: s,
          endAnchorIndex: anchors.length,
          x: mid.x,
          y: mid.y,
        });
      }
    }
    return views;
  }

  /**
   * Subscribe to edge-midpoint changes. Returns an unsubscribe fn.
   * Fires at the same moments as `onAnchorsChanged` (midpoints are derived
   * from anchor positions). Does NOT fire immediately — call
   * `getEdgeMidpoints()` synchronously for the initial snapshot.
   */
  onEdgeMidpointsChanged(handler: (eds: EdgeMidpointView[]) => void): () => void {
    this._midpointSubs.add(handler);
    return () => { this._midpointSubs.delete(handler); };
  }

  /**
   * Current segment hover state (the point on the hovered segment closest
   * to the cursor). Null when the cursor is not over any segment. Updated
   * continuously during pointermove.
   */
  getSegmentHover(): SegmentHoverView | null {
    return this._segmentHoverView;
  }

  /**
   * Subscribe to segment-hover changes. Fires on pointermove whenever the
   * hovered segment or the cursor's position along it changes (including
   * transitions to/from null when entering/leaving segment proximity).
   * Returns an unsubscribe fn.
   */
  onSegmentHoverChanged(handler: (h: SegmentHoverView | null) => void): () => void {
    this._segmentHoverSubs.add(handler);
    return () => { this._segmentHoverSubs.delete(handler); };
  }

  private _emitSegmentHover(): void {
    for (const h of this._segmentHoverSubs) h(this._segmentHoverView);
  }

  private _resolveSegmentHoverView(
    raw: { shapeIndex: number; anchorIndex: number; t: number } | null,
  ): SegmentHoverView | null {
    if (!raw) return null;
    const shape = this.doc.shapes[raw.shapeIndex];
    if (!shape) return null;
    const anchors = shape.path.anchors;
    const prevA = anchors[raw.anchorIndex - 1];
    const currA = anchors[raw.anchorIndex];
    if (!prevA || !currA) return null;
    let pt: Point;
    if (currA.handleIn || prevA.handleOut) {
      const cp1: Point = prevA.handleOut
        ? { x: prevA.point.x + prevA.handleOut.x, y: prevA.point.y + prevA.handleOut.y }
        : prevA.point;
      const cp2: Point = currA.handleIn
        ? { x: currA.point.x + currA.handleIn.x, y: currA.point.y + currA.handleIn.y }
        : currA.point;
      pt = pointOnCubic(prevA.point, cp1, cp2, currA.point, raw.t);
    } else {
      pt = pointOnLine(prevA.point, currA.point, raw.t);
    }
    return {
      shapeIndex: raw.shapeIndex,
      endAnchorIndex: raw.anchorIndex,
      x: pt.x,
      y: pt.y,
      t: raw.t,
    };
  }

  /**
   * Host pointerdown forwarder — insert a new anchor at an arbitrary point
   * along a segment (parameterized by `t`) and immediately begin dragging
   * it. Mirrors the library's internal Alt+click-on-segment behavior, but
   * keyed by `(shapeIndex, endAnchorIndex, t)` rather than a midpoint id,
   * so the host can call this straight from the segment-hover state.
   *
   * Subsequent pointermove / pointerup are handled by the editor's own
   * window listeners (same as `beginDragAnchor`).
   */
  beginInsertAnchorAtSegment(
    shapeIndex: number,
    endAnchorIndex: number,
    t: number,
    screenX: number,
    screenY: number,
  ): void {
    const shape = this.doc.getShape(shapeIndex);
    if (!shape) return;

    let newIdx: number;
    if (endAnchorIndex >= shape.path.anchors.length) {
      newIdx = shape.path.splitClosingSegment(t);
    } else {
      // splitSegment takes the END anchor index of the segment — matches
      // our `SegmentHoverView.endAnchorIndex` exactly.
      newIdx = shape.path.splitSegment(endAnchorIndex, t);
    }
    if (newIdx < 0) return;

    const svgPoint = this._screenToSvg(screenX, screenY);
    this.dragging = true;
    this.dragStartSvg = svgPoint;
    this.dragType = 'anchor';
    this.dragShapeIndex = shapeIndex;
    this.dragAnchorIndex = newIdx;

    const ref: AnchorRef = { shapeIndex, anchorIndex: newIdx };
    this.selection = {
      anchors: new Set([newIdx]),
      anchorRefs: [ref],
      activeShapeIndex: shapeIndex,
      activeHandle: null,
    };
    this.hoveredSegment = null;
    this._segmentHoverView = null;
    this._emitSegmentHover();
    this._onModelChange();
    this._emitSelection();
  }

  /**
   * Host pointerdown forwarder — insert a new anchor at the midpoint of
   * an edge and immediately begin dragging it, mirroring the library's
   * internal Alt+click-on-segment behavior.
   *
   * Subsequent pointermove / pointerup are handled by the editor's own
   * window listeners (same as `beginDragAnchor`).
   */
  beginInsertAnchorAtMidpoint(midpointId: string, screenX: number, screenY: number): void {
    const parts = midpointId.split(':');
    if (parts.length !== 2) return;
    const shapeIndex = parseInt(parts[0], 10);
    const endAnchorIndex = parseInt(parts[1], 10);
    if (!Number.isFinite(shapeIndex) || !Number.isFinite(endAnchorIndex)) return;
    const shape = this.doc.getShape(shapeIndex);
    if (!shape) return;

    let newIdx: number;
    if (endAnchorIndex >= shape.path.anchors.length) {
      // Wrap-around (closing) edge — only valid for closed paths.
      newIdx = shape.path.splitClosingSegment(0.5);
    } else {
      newIdx = shape.path.splitSegment(endAnchorIndex, 0.5);
    }
    if (newIdx < 0) return;

    // Start dragging the new anchor so the user can reposition it live.
    const svgPoint = this._screenToSvg(screenX, screenY);
    this.dragging = true;
    this.dragStartSvg = svgPoint;
    this.dragType = 'anchor';
    this.dragShapeIndex = shapeIndex;
    this.dragAnchorIndex = newIdx;

    const ref: AnchorRef = { shapeIndex, anchorIndex: newIdx };
    this.selection = {
      anchors: new Set([newIdx]),
      anchorRefs: [ref],
      activeShapeIndex: shapeIndex,
      activeHandle: null,
    };
    this.hoveredSegment = null;
    this._onModelChange();
    this._emitSelection();
  }

  /**
   * Host pointerdown forwarder — begin dragging an anchor (host-rendered).
   * Selects the anchor (or keeps existing multi-selection if shift-like
   * behavior is desired — caller can pre-adjust selection via `selectShape`
   * / future API). Subsequent pointermove / pointerup are handled by the
   * editor's window listeners.
   *
   * `screenX` / `screenY` are client coords (as from PointerEvent.clientX).
   */
  beginDragAnchor(anchorId: string, screenX: number, screenY: number): void {
    const parsed = this._parseAnchorId(anchorId);
    if (!parsed) return;
    const { shapeIndex, anchorIndex } = parsed;
    const shape = this.doc.getShape(shapeIndex);
    if (!shape || !shape.path.anchors[anchorIndex]) return;

    const svgPoint = this._screenToSvg(screenX, screenY);
    this.dragging = true;
    this.dragStartSvg = svgPoint;
    this.dragType = 'anchor';
    this.dragShapeIndex = shapeIndex;
    this.dragAnchorIndex = anchorIndex;

    const ref: AnchorRef = { shapeIndex, anchorIndex };
    const alreadySelected = this.selection.anchorRefs.some(
      r => r.shapeIndex === shapeIndex && r.anchorIndex === anchorIndex,
    );
    if (!alreadySelected) {
      this.selection = {
        anchors: new Set([anchorIndex]),
        anchorRefs: [ref],
        activeShapeIndex: shapeIndex,
        activeHandle: null,
      };
    }
    this._emitSelection();
    this._emitAnchorsChanged();
    this.render();
  }

  /** Host pointerdown forwarder — begin dragging a bezier control handle. */
  beginDragHandle(anchorId: string, which: 'in' | 'out', screenX: number, screenY: number): void {
    const parsed = this._parseAnchorId(anchorId);
    if (!parsed) return;
    const { shapeIndex, anchorIndex } = parsed;
    const shape = this.doc.getShape(shapeIndex);
    if (!shape || !shape.path.anchors[anchorIndex]) return;

    const svgPoint = this._screenToSvg(screenX, screenY);
    this.dragging = true;
    this.dragStartSvg = svgPoint;
    this.dragType = which === 'in' ? 'handleIn' : 'handleOut';
    this.dragShapeIndex = shapeIndex;
    this.dragAnchorIndex = anchorIndex;

    const ref: AnchorRef = { shapeIndex, anchorIndex };
    this.selection = {
      anchors: new Set([anchorIndex]),
      anchorRefs: [ref],
      activeShapeIndex: shapeIndex,
      activeHandle: { shapeIndex, anchorIndex, type: which },
    };
    this._emitSelection();
    this._emitAnchorsChanged();
    this.render();
  }

  private _parseAnchorId(id: string): { shapeIndex: number; anchorIndex: number } | null {
    const parts = id.split(':');
    if (parts.length !== 2) return null;
    const shapeIndex = parseInt(parts[0], 10);
    const anchorIndex = parseInt(parts[1], 10);
    if (!Number.isFinite(shapeIndex) || !Number.isFinite(anchorIndex)) return null;
    return { shapeIndex, anchorIndex };
  }

  /** Select all anchors of a shape (for dragging the whole sub-path). */
  selectShape(shapeIndex: number): void {
    this._selectWholeShape(shapeIndex);
    this._emitSelection();
    this.render();
  }

  private _selectWholeShape(shapeIndex: number): void {
    const shape = this.doc.getShape(shapeIndex);
    if (!shape) return;
    const refs: AnchorRef[] = shape.path.anchors.map((_, i) => ({ shapeIndex, anchorIndex: i }));
    this.selection = {
      anchors: new Set(refs.map(r => r.anchorIndex)),
      anchorRefs: refs,
      activeShapeIndex: shapeIndex,
      activeHandle: null,
    };
  }

  /** Remove shapes with 0 anchors (empty pen drawings). */
  private _cleanupEmptyShapes(): void {
    for (let i = this.doc.shapes.length - 1; i >= 0; i--) {
      if (this.doc.shapes[i].path.anchors.length === 0) {
        this.doc.removeShape(i);
      }
    }
  }

  /**
   * Update the screen-pixel scale factor for handle visuals.
   * Pass `1 / canvasZoom` from the host so handles stay visually constant
   * when the host canvas is zoomed. Triggers a re-render.
   */
  setScreenScale(scale: number): void {
    this.config.screenScale = scale;
    this.render();
  }

  /**
   * Update one or more handle styles at runtime (e.g. theme change).
   * Any field omitted from the partial keeps its current value.
   */
  setHandleStyles(styles: {
    anchor?: HandleStyle;
    selectedAnchor?: HandleStyle;
    controlHandle?: HandleStyle;
  }): void {
    if (styles.anchor) {
      this.config.anchorStyle = resolveStyle(styles.anchor, this.config.anchorStyle);
    }
    if (styles.selectedAnchor) {
      this.config.selectedAnchorStyle = resolveStyle(styles.selectedAnchor, this.config.selectedAnchorStyle);
    }
    if (styles.controlHandle) {
      this.config.controlHandleStyle = resolveStyle(styles.controlHandle, this.config.controlHandleStyle);
    }
    this.render();
  }

  setHandleMode(mode: HandleMode): void {
    for (const ref of this.selection.anchorRefs) {
      const shape = this.doc.getShape(ref.shapeIndex);
      shape?.path.setHandleMode(ref.anchorIndex, mode);
    }
    this._onModelChange();
  }

  /** Convert every anchor across every shape to the given non-straight mode,
   *  adding default tangent handles where they don't already exist so the
   *  handles are immediately draggable. Used by hosts that want "all
   *  shapes default to smooth/Mirrored" semantics (e.g. standard).
   *  No-op for anchors that are already in the requested mode AND already
   *  have handles. Triggers a single `_onModelChange` at the end so the
   *  adapter / subscribers see one consolidated update. */
  convertAllAnchorsToMode(mode: 'mirrored' | 'disconnected'): void {
    let changed = false;
    for (const shape of this.doc.shapes) {
      const anchors = shape.path.anchors;
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const needsHandles = !a.handleIn && !a.handleOut;
        if (a.handleMode !== mode || needsHandles) {
          shape.path.setHandleMode(i, mode);
          changed = true;
        }
      }
    }
    if (changed) this._onModelChange();
  }

  /** Programmatically select an anchor by (shapeIndex, anchorIndex).
   *  Pass `null` to clear the selection.
   *
   *  Use case: the host needs to re-establish a selection after
   *  `reload()` resets internal state (e.g. wrapper bounds normalize
   *  triggers a re-parse, but the user's selected anchor should persist
   *  visually so a handle drag doesn't end with the panel collapsing).
   *  Emits `onSelectionChange` + `onAnchorInfo` synchronously so subscribers
   *  see the new state in the same tick. */
  selectAnchor(target: { shapeIndex: number; anchorIndex: number } | null): void {
    if (!target) {
      this.selection = emptySelection();
    } else {
      const shape = this.doc.getShape(target.shapeIndex);
      if (!shape || !shape.path.anchors[target.anchorIndex]) {
        // Target no longer exists (e.g. anchor count shrunk on reload) —
        // fall through to empty selection rather than dangle.
        this.selection = emptySelection();
      } else {
        this.selection = {
          anchors: new Set([target.anchorIndex]),
          anchorRefs: [{ shapeIndex: target.shapeIndex, anchorIndex: target.anchorIndex }],
          activeShapeIndex: target.shapeIndex,
          activeHandle: null,
        };
      }
    }
    this._emitSelection();
    this.render();
  }

  /** Move an anchor to an absolute SVG-space position. Used by hosts that
   *  expose numeric Position inputs in a Path tool (design-tool parity).
   *  No-op if the target doesn't exist. Triggers `_onModelChange` so the
   *  adapter sees the new path data and anchor-info fires with new coords. */
  setAnchorPosition(target: { shapeIndex: number; anchorIndex: number }, x: number, y: number): void {
    const shape = this.doc.getShape(target.shapeIndex);
    if (!shape) return;
    const anchor = shape.path.anchors[target.anchorIndex];
    if (!anchor) return;
    const dx = x - anchor.point.x;
    const dy = y - anchor.point.y;
    if (dx === 0 && dy === 0) return;
    shape.path.moveAnchor(target.anchorIndex, dx, dy);
    this._onModelChange();
  }

  deleteSelected(): void {
    // Group by shape, delete in reverse anchor order
    const byShape = new Map<number, number[]>();
    for (const ref of this.selection.anchorRefs) {
      if (!byShape.has(ref.shapeIndex)) byShape.set(ref.shapeIndex, []);
      byShape.get(ref.shapeIndex)!.push(ref.anchorIndex);
    }
    for (const [si, anchors] of byShape) {
      const sorted = anchors.sort((a, b) => b - a);
      const shape = this.doc.getShape(si);
      if (shape) for (const ai of sorted) shape.path.deleteAnchor(ai);
    }
    this.selection = emptySelection();
    this._onModelChange();
  }

  // ── Pointer Events ───────────────────────────────────────────────────────

  private _handlePointerDown(e: PointerEvent): void {
    const svgPoint = this._screenToSvg(e.clientX, e.clientY);

    if (this._tool === 'pen') {
      // the reference pen toggle: clicking an EXISTING anchor while drawing SELECTS it
      // and drops into edit mode (drag it / tweak its curve via the panel). The
      // FIRST anchor (≥3) still closes the path. Empty / segment clicks extend
      // the path as before.
      const penHit = hitTestMultiShape(
        e.clientX, e.clientY, this.doc.shapes,
        this.adapter.getSvgRect(), this.adapter.getViewBox(),
        this.config.anchorHitRadius, this.config.handleHitRadius,
        this.adapter.getScreenCTM?.() ?? null,
      );
      // Dragging a curve HANDLE while in pen mode → adjust the curve, NOT add a
      // point. Set up the same drag the select tool uses; the pointer move/up now
      // fall through to the drag logic when this.dragging is set.
      if (penHit && (penHit.type === 'handleIn' || penHit.type === 'handleOut')) {
        this.dragging = true;
        this.dragStartSvg = svgPoint;
        this.dragShapeIndex = penHit.shapeIndex;
        this.dragType = penHit.type;
        this.dragAnchorIndex = penHit.anchorIndex;
        this.selection = {
          anchors: new Set([penHit.anchorIndex]),
          anchorRefs: [{ shapeIndex: penHit.shapeIndex, anchorIndex: penHit.anchorIndex }],
          activeShapeIndex: penHit.shapeIndex,
          activeHandle: { shapeIndex: penHit.shapeIndex, anchorIndex: penHit.anchorIndex, type: penHit.type === 'handleIn' ? 'in' : 'out' },
        };
        this._emitSelection();
        this.render();
        e.preventDefault();
        return;
      }
      if (penHit && penHit.type === 'anchor') {
        const shape = this.doc.getShape(penHit.shapeIndex);
        const n = shape ? shape.path.anchors.length : 0;
        const isLastPen = penHit.anchorIndex === n - 1;
        if (penHit.anchorIndex === 0 && n >= 3) {
          // Close the path. Pass the EXACT start point, not the raw click:
          // PenTool only closes when the click is within 5 viewBox units of the
          // first anchor, but the editor's anchor hit-radius (screen space, what
          // drives the magnetise preview) is wider — so a click that magnetised
          // could still miss PenTool's threshold and add a point instead. Snapping
          // to the start makes the close fire whenever the editor says we hit it.
          const startPt = shape?.path.anchors[0]?.point ?? svgPoint;
          this.penTool.onPointerDown(startPt);
        } else if (isLastPen) {
          // Clicking the ACTIVE endpoint while drawing must NOT drop to select
          // mode (the pen owns this point). A DOUBLE-click toggles its curve and
          // STAYS in pen mode, so hovering away keeps drawing. A single click is
          // a no-op (just arms the double-click timer).
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          const lc = this._lastAnchorClick;
          const isRepeat = !!lc && lc.shapeIndex === penHit.shapeIndex && lc.anchorIndex === penHit.anchorIndex && now - lc.time < 350;
          if (isRepeat) {
            this._lastAnchorClick = null;
            const cm = shape?.path.anchors[penHit.anchorIndex]?.handleMode;
            const nm: HandleMode = cm === 'mirrored' ? 'straight' : 'mirrored';
            this.selection = {
              anchors: new Set([penHit.anchorIndex]),
              anchorRefs: [{ shapeIndex: penHit.shapeIndex, anchorIndex: penHit.anchorIndex }],
              activeShapeIndex: penHit.shapeIndex,
              activeHandle: null,
            };
            this.setHandleMode(nm); // toggle curve; tool stays 'pen'
            this._emitSelection();
          } else {
            this._lastAnchorClick = { shapeIndex: penHit.shapeIndex, anchorIndex: penHit.anchorIndex, time: now };
            // Single click also ARMS a drag so the endpoint can be repositioned
            // just like the other anchors (the pen previously swallowed it,
            // leaving the active endpoint un-draggable). A click with no movement
            // leaves the point untouched and the double-click timer above intact;
            // a real drag moves it. pointer move/up fall through to the shared
            // drag path (guarded on this.dragging) and STAY in pen mode.
            this.dragging = true;
            this.dragStartSvg = svgPoint;
            this.dragShapeIndex = penHit.shapeIndex;
            this.dragType = 'anchor';
            this.dragAnchorIndex = penHit.anchorIndex;
            this.selection = {
              anchors: new Set([penHit.anchorIndex]),
              anchorRefs: [{ shapeIndex: penHit.shapeIndex, anchorIndex: penHit.anchorIndex }],
              activeShapeIndex: penHit.shapeIndex,
              activeHandle: null,
            };
            this._emitSelection();
            this.render();
          }
        } else {
          // A MIDDLE vertex → select it + drop into edit/select mode.
          this.selection = {
            anchors: new Set([penHit.anchorIndex]),
            anchorRefs: [{ shapeIndex: penHit.shapeIndex, anchorIndex: penHit.anchorIndex }],
            activeShapeIndex: penHit.shapeIndex,
            activeHandle: null,
          };
          this.setTool('select');
          this._onModelChange();
          this._emitSelection();
        }
        e.preventDefault();
        return;
      }
      this.penTool.onPointerDown(svgPoint);
      e.preventDefault();
      return;
    }

    const hit = hitTestMultiShape(
      e.clientX, e.clientY, this.doc.shapes,
      this.adapter.getSvgRect(), this.adapter.getViewBox(),
      this.config.anchorHitRadius, this.config.handleHitRadius,
      this.adapter.getScreenCTM?.() ?? null,
    );

    if (!hit) {
      // Empty-space click in SELECT mode → let the host exit/commit the session
      // (pen-creation: this is "click away to finish the drawn path"). The host
      // decides whether to act; the editor still clears selection.
      this.config.onRequestExit?.();
      this.selection = emptySelection();
      this._emitSelection();
      this.render();
      return;
    }

    // RESUME PEN: in select mode (entered by clicking a mid-draw vertex), clicking
    // an ENDPOINT switches back to the pen to keep drawing — the reference's "click the
    // end to continue". Clicking the LAST anchor extends from the end; clicking
    // the FIRST (start) REVERSES the path first so drawing continues from the
    // START (the pen always appends to the end, so we make the start the end).
    if (hit.type === 'anchor') {
      const endShape = this.doc.getShape(hit.shapeIndex);
      const an = endShape ? endShape.path.anchors.length : 0;
      const isLast = hit.anchorIndex === an - 1;
      const isFirst = hit.anchorIndex === 0;

      // DOUBLE-CLICK on ANY anchor (incl. endpoints) → toggle curve straight ↔
      // mirrored. Checked FIRST so the single-click endpoint-resume below can't
      // pre-empt it. Native dblclick is unreliable (the anchor re-renders), so we
      // time the repeat manually.
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const lc = this._lastAnchorClick;
      const isRepeat = !!lc && lc.shapeIndex === hit.shapeIndex && lc.anchorIndex === hit.anchorIndex && now - lc.time < 350;
      if (isRepeat) {
        if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
        this._lastAnchorClick = null;
        const curMode = endShape?.path.anchors[hit.anchorIndex]?.handleMode;
        const nextMode: HandleMode = curMode === 'mirrored' ? 'straight' : 'mirrored';
        this.selection = { anchors: new Set([hit.anchorIndex]), anchorRefs: [{ shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex }], activeShapeIndex: hit.shapeIndex, activeHandle: null };
        this.setHandleMode(nextMode);
        this._emitSelection();
        e.preventDefault();
        return;
      }
      this._lastAnchorClick = { shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex, time: now };

      // EDIT-mode CLOSE: re-opening a committed OPEN path (NOT a live pen
      // session), clicking its START or END vertex connects the two loose ends —
      // the reference's "click an endpoint of an unfinished path to close it". A finished
      // open path can't be continued; the one endpoint gesture left is to close
      // it. Needs ≥3 points to form a real shape; other vertices fall through to
      // select/drag below.
      if (!this.allowResumePen && endShape && !endShape.path.closed && an >= 3 && (isLast || isFirst)) {
        endShape.path.closePath();
        this.selection = { anchors: new Set([hit.anchorIndex]), anchorRefs: [{ shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex }], activeShapeIndex: hit.shapeIndex, activeHandle: null };
        this._onModelChange();
        this._emitSelection();
        e.preventDefault();
        return;
      }

      // SINGLE-click an ENDPOINT → resume the pen, but DELAYED so a double-click
      // can cancel it (toggling the endpoint's curve instead). Select it now for
      // feedback; the timer resumes pen (reversing first when the START was hit).
      //
      // Resume only inside a LIVE pen-creation session. After a path is committed
      // and re-opened for editing (allowResumePen=false), clicking a vertex must
      // EDIT it, not re-enter the pen — the reference's behaviour: a finished path can't
      // be "continued", you edit its vertices. A CLOSED path also has no open end
      // to resume. Either way the click falls through to select/drag the vertex.
      const isClosedPath = !!endShape && endShape.path.closed;
      if (this.allowResumePen && an >= 2 && !isClosedPath && (isLast || isFirst)) {
        this.selection = { anchors: new Set([hit.anchorIndex]), anchorRefs: [{ shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex }], activeShapeIndex: hit.shapeIndex, activeHandle: null };
        this._emitSelection();
        this.render();
        if (this._resumeTimer) clearTimeout(this._resumeTimer);
        this._resumeTimer = setTimeout(() => {
          this._resumeTimer = null;
          if (isFirst && !isLast && endShape) endShape.path.reverse();
          this.setTool('pen');
          this._onModelChange();
        }, 280);
        e.preventDefault();
        return;
      }
      // Middle anchor: fall through to the drag setup below (its double-click is
      // handled by the isRepeat check above).
    }

    // Segment interaction:
    //   Plain click → split (add a new anchor at the hover point). Matches
    //     the cyan `+` hover indicator that already says "click to add
    //     point" — the standard pen-edit convention in the reference / Figma.
    //   Alt+click → select all anchors of that shape and drag the whole
    //     sub-path. Moved off plain click because the previous binding
    //     contradicted the visual cue: users saw the `+` indicator,
    //     clicked, and the entire shape started dragging instead of
    //     splitting. Segment-as-drag-handle is the less common / power-
    //     user interaction; gating it behind Alt is the safer default.
    if (hit.type === 'segment') {
      if (e.altKey) {
        // Select entire shape for dragging.
        this._selectWholeShape(hit.shapeIndex);
        this.dragging = true;
        this.dragStartSvg = svgPoint;
        this.dragType = 'anchor';
        this.dragShapeIndex = hit.shapeIndex;
        this.dragAnchorIndex = -1; // all anchors
        this._emitSelection();
        this.render();
      } else {
        // Split segment — insert a new anchor at the hover position and
        // select it so the user can immediately drag it / tweak handles.
        const shape = this.doc.getShape(hit.shapeIndex);
        if (shape) {
          const newIdx = shape.path.splitSegment(hit.anchorIndex, hit.t);
          if (newIdx >= 0) {
            this.selection = {
              anchors: new Set([newIdx]),
              anchorRefs: [{ shapeIndex: hit.shapeIndex, anchorIndex: newIdx }],
              activeShapeIndex: hit.shapeIndex,
              activeHandle: null,
            };
            this.hoveredSegment = null;
            this._onModelChange();
            this._emitSelection();
          }
        }
      }
      e.preventDefault();
      return;
    }

    this.dragging = true;
    this.dragStartSvg = svgPoint;
    this.dragShapeIndex = hit.shapeIndex;

    if (hit.type === 'anchor') {
      this.dragType = 'anchor';
      this.dragAnchorIndex = hit.anchorIndex;
      const ref: AnchorRef = { shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex };

      if (e.shiftKey) {
        // Toggle in selection
        const refs = [...this.selection.anchorRefs];
        const existIdx = refs.findIndex(r => r.shapeIndex === ref.shapeIndex && r.anchorIndex === ref.anchorIndex);
        if (existIdx >= 0) refs.splice(existIdx, 1);
        else refs.push(ref);
        this.selection = {
          anchors: new Set(refs.filter(r => r.shapeIndex === hit.shapeIndex).map(r => r.anchorIndex)),
          anchorRefs: refs,
          activeShapeIndex: hit.shapeIndex,
          activeHandle: null,
        };
      } else {
        const alreadySelected = this.selection.anchorRefs.some(
          r => r.shapeIndex === ref.shapeIndex && r.anchorIndex === ref.anchorIndex
        );
        if (!alreadySelected) {
          this.selection = {
            anchors: new Set([hit.anchorIndex]),
            anchorRefs: [ref],
            activeShapeIndex: hit.shapeIndex,
            activeHandle: null,
          };
        }
      }
    } else if (hit.type === 'handleIn' || hit.type === 'handleOut') {
      this.dragType = hit.type;
      this.dragAnchorIndex = hit.anchorIndex;
      const ref: AnchorRef = { shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex };
      this.selection = {
        anchors: new Set([hit.anchorIndex]),
        anchorRefs: [ref],
        activeShapeIndex: hit.shapeIndex,
        activeHandle: {
          shapeIndex: hit.shapeIndex,
          anchorIndex: hit.anchorIndex,
          type: hit.type === 'handleIn' ? 'in' : 'out',
        },
      };
    }

    this._emitSelection();
    this.render();
    e.preventDefault();
  }

  private _handlePointerMove(e: PointerEvent): void {
    const svgPoint = this._screenToSvg(e.clientX, e.clientY);

    // In pen mode, the pen owns moves UNLESS we're dragging a curve handle/anchor
    // (started by clicking a handle in pen mode) — then fall through to the drag
    // logic so the handle moves instead of the pen previewing a new segment.
    if (this._tool === 'pen' && !this.dragging) {
      const penHover = hitTestMultiShape(
        e.clientX, e.clientY, this.doc.shapes,
        this.adapter.getSvgRect(), this.adapter.getViewBox(),
        this.config.anchorHitRadius, this.config.handleHitRadius,
        this.adapter.getScreenCTM?.() ?? null,
      );
      // Hovering the START anchor (with ≥3 points) is the CLOSE gesture. Snap the
      // rubber-band preview to the start point ("magnetise") and KEEP it visible
      // as a solid line, so the user sees the closing segment before clicking to
      // close. (Without this it would be hidden by the reshape rule below.)
      const closeShape = penHover && penHover.type === 'anchor' && penHover.anchorIndex === 0
        ? this.doc.getShape(penHover.shapeIndex) : null;
      if (closeShape && closeShape.path.anchors.length >= 3) {
        this._penOverAnchor = false;
        this.penTool.onPointerMove(closeShape.path.anchors[0].point);
        return;
      }
      // Any OTHER anchor/handle → hide the preview: the user is reshaping
      // (select / drag / curve toggle), not extending. It reappears the moment
      // the cursor is back over empty canvas. (Drag is hidden via this.dragging.)
      this._penOverAnchor = !!penHover && (penHover.type === 'anchor' || penHover.type === 'handleIn' || penHover.type === 'handleOut');
      this.penTool.onPointerMove(svgPoint);
      return;
    }

    if (!this.dragging) {
      // Segment hover hit-test. Runs in BOTH modes:
      //  - standalone: library draws its own hover "+"-circle preview
      //  - hostRendersHandles: library skips the preview rendering but
      //    still emits the hover state via onSegmentHoverChanged so the
      //    host can render a follower circle itself.
      const hit = hitTestMultiShape(
        e.clientX, e.clientY, this.doc.shapes,
        this.adapter.getSvgRect(), this.adapter.getViewBox(),
        this.config.anchorHitRadius, this.config.handleHitRadius,
        this.adapter.getScreenCTM?.() ?? null,
      );
      const newHover = hit?.type === 'segment'
        ? { shapeIndex: hit.shapeIndex, anchorIndex: hit.anchorIndex, t: hit.t }
        : null;
      const changed = JSON.stringify(newHover) !== JSON.stringify(this.hoveredSegment);
      if (changed) {
        this.hoveredSegment = newHover;
        if (this.overlayEl) this.overlayEl.style.cursor = newHover ? 'copy' : 'default';
        // Resolve the (x, y) point on the segment for the public
        // SegmentHoverView (viewBox space).
        this._segmentHoverView = this._resolveSegmentHoverView(newHover);
        this._emitSegmentHover();
        this.render();
      }
      return;
    }

    const dx = svgPoint.x - this.dragStartSvg.x;
    const dy = svgPoint.y - this.dragStartSvg.y;

    if (this.dragType === 'anchor') {
      // Move all selected anchors
      for (const ref of this.selection.anchorRefs) {
        const shape = this.doc.getShape(ref.shapeIndex);
        shape?.path.moveAnchor(ref.anchorIndex, dx, dy);
      }
    } else if (this.dragType === 'handleIn' || this.dragType === 'handleOut') {
      const type = this.dragType === 'handleIn' ? 'in' : 'out';
      const shape = this.doc.getShape(this.dragShapeIndex);
      shape?.path.moveHandle(this.dragAnchorIndex, type, dx, dy);
    }

    this.dragStartSvg = svgPoint;
    this._onModelChange();
  }

  private _handlePointerUp(e: PointerEvent): void {
    const svgPoint = this._screenToSvg(e.clientX, e.clientY);

    // In pen mode, end a handle/anchor drag (started in pen mode) via the drag
    // path below; otherwise the pen handles the release (add point / curve).
    if (this._tool === 'pen' && !this.dragging) {
      this.penTool.onPointerUp(svgPoint);
      if (!this.penTool.state.active) {
        this._cleanupEmptyShapes();
        this.setTool('select');
      }
      return;
    }

    if (this.dragging) {
      this.dragging = false;
      this.dragType = null;
      this.selection = { ...this.selection, activeHandle: null };
      this._emitSelection();
    }
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (this._tool === 'pen') { this.penTool.finish(); this.setTool('select'); }
      else { this.selection = emptySelection(); this._emitSelection(); this.render(); }
      return;
    }
    if (e.key === 'p' || e.key === 'P') { this.setTool(this._tool === 'pen' ? 'select' : 'pen'); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.anchorRefs.length > 0) {
      e.preventDefault(); this.deleteSelected(); return;
    }
    if (e.key === '1') this.setHandleMode('straight');
    if (e.key === '2') this.setHandleMode('mirrored');
    if (e.key === '3') this.setHandleMode('disconnected');

    // Ctrl+A / Cmd+A: select all anchors in active shape
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._selectWholeShape(this.selection.activeShapeIndex);
      this._emitSelection();
      this.render();
    }
  }

  private _handleDblClick(_e: MouseEvent): void {
    // Anchor curve-toggle on double-click is handled MANUALLY in _handlePointerDown
    // (native dblclick is unreliable — the anchor SVG re-renders between clicks).
    if (this._tool === 'pen') { this.penTool.finish(); this.setTool('select'); }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _screenToSvg(screenX: number, screenY: number): Point {
    // Prefer getScreenCTM when the adapter provides it. CTM-inverse handles
    // rotation / scale on the host SVG transparently — the rect-based
    // fallback below assumes an axis-aligned host and falls apart for
    // rotated shapes.
    if (this.adapter.getScreenCTM) {
      const ctm = this.adapter.getScreenCTM();
      if (ctm) {
        try {
          const inv = ctm.inverse();
          const p = inv.transformPoint(new DOMPoint(screenX, screenY));
          return { x: p.x, y: p.y };
        } catch { /* singular — fall through */ }
      }
    }
    return screenToSvg(screenX, screenY, this.adapter.getSvgRect(), this.adapter.getViewBox());
  }

  private _onModelChange(): void {
    if (this.multiShapeMode) {
      const svg = this.doc.serializeSvg();
      this.adapter.setSvgContent?.(svg);
    } else {
      const d = this.doc.shapes[0]?.path.serialize() ?? '';
      this.adapter.setPathData(d);
    }
    this.config.onChange?.(this.doc.shapes[0]?.path.serialize() ?? '');
    this._emitAnchorInfo();
    this._emitAnchorsChanged();
    this.render();
  }

  private _emitSelection(): void {
    this.config.onSelectionChange?.(this.selection);
    this._emitAnchorInfo();
    this._emitAnchorsChanged();
  }

  private _emitAnchorInfo(): void {
    if (this.selection.anchorRefs.length === 1) {
      const ref = this.selection.anchorRefs[0];
      const shape = this.doc.getShape(ref.shapeIndex);
      const anchor = shape?.path.anchors[ref.anchorIndex];
      if (anchor) {
        this.config.onAnchorInfo?.({
          shapeIndex: ref.shapeIndex,
          anchorIndex: ref.anchorIndex,
          x: Math.round(anchor.point.x * 10) / 10,
          y: Math.round(anchor.point.y * 10) / 10,
          handleMode: anchor.handleMode,
        });
        return;
      }
    }
    this.config.onAnchorInfo?.(null);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  render(): void {
    if (!this.overlayEl) return;

    const viewBox = this.doc.viewBox;
    const shapes = this.doc.shapes;
    const penState = this.penTool.state;

    this.overlayEl.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);

    // Convert screen pixels → viewBox units. With preserveAspectRatio="none"
    // on the overlay (so anchor positions track the host SVG's stretched
    // path projection), the X and Y ratios DIFFER on aspect-mismatched
    // viewBoxes. Computing each axis separately and passing both to
    // `buildAnchorMarkup` lets it draw anchors as ellipses with X/Y-
    // compensated rx/ry, producing visually-CIRCULAR handles in screen
    // space even under heavy aspect distortion. The averaged `pxToVb`
    // is kept for callers that still want a single scalar (preview lines,
    // stroke widths on non-handle decorations).
    const svgRect = this.adapter.getSvgRect();
    const pxToVbX = svgRect.width > 0 ? viewBox.width / svgRect.width : viewBox.width * 0.002;
    const pxToVbY = svgRect.height > 0 ? viewBox.height / svgRect.height : viewBox.height * 0.002;
    const pxToVb = (pxToVbX + pxToVbY) / 2;
    const ss = this.config.screenScale;

    // Resolved styles for this render pass.
    const aStyle = this.config.anchorStyle;
    const sStyle = this.config.selectedAnchorStyle;
    const hStyle = this.config.controlHandleStyle;

    // Default stroke-width (in viewBox units) for non-handle decorative lines
    // — keeps preview lines, segment highlights, etc. visually sized in screen px.
    const sw = 1 * ss * pxToVb;
    // Hover/preview circle radii (also screen-px sized).
    const previewR = (aStyle.size * ss * pxToVb) / 2;

    // Track which anchors are selected (by shape+anchor)
    const selectedSet = new Set(
      this.selection.anchorRefs.map(r => `${r.shapeIndex}:${r.anchorIndex}`)
    );

    let html = '';

    // ── Pen tool previews ──────────────────────────────────────────────
    // Suppress the rubber-band preview while reshaping: during an anchor/handle
    // drag (this.dragging) or while hovering an existing anchor/handle
    // (_penOverAnchor). It returns over empty canvas. The handle-drag preview
    // below (penState.dragging) is a different gesture and stays visible.
    if (penState.active) {
      const showPreview = !this.dragging && !this._penOverAnchor;
      if (showPreview && penState.previewLine) {
        const { from, to } = penState.previewLine;
        html += `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#2680EB" stroke-width="${sw}"/>`;
      }
      if (showPreview && penState.previewCurve) {
        const { from, cp1, cp2, to } = penState.previewCurve;
        html += `<path d="M${from.x},${from.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${to.x},${to.y}" fill="none" stroke="#2680EB" stroke-width="${sw}"/>`;
      }
      if (penState.dragging && penState.currentPoint && penState.handleOut) {
        const cp = penState.currentPoint;
        const hOut = { x: cp.x + penState.handleOut.x, y: cp.y + penState.handleOut.y };
        const hIn = { x: cp.x - penState.handleOut.x, y: cp.y - penState.handleOut.y };
        html += `<line x1="${hIn.x}" y1="${hIn.y}" x2="${hOut.x}" y2="${hOut.y}" stroke="#2680EB" stroke-width="${sw}" opacity="0.6"/>`;
        html += buildAnchorMarkup(hOut.x, hOut.y, hStyle, pxToVb, ss, pxToVbX, pxToVbY);
        html += buildAnchorMarkup(hIn.x, hIn.y, hStyle, pxToVb, ss, pxToVbX, pxToVbY);
        html += buildAnchorMarkup(cp.x, cp.y, aStyle, pxToVb, ss, pxToVbX, pxToVbY);
      }
    }

    // ── Hovered segment highlight ────────────────────────────────────────
    // Suppressed when the host renders handles — the host draws its own
    // persistent midpoint dots, so the library's hover-preview "+" dot
    // would be redundant AND would conflict with the host's handle layer.
    if (this.hoveredSegment && this._tool === 'select' && !this.config.hostRendersHandles) {
      const { shapeIndex, anchorIndex, t } = this.hoveredSegment;
      const shape = shapes[shapeIndex];
      if (shape) {
        const anchors = shape.path.anchors;
        const prevA = anchors[anchorIndex - 1];
        const currA = anchors[anchorIndex];
        if (prevA && currA) {
          // Highlight the segment
          if (currA.handleIn || prevA.handleOut) {
            const cp1 = prevA.handleOut
              ? { x: prevA.point.x + prevA.handleOut.x, y: prevA.point.y + prevA.handleOut.y }
              : prevA.point;
            const cp2 = currA.handleIn
              ? { x: currA.point.x + currA.handleIn.x, y: currA.point.y + currA.handleIn.y }
              : currA.point;
            html += `<path d="M${prevA.point.x},${prevA.point.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${currA.point.x},${currA.point.y}" fill="none" stroke="#22d3ee" stroke-width="${sw * 3}" stroke-linecap="round"/>`;
          } else {
            html += `<line x1="${prevA.point.x}" y1="${prevA.point.y}" x2="${currA.point.x}" y2="${currA.point.y}" stroke="#22d3ee" stroke-width="${sw * 3}" stroke-linecap="round"/>`;
          }

          // Preview dot with +
          let hoverPoint: Point;
          if (currA.handleIn || prevA.handleOut) {
            const cp1 = prevA.handleOut
              ? { x: prevA.point.x + prevA.handleOut.x, y: prevA.point.y + prevA.handleOut.y }
              : prevA.point;
            const cp2 = currA.handleIn
              ? { x: currA.point.x + currA.handleIn.x, y: currA.point.y + currA.handleIn.y }
              : currA.point;
            hoverPoint = pointOnCubic(prevA.point, cp1, cp2, currA.point, t);
          } else {
            hoverPoint = pointOnLine(prevA.point, currA.point, t);
          }
          // Use ellipse with X/Y-compensated radii so the segment-hover
          // preview stays visually circular under preserveAspectRatio="none".
          const previewSize = aStyle.size * ss * 0.5; // screen px
          const prx = previewSize * pxToVbX;
          const pry = previewSize * pxToVbY;
          html += `<ellipse cx="${hoverPoint.x}" cy="${hoverPoint.y}" rx="${prx}" ry="${pry}" fill="#2680EB" fill-opacity="0.5" stroke="white" stroke-width="${sw * 1.5}"/>`;
          const plusX = prx * 0.5;
          const plusY = pry * 0.5;
          html += `<line x1="${hoverPoint.x - plusX}" y1="${hoverPoint.y}" x2="${hoverPoint.x + plusX}" y2="${hoverPoint.y}" stroke="white" stroke-width="${sw * 0.8}"/>`;
          html += `<line x1="${hoverPoint.x}" y1="${hoverPoint.y - plusY}" x2="${hoverPoint.x}" y2="${hoverPoint.y + plusY}" stroke="white" stroke-width="${sw * 0.8}"/>`;
        }
      }
    }

    // ── Handle lines + dots (per shape) ────────────────────────────────
    // Active handle uses controlHandle style with fill swapped to highlight color.
    // Skipped entirely when the host renders handles — host draws both the
    // anchor circles and the control-handle dots + connector lines itself.
    const activeHandleStyle: ResolvedHandleStyle = { ...hStyle, fill: '#FF6B35' };

    if (!this.config.hostRendersHandles) {
      for (let s = 0; s < shapes.length; s++) {
        if (!shapes[s].visible) continue;
        const anchors = shapes[s].path.anchors;

        for (let i = 0; i < anchors.length; i++) {
          const a = anchors[i];
          const selected = selectedSet.has(`${s}:${i}`);
          if (!selected) continue;

          if (a.handleIn) {
            const hx = a.point.x + a.handleIn.x;
            const hy = a.point.y + a.handleIn.y;
            html += `<line x1="${hx}" y1="${hy}" x2="${a.point.x}" y2="${a.point.y}" stroke="${hStyle.stroke}" stroke-width="${sw}" opacity="0.5"/>`;
            const isActive = this.selection.activeHandle?.shapeIndex === s && this.selection.activeHandle?.anchorIndex === i && this.selection.activeHandle?.type === 'in';
            html += buildAnchorMarkup(hx, hy, isActive ? activeHandleStyle : hStyle, pxToVb, ss, pxToVbX, pxToVbY);
          }
          if (a.handleOut) {
            const hx = a.point.x + a.handleOut.x;
            const hy = a.point.y + a.handleOut.y;
            html += `<line x1="${a.point.x}" y1="${a.point.y}" x2="${hx}" y2="${hy}" stroke="${hStyle.stroke}" stroke-width="${sw}" opacity="0.5"/>`;
            const isActive = this.selection.activeHandle?.shapeIndex === s && this.selection.activeHandle?.anchorIndex === i && this.selection.activeHandle?.type === 'out';
            html += buildAnchorMarkup(hx, hy, isActive ? activeHandleStyle : hStyle, pxToVb, ss, pxToVbX, pxToVbY);
          }
        }
      }

      // ── Anchor dots (on top, per shape) ────────────────────────────────
      for (let s = 0; s < shapes.length; s++) {
        if (!shapes[s].visible) continue;
        const anchors = shapes[s].path.anchors;

        for (let i = 0; i < anchors.length; i++) {
          const a = anchors[i];
          const selected = selectedSet.has(`${s}:${i}`);
          html += buildAnchorMarkup(a.point.x, a.point.y, selected ? sStyle : aStyle, pxToVb, ss, pxToVbX, pxToVbY);
        }
      }
    }
    // Suppress "unused style" warnings when handles are host-rendered.
    void activeHandleStyle; void aStyle; void sStyle;

    this.overlayEl.innerHTML = html;
  }
}
