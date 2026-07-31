// flex-helpers.ts — Pure helpers for CSS flex shorthand parsing/formatting.

export interface FlexShorthand {
  grow: number;
  shrink: number;
  basis: string;
}

/** Parse `flex` shorthand: "1 0 0px" → { grow: 1, shrink: 0, basis: '0px' } */
export function parseFlex(value: string): FlexShorthand {
  if (!value) return { grow: 0, shrink: 1, basis: 'auto' };
  const parts = value.trim().split(/\s+/);
  return {
    grow: parseFloat(parts[0]) || 0,
    shrink: parts.length > 1 ? (parseFloat(parts[1]) || 0) : 1,
    basis: parts.length > 2 ? parts[2] : 'auto',
  };
}

/** Format flex shorthand back to CSS */
export function formatFlex(f: FlexShorthand): string {
  return `${f.grow} ${f.shrink} ${f.basis}`;
}

/** Check if an element is in "fill" mode (flex-grow > 0) */
export function isFillMode(flex: string): boolean {
  const f = parseFlex(flex);
  return f.grow > 0;
}

/** Get the fill multiplier (1fr, 2fr, etc) from flex value */
export function getFillMultiplier(flex: string): number {
  const f = parseFlex(flex);
  return f.grow > 0 ? f.grow : 1;
}

/** Create a flex value for fill mode with given multiplier */
export function makeFillFlex(multiplier: number): string {
  return `${Math.max(1, multiplier)} 0 0px`;
}

/** Determine if "fill" unit should be available for a given axis */
export function canUseFill(
  parentLayout: 'grid' | 'flex' | 'none',
  parentFlexDirection: string,
  axis: 'width' | 'height',
): boolean {
  if (parentLayout !== 'flex') return false;
  // Fill is available on both axes — main axis uses flex grow, cross axis uses 100%
  return true;
}

/** Check if an axis is the main flex axis (uses flex grow) or cross axis (uses 100%) */
export function isMainAxis(parentFlexDirection: string, axis: 'width' | 'height'): boolean {
  const isRow = !parentFlexDirection || parentFlexDirection === 'row' || parentFlexDirection === 'row-reverse';
  return (axis === 'width' && isRow) || (axis === 'height' && !isRow);
}

/** GapHandles wrap gate: is the container effectively WRAPPING for this
 *  viewport? Precedence: the viewport's @media/@container override map
 *  (replica truth — a replica-only `flex-wrap: wrap` must hide the handles,
 *  and an explicit override back to 'nowrap' must re-show them even when the
 *  BASE wraps), then the authored base styles, then the computed fallback
 *  (covers wrap arriving from a code-component stylesheet). */
export function wrapHidesGapHandles(
  replicaOverrides: Map<string, string> | null | undefined,
  baseStyles: Record<string, unknown> | undefined,
  computed: Record<string, string | undefined>,
): boolean {
  const wrap = replicaOverrides?.get('flexWrap') || replicaOverrides?.get('flex-wrap')
    || (baseStyles?.flexWrap as string) || (baseStyles?.['flex-wrap'] as string)
    || computed['flexWrap'] || computed['flex-wrap'] || '';
  return wrap === 'wrap' || wrap === 'wrap-reverse';
}

/** Cross-axis Fill write (SizeTool). On a REPLICA whose @media flipped the
 *  parent's flex-direction, the node's BASE grow flex ('1 0 0px') still
 *  applies there and governs the OTHER axis — pair the dialect's re-base
 *  (flex: '0 0 auto') into the same write so the child doesn't collapse to a
 *  0-basis strip. Primary writes stay single-prop (a grow flex there is the
 *  intentional other-axis Fill). */
export function crossAxisFillPatch(
  axis: 'width' | 'height',
  isReplicaVp: boolean,
  currentFlex: string,
): Record<string, string> {
  const rebase = isReplicaVp && isFillMode(currentFlex);
  return rebase ? { [axis]: '100%', flex: '0 0 auto' } : { [axis]: '100%' };
}

/** Props that only mean anything to a FLOW PARENT — how that parent sizes,
 *  orders and aligns this child. With no flow parent they are dead weight at
 *  best and a lie at worst. The same list is hand-cleared by the Layout tool's
 *  remove-layout path, FrameCreator and the drag lift. */
