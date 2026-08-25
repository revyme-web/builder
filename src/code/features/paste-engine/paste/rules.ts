// rules.ts — Priority-ordered paste rules.
//
// Each rule says "if these conditions all match, paste with this config".
// Rules are sorted by `priority` (lower = higher priority) and the first
// matching rule wins. Adding a new scenario = adding a row.
//
// Adapted from the builder's 22-rule engine, dropping rules that don't
// apply to Revyme (no per-viewport syncId/replicas, no top-level
// component variant pasting, no synced-viewports clipboard).

import type { PasteRule, PasteContext } from '../types';
import { checkConditions } from './conditions';

const PASTE_RULES: PasteRule[] = [
  // ─── Drop intents (highest priority) ──────────────────────────────────────
  // These come from template/toolbar drops. forceInsertIndex / forceNoLayout
  // bypass the usual "what's selected" routing.

  {
    id: 'drop-into-no-layout-frame',
    name: 'Drop into no-layout frame',
    description: 'Template drop into a frame without flex/grid — abs-in-frame at drop point.',
    priority: 0.45,
    conditions: ['DROPPING_INTO_NO_LAYOUT_FRAME', 'FRAME_SELECTED'],
    config: {
      targetMode: 'frame-children',
      positioning: 'at-origin', // overridden by forceNoLayoutPosition in executor
      styleTransform: 'to-absolute-in-frame',
    },
  },

  {
    id: 'drop-into-layout-frame',
    name: 'Drop into layout frame',
    description: 'Template drop into a flex/grid frame at a specific index.',
    priority: 0.5,
    conditions: ['HAS_FORCE_INSERT_INDEX', 'FRAME_SELECTED'],
    config: {
      targetMode: 'frame-children',
      positioning: 'last-child', // index from forceInsertIndex
      styleTransform: 'force-relative',
    },
  },

  // ─── Text paste special-cases ─────────────────────────────────────────────

  {
    id: 'paste-text-into-absolute-frame',
    name: 'Paste text into absolute frame',
    description: 'Text into a frame with isAbsoluteFrame=true → land at 0,0.',
    priority: 0.55,
    conditions: ['TEXT_IN_CLIPBOARD', 'ABSOLUTE_FRAME_SELECTED'],
    config: {
      targetMode: 'frame-children',
      positioning: 'at-origin',
      styleTransform: 'none',
      forcePosition: { x: 0, y: 0 },
    },
  },

  {
    id: 'paste-text-into-frame',
    name: 'Paste text into frame',
    description: 'Text + frame selected → insert as last child, force-relative.',
    priority: 0.6,
    conditions: ['TEXT_IN_CLIPBOARD', 'FRAME_SELECTED', 'NOT_CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'frame-children',
      positioning: 'last-child',
      styleTransform: 'force-relative',
    },
  },

  // ─── Absolute-in-frame siblings ───────────────────────────────────────────
  //
  // NOTE: `data-pinned` nodes used to divert to the canvas here (a
  // `paste-pinned-to-canvas` rule). Removed 2026-07-24 at the user's request —
  // duplicate/paste of a pinned absolute-in-frame node must stay in the SAME
  // parent at the SAME position, exactly like a non-pinned one. Pinned nodes now
  // fall straight through to the abs-in-frame rules below (in-place sibling).

  {
    id: 'paste-at-abs-in-canvas-frame',
    name: 'Paste at abs-in-frame position (canvas frame)',
    description: 'Sel is abs-in-frame child of a canvas node → sibling at same pos inside canvas frame.',
    priority: 0.62,
    conditions: ['ABSOLUTE_IN_CANVAS_FRAME_SELECTED'],
    config: {
      targetMode: 'canvas-frame-children',
      // `preserve`, for the same reason the viewport twin below uses
      // `after-selected`: `at-selected-position` REBUILDS the position as
      // numeric left/top out of `parseFloat(sel.styles.left|top)`, which throws
      // away both the unit and the anchor SIDE. A node pinned `top` + `left` in
      // PERCENT came back `left: '32.5826px'` — same number, wrong unit, and
      // the panel read it as a px pin (reported 2026-08-24); a right/bottom
      // anchored node loses its side entirely. The clone already carries the
      // source's own anchors, and for a duplicate-in-place those ARE the answer
      // — whatever units and sides the user pinned. `preserve` computes no
      // override, so `to-absolute-in-frame` passes them through untouched.
      // Target is unaffected: resolveCanvasFrameChildren appends into the same
      // frame regardless of positioning.
      positioning: 'preserve',
      styleTransform: 'to-absolute-in-frame',
    },
  },

  {
    id: 'paste-at-abs-in-frame',
    name: 'Paste at abs-in-frame position',
    description: 'Sel is abs-in-frame inside a viewport frame → sibling at the EXACT same spot.',
    priority: 0.65,
    conditions: ['ABSOLUTE_IN_FRAME_SELECTED', 'NOT_CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'sibling',
      // `after-selected` (NOT `at-selected-position`): keep the source's exact
      // anchors. `at-selected-position` rebuilds the position as left/top from
      // `sel.styles.left|top` — which is 0 for a RIGHT/BOTTOM-anchored node, so
      // it forced `left:0` and snapped the paste to the edge. No override → the
      // `to-absolute-in-frame` styles (top/right/etc.) pass through unchanged.
      positioning: 'after-selected',
      styleTransform: 'to-absolute-in-frame',
    },
  },

  // ─── Canvas node selected (always paste to RIGHT, never inside) ───────────

  {
    id: 'paste-with-canvas-node-selected',
    name: 'Paste with canvas node selected',
    description: 'Canvas node selected → paste a NEW canvas node to the right.',
    priority: 0.7,
    conditions: ['CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'canvas',
      positioning: 'smart-right',
      styleTransform: 'to-canvas',
      gap: 100,
    },
  },

  // ─── Children paste (siblings) ────────────────────────────────────────────

  {
    id: 'paste-child-as-sibling-no-layout',
    name: 'Paste child as sibling (no-layout parent)',
    description: 'Selected child has a no-layout parent → sibling, abs-in-frame.',
    priority: 0.75,
    conditions: [
      'CHILD_NODE_SELECTED',
      'NO_LAYOUT_PARENT',
      'NOT_TEXT_INTO_FRAME',
      'NOT_CANVAS_NODE_SELECTED',
    ],
    config: {
      targetMode: 'sibling',
      positioning: 'after-selected',
      styleTransform: 'to-absolute-in-frame',
    },
  },

  {
    id: 'paste-canvas-node-into-relative-parent',
    name: 'Paste canvas node into relative parent',
    description: 'Clipboard has canvas nodes + selected has a relative parent → strip absolute.',
    priority: 0.78,
    conditions: ['RELATIVE_PARENT_SELECTED', 'CANVAS_NODE_IN_CLIPBOARD', 'NOT_CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'sibling',
      positioning: 'after-selected',
      styleTransform: 'strip-absolute',
    },
  },

  {
    id: 'paste-child-as-sibling',
    name: 'Paste child as sibling',
    description: 'Default sibling case — selected child, paste after it.',
    priority: 0.8,
    conditions: ['CHILD_NODE_SELECTED', 'NOT_TEXT_INTO_FRAME', 'NOT_CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'sibling',
      positioning: 'after-selected',
      styleTransform: 'none',
    },
  },

  // ─── Page root selected (paste INTO viewport) ─────────────────────────────

  {
    id: 'paste-into-page-root-no-layout',
    name: 'Paste into page root (no layout)',
    description: 'Page root with no flex/grid → child, abs-in-frame.',
    priority: 0.85,
    conditions: ['PAGE_ROOT_NO_LAYOUT', 'NOT_CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'viewport-children',
      positioning: 'last-child',
      styleTransform: 'to-absolute-in-frame',
    },
  },

  {
    id: 'paste-into-page-root',
    name: 'Paste into page root',
    description: 'Page root with flex/grid → child, force-relative.',
    priority: 0.9,
    conditions: ['PAGE_ROOT_HAS_LAYOUT', 'NOT_CANVAS_NODE_SELECTED'],
    config: {
      targetMode: 'viewport-children',
      positioning: 'last-child',
      styleTransform: 'force-relative',
    },
  },

  // ─── Canvas frame children (paste INTO a canvas frame) ────────────────────

  {
    id: 'paste-into-canvas-frame-no-layout',
    name: 'Paste into canvas frame (no layout)',
    description: 'Selected canvas node has no flex/grid → child, abs-in-frame, centered.',
    priority: 1.0,
    conditions: ['CANVAS_NODE_NO_LAYOUT_SELECTED'],
    config: {
      targetMode: 'canvas-frame-children',
      positioning: 'center-in-parent',
      styleTransform: 'to-absolute-in-frame',
    },
  },

  {
    id: 'paste-into-canvas-frame-with-layout',
    name: 'Paste into canvas frame (with layout)',
    description: 'Selected canvas node has flex/grid → child, force-relative.',
    priority: 1.05,
    conditions: ['CANVAS_NODE_HAS_LAYOUT_SELECTED'],
    config: {
      targetMode: 'canvas-frame-children',
      positioning: 'last-child',
      styleTransform: 'force-relative',
    },
  },

  // ─── No-selection fallback ────────────────────────────────────────────────

  {
    id: 'paste-on-canvas-no-selection',
    name: 'Paste on canvas (no selection)',
    description: 'Nothing selected → paste at center of visible canvas.',
    priority: 5.0,
    conditions: ['NO_SELECTION'],
    config: {
      targetMode: 'canvas',
      positioning: 'visible-center',
      styleTransform: 'to-canvas',
      gap: 100,
      defaultPosition: { x: 100, y: 100 },
    },
  },

  // ─── Clipboard-canvas fallback ────────────────────────────────────────────

  {
    id: 'paste-canvas-node-fallback',
    name: 'Paste canvas node (fallback)',
    description: 'Clipboard has canvas nodes + something selected, no other rule matched.',
    priority: 8.0,
    conditions: ['CANVAS_NODE_IN_CLIPBOARD', 'HAS_SELECTION'],
    config: {
      targetMode: 'canvas',
      positioning: 'smart-right',
      styleTransform: 'to-canvas',
      gap: 100,
    },
  },
];

/** Sort rules by priority and return the first match for a context. */
export function findMatchingRule(ctx: PasteContext): PasteRule | null {
  const sorted = [...PASTE_RULES].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (checkConditions(rule.conditions, ctx)) return rule;
  }
  return null;
}

/** For tests/debugging. */
export function getRuleById(id: string): PasteRule | undefined {
  return PASTE_RULES.find(r => r.id === id);
}
