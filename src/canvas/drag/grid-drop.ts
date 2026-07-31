// grid-drop.ts — Grid-aware drop-target computation.
//
// The default flex-style drop-line math (1D midpoint walk along the
// primary axis) doesn't work for grid: grids are 2D, the natural insert
// position depends on BOTH the cursor's column-zone AND row-zone, and the
// drop indicator should live in an actual inter-cell gap — not float at
// a centered-between-children midpoint that doesn't correspond to any
// visible gap.
//
// standard behaviour we implement:
//   • Cursor between two cells in the SAME row → vertical line in the
//     column-gap between them. Insert position = the after-child's
//     row-major index in the children list.
//   • Cursor between two ROWS → horizontal line in the row-gap.
//     Insert position = the first child of the lower row.
//   • Cursor over a cell → split the cell at its midpoint:
//       left half → line at cell's LEFT edge (insert before this cell)
//       right half → line at cell's RIGHT edge (insert after this cell)
//     If "after" lands on the row's last cell AND the cursor's y sits
//     near the row's bottom-half, we further check if the user meant a
//     row-gap drop (avoids ambiguity at row-end cells).
//   • Empty grid → no line, return index 0.

import { findVisibleChildRects, findNodeRect } from '@/canvas/node-ops';

/** Grid-cell info bundled per visible child for the drop-target picker. */
interface GridChild {
  id: string;
  rect: DOMRect;
  /** Source-order index in the children list (for the insert-position
   *  return value). */
  sourceIndex: number;
}

/** A row of visually-clustered grid children, sorted by `rect.left`. */
interface GridRow {
  children: GridChild[];
  top: number;
  bottom: number;
}

/** Inter-cell gap descriptor — fed straight into the drop-line indicator
 *  so it renders right in the gap (no need to re-derive from cell rects). */
interface GridDropLine {
  axis: 'vertical' | 'horizontal';
  /** Screen-space x (axis='vertical') or y (axis='horizontal'). */
  position: number;
  /** Screen-space y-start (vertical) / x-start (horizontal). */
  start: number;
  /** Screen-space y-end (vertical) / x-end (horizontal). */
  end: number;
}

export interface GridDropResult {
  /** Insert position in the parent's children list (source order). The
   *  same N that `calculateLayoutInsertIndexById` returns for non-grid
   *  parents — drag strategies treat it identically. */
  insertIndex: number;
  /** Where the drop-line indicator should render. `null` for empty
   *  grids (no line to draw) or when there are no children to gap
   *  between. */
  line: GridDropLine | null;
}

/** Cluster visible children into visual rows by vertical overlap.
 *  Two children are in the same row when their vertical centres differ
 *  by less than half of the smaller child's height — robust to mixed-
 *  height items, grid items spanning rows, etc. */
function groupIntoRows(children: GridChild[]): GridRow[] {
  if (children.length === 0) return [];
  // Sort by top so we walk rows top-to-bottom.
  const sorted = [...children].sort((a, b) => a.rect.top - b.rect.top);
  const rows: GridRow[] = [];
  for (const child of sorted) {
    const childCenterY = child.rect.top + child.rect.height / 2;
    let placed = false;
    for (const row of rows) {
      // Use the row's existing bounds to test overlap.
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
      rows.push({
        children: [child],
        top: child.rect.top,
        bottom: child.rect.bottom,
      });
    }
  }
  // Sort each row's children by left edge for in-row gap detection.
  for (const row of rows) {
    row.children.sort((a, b) => a.rect.left - b.rect.left);
  }
  return rows;
}

/** Compute the drop position + indicator line for a grid parent.
 *
 *  `mouseScreen` is in screen pixels (same space as `findNodeRect`).
 *  `excludeIds` removes children that shouldn't count as drop targets —
 *  typically the dragged element itself + any descendants. */
