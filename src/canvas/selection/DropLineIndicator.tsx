// DropLineIndicator.tsx — Blue line showing where an element will be inserted during reorder.
// Reads from dropLineOps (module-level store). Positioned in screen-space (position: fixed).
// For column flex: horizontal line spanning parent width.
// For row flex: vertical line spanning parent height.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { findNodeRect, findVisibleChildRects, findNodeComputedStyles } from '@/canvas/node-ops';
import { SELECTION_COLOR } from '@/shared/constants';
import { dropLineOps, type DropLineInfo } from './drop-line-store';
import { trace } from '@/shared/debug-trace';

const LINE_COLOR = SELECTION_COLOR;
const LINE_WIDTH = 2;
const DOT_DIAMETER = 10;
const DOT_BORDER_WIDTH = 2;

interface LinePosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Cluster visible grid children into visual rows (same rule
 *  `grid-drop.ts::groupIntoRows` uses — two children are in the same
 *  row when their vertical centres differ by less than half of the
 *  smaller's height). Each row's children sorted by `rect.left`. */
function groupGridRowsForLine(
  children: Array<{ id: string; rect: DOMRect }>,
): Array<{ children: Array<{ id: string; rect: DOMRect }>; top: number; bottom: number }> {
  if (children.length === 0) return [];
  const sorted = [...children].sort((a, b) => a.rect.top - b.rect.top);
  const rows: Array<{ children: Array<{ id: string; rect: DOMRect }>; top: number; bottom: number }> = [];
  for (const child of sorted) {
    const childCenterY = child.rect.top + child.rect.height / 2;
    let placed = false;
    for (const row of rows) {
      const rowCenterY = (row.top + row.bottom) / 2;
      const tolerance = Math.min(child.rect.height, row.bottom - row.top) / 2;
      if (Math.abs(childCenterY - rowCenterY) <= tolerance) {
        row.children.push(child);
        row.top = Math.min(row.top, child.rect.top);
        row.bottom = Math.max(row.bottom, child.rect.bottom);
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push({ children: [child], top: child.rect.top, bottom: child.rect.bottom });
    }
  }
  for (const row of rows) row.children.sort((a, b) => a.rect.left - b.rect.left);
  return rows;
}

/** Resolve insertIndex into a row-major position (row index, col-in-row
 *  index) so the line can sit at the proper inter-cell gap. */
function calculateGridLinePosition(info: DropLineInfo, parentRect: DOMRect): LinePosition | null {
  const visible = findVisibleChildRects(info.parentId, info.vpId);
  if (visible.length === 0) {
    // Empty grid → no line to draw. Caller will return null.
    return null;
  }
  // Map insertIndex (source-order, 0..N inclusive) to a row-major
  // position. Walk the rows in visual order, accumulating the running
  // child count; the row containing `insertIndex - 1` (BEFORE) and
  // `insertIndex` (AFTER) determines whether the line is between two
  // cells in the same row (vertical) or between two rows (horizontal).
  const rows = groupGridRowsForLine(visible);
  if (rows.length === 0) return null;

  // Flatten rows row-major to get the order indices map to.
  const flat: { row: number; col: number; rect: DOMRect; id: string }[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].children.length; c++) {
      flat.push({ row: r, col: c, rect: rows[r].children[c].rect, id: rows[r].children[c].id });
    }
  }

  const before = info.insertIndex > 0 ? flat[info.insertIndex - 1] ?? null : null;
  const after = info.insertIndex < flat.length ? flat[info.insertIndex] ?? null : null;

  // Insert at very start → vertical line at first cell's left edge.
  if (!before && after) {
    const row = rows[after.row];
    return {
      left: after.rect.left - LINE_WIDTH / 2,
      top: row.top,
      width: LINE_WIDTH,
      height: row.bottom - row.top,
    };
  }
  // Insert at very end → vertical line at last cell's right edge.
  if (before && !after) {
    const row = rows[before.row];
    return {
      left: before.rect.right - LINE_WIDTH / 2,
      top: row.top,
      width: LINE_WIDTH,
      height: row.bottom - row.top,
    };
  }
  // Both exist:
  if (before && after) {
    if (before.row === after.row) {
      // Same row → vertical line in the column gap between them.
      const row = rows[before.row];
      const gapMidX = (before.rect.right + after.rect.left) / 2;
      return {
        left: gapMidX - LINE_WIDTH / 2,
        top: row.top,
        width: LINE_WIDTH,
        height: row.bottom - row.top,
      };
    }
    // Different rows → horizontal line in the row gap, spanning parent
    // width. Matches the reference "between two rows" indicator.
    const upperRow = rows[before.row];
    const lowerRow = rows[after.row];
    const gapMidY = (upperRow.bottom + lowerRow.top) / 2;
    return {
      left: parentRect.left,
      top: gapMidY - LINE_WIDTH / 2,
      width: parentRect.width,
      height: LINE_WIDTH,
    };
  }
  return null;
}

