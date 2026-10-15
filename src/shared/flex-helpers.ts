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

/** Cross-axis Fill write (SizeTool, the agent's set_size_units). Spelled per AXIS:
 *
 *  HEIGHT (a row parent) — `alignSelf: 'stretch'` + `height: auto`, Framer's spelling.
 *  A percentage height needs a DEFINITE parent height, so in a row that hugs
 *  (`height: min-content`, the default for a stack) `100%` resolves to auto and an
 *  empty child collapsed to 0 (user report 2026-09-29). Stretch fills the flex line —
 *  the parent's own height when it is fixed, the tallest sibling when it hugs. The
 *  size must be `auto` (min-content blocks the stretch); `auto` rather than removed
 *  so a REPLICA's band overrides a base size too.
 *
 *  WIDTH (a column parent) — `width: '100%'`. A percentage width always resolves
 *  (the parent's width is settled before its children's), so it never had that
 *  collapse, and it keeps the PARENT's align-items in charge: with a `maxWidth` the
 *  child centres under `alignItems: center`. A stretch can't — `align-self: stretch`
 *  overrides the parent's alignment and a capped stretched item sits at the start
 *  edge (a 1280px header pinned left on a 1412px screen, 2026-10-15). A stretch the
 *  2026-09-29..10-15 writer left there (`currentAlignSelf`) is dropped with the
 *  write — `auto` on a replica, so a base stretch is overridden, not just unset.
 *
 *  On a REPLICA whose @media flipped the parent's flex-direction, the node's BASE
 *  grow flex ('1 0 0px') still applies there and governs the OTHER axis — pair the
 *  dialect's re-base (flex: '0 0 auto') into the same write so the child doesn't
 *  collapse to a 0-basis strip. Primary writes don't (a grow flex there is the
 *  intentional other-axis Fill). */
export function crossAxisFillPatch(
  axis: 'width' | 'height',
  isReplicaVp: boolean,
  currentFlex: string,
  currentAlignSelf?: string,
): Record<string, string> {
  const patch: Record<string, string> = axis === 'width'
    ? { width: '100%' }
    : { height: 'auto', alignSelf: 'stretch' };
  if (axis === 'width' && (currentAlignSelf ?? '').trim() === 'stretch') patch.alignSelf = isReplicaVp ? 'auto' : '';
  if (isReplicaVp && isFillMode(currentFlex)) patch.flex = '0 0 auto';
  return patch;
}

/** Does the Size panel read this axis as a CROSS-axis Fill? Height: the stretch
 *  crossAxisFillPatch writes (a `100%` height is the % it is — it may be collapsing).
 *  Width: `100%`, or the stretch spelling written 2026-09-29..10-15. */
export function isCrossAxisFillFor(axis: 'width' | 'height', alignSelf: string | undefined, size: string | undefined): boolean {
  if (axis === 'width' && (size ?? '').trim() === '100%') return true;
  return isCrossAxisStretchFill(alignSelf, size);
}

/** Is this axis the CROSS-axis Fill crossAxisFillPatch writes — `alignSelf: 'stretch'`
 *  with no size of its own there (absent / `auto`)? A size (px, %, min-content) wins
 *  over the stretch in CSS, so it isn't a fill. */
