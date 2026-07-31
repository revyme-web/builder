/** A 2D point. */
export interface Point {
  x: number;
  y: number;
}

/** How bezier handles behave when dragged. */
export type HandleMode = 'straight' | 'mirrored' | 'disconnected';

/** An anchor point on a path with optional bezier control handles. */
export interface Anchor {
  /** Index in the command array */
  index: number;
  /** Position of the anchor point */
  point: Point;
  /** Incoming bezier control handle (relative to point). Null = no handle. */
  handleIn: Point | null;
  /** Outgoing bezier control handle (relative to point). Null = no handle. */
  handleOut: Point | null;
  /** Handle constraint mode */
  handleMode: HandleMode;
}

/** Active editor tool. */
export type EditorTool = 'select' | 'pen';

/** A reference to a specific anchor across multiple shapes. */
export interface AnchorRef {
  shapeIndex: number;
  anchorIndex: number;
}

/** What the user has selected in the path editor. */
export interface PathSelection {
  /** Selected anchor indices (single shape mode — for backward compat) */
  anchors: Set<number>;
  /** Selected anchors across all shapes (multi-shape mode) */
  anchorRefs: AnchorRef[];
  /** Which shape is currently active (for pen tool, handle mode, etc.) */
  activeShapeIndex: number;
  /** If dragging a handle: which anchor + which handle */
  activeHandle: { shapeIndex: number; anchorIndex: number; type: 'in' | 'out' } | null;
}

/** Hit test result when clicking on the path overlay. */
export type HitResult =
  | { type: 'anchor'; shapeIndex: number; anchorIndex: number }
  | { type: 'handleIn'; shapeIndex: number; anchorIndex: number }
  | { type: 'handleOut'; shapeIndex: number; anchorIndex: number }
  | { type: 'segment'; shapeIndex: number; anchorIndex: number; t: number }
  | null;

/** Adapter interface — how the editor reads/writes SVG data. */
export interface SvgEditorAdapter {
  /** Get the SVG path `d` attribute string (single path mode). */
  getPathData(): string;
  /** Write the updated `d` attribute string back (single path mode). */
  setPathData(d: string): void;
  /** Get full SVG markup (multi-shape mode). Return empty string if single path. */
  getSvgContent?(): string;
  /** Write full SVG markup back (multi-shape mode). */
  setSvgContent?(svg: string): void;
  /** Get the SVG viewBox dimensions. */
  getViewBox(): { x: number; y: number; width: number; height: number };
  /** Get the screen-space bounding rect of the SVG element (for overlay positioning). */
  getSvgRect(): { left: number; top: number; width: number; height: number };
  /** Optional: DOMMatrix mapping SVG user-space → screen, INCLUDING any
   *  CSS transforms applied to the host SVG (rotate, scale, etc.). When
   *  provided, the library uses this matrix for screen↔user-space coord
   *  conversion instead of the rect-based linear mapping — anchor handles
   *  then render at correct screen positions on rotated SVG elements and
   *  pointer hit-tests work in the rotated frame. Return `null` (or omit)
   *  to fall back to the rect-based path. */
  getScreenCTM?(): DOMMatrix | null;
}

/**
 * Visual style for an editor handle (anchor or control point).
 *
 * Sizes are in *screen pixels* — the renderer converts to viewBox units
 * using the current `getSvgRect()` ratio so handles look consistent
 * regardless of the path's natural coordinate range.
 */
export interface HandleStyle {
  /** Diameter in screen px. */
  size?: number;
  /** Fill color (any CSS color). */
  fill?: string;
  /** Stroke color. */
  stroke?: string;
  /** Stroke width in screen px. */
  strokeWidth?: number;
}