export const PARENT_FLOW_PROPS = [
  'flex', 'flexGrow', 'flexShrink', 'flexBasis',
  'alignSelf', 'justifySelf', 'order',
  'gridColumn', 'gridRow', 'gridArea',
] as const;

/**
 * Style patch that makes a node valid at CANVAS ROOT, where it has no parent to
 * lay it out. Returns only the keys that actually need changing (`''` = remove).
 *
 * Dragging a flex child out to the canvas kept `flex: '1 0 0px'` — a grow factor
 * with nothing to grow inside (user report 2026-07-26). It survives because every
 * exit path builds its committed styles from position/size only: the strategies
 * DO clear flex, but on the mid-drag LIFT styles (the `zIndex: 9999` DOM
 * overlay), never on the commit.
 *
 * `flex` is normalised rather than deleted: `0 0 auto` is also the value a node
 * needs the moment it's dragged back INTO a flex parent, so the canvas node
 * carries the correct default instead of falling back to CSS's shrinking
 * `0 1 auto`. Everything else is removed outright.
 */
export function canvasRootFlowReset(
  styles: Record<string, string | undefined> | undefined | null,
): Record<string, string> {
  const s = styles ?? {};
  const out: Record<string, string> = {};

  const hasFlex = !!(s.flex || s.flexGrow || s.flexShrink || s.flexBasis);
  if (hasFlex) {
    // Already neutral and with no stray longhands → nothing to write.
    const alreadyNeutral = (s.flex ?? '').trim() === '0 0 auto'
      && !s.flexGrow && !s.flexShrink && !s.flexBasis;
    if (!alreadyNeutral) {
      out.flex = '0 0 auto';
      if (s.flexGrow) out.flexGrow = '';
      if (s.flexShrink) out.flexShrink = '';
      if (s.flexBasis) out.flexBasis = '';
    }
  }

  for (const prop of ['alignSelf', 'justifySelf', 'order', 'gridColumn', 'gridRow', 'gridArea'] as const) {
    if (s[prop]) out[prop] = '';
  }
  return out;
}

/** Is this axis size the tool's CROSS-AXIS fill? `100%` is the only dialect the
 *  editor writes for it (`crossAxisFillPatch`), so match it exactly — a px or
 *  `auto` size is an authored value, not a fill. */
function isCrossAxisFill(size: string | undefined): boolean {
  return (size ?? '').trim() === '100%';
}

function isColumnDir(direction: string | undefined): boolean {
  const v = (direction ?? '').trim();
  return v === 'column' || v === 'column-reverse';
}

/** A flow child's sizing, EFFECTIVE for the tile being edited (base merged with
 *  that viewport's `@media` / variant overrides — a band that already re-based
 *  `flex` must read as re-based, or the flip would clobber it). */
export interface DirectionFlipChild {
  id: string;
  flex?: string;
  width?: string;
  height?: string;
  position?: string;
}

export interface DirectionFlipRebase {
  id: string;
  styles: Record<string, string>;
}

/**
 * Re-express each child's FILL intent when the container's flex-direction
 * flips axis, so "Width: Fill" keeps meaning width.
 *
 * `flex-basis` follows the MAIN AXIS, so a row-authored `flex: 1 0 0px` silently
 * becomes HEIGHT-sharing the moment an `@media` band (or a variant) flips the
 * parent to `column` — basis 0 then grows to fill and OUTRANKS the child's own
 * `height`, so every height edit is a no-op. That was the reported bug: a tablet
 * band held `height: 213px !important` and the card never moved (2026-07-26).
 * The oracle already flags the authored form of this
 * (MEDIA_COLUMN_FLIP_MISSING_REBASE); this is the editor writing what the rule
 * asks for.
 *
 * Fill is a per-DIMENSION idea in the panel ("Width: Fill"), while CSS expresses
 * it per-AXIS: grow on the main axis, `100%` on the cross axis. A flip swaps
 * which is which, so each fill has to change spelling to keep its meaning:
 *
 *   old MAIN fill  (`flex: N 0 0px`) → now the cross axis → `<oldMain>: 100%`
 *                                       + `flex: 0 0 auto` (stop growing, so an
 *                                         explicit size on the new main axis
 *                                         finally applies)
 *   old CROSS fill (`<oldCross>: 100%`) → now the main axis → `flex: 1 0 0px`
 *                                       + clear the stale `100%`
 *
 * That makes a flip-and-flip-back round-trip return the original spelling. A
 * fill MULTIPLIER (`flex: 3 0 0px`) is the one lossy part — proportional sharing
 * only exists on the main axis, so it comes back as `1`.
 *
 * Children that fill NEITHER axis are left alone (nothing to re-express), and
 * out-of-flow children are skipped entirely — `flex` doesn't apply to them.
 */
