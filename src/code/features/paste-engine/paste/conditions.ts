// conditions.ts — All condition checkers used by the paste rules engine.
//
// Each checker is a pure function: PasteContext → boolean. They're keyed by
// name in `conditionCheckers`, and rules reference them by string. The two
// upsides of a string-keyed registry: rules stay declarative + testable, and
// adding a condition is a single append.
//
// Naming convention:
//   - SUBJECT_PROPERTY → asserts something about selection / clipboard
//   - NOT_SUBJECT      → guard (negation of another condition)
//   - HAS_X            → presence check on context fields

import { isPageRoot, isCanvasNode, hasLayout } from '../core/target-resolver';
import { findRootNodes } from '../core/position';
import type { ConditionChecker, ConditionCheckers, PasteContext } from '../types';
import type { CanvasNode } from '@/code/parsing/parser';

/**
 * Canonical "absolute-in-frame" test from the node cache — mirrors
 * PositionTool's derivation. `styles.isAbsoluteInFrame` is a SYNTHETIC flag:
 * stripped before code emit (node-creator `stripSyntheticStyles`) and only
 * re-derived locally, so a parsed/just-copied node never carries it. The old
 * `=== 'true'` gate therefore ALWAYS failed → an absolute node pasted as
 * RELATIVE. Derive it instead: an absolute/fixed node whose IMMEDIATE parent is
 * positioned (relative/absolute/fixed), or that carries the synthetic flag (set
 * during editing). `data-pinned` is NOT a signal here — pinned nodes paste in
 * place like any other absolute-in-frame node (the old pinned→canvas divert was
 * removed 2026-07-24).
 */
function isAbsoluteInFrameNode(node: CanvasNode, nodes: PasteContext['nodes']): boolean {
  const pos = node.styles.position;
  if (pos !== 'absolute' && pos !== 'fixed') return false;
  if (node.styles.isAbsoluteInFrame === 'true') return true;
  if (!node.parentId) return false;
  const ppos = nodes.get(node.parentId)?.styles.position;
  return ppos === 'relative' || ppos === 'absolute' || ppos === 'fixed';
}

// ─── Selection conditions ────────────────────────────────────────────────────

const NO_SELECTION: ConditionChecker = ctx => ctx.selectedIds.length === 0;
const HAS_SELECTION: ConditionChecker = ctx => ctx.selectedIds.length > 0;

const CANVAS_NODE_SELECTED: ConditionChecker = ctx => {
  return ctx.selectedIds.some(id => {
    const node = ctx.nodes.get(id);
    return node ? isCanvasNode(node) : false;
  });
};

const NOT_CANVAS_NODE_SELECTED: ConditionChecker = ctx => !CANVAS_NODE_SELECTED(ctx);

const PAGE_ROOT_SELECTED: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  return isPageRoot(ctx.nodes.get(ctx.selectedIds[0]));
};

const PAGE_ROOT_NO_LAYOUT: ConditionChecker = ctx => {
  if (!PAGE_ROOT_SELECTED(ctx)) return false;
  return !hasLayout(ctx.nodes.get(ctx.selectedIds[0]));
};

const PAGE_ROOT_HAS_LAYOUT: ConditionChecker = ctx => {
  if (!PAGE_ROOT_SELECTED(ctx)) return false;
  return hasLayout(ctx.nodes.get(ctx.selectedIds[0]));
};

const CHILD_NODE_SELECTED: ConditionChecker = ctx => {
  return ctx.selectedIds.some(id => {
    const node = ctx.nodes.get(id);
    if (!node || !node.parentId || isCanvasNode(node)) return false;
    return ctx.nodes.has(node.parentId);
  });
};

const FRAME_SELECTED: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  // Treat any non-text container as a frame target (div, section, nav, etc.).
  // Specifically excludes text tags — text shouldn't accept dropped children.
  if (!node) return false;
  const TEXT_TAGS = ['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'strong', 'em'];
  if (TEXT_TAGS.includes(node.type)) return false;
  return true;
};

const ABSOLUTE_FRAME_SELECTED: ConditionChecker = ctx => {
  if (!FRAME_SELECTED(ctx)) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  return node?.styles.isAbsoluteFrame === 'true';
};

const ABSOLUTE_IN_FRAME_SELECTED: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  if (!node) return false;
  if (!isAbsoluteInFrameNode(node, ctx.nodes)) return false;
  if (!node.parentId) return false;
  if (isCanvasNode(node)) return false;
  return true;
};