/** Calculate the screen-space position of the drop line using bridge helpers. */
function calculateLinePosition(info: DropLineInfo): LinePosition | null {
  const parentRect = findNodeRect(info.parentId, info.vpId);
  if (!parentRect) return null;

  // Get layout direction via bridge
  const cs = findNodeComputedStyles(info.parentId, info.vpId, ['display', 'flexDirection', 'flex-direction', 'gridAutoFlow', 'grid-auto-flow']);
  const display = cs['display'] || '';

  // ── Grid parent: row-major 2D gap layout ──────────────────────────
  // Group visible children into visual rows and use `info.insertIndex`
  // to pick the gap BEFORE the child at that source-order position.
  // The line sits in the actual inter-cell gap (vertical between two
  // cells in the same row, horizontal between two rows) — same gap
  // `calculateGridDrop` picked in the strategy, so geometry agrees
  // with the chosen insert position 1:1. No "centered halfway between
  // children" approximation that doesn't correspond to a visible gap.
  if (display === 'grid' || display === 'inline-grid') {
    return calculateGridLinePosition(info, parentRect);
  }

  let isColumn = true; // default: block flow = column
  if (display === 'flex' || display === 'inline-flex') {
    const dir = cs['flexDirection'] || cs['flex-direction'] || '';
    isColumn = dir === 'column' || dir === 'column-reverse';
  }

  // Get visible child rects via bridge — must match what
  // `calculateLayoutInsertIndexById` filters out (hidden / zero-area
  // children) so the rendered line lands at the same gap the index was
  // computed against. Otherwise the index refers to filtered position N
  // but the renderer slots at full-list position N → line drifts past
  // hidden siblings.
  //
  // Then sort by visual position along the primary axis so the
  // `prev.bottom → next.top` gap math walks visually-adjacent siblings,
  // not JSX-adjacent ones. After a reorder, children carry CSS `order: N`
  // which reshuffles visual layout without changing NodeMap children
  // order — without this sort the line draws between two children that
  // are visually on opposite sides of a third sibling, landing on top of
  // an unrelated element. Same fix `calculateLayoutInsertIndexById` and
  // `LayoutLiftedStrategy.getLayoutSiblingRects` apply.
  const unsorted = findVisibleChildRects(info.parentId, info.vpId);
  const childRects = isColumn
    ? [...unsorted].sort((a, b) => a.rect.top - b.rect.top)
    : [...unsorted].sort((a, b) => a.rect.left - b.rect.left);

  if (isColumn) {
    // Horizontal line spanning parent width
    let y: number;
    if (childRects.length === 0) {
      y = parentRect.top;
    } else if (info.insertIndex <= 0) {
      y = childRects[0].rect.top;
    } else if (info.insertIndex >= childRects.length) {
      y = childRects[childRects.length - 1].rect.bottom;
    } else {
      const prevRect = childRects[info.insertIndex - 1].rect;
      const nextRect = childRects[info.insertIndex].rect;
      y = (prevRect.bottom + nextRect.top) / 2;
    }

    return {
      left: parentRect.left,
      top: y - LINE_WIDTH / 2,
      width: parentRect.width,
      height: LINE_WIDTH,
    };
  } else {
    // Vertical line spanning parent height
    let x: number;
    if (childRects.length === 0) {
      x = parentRect.left;
    } else if (info.insertIndex <= 0) {
      x = childRects[0].rect.left;
    } else if (info.insertIndex >= childRects.length) {
      x = childRects[childRects.length - 1].rect.right;
    } else {
      const prevRect = childRects[info.insertIndex - 1].rect;
      const nextRect = childRects[info.insertIndex].rect;
      x = (prevRect.right + nextRect.left) / 2;
    }

    return {
      left: x - LINE_WIDTH / 2,
      top: parentRect.top,
      width: LINE_WIDTH,
      height: parentRect.height,
    };
  }
}

