// arrow-path.ts — Shared arrow connector geometry.
// Reused by ArrowConnectors (component variants) and MapGhostOverlay (inline maps).
// standard stepped path with quadratic bezier corners.

import { cornersFromRect, type ScreenCorners } from '@/canvas/resize/geometry-utils';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Pt { x: number; y: number }

// ─── Quad Helpers ───────────────────────────────────────────────────────────

export function quadCenter(q: ScreenCorners): Pt {
  return { x: (q.TL.x + q.BR.x) / 2, y: (q.TL.y + q.BR.y) / 2 };
}

function mid(p1: Pt, p2: Pt): Pt {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

function edgeOutwardDir(p1: Pt, p2: Pt, center: Pt): Pt {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const edgeMid = mid(p1, p2);
  const nx = -dy, ny = dx;
  const dot = (edgeMid.x - center.x) * nx + (edgeMid.y - center.y) * ny;
  const len = Math.hypot(nx, ny) || 1;
  if (dot >= 0) return { x: nx / len, y: ny / len };
  return { x: -nx / len, y: -ny / len };
}

// ─── Closest Edge Detection ─────────────────────────────────────────────────

/** Find which edge center of the quad is closest to the target center. */
export function getClosestEdgeCenterFromQuad(
  q: ScreenCorners,
  targetCenter: Pt,
): { point: Pt; dir: Pt } {
  const c = quadCenter(q);
  const edges = [
    { p1: q.TL, p2: q.TR },
    { p1: q.TR, p2: q.BR },
    { p1: q.BR, p2: q.BL },
    { p1: q.BL, p2: q.TL },
  ];

  let closestMid = mid(edges[0].p1, edges[0].p2);
  let closestDir = edgeOutwardDir(edges[0].p1, edges[0].p2, c);
  let minDist = Number.MAX_VALUE;

  for (const edge of edges) {
    const edgeMidPt = mid(edge.p1, edge.p2);
    const dist = Math.hypot(edgeMidPt.x - targetCenter.x, edgeMidPt.y - targetCenter.y);
    if (dist < minDist) {
      minDist = dist;
      closestMid = edgeMidPt;
      closestDir = edgeOutwardDir(edge.p1, edge.p2, c);
    }
  }

  return { point: closestMid, dir: closestDir };
}

/** Edge center + outward dir for a SPECIFIC edge of the quad (rotation-aware).
 *  Used by slot connectors, which must always leave from the component's
 *  right edge — the connection handle — rather than the closest edge. */
export function getEdgeCenterFromQuad(
  q: ScreenCorners,
  which: 'top' | 'right' | 'bottom' | 'left',
): { point: Pt; dir: Pt } {
  const c = quadCenter(q);
  const [p1, p2] =
    which === 'top' ? [q.TL, q.TR]
    : which === 'right' ? [q.TR, q.BR]
    : which === 'bottom' ? [q.BR, q.BL]
    : [q.BL, q.TL];
  return { point: mid(p1, p2), dir: edgeOutwardDir(p1, p2, c) };
}

// ─── Path Generation ────────────────────────────────────────────────────────

const CORNER_RADIUS = 10;

/** standard stepped path with quadratic bezier corners. */
export function generateSteppedPath(
  start: Pt,
  end: Pt,
  startDir: Pt,
  endDir: Pt,
): string | null {
  const sx = start.x, sy = start.y;
  const ex = end.x, ey = end.y;
  const dist = Math.hypot(ex - sx, ey - sy);

  if (dist < 6) {
    trace.fn('arrow-path:stepped-path', { degenerate: 'dist<6', dist, start, end });
    return `M ${sx} ${sy} L ${ex} ${ey}`;
  }

  const gap = Math.min(30, dist * 0.2);

  const p1 = { x: sx + startDir.x * gap, y: sy + startDir.y * gap };
  const p2 = { x: ex + endDir.x * gap, y: ey + endDir.y * gap };

  const diagDx = p2.x - p1.x, diagDy = p2.y - p1.y;
  const diagLen = Math.hypot(diagDx, diagDy);

  if (diagLen < 2) {
    trace.fn('arrow-path:stepped-path', { degenerate: 'diagLen<2', diagLen, start, end });
    return `M ${sx} ${sy} L ${p1.x} ${p1.y} L ${ex} ${ey}`;
  }

  const nDx = diagDx / diagLen, nDy = diagDy / diagLen;
  const r = Math.min(CORNER_RADIUS, gap * 0.8, diagLen * 0.4);

  const c1s = { x: p1.x - startDir.x * r, y: p1.y - startDir.y * r };
  const c1e = { x: p1.x + nDx * r, y: p1.y + nDy * r };
  const c2s = { x: p2.x - nDx * r, y: p2.y - nDy * r };
  const c2e = { x: p2.x - endDir.x * r, y: p2.y - endDir.y * r };

  return [
    `M ${sx} ${sy}`,
    `L ${c1s.x} ${c1s.y}`,
    `Q ${p1.x} ${p1.y} ${c1e.x} ${c1e.y}`,
    `L ${c2s.x} ${c2s.y}`,
    `Q ${p2.x} ${p2.y} ${c2e.x} ${c2e.y}`,
    `L ${ex} ${ey}`,
  ].join(' ');
}

/**
 * Connector for code-component SLOTS. Exits `start` (the connection handle)
 * with a straight HORIZONTAL run to `exitX` — kept horizontal while it
 * crosses the viewport (hidden behind it) — then turns the corner just
 * past the viewport edge and runs a straight diagonal into `end`. Mirrors
 * the reference: a small space past the viewport, then the angled path.
 */
export function generateSlotConnectorPath(
  start: Pt,
  end: Pt,
  endDir: Pt,
  exitX: number,
): string {
  const elbow: Pt = { x: Math.max(exitX, start.x + 12), y: start.y };
  // Approach the target along a short stub off its edge.
  const endStub = 16;
  const tStub: Pt = { x: end.x + endDir.x * endStub, y: end.y + endDir.y * endStub };
  // Diagonal direction: elbow → target stub.
  const dx = tStub.x - elbow.x, dy = tStub.y - elbow.y;
  const len = Math.hypot(dx, dy) || 1;
  const ndx = dx / len, ndy = dy / len;
  // Rounded corner at the elbow — clamped to the short segments so it
  // never overshoots.
  const r = Math.max(0, Math.min(CORNER_RADIUS, (elbow.x - start.x) / 2, len / 2));
  const cIn: Pt = { x: elbow.x - r, y: elbow.y };
  const cOut: Pt = { x: elbow.x + ndx * r, y: elbow.y + ndy * r };
  return [
    `M ${start.x} ${start.y}`,
    `L ${cIn.x} ${cIn.y}`,
    `Q ${elbow.x} ${elbow.y} ${cOut.x} ${cOut.y}`,
    `L ${tStub.x} ${tStub.y}`,
    `L ${end.x} ${end.y}`,
  ].join(' ');
}


/** Compute an arrow path from DOMRects (bridge-compatible, no direct DOM access). */
export function computeArrowPathFromRects(fromRect: DOMRect, toRect: DOMRect): string | null {
  trace.fn('arrow-path:compute-from-rects', {
    fromRect: { left: fromRect.left, top: fromRect.top, width: fromRect.width, height: fromRect.height },
    toRect: { left: toRect.left, top: toRect.top, width: toRect.width, height: toRect.height },
  });
  const fromQuad = cornersFromRect(fromRect);
  const toQuad = cornersFromRect(toRect);
  const fromCenter = quadCenter(fromQuad);
  const toCenter = quadCenter(toQuad);
  const source = getClosestEdgeCenterFromQuad(fromQuad, toCenter);
  const target = getClosestEdgeCenterFromQuad(toQuad, fromCenter);
  return generateSteppedPath(source.point, target.point, source.dir, target.dir);
}

/** Compute an arrow path from ScreenCorners (for rotated elements). */
export function computeArrowPathFromCorners(fromCorners: ScreenCorners, toCorners: ScreenCorners): string | null {
  trace.fn('arrow-path:compute-from-corners');
  const fromCenter = quadCenter(fromCorners);
  const toCenter = quadCenter(toCorners);
  const source = getClosestEdgeCenterFromQuad(fromCorners, toCenter);
  const target = getClosestEdgeCenterFromQuad(toCorners, fromCenter);
  return generateSteppedPath(source.point, target.point, source.dir, target.dir);
}