export function planDirectionFlipRebase(
  children: readonly DirectionFlipChild[],
  fromDirection: string | undefined,
  toDirection: string | undefined,
): DirectionFlipRebase[] {
  const fromCol = isColumnDir(fromDirection);
  const toCol = isColumnDir(toDirection);
  // Same axis (no-op click, or row → row-reverse): nothing rotates.
  if (fromCol === toCol) return [];

  const oldMain: 'width' | 'height' = fromCol ? 'height' : 'width';
  const oldCross: 'width' | 'height' = fromCol ? 'width' : 'height';

  const out: DirectionFlipRebase[] = [];
  for (const child of children) {
    const pos = (child.position ?? '').trim();
    if (pos === 'absolute' || pos === 'fixed') continue;

    const fillsMain = isFillMode((child.flex ?? '').trim());
    const fillsCross = isCrossAxisFill(child[oldCross]);
    if (!fillsMain && !fillsCross) continue;

    const styles: Record<string, string> = {};
    if (fillsMain) {
      // The old main axis becomes the CROSS axis, where fill is spelled `100%` —
      // but only claim it when the child has no size of its own there. Under a
      // grow flex an old-main size was INERT (basis 0 outranks it), so it may
      // hold a stale or authored number; the flip makes it live again rather
      // than overwriting it. That's also what keeps a flip-back non-destructive
      // to a height the user typed on the stacked tile.
      const ownOldMain = (child[oldMain] ?? '').trim();
      if (!ownOldMain || ownOldMain === 'auto') styles[oldMain] = '100%';
      styles.flex = '0 0 auto';
    }
    if (fillsCross) {
      // Wins over the `0 0 auto` above when the child filled BOTH axes: the old
      // cross axis IS the new main axis, and only grow can fill that one.
      styles.flex = makeFillFlex(1);
      styles[oldCross] = '';
    }
    out.push({ id: child.id, styles });
  }
  return out;
}

/**
 * For a MERGED TEMPLATED ROOT reordered on a REPLICA: the page sections (CSS
 * order 0..N-1) share one flex root with the template's locked `layout::`
 * sections (order 0), so they'd collide on the canvas merge. Bracket the
 * `layout::` sections so the page sections always slot BETWEEN them: leading
 * ones (before the first page section) get a very LOW order, trailing ones
 * (after the last) a very HIGH one. Ids KEEP the `layout::` prefix — that's what
 * the canvas merge's prefixed data-ids use (`[data-id="layout::X"]`); the rule is
 * a dead no-op in the deployed page (no such elements there), which doesn't need
 * the bracket anyway (page sections live in their own root div).
 */
export function computeLayoutBrackets(mergedChildren: string[]): { id: string; order: number }[] {
  let firstPageIdx = -1, lastPageIdx = -1;
  mergedChildren.forEach((id, i) => {
    if (!id.startsWith('layout::')) { if (firstPageIdx < 0) firstPageIdx = i; lastPageIdx = i; }
  });
  const brackets: { id: string; order: number }[] = [];
  if (firstPageIdx < 0) return brackets; // no page sections → nothing to slot
  mergedChildren.forEach((id, i) => {
    if (!id.startsWith('layout::')) return;
    if (i < firstPageIdx) brackets.push({ id, order: -100000 + i });   // leading → first
    else if (i > lastPageIdx) brackets.push({ id, order: 100000 + i }); // trailing → last
  });
  return brackets;
}
