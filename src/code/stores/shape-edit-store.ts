// shape-edit-store.ts — Jotai atoms for SVG shape edit mode.
// Same pattern as gradient-store.ts / clippath-store.ts.

import { atom } from 'jotai';
import type { SvgPath } from '@/shared/svg-path/svg-path-model';

/** ID of the SVG node currently being edited. null = not in shape edit mode. */
export const shapeEditingIdAtom = atom<string | null>(null);

/** When true, the shape-edit session starts with the PEN tool active — set by the
 *  path tool to DRAW a new shape with the full editor (place points + curve/drag
 *  existing vertices mid-draw, standard). Cleared on exit. */
export const shapeEditPenModeAtom = atom<boolean>(false);

/** Node id the path tool just CREATED as a viewport-sized seed for pen drawing —
 *  if the user exits without drawing a real path (<2 verts), it's deleted instead
 *  of leaving a huge empty node. null = not a fresh pen-creation. */
export const shapeEditCreatedNodeAtom = atom<string | null>(null);

/**
 * ID of the SVG GROUP currently in "isolation / group-edit" mode (Figma-
 * style). When set, clicks scoped INSIDE the group select that group's
 * immediate child instead of redirecting back up to the group itself,
 * letting the user pick / move / shape-edit individual shapes without
 * ungrouping. Clicks OUTSIDE the group exit isolation. null = not in
 * group-edit mode.
 *
 * Distinct from `shapeEditingIdAtom`: shape-edit operates on path
 * vertices of ONE shape, group-edit just changes the SELECTION SCOPE so
 * children become individually selectable. The two can chain — double-
 * click into a group, then double-click a child shape inside the group
 * to enter shape-edit on it.
 */
export const groupEditingIdAtom = atom<string | null>(null);

/**
 * Figma-style nested-selection cursor. When `directSelectionEnabledAtom`
 * is OFF (user-preferences-store), this id is the "container the user
 * has entered" — clicks on canvas walk UP from the deepest hit to the
 * direct child of THIS id, instead of selecting the deep hit verbatim.
 *
 *   null               → top-level scope (clicks select top-level frames)
 *   <some node id>     → user double-clicked into that container; clicks
 *                        now select its direct children
 *
 * Double-click drills deeper (sets activeContainerId to the clicked
 * direct child). Escape pops back up one level. Click on canvas
 * background resets to null. Switching pages / projects also resets.
 *
 * Distinct from `groupEditingIdAtom` — that's specifically for SVG-group
 * isolation (Figma's "isolation mode" inside a vector group). This
 * applies to the regular page tree (frames containing frames).
 */
export const activeContainerIdAtom = atom<string | null>(null);


/** A single child shape element within an SVG wrapper. */
export interface ShapeChild {
  element: Element;      // DOM element reference (for CTM)
  tag: string;           // 'path' | 'polygon' | 'polyline' | 'line' | 'rect' | 'circle' | 'ellipse'
  svgPath: SvgPath;      // parsed point data (all shapes converted to path d)
  childIndex: number;    // index among shape children in the SVG
}

/** Compound selection: which shape + which point. null = none selected. */
export const selectedPointAtom = atom<{ shapeIndex: number; pointIndex: number } | null>(null);

/**
 * Anchor info reported by the SvgPathEditor library whenever the selection
 * changes or the user toggles handle mode. Drives the right-panel Path tool
 * (Position read-out + Curve segmented control) in shape-edit mode.
 * null = no anchor selected → Path tool hidden.
 */
export const selectedAnchorInfoAtom = atom<null | {
  shapeIndex: number;
  anchorIndex: number;
  x: number;
  y: number;
  handleMode: 'straight' | 'mirrored' | 'disconnected';
}>(null);

/**
 * Callback atom: called by ShapeEditOverlay when the user drags a point.
 * Receives the updated SVG path `d` string to write back to code.
 */
export const shapeEditCallbackAtom = atom<((d: string) => void) | null>(null);

/**
 * Brief flag set true between a shape-edit commit (SvgEditorOverlay
 * unmount) and the next renderer onRenderComplete event. Selection
 * overlays + the floating name-label use this to skip a frame of
 * rendering against the stale pre-edit `findNodeRect` cache, avoiding
 * a one-frame visual jump.
 *
 * Writer: Canvas.tsx in the post-commit handler. Reader: SelectionOverlay,
 * CanvasNodeNameDisplay. Defaults to false; if no writer ever sets it,
 * the gate is a no-op (which is fine — the prior frame just looks the
 * same as the new one).
 */
export const shapeEditCommitPendingAtom = atom<boolean>(false);