export function isCrossAxisStretchFill(alignSelf: string | undefined, size: string | undefined): boolean {
  const s = (size ?? '').trim();
  return (alignSelf ?? '').trim() === 'stretch' && (s === '' || s === 'auto');
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

/** Is this axis the tool's CROSS-AXIS fill? Either spelling crossAxisFillPatch has
 *  written on either axis: a stretch, or `100%` (width today; height before
 *  2026-09-29, still in existing files). A px or plain `auto` size is an authored
 *  value, not a fill. */
function isCrossAxisFill(size: string | undefined, alignSelf?: string): boolean {
  return (size ?? '').trim() === '100%' || isCrossAxisStretchFill(alignSelf, size);
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
  alignSelf?: string;
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
 * it per-AXIS: grow on the main axis, a stretch on the cross axis
 * (crossAxisFillPatch). A flip swaps which is which, so each fill has to change
 * spelling to keep its meaning:
 *
 *   old MAIN fill  (`flex: N 0 0px`) → now the cross axis → crossAxisFillPatch's
 *                                       spelling (`width: 100%`, or `height: auto`
 *                                       + `alignSelf: stretch`) + `flex: 0 0 auto`
 *                                       (stop growing, so an explicit size on the
 *                                       new main axis finally applies)
 *   old CROSS fill (stretch, or a legacy `<oldCross>: 100%`) → now the main axis
 *                                       → `flex: 1 0 0px` + clear the stale size
 *                                       and stretch
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
    const fillsCross = isCrossAxisFill(child[oldCross], child.alignSelf);
    if (!fillsMain && !fillsCross) continue;

    const styles: Record<string, string> = {};
    if (fillsMain) {
      // The old main axis becomes the CROSS axis, where fill is spelled by
      // crossAxisFillPatch — but only claim it when the child has no size of its
      // own there. Under a grow flex an old-main size was INERT (basis 0 outranks
      // it), so it may hold a stale or authored number; the flip makes it live
      // again rather than overwriting it. That's also what keeps a flip-back
      // non-destructive to a height the user typed on the stacked tile.
      const ownOldMain = (child[oldMain] ?? '').trim();
      if (!ownOldMain || ownOldMain === 'auto') Object.assign(styles, crossAxisFillPatch(oldMain, false, '', child.alignSelf));
      styles.flex = '0 0 auto';
    }
    if (fillsCross) {
      // Wins over the `0 0 auto` above when the child filled BOTH axes: the old
      // cross axis IS the new main axis, and only grow can fill that one.
      styles.flex = makeFillFlex(1);
      styles[oldCross] = '';
      // The stretch was the cross-axis fill — unless the old main fill just claimed it.
      if (!fillsMain && (child.alignSelf ?? '').trim() === 'stretch') styles.alignSelf = '';
    }
    out.push({ id: child.id, styles });
  }
  return out;
}

/** A CSS `order` value as the flex algorithm reads it (unset / unparseable → 0). */
export function cssOrderValue(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The children of the template node that holds `{children}`, with the page's
 * sections spliced in — in the order the LIVE site PAINTS them. Live,
 * `{children}` is one flex item (the page root) among the template's own
 * children, and flex paints by `order`, then source order: a navbar written
 * AFTER `{children}` with `order: -1` (sticky on top) paints BEFORE the page.
 * The canvas merge flattens the page's sections into that column and brackets
 * the chrome by ARRAY position (computeLayoutBrackets), so the array must be in
 * paint order — in source order the navbar counted as trailing chrome, its
 * `order: -1` was overwritten with a very high one, and the page's content
 * painted above the header on the canvas (user report 2026-09-29).
 *
 * `templateKids` are the template's (unprefixed) ids in source order,
 * `slotIndex` how many of them come before `{children}`, `slotOrder` the page
 * root's own `order` (the `{children}` flex item). Returns merged ids: template
 * ids `layout::`-prefixed, page section ids as given.
 */
export function mergeTemplateChildren(
  templateKids: string[],
  slotIndex: number,
  pageSectionIds: string[],
  orderOf: (templateKid: string) => number,
  slotOrder: number,
): string[] {
  const SLOT = '\u0000children';
  const seq = templateKids.map((id, i) => ({ id, order: orderOf(id), src: i < slotIndex ? i : i + 1 }));
  seq.push({ id: SLOT, order: slotOrder, src: slotIndex });
  seq.sort((a, b) => a.order - b.order || a.src - b.src);
  return seq.flatMap((e) => (e.id === SLOT ? pageSectionIds : ['layout::' + e.id]));
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