// (Removed 2026-07-24) `PINNED_NODE_SELECTED` used to divert data-pinned nodes
// to the canvas on paste/duplicate. Dropped at the user's request — pinned
// absolute-in-frame nodes now paste in place like any other. See rules.ts.

const ABSOLUTE_IN_CANVAS_FRAME_SELECTED: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  if (!node) return false;
  if (!isAbsoluteInFrameNode(node, ctx.nodes)) return false;
  if (!node.parentId) return false;
  const parent = ctx.nodes.get(node.parentId);
  return parent ? isCanvasNode(parent) : false;
};

const RELATIVE_PARENT_SELECTED: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  if (!node) return false;
  return !!node.parentId && !isPageRoot(node) && node.styles.isAbsoluteFrame !== 'true';
};

const NO_LAYOUT_PARENT: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  if (!node?.parentId) return false;
  const parent = ctx.nodes.get(node.parentId);
  return parent ? !hasLayout(parent) : false;
};

const HAS_LAYOUT_PARENT: ConditionChecker = ctx => {
  if (ctx.selectedIds.length === 0) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  if (!node?.parentId) return false;
  const parent = ctx.nodes.get(node.parentId);
  return parent ? hasLayout(parent) : false;
};

const CANVAS_NODE_NO_LAYOUT_SELECTED: ConditionChecker = ctx => {
  if (!CANVAS_NODE_SELECTED(ctx)) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  return node ? !hasLayout(node) : false;
};

const CANVAS_NODE_HAS_LAYOUT_SELECTED: ConditionChecker = ctx => {
  if (!CANVAS_NODE_SELECTED(ctx)) return false;
  const node = ctx.nodes.get(ctx.selectedIds[0]);
  return node ? hasLayout(node) : false;
};

// ─── Clipboard conditions ────────────────────────────────────────────────────

const TEXT_IN_CLIPBOARD: ConditionChecker = ctx => {
  const TEXT_TAGS = ['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'strong', 'em'];
  return findRootNodes(ctx.clipboardNodes).some(n => TEXT_TAGS.includes(n.type));
};

const CANVAS_NODE_IN_CLIPBOARD: ConditionChecker = ctx => {
  return ctx.clipboardNodes.some(n => n.isCanvasNode);
};

const NOT_TEXT_INTO_FRAME: ConditionChecker = ctx => {
  // Guard: don't treat text-into-frame as plain sibling paste.
  if (!TEXT_IN_CLIPBOARD(ctx)) return true;
  const node = ctx.selectedIds[0] ? ctx.nodes.get(ctx.selectedIds[0]) : null;
  if (!node) return true;
  if (FRAME_SELECTED(ctx)) return false;
  return true;
};

// ─── Drop-intent conditions ──────────────────────────────────────────────────

const HAS_FORCE_INSERT_INDEX: ConditionChecker = ctx => ctx.forceInsertIndex !== undefined;
const DROPPING_INTO_NO_LAYOUT_FRAME: ConditionChecker = ctx => ctx.forceNoLayoutPosition !== undefined;

// ─── Public ──────────────────────────────────────────────────────────────────

export const conditionCheckers: ConditionCheckers = {
  // Selection
  NO_SELECTION,
  HAS_SELECTION,
  CANVAS_NODE_SELECTED,
  NOT_CANVAS_NODE_SELECTED,
  PAGE_ROOT_SELECTED,
  PAGE_ROOT_NO_LAYOUT,
  PAGE_ROOT_HAS_LAYOUT,
  CHILD_NODE_SELECTED,
  FRAME_SELECTED,
  ABSOLUTE_FRAME_SELECTED,
  ABSOLUTE_IN_FRAME_SELECTED,
  ABSOLUTE_IN_CANVAS_FRAME_SELECTED,
  RELATIVE_PARENT_SELECTED,
  NO_LAYOUT_PARENT,
  HAS_LAYOUT_PARENT,
  CANVAS_NODE_NO_LAYOUT_SELECTED,
  CANVAS_NODE_HAS_LAYOUT_SELECTED,

  // Clipboard
  TEXT_IN_CLIPBOARD,
  CANVAS_NODE_IN_CLIPBOARD,
  NOT_TEXT_INTO_FRAME,

  // Drop intent
  HAS_FORCE_INSERT_INDEX,
  DROPPING_INTO_NO_LAYOUT_FRAME,
};

/** Returns true iff every named condition passes for the context. */
export function checkConditions(names: string[], ctx: PasteContext): boolean {
  return names.every(name => {
    const checker = conditionCheckers[name];
    if (!checker) {
      // Unknown condition — fail closed so a typo doesn't silently match.
      return false;
    }
    return checker(ctx);
  });
}
