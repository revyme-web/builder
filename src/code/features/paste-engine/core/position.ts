// position.ts — Paste position calculator.
//
// Pure functions: take a PasteContext + positioning mode, return { x, y }.
// No DOM access — everything reads from the nodes map and ctx.transform.

import type { CanvasNode } from '@/code/parsing/parser';
import type {
  ClipboardNode,
  PasteConfig,
  PasteContext,
  PositioningMode,
} from '../types';

interface Position { x: number; y: number; }
interface Rect { left: number; top: number; right: number; bottom: number; }

const DEFAULT_GAP = 100;
const DEFAULT_POSITION: Position = { x: 100, y: 100 };

// ─── Root-node detection ─────────────────────────────────────────────────────

/**
 * Find clipboard nodes whose parent isn't also in the clipboard. These are
 * the "tops" of subtrees we'll create — the rest get created as descendants.
 */
export function findRootNodes(nodes: ClipboardNode[]): ClipboardNode[] {
  const ids = new Set(nodes.map(n => n.id));
  return nodes.filter(n => !n.parentId || !ids.has(n.parentId));
}

// ─── Collision helpers ───────────────────────────────────────────────────────

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function getCanvasNodeRects(nodes: Map<string, CanvasNode>): Rect[] {
  const rects: Rect[] = [];
  for (const node of nodes.values()) {
    if (!node.isCanvasNode) continue;
    const left = parseFloat(node.styles.left || '0') || 0;
    const top = parseFloat(node.styles.top || '0') || 0;
    const width = parseFloat(node.styles.width || '0') || 100;
    const height = parseFloat(node.styles.height || '0') || 100;
    rects.push({ left, top, right: left + width, bottom: top + height });
  }
  return rects;
}

// ─── Smart-right placement ───────────────────────────────────────────────────

/**
 * Try positions in order: right, bottom, left, top of the selected canvas
 * node — first non-colliding wins. If nothing's selected, walks rightward
 * from the right-most existing canvas node.
 */
function calculateSmartRightPosition(
  ctx: PasteContext,
  gap: number,
  defaultPosition: Position,
): Position {
  const existingRects = getCanvasNodeRects(ctx.nodes);
  const rootNodes = findRootNodes(ctx.clipboardNodes);
  const first = rootNodes[0];
  const pasteW = parseFloat(first?.styles.width || '200') || 200;
  const pasteH = parseFloat(first?.styles.height || '200') || 200;

  // Selected canvas node: position around it.
  if (ctx.selectedIds.length > 0) {
    const sel = ctx.nodes.get(ctx.selectedIds[0]);
    if (sel?.isCanvasNode) {
      const sx = parseFloat(sel.styles.left || '0') || 0;
      const sy = parseFloat(sel.styles.top || '0') || 0;
      const sw = parseFloat(sel.styles.width || '200') || 200;
      const sh = parseFloat(sel.styles.height || '200') || 200;

      const candidates: Position[] = [
        { x: sx + sw + gap, y: sy },                      // right
        { x: sx, y: sy + sh + gap },                      // bottom
        { x: sx - pasteW - gap, y: sy },                  // left
        { x: sx, y: sy - pasteH - gap },                  // top
      ];

      for (const pos of candidates) {
        const rect = { left: pos.x, top: pos.y, right: pos.x + pasteW, bottom: pos.y + pasteH };
        if (!existingRects.some(r => rectsOverlap(rect, r))) return pos;
      }
      return { x: sx + sw + gap + 200, y: sy };
    }
  }

  // No canvas nodes: just use default.
  if (existingRects.length === 0) return defaultPosition;

  // Try default first.
  const defaultRect = {
    left: defaultPosition.x, top: defaultPosition.y,
    right: defaultPosition.x + pasteW, bottom: defaultPosition.y + pasteH,
  };
  if (!existingRects.some(r => rectsOverlap(defaultRect, r))) return defaultPosition;

  // Walk right from the rightmost edge.
  const rightmost = Math.max(...existingRects.map(r => r.right));
  let x = rightmost + gap;
  for (let i = 0; i < 20; i++) {
    const rect = { left: x, top: defaultPosition.y, right: x + pasteW, bottom: defaultPosition.y + pasteH };
    if (!existingRects.some(r => rectsOverlap(rect, r))) return { x, y: defaultPosition.y };
    x += pasteW + gap;
  }
  return { x, y: defaultPosition.y };
}

