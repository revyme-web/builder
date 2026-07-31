// grid-cell-resolver.ts — Resolves CSS Grid cell positions, occupancy, and
// placement swaps for `GridDragStrategy`. Bridge-adapted port of the old
// `revyme-old/revyme-new/canvas-dnd/src/core/GridCellResolver.ts`.
//
// What it does:
//   - Parses the resolved grid template (track sizes + gaps) from the
//     parent's computed styles via the bridge.
//   - Reads each child's INLINE `gridColumn`/`gridRow`/`gridArea` from
//     the NodeMap (the inline styles are the source of truth for the
//     authored grid placement — computed styles only carry the resolved
//     line numbers after auto-placement, which is what we need for
//     occupancy detection but not for round-tripping the values to file).
//   - Builds a cell-occupancy map (`"col,row" → nodeId`) including spans.
//   - Provides mouse→cell detection (`getCellAtPoint`), item lookup
//     (`getItemAtCell`), and explicit-placement swap math
//     (`computeGridSwap`).
//
// Differences from the old DOM-based version:
//   - `getComputedStyle(el)` → `findNodeComputedStyles(nodeId, vpId, props)`.
//   - `el.style.gridColumn` → `node.styles?.gridColumn` (NodeMap).
//   - `el.getBoundingClientRect()` → `findNodeRect(nodeId, vpId)` (for
//     auto-placement detection fallback).
//   - All reads scoped to a viewport prefix; pixel coordinates returned
//     by `findNodeRect` are screen-space, so the strategy converts to
//     parent-local + unscaled via the existing transform.
//
// Pure functions (`parseTrackList`, `parseGridInfo` internals) port
// verbatim — no adaptation needed; they don't touch the DOM.

import type { NodeMap } from '@/shared/types';
import { findNodeRect, findNodeComputedStyles, findNodeComputedStyle } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GridPlacement {
  /** Inline `grid-column` value (e.g. `"1 / 3"`), or `""` if auto-placed. */
  gridColumn: string;
  gridRow: string;
  gridArea: string;
  /** Resolved start/end track indices (1-based). End is exclusive. */
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
}

