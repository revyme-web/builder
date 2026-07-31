// pin-constraint-utils.ts — Pure helpers for PinConstraintLines.
//
// Lives in a separate file so PinConstraintLines.tsx exports only the
// React component (default). React Fast Refresh requires that component
// files don't co-export non-component values — mixing them disables
// HMR for the file with the warning:
//   "Could not Fast Refresh (`nodeOrAncestorHasTransform` export is
//    incompatible)."

import type { CanvasNode } from '@/code/parsing/parser';
import type { ContainerOverrideMap } from '@/code/stores/container-query-store';

/** Check if a style value represents a pin (not empty, not auto). */
export function isStylePinned(v: string | undefined): boolean {
  if (!v || v === 'auto' || v === '') return false;
  return v.endsWith('px') || /^-?\d+(\.\d+)?$/.test(v);
}

/** Check if a CSS transform value is meaningfully set (i.e. not the
 *  identity). Empty / unset / 'none' all count as no transform. */
export function hasTransform(transform: string | undefined): boolean {
  if (!transform) return false;
  const t = transform.trim();
  return t.length > 0 && t !== 'none';
}

/** Merge active-viewport @media overrides on top of a node's base
 *  styles. `''` and `'auto'` in the @media rule mean "treat as not-
 *  set" (the delete-property convention + the inset-pin auto-emit's
 *  `width: auto` which is semantically equivalent to no width).
 *
 *  Same merge logic PinControl, ResizeManager, and
 *  AbsoluteInFrameStrategy use — kept in sync so all four read the
 *  same effective styles. */
export function getEffectiveStyles(
  nodeId: string,
  baseStyles: Record<string, string>,
  vpMaxWidth: number,
  containerOverrides: ContainerOverrideMap,
): Record<string, string> {
  const replicaProps = containerOverrides.get(nodeId)?.get(vpMaxWidth);
  if (!replicaProps || replicaProps.size === 0) return baseStyles;
  const merged = { ...baseStyles };
  for (const [prop, val] of replicaProps) {
    if (val === '' || val === 'auto') delete merged[prop];
    else merged[prop] = val;
  }
  return merged;
}

/**
 * Walk up the node tree from `nodeId` and return true if the node itself or
 * any ancestor has a `transform` style. Stops at the root (no parentId).
 *
 * Each step reads the EFFECTIVE transform for the given viewport
 * (`base` merged with active vp's `@media` override) — without this,
 * a rotation that lives only in the replica's @media rule never trips
 * the suppression, and pin constraint lines render across a visibly-
 * rotated element with axis-aligned math.
 *
 * Pass `null` for `containerOverrides` (or `0` for `vpMaxWidth`) to
 * fall back to base-only — that path keeps the function callable in
 * environments without the responsive store (unit tests).
 */
export function nodeOrAncestorHasTransform(
  nodeId: string,
  nodes: Map<string, Pick<CanvasNode, 'parentId' | 'styles'>>,
  containerOverrides?: ContainerOverrideMap | null,
  vpMaxWidth: number = 0,
): boolean {
  let cur: string | null | undefined = nodeId;
  // Cap the walk in case of a cycle (defensive — parser shouldn't produce one).
  for (let depth = 0; cur && depth < 64; depth++) {
    const n = nodes.get(cur);
    if (!n) return false;
    const baseT = n.styles?.transform;
    const effective = (containerOverrides && vpMaxWidth > 0)
      ? getEffectiveStyles(cur, n.styles ?? {}, vpMaxWidth, containerOverrides).transform
      : baseT;
    if (hasTransform(effective)) return true;
    cur = n.parentId;
  }
  return false;
}

/** The poll result shape PinConstraintLines keeps in state. Declared
 *  structurally here so this leaf module stays free of React imports. */
export interface PinDataLike {
  lp: boolean; rp: boolean; tp: boolean; bp: boolean;
  er: { left: number; top: number; width: number; height: number };
  pr: { left: number; top: number; width: number; height: number };
}

/**
 * Is this frame's poll result the same as the last one?
 *
 * The RAF loop below built a FRESH `PinData` object every frame and set it
 * unconditionally, so every frame re-rendered even when nothing moved. That is
 * merely wasteful on its own — but the poll effect's deps include the live
 * `node`, whose identity churns per frame while a drag writes the node cache,
 * and the effect kicks its first `update()` off SYNCHRONOUSLY. Set → render →
 * effect re-runs → set → … with no frame boundary to break it: React hit
 * "Maximum update depth exceeded" and took the whole app down mid-drag (user
 * report 2026-07-26; the comlink `reading 'apply'` errors after it are the
 * sandbox's callbacks firing into the torn-down tree).
 *
 * Returning the PREVIOUS object when nothing changed lets React bail out of the
 * re-render (Object.is), which caps the chain at one set. This is the
 * equality-preserving contract `usePolledValue` documents for exactly this
 * skeleton — HoverHighlight's `cornersEqual` guard is the same idea; this
 * component hand-rolls the loop and never had it.
 *
 * Rects are compared field-wise: `findNodeRect` returns a NEW DOMRect per call,
 * so reference equality is always false.
 */
export function pinDataEqual(a: PinDataLike | null, b: PinDataLike | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.lp === b.lp && a.rp === b.rp && a.tp === b.tp && a.bp === b.bp
    && rectEq(a.er, b.er) && rectEq(a.pr, b.pr)
  );
}

function rectEq(a: PinDataLike['er'], b: PinDataLike['er']): boolean {
  // Object.is, NOT === : a rect field can be NaN when a bridge read fails
  // mid-drag (e.g. a code-component instance while the sandbox is busy).
  // With ===, NaN !== NaN made pinDataEqual PERMANENTLY false — every
  // effect pass then set a fresh state object and the synchronous
  // set→render→effect chain blew React's update-depth limit, crashing the
  // whole app (user report 2026-07-30, dragging a code component in a
  // master).
  return Object.is(a.left, b.left) && Object.is(a.top, b.top)
    && Object.is(a.width, b.width) && Object.is(a.height, b.height);
}