/** Configuration for the SVG editor. */
export interface SvgEditorConfig {
  adapter: SvgEditorAdapter;
  /** Hit radius for anchor points (px). Default: 6 */
  anchorHitRadius?: number;
  /** Hit radius for control handles (px). Default: 5 */
  handleHitRadius?: number;
  /** Snap to grid size. 0 = no snap. Default: 0 */
  gridSnap?: number;
  /**
   * Visual style for unselected anchor dots.
   * Defaults: { size: 8, fill: 'white', stroke: '#2680EB', strokeWidth: 1.5 }
   */
  anchorStyle?: HandleStyle;
  /**
   * Visual style for selected anchor dots.
   * Defaults: { size: 10, fill: '#2680EB', stroke: 'white', strokeWidth: 1.5 }
   */
  selectedAnchorStyle?: HandleStyle;
  /**
   * Visual style for bezier control-point handles.
   * Defaults: { size: 7, fill: '#2680EB', stroke: 'white', strokeWidth: 1 }
   */
  controlHandleStyle?: HandleStyle;
  /**
   * Screen-space scale factor applied to handle visuals only (NOT path).
   * Pass `1 / canvasZoom` from the host so handles stay constant size
   * when the host canvas is zoomed in. Default: 1.
   */
  screenScale?: number;
  /** Callback when path data changes */
  onChange?: (d: string) => void;
  /** Callback when selection changes */
  onSelectionChange?: (selection: PathSelection) => void;
  /** Callback when tool changes */
  onToolChange?: (tool: EditorTool) => void;
  /** Callback when anchor info changes (for properties panel) */
  onAnchorInfo?: (info: AnchorInfo | null) => void;
  /** Called when the user clicks empty space while in SELECT mode — the host may
   *  use it to exit/commit the edit session (e.g. pen-creation: click-away ends
   *  the draw). The editor still clears its selection regardless. */
  onRequestExit?: () => void;
  /**
   * If true, the editor will NOT render anchor circles or control-point
   * handles inside its own SVG overlay. The host is expected to render
   * them as absolutely-positioned overlay divs (in screen space) and
   * forward pointerdown events via `beginDragAnchor` / `beginDragHandle`.
   *
   * The library still renders: segment highlights, pen-tool previews,
   * and continues to track pointermove / pointerup on the window for
   * delegated drags. Default: false.
   */
  hostRendersHandles?: boolean;
  /** Callback fired whenever the anchor set or their positions change. */
  onAnchorsChanged?: (anchors: AnchorView[]) => void;
}

/** Info about the selected anchor for external UI (properties panel). */
export interface AnchorInfo {
  shapeIndex: number;
  anchorIndex: number;
  x: number;
  y: number;
  handleMode: HandleMode;
}

/**
 * View model for a single anchor — emitted to the host when
 * `hostRendersHandles` is enabled so the host can render handle divs
 * in screen-space (mirroring SelectionOverlay's resize handles).
 *
 * Coordinates are in SVG/viewBox space. The host converts to screen px
 * via its existing shape-screen-rect math.
 */
export interface AnchorView {
  /** Stable id within this editor instance. Format: `${shapeIndex}:${anchorIndex}`. */
  id: string;
  shapeIndex: number;
  anchorIndex: number;
  /** Anchor point in viewBox space. */
  x: number;
  y: number;
  /** Is this anchor currently selected? Selected handles get bigger styling. */
  selected: boolean;
  /** Incoming bezier control handle in viewBox space (absolute — not relative). */
  inHandle?: { x: number; y: number };
  /** Outgoing bezier control handle in viewBox space (absolute — not relative). */
  outHandle?: { x: number; y: number };
  /** Is this active handle currently being dragged? (For highlighting.) */
  activeInHandle?: boolean;
  activeOutHandle?: boolean;
}

/**
 * View model for a single edge midpoint (the "insert anchor" dot drawn
 * between two consecutive anchors). Emitted when `hostRendersHandles`
 * is enabled so the host can render its own midpoint dots in screen
 * space (constant size regardless of canvas zoom).
 *
 * Coordinates are in SVG/viewBox space. Host converts to screen px via
 * the same mapping it uses for `AnchorView`s.
 *
 * Stable id format: `${shapeIndex}:${endAnchorIndex}` where
 * `endAnchorIndex` is the END anchor of the segment (matches the shape
 * of `PathModel.splitSegment`). For a closed path's wrap-around edge
 * (last anchor → first anchor), `endAnchorIndex === anchors.length`
 * (a sentinel the editor uses to dispatch into the closing-segment
 * split path).
 */
export interface EdgeMidpointView {
  id: string;
  shapeIndex: number;
  /**
   * END anchor index of the segment (for open edges, 1..n-1). For the
   * closing wrap-edge of a closed path, this equals `anchors.length`.
   */
  endAnchorIndex: number;
  /** Midpoint x in viewBox space. */
  x: number;
  /** Midpoint y in viewBox space. */
  y: number;
}

/**
 * View model for the single "segment hover" point — the circle that
 * follows the cursor along whichever segment is currently hovered.
 * Emitted continuously during pointermove (when `hostRendersHandles` is
 * enabled) so the host can render a follower circle in screen space.
 *
 * Coordinates are in SVG/viewBox space. Null when the cursor is not
 * over any segment.
 */
export interface SegmentHoverView {
  shapeIndex: number;
  /** END anchor index of the hovered segment (matches splitSegment's input + 1). */
  endAnchorIndex: number;
  /** Point on the segment closest to the cursor (viewBox space). */
  x: number;
  y: number;
  /** Parametric position along the segment (0..1). */
  t: number;
}