export interface GridInfo {
  /** Resolved column track sizes in px. */
  columns: number[];
  /** Resolved row track sizes in px. */
  rows: number[];
  /** Column gap in px. */
  columnGap: number;
  /** Row gap in px. */
  rowGap: number;
  /** Cell boundaries, keyed `"col,row"` → `{ left, top, width, height }`
   *  relative to the grid container's content box (after padding). */
  cellRects: Map<string, { left: number; top: number; width: number; height: number }>;
  /** Cell occupancy, keyed `"col,row"` → `nodeId`. Spanning items
   *  populate every cell they cover. */
  cellOccupancy: Map<string, string>;
  /** Each item's resolved placement (both inline string AND parsed line
   *  numbers — see `GridPlacement`). */
  itemPlacements: Map<string, GridPlacement>;
  /** True if ANY child has an inline `grid-column`/`grid-row`/`grid-area`
   *  with explicit lines (`/` or `span` or a name). Drives the strategy's
   *  swap-vs-reorder branch on drop. */
  hasExplicitPlacement: boolean;
}

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse resolved grid template + per-child placement for a grid container.
 *
 * `parentId` — the grid container's node id.
 * `vpId` — viewport id (e.g. `'desktop'`, `'tablet'`) for the bridge reads.
 * `childIds` — direct children to consider (caller filters out dragged
 *  nodes if they want; the resolver doesn't skip anyone on its own).
 * `nodes` — parsed NodeMap for reading inline `gridColumn`/`gridRow` values.
 */
export function parseGridInfo(
  parentId: string,
  vpId: string,
  childIds: string[],
  nodes: NodeMap,
): GridInfo {
  trace.fn('grid-cell-resolver:parseGridInfo', { parentId, vpId, childCount: childIds.length });

  // Browser computes `gridTemplateColumns` / `gridTemplateRows` as a
  // space-separated list of resolved track sizes (e.g. "120px 80px 120px").
  // We read both, plus the explicit column/row gaps.
  const cs = findNodeComputedStyles(parentId, vpId, [
    'gridTemplateColumns', 'gridTemplateRows', 'columnGap', 'rowGap',
  ]);
  const columns = parseTrackList(cs['gridTemplateColumns'] || '');
  const rows = parseTrackList(cs['gridTemplateRows'] || '');
  const columnGap = parseFloat(cs['columnGap'] || '0') || 0;
  const rowGap = parseFloat(cs['rowGap'] || '0') || 0;

  // Build cell boundary rects relative to the container's content box.
  // The strategy converts mouse coords into this space before calling
  // `getCellAtPoint` — see `GridDragStrategy.onMove`.
  const cellRects = new Map<string, { left: number; top: number; width: number; height: number }>();
  let y = 0;
  for (let r = 0; r < rows.length; r++) {
    let x = 0;
    for (let c = 0; c < columns.length; c++) {
      cellRects.set(`${c + 1},${r + 1}`, { left: x, top: y, width: columns[c], height: rows[r] });
      x += columns[c] + columnGap;
    }
    y += rows[r] + rowGap;
  }

  // Resolve each child's placement + mark occupancy.
  const itemPlacements = new Map<string, GridPlacement>();
  const cellOccupancy = new Map<string, string>();
  let hasExplicitPlacement = false;

  for (const childId of childIds) {
    const placement = resolveItemPlacement(childId, vpId, columns, rows, columnGap, rowGap, parentId, nodes);
    if (!placement) continue;
    itemPlacements.set(childId, placement);

    // Inline grid-column / grid-row / grid-area — detect explicit
    // placement by looking for slash, span keyword, or a non-auto area.
    // Drives the swap-vs-reorder branch in `GridDragStrategy.onMove`.
    const inline = nodes.get(childId)?.styles ?? {};
    const gc = inline.gridColumn || '';
    const gr = inline.gridRow || '';
    const ga = inline.gridArea || '';
    if (gc.includes('/') || gr.includes('/') ||
        gc.includes('span') || gr.includes('span') || (ga && ga !== 'auto')) {
      hasExplicitPlacement = true;
    }

    // Mark every cell this item occupies (handles row + column spans).
    for (let c = placement.colStart; c < placement.colEnd; c++) {
      for (let r = placement.rowStart; r < placement.rowEnd; r++) {
        cellOccupancy.set(`${c},${r}`, childId);
      }
    }
  }

  return { columns, rows, columnGap, rowGap, cellRects, cellOccupancy, itemPlacements, hasExplicitPlacement };
}

/** Parse a resolved track list like `"120px 80px 120px"` → `[120, 80, 120]`. */
function parseTrackList(value: string): number[] {
  if (!value || value === 'none') return [];
  return value.split(/\s+/).map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
}

/**
 * Resolve a single item's placement.
 *
 * Computed `gridColumnStart` / `gridRowStart` always carry resolved
 * 1-based line numbers (the browser auto-places where needed), so the
 * primary read path is the bridge's computed-style cache. The BCR
 * fallback (detect-from-position) survives as a last resort for
 * containers where the browser hasn't yet committed grid layout (rare
 * timing-edge during the first lift frame).
 */
function resolveItemPlacement(
  childId: string,
  vpId: string,
  columns: number[],
  rows: number[],
  columnGap: number,
  rowGap: number,
  parentId: string,
  nodes: NodeMap,
): GridPlacement | null {
  const inline = nodes.get(childId)?.styles ?? {};
  const gridColumn = inline.gridColumn || '';
  const gridRow = inline.gridRow || '';
  const gridArea = inline.gridArea || '';

  const cs = findNodeComputedStyles(childId, vpId, [
    'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd',
  ]);
  let colStart = parseInt(cs['gridColumnStart'] || '');
  let colEnd = parseInt(cs['gridColumnEnd'] || '');
  let rowStart = parseInt(cs['gridRowStart'] || '');
  let rowEnd = parseInt(cs['gridRowEnd'] || '');

  // BCR fallback for auto-placed items the browser hasn't resolved yet.
  if (isNaN(colStart) || isNaN(rowStart)) {
    const parentRect = findNodeRect(parentId, vpId);
    const childRect = findNodeRect(childId, vpId);
    if (parentRect && childRect) {
      const padL = parseFloat(findNodeComputedStyle(parentId, vpId, 'paddingLeft') || '0') || 0;
      const padT = parseFloat(findNodeComputedStyle(parentId, vpId, 'paddingTop') || '0') || 0;
      const relX = childRect.left - parentRect.left - padL;
      const relY = childRect.top - parentRect.top - padT;
      if (isNaN(colStart)) colStart = detectTrackIndex(relX, columns, columnGap);
      if (isNaN(colEnd)) colEnd = detectTrackEnd(relX, childRect.width, columns, columnGap);
      if (isNaN(rowStart)) rowStart = detectTrackIndex(relY, rows, rowGap);
      if (isNaN(rowEnd)) rowEnd = detectTrackEnd(relY, childRect.height, rows, rowGap);
    }
  }

  // Final defaults — single-cell at (1, 1) if everything failed.
  if (isNaN(colStart)) colStart = 1;
  if (isNaN(rowStart)) rowStart = 1;
  if (isNaN(colEnd)) colEnd = colStart + 1;
  if (isNaN(rowEnd)) rowEnd = rowStart + 1;

  return { gridColumn, gridRow, gridArea, colStart, colEnd, rowStart, rowEnd };
}

/** Detect which track (1-based) an element starts in based on its position. */
function detectTrackIndex(pos: number, tracks: number[], gap: number): number {
  let x = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (pos >= x - 2 && pos <= x + tracks[i] + 2) return i + 1;
    x += tracks[i] + gap;
  }
  return 1;
}

/** Detect which track (1-based, exclusive end) an element ends at based on its position + size. */
function detectTrackEnd(pos: number, size: number, tracks: number[], gap: number): number {
  const endPos = pos + size;
  let x = 0;
  for (let i = 0; i < tracks.length; i++) {
    x += tracks[i];
    if (endPos <= x + 2) return i + 2;
    x += gap;
  }
  return tracks.length + 1;
}