export default function DropLineIndicator() {
  const info = useSyncExternalStore(dropLineOps.subscribe, dropLineOps.get);
  const [linePos, setLinePos] = useState<LinePosition | null>(null);

  // RAF poll to keep the line position in sync with DOM layout changes
  useEffect(() => {
    if (!info) {
      setLinePos(null);
      return;
    }

    trace.action('drop-line-indicator:mount', { parentId: info.parentId, insertIndex: info.insertIndex });

    let rafId: number;
    const poll = () => {
      const pos = calculateLinePosition(info);
      setLinePos(pos);
      rafId = requestAnimationFrame(poll);
    };

    // Immediate first computation
    setLinePos(calculateLinePosition(info));
    rafId = requestAnimationFrame(poll);

    return () => {
      cancelAnimationFrame(rafId);
      trace.action('drop-line-indicator:unmount');
    };
  }, [info]);

  // Guard `info` too — there's a one-render window where the drop line
  // hides (drag ended / strategy switched) BUT the RAF poll has already
  // committed `linePos` from the previous tick. Without this, the JSX
  // below reads `info.parentId` / `info.insertIndex` on null and crashes.
  // Same race the ParentHighlight sibling had.
  if (!linePos || !info) return null;

  const isVertical = linePos.height > linePos.width;

  // Dot style: matches old builder exactly (w-2.5 h-2.5 border-2 translate(-40%, -40%))
  const dotStyle: React.CSSProperties = {
    position: 'fixed',
    width: DOT_DIAMETER,
    height: DOT_DIAMETER,
    borderRadius: '50%',
    backgroundColor: 'white',
    border: `${DOT_BORDER_WIDTH}px solid ${LINE_COLOR}`,
    pointerEvents: 'none',
    zIndex: 4,
    transform: 'translate(-40%, -40%)',
    boxSizing: 'border-box',
  };

  return (
    <>
      {/* Main line */}
      <div
        data-drop-line-indicator=""
        data-parent-id={info.parentId}
        data-insert-index={info.insertIndex}
        style={{
          position: 'fixed',
          left: linePos.left,
          top: linePos.top,
          width: linePos.width,
          height: linePos.height,
          backgroundColor: LINE_COLOR,
          pointerEvents: 'none',
          zIndex: 3,
        }}
      />
      {isVertical ? (
        <>
          {/* Top dot */}
          <div style={{ ...dotStyle, left: linePos.left, top: linePos.top }} />
          {/* Bottom dot */}
          <div style={{ ...dotStyle, left: linePos.left, top: linePos.top + linePos.height }} />
        </>
      ) : (
        <>
          {/* Left dot */}
          <div style={{ ...dotStyle, left: linePos.left, top: linePos.top }} />
          {/* Right dot */}
          <div style={{ ...dotStyle, left: linePos.left + linePos.width, top: linePos.top }} />
        </>
      )}
    </>
  );
}