export function calculateGridDrop(
  mouseScreen: { x: number; y: number },
  parentId: string,
  vpId: string,
  excludeIds: Set<string> = new Set(),
): GridDropResult {
  const parentRect = findNodeRect(parentId, vpId);
  const visibleRects = findVisibleChildRects(parentId, vpId);
  // Children carry their source-order index for the insertIndex return.
  // We filter AFTER assigning sourceIndex so excluded items don't shift
  // the remaining ones' indices.
  const allChildren: GridChild[] = visibleRects.map((c, i) => ({
    id: c.id, rect: c.rect, sourceIndex: i,
  }));
  const children = allChildren.filter(c => !excludeIds.has(c.id));

  if (children.length === 0) {
    return { insertIndex: 0, line: null };
  }

  const rows = groupIntoRows(children);
  if (rows.length === 0) {
    return { insertIndex: 0, line: null };
  }

  // ── Pick the row the cursor is in (or the row-gap between two rows) ─

  // Above first row → insert at index 0, line at the top of the first row.
  if (mouseScreen.y < rows[0].top) {
    const firstChild = rows[0].children[0];
    return {
      insertIndex: firstChild.sourceIndex,
      line: parentRect ? {
        axis: 'horizontal',
        position: rows[0].top,
        start: parentRect.left,
        end: parentRect.right,
      } : null,
    };
  }

  // Below last row → insert at end, line at the bottom of the last row.
  const lastRow = rows[rows.length - 1];
  if (mouseScreen.y > lastRow.bottom) {
    return {
      insertIndex: children.length,
      line: parentRect ? {
        axis: 'horizontal',
        position: lastRow.bottom,
        start: parentRect.left,
        end: parentRect.right,
      } : null,
    };
  }

  // Between two rows (in the inter-row gap) → horizontal line.
  for (let r = 0; r < rows.length - 1; r++) {
    const upper = rows[r];
    const lower = rows[r + 1];
    if (mouseScreen.y > upper.bottom && mouseScreen.y < lower.top) {
      const firstOfLower = lower.children[0];
      return {
        insertIndex: firstOfLower.sourceIndex,
        line: parentRect ? {
          axis: 'horizontal',
          position: (upper.bottom + lower.top) / 2,
          start: parentRect.left,
          end: parentRect.right,
        } : null,
      };
    }
  }

  // Cursor is inside a specific row → find the column-zone within it.
  let activeRow: GridRow | null = null;
  for (const row of rows) {
    if (mouseScreen.y >= row.top && mouseScreen.y <= row.bottom) {
      activeRow = row;
      break;
    }
  }
  if (!activeRow) {
    // Defensive fallback — shouldn't happen given the bounds checks
    // above, but keeps the function total.
    return { insertIndex: children.length, line: null };
  }

  // Left of first cell in row → insert at this cell's index.
  const firstCell = activeRow.children[0];
  if (mouseScreen.x < firstCell.rect.left) {
    return {
      insertIndex: firstCell.sourceIndex,
      line: {
        axis: 'vertical',
        position: firstCell.rect.left,
        start: activeRow.top,
        end: activeRow.bottom,
      },
    };
  }

  // Walk adjacent cell pairs in the row — cursor in their column-gap
  // OR over the boundary half of one of them.
  for (let c = 0; c < activeRow.children.length; c++) {
    const cell = activeRow.children[c];
    const next = activeRow.children[c + 1] ?? null;
    const cellMidX = cell.rect.left + cell.rect.width / 2;

    // Cursor over the LEFT half of this cell (and we already proved
    // mouse.x >= firstCell.left if c === 0, so this catches in-cell hits).
    if (mouseScreen.x < cellMidX) {
      return {
        insertIndex: cell.sourceIndex,
        line: {
          axis: 'vertical',
          position: cell.rect.left,
          start: activeRow.top,
          end: activeRow.bottom,
        },
      };
    }

    // Cursor over the RIGHT half OR in the gap after this cell.
    const rightEdgeOfHere = cell.rect.right;
    const leftEdgeOfNext = next ? next.rect.left : rightEdgeOfHere;
    if (!next || mouseScreen.x <= leftEdgeOfNext) {
      // Either right-half of last cell in row OR in the inter-column
      // gap before `next`. Insert AFTER this cell.
      // Line goes in the middle of the gap when one exists; otherwise
      // at the right edge of the cell (end of row).
      const gapMid = next
        ? (rightEdgeOfHere + leftEdgeOfNext) / 2
        : rightEdgeOfHere;
      return {
        insertIndex: cell.sourceIndex + 1,
        line: {
          axis: 'vertical',
          position: gapMid,
          start: activeRow.top,
          end: activeRow.bottom,
        },
      };
    }
    // Cursor is past the next cell's left edge — continue to evaluate it.
  }

  // Past the last cell in the row → insert after it (covered by the
  // !next branch above for typical grids, but kept as a safety net).
  const lastCell = activeRow.children[activeRow.children.length - 1];
  return {
    insertIndex: lastCell.sourceIndex + 1,
    line: {
      axis: 'vertical',
      position: lastCell.rect.right,
      start: activeRow.top,
      end: activeRow.bottom,
    },
  };
}