// ─── Visible-center (no selection paste) ─────────────────────────────────────

/**
 * Center of the user's currently-visible canvas area, in canvas coords.
 * Used when no selection — pastes "where the user is looking".
 */
function calculateVisibleCenter(ctx: PasteContext, defaultPosition: Position): Position {
  if (!ctx.transform || !ctx.containerWidth || !ctx.containerHeight) return defaultPosition;
  const { x: panX, y: panY, scale } = ctx.transform;
  return {
    x: (ctx.containerWidth / 2 - panX) / scale,
    y: (ctx.containerHeight / 2 - panY) / scale,
  };
}

// ─── At-selected-position (abs-in-frame siblings) ────────────────────────────

function calculateAtSelectedPosition(ctx: PasteContext, defaultPosition: Position): Position {
  if (ctx.selectedIds.length === 0) return defaultPosition;
  const sel = ctx.nodes.get(ctx.selectedIds[0]);
  if (!sel) return defaultPosition;
  return {
    x: parseFloat(sel.styles.left || '0') || 0,
    y: parseFloat(sel.styles.top || '0') || 0,
  };
}

// ─── Center-in-parent (canvas-frame-children) ────────────────────────────────

function calculateCenterInParent(ctx: PasteContext, defaultPosition: Position): Position {
  if (ctx.selectedIds.length === 0) return defaultPosition;
  const parent = ctx.nodes.get(ctx.selectedIds[0]);
  if (!parent) return defaultPosition;
  const pw = parseFloat(parent.styles.width || '0') || 200;
  const ph = parseFloat(parent.styles.height || '0') || 200;
  const first = findRootNodes(ctx.clipboardNodes)[0];
  const nw = parseFloat(first?.styles.width || '0') || 100;
  const nh = parseFloat(first?.styles.height || '0') || 100;
  return { x: (pw - nw) / 2, y: (ph - nh) / 2 };
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export function calculatePosition(
  ctx: PasteContext,
  mode: PositioningMode,
  config?: Pick<PasteConfig, 'gap' | 'defaultPosition' | 'forcePosition'>,
): Position {
  const gap = config?.gap ?? DEFAULT_GAP;
  const defaultPosition = config?.defaultPosition ?? DEFAULT_POSITION;

  // Force-position from drop wins for canvas-style modes.
  if (ctx.forcePosition && (mode === 'visible-center' || mode === 'smart-right')) {
    return ctx.forcePosition;
  }

  switch (mode) {
    case 'smart-right':
      return calculateSmartRightPosition(ctx, gap, defaultPosition);

    case 'visible-center':
      return calculateVisibleCenter(ctx, defaultPosition);

    case 'at-origin':
      return config?.forcePosition ?? { x: 0, y: 0 };

    case 'preserve': {
      const first = findRootNodes(ctx.clipboardNodes)[0];
      if (first?.styles) {
        return {
          x: parseFloat(first.styles.left || '0') || 0,
          y: parseFloat(first.styles.top || '0') || 0,
        };
      }
      return defaultPosition;
    }

    case 'at-selected-position':
      return calculateAtSelectedPosition(ctx, defaultPosition);

    case 'center-in-parent':
      return calculateCenterInParent(ctx, defaultPosition);

    case 'after-selected':
    case 'last-child':
      // Position is determined by insert index, not coordinates.
      return defaultPosition;

    default:
      return defaultPosition;
  }
}
