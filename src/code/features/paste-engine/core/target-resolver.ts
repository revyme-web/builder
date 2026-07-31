// target-resolver.ts — Determines WHERE pasted nodes go.
//
// Each TargetMode produces a PasteTarget[] (parent + insertIndex). In the
// builder this would fan out to multiple targets for cascade; in Revyme
// we always return exactly one (single-source JSX, browser handles viewports).

import type { CanvasNode } from '@/code/parsing/parser';
import type { PasteContext, PasteTarget, TargetMode } from '../types';

// ─── Layout helpers ──────────────────────────────────────────────────────────

export function hasLayout(node: CanvasNode | undefined): boolean {
  if (!node) return false;
  const display = node.styles.display;
  return display === 'flex' || display === 'inline-flex' ||
         display === 'grid' || display === 'inline-grid';
}

/** Page root has data-id="root" and no parent. */
export function isPageRoot(node: CanvasNode | undefined): boolean {
  if (!node) return false;
  return node.id === 'root' && !node.parentId;
}

/** Free-floating canvas element (in `const canvasNodes = (<>...</>)` fragment). */
export function isCanvasNode(node: CanvasNode | undefined): boolean {
  return !!node?.isCanvasNode;
}

// ─── Resolvers per mode ──────────────────────────────────────────────────────

function resolveCanvas(): PasteTarget[] {
  return [{ parentId: null, isPrimary: true }];
}

function resolveCanvasFrameChildren(ctx: PasteContext): PasteTarget[] {
  if (ctx.selectedIds.length === 0) return [];
  const sel = ctx.nodes.get(ctx.selectedIds[0]);
  if (!sel) return [];

  // Selected is a canvas node OR a child of a canvas node — paste INTO the canvas frame.
  let canvasNode = sel;
  if (!isCanvasNode(canvasNode)) {
    if (sel.parentId) {
      const parent = ctx.nodes.get(sel.parentId);
      if (parent && isCanvasNode(parent)) canvasNode = parent;
      else return [];
    } else {
      return [];
    }
  }

  return [{
    parentId: canvasNode.id,
    insertIndex: ctx.forceInsertIndex ?? canvasNode.children.length,
    isPrimary: true,
  }];
}

function resolveViewportChildren(ctx: PasteContext): PasteTarget[] {
  if (ctx.selectedIds.length === 0) return [];
  const sel = ctx.nodes.get(ctx.selectedIds[0]);
  if (!sel || !isPageRoot(sel)) return [];

  return [{
    parentId: sel.id,
    insertIndex: ctx.forceInsertIndex ?? sel.children.length,
    isPrimary: true,
  }];
}

function resolveSibling(ctx: PasteContext): PasteTarget[] {
  if (ctx.selectedIds.length === 0) return [];
  const sel = ctx.nodes.get(ctx.selectedIds[0]);
  if (!sel?.parentId) return [];

  const parent = ctx.nodes.get(sel.parentId);
  if (!parent) return [];

  const insertIndex = ctx.forceInsertIndex !== undefined
    ? ctx.forceInsertIndex
    : (parent.children.indexOf(sel.id) + 1);

  return [{ parentId: parent.id, insertIndex, isPrimary: true }];
}

function resolveFrameChildren(ctx: PasteContext): PasteTarget[] {
  if (ctx.selectedIds.length === 0) return [];
  const sel = ctx.nodes.get(ctx.selectedIds[0]);
  if (!sel) return [];

  return [{
    parentId: sel.id,
    insertIndex: ctx.forceInsertIndex ?? sel.children.length,
    isPrimary: true,
  }];
}

// ─── Public ──────────────────────────────────────────────────────────────────

export function resolveTargets(ctx: PasteContext, mode: TargetMode): PasteTarget[] {
  switch (mode) {
    case 'canvas':                return resolveCanvas();
    case 'canvas-frame-children': return resolveCanvasFrameChildren(ctx);
    case 'viewport-children':     return resolveViewportChildren(ctx);
    case 'sibling':               return resolveSibling(ctx);
    case 'frame-children':        return resolveFrameChildren(ctx);
    default:                      return [];
  }
}
