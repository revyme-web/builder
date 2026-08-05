// layout-injection.ts — shared helper for "add a flex layout to this frame +
// reflow its children to flow children".
//
// Two callers wire to this:
//   1. LayoutTool's `+` button on the Layout section header.
//   2. SizeTool when the user switches Width or Height to `auto` on a
//      no-layout frame that has children — auto-sizing only makes sense
//      when children participate in normal flow, so we silently inject
//      the layout instead of leaving the frame to collapse to 0.
//
// Behavior matches LayoutTool's "add layout" branch exactly:
//   - Each child gets `position: relative`, `left/top/right/bottom` cleared,
//     non-px dimensions resolved to px, flex shorthand cleared, transform
//     translate stripped, then `flex: '0 0 auto'` so siblings don't squish.
//   - Parent gets `display: flex; flex-direction: column; align-items: center;
//     justify-content: center` — a sensible default the user can re-tune
//     via the Layout panel after.
//
// The flush is the caller's responsibility — LayoutTool wants synchronous
// flushNow for instant panel feedback, SizeTool may want to bundle the
// width/height write into the same flush.

import type { CanvasNode } from '@/code/parsing/parser';
import { updateNodeStyles, getContentRoot, findNodeSize, findNodeComputedStyle } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { isFitSize, isPrimaryViewport } from '@/shared/constants';
import { planDirectionFlipRebase, isMainAxis, isFillMode } from '@/shared/flex-helpers';
import { resolveEffectiveStylesForViewport } from '@/code/stores/container-query-store';
import type { ContainerOverrideMap } from '@/code/stores/container-query-store';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';

// ─── Gate ────────────────────────────────────────────────────────────────────

/**
 * Tags that MUST NOT be auto-converted into flex containers when the
 * user switches W/H to `auto`. These render text inline by default;
 * forcing flex on them would break their flow + cause the renderer to
 * produce surprising boxes around their text. Keep the list tight —
 * a frame-y `<section>` / `<div>` is still a candidate.
 */
const TEXT_LIKE_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'a', 'li', 'label', 'blockquote',
]);

/**
 * Decide whether a frame should be auto-converted to flex when the
 * user switches its W or H to `auto`. Skip when:
 *
 *   • The frame has no children (auto on an empty frame is fine —
 *     nothing to reflow, and adding flex would change nothing).
 *   • The frame already has a flex/grid layout (the user explicitly
 *     opted in; `auto` works with their existing layout).
 *   • The frame's tag is text-like (auto on `<p>` is meaningful — its
 *     own intrinsic content sets the size — and adding flex would
 *     break inline text flow).
 *
 * The matching `injectFlexLayoutOnFrame` call should follow.
 */
export function shouldInjectLayoutOnAuto(
  node: CanvasNode | undefined,
  currentDisplay: string,
): boolean {
  if (!node) return false;
  if (node.children.length === 0) return false;
  // Component instances own their layout in the MASTER file. The instance
  // wrapper carries none of the master root's display/flex-direction, so
  // injecting `display:flex; flex-direction:column; align-items/justify:center`
  // here would land on the instance tag and OVERRIDE the master's own layout
  // (e.g. a row button becomes a vertical stack). the reference never reflows an
  // instance's internals when you resize it from the outside — skip injection.
  if (node.componentFile != null) {
    trace.action('layout-injection:skip-instance', { nodeId: node.id, componentFile: node.componentFile });
    return false;
  }
  const d = (currentDisplay ?? '').trim();
  if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid') return false;
  const tag = (node.type ?? '').toLowerCase();
  if (TEXT_LIKE_TAGS.has(tag)) return false;
  return true;
}

/**
 * The frames one "add layout" action should target.
 *
 * `injectFlexLayoutOnFrame` does BOTH halves of the job for a single frame — the
 * container's flex props AND the absolute→relative reflow of its children — so,
 * unlike a plain style write, it does NOT fan out through `ControlProvider`.
 * Calling it with only the primary laid out that one frame and left every other
 * selected frame's children absolutely positioned inside a flex box (user report
 * 2026-07-25).
 *
 * Ids are de-duplicated and re-validated against the snapshot; the primary is
 * always included even if the selection array is stale. A nested pair (a selected
 * frame that is itself a child of another selected frame) is fine — the parent
 * pass rewrites the child's own position, the child pass rewrites its children's.
 */
export function resolveLayoutInjectionTargets(
  primaryId: string,
  selectedIds: readonly string[],
  nodes: Map<string, CanvasNode>,
): string[] {
  const ids = selectedIds.length > 1 ? [primaryId, ...selectedIds] : [primaryId];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id) || !nodes.get(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A node's rendered CSS-layout px on one axis — CANVAS-SCALE INDEPENDENT.
 *  `findNodeSize` returns the bridge rect, which is in parent-frame SCREEN
 *  space (the canvas transform applied) — freezing children from it at 50%
 *  zoom wrote half the true size (user report 2026-07-29). Prefer the
 *  iframe's computed style (layout px, unscaled); fall back to the rect
 *  divided by the current canvas scale when the computed cache is cold. */
function measureCssPx(nodeId: string, vpId: string, axis: 'width' | 'height'): number | null {
  const computed = parseFloat(findNodeComputedStyle(nodeId, vpId, axis));
  if (Number.isFinite(computed) && computed > 0) return computed;
  const screenPx = findNodeSize(nodeId, vpId)[axis];
  if (!Number.isFinite(screenPx) || screenPx <= 0) return null;
  const scale = transformManager.getTransform().scale || 1;
  return screenPx / scale;
}

/** PURE planning half of `freezeParentRelativeChildrenForAuto` — unit tested.
 *  For each direct FLOW child, decide whether its size on `axis` is
 *  parent-relative (`%`) or a grow-FILL on the frame's own main axis, and if
 *  so what px patch freezes it. `measure` returns the child's CURRENT
 *  rendered px on that axis. */
export function planChildAutoFreeze(args: {
  axis: 'width' | 'height';
  /** The frame's OWN flexDirection (children fill along ITS main axis —
   *  NOT the frame's placement axis in its parent). CSS default is 'row'. */
  frameFlexDirection: string;
  children: Array<{ id: string; styles: Record<string, string> | undefined }>;
  measure: (id: string) => number | null;
}): Array<{ id: string; styles: Record<string, string> }> {
  const axisIsMain = isMainAxis(args.frameFlexDirection || 'row', args.axis);
  const out: Array<{ id: string; styles: Record<string, string> }> = [];
  for (const c of args.children) {
    const s = c.styles ?? {};
    const pos = (s.position ?? '').trim();
    // Absolute/fixed children don't drive the parent's auto size — % of an
    // auto parent is their own (pre-existing) problem, not a collapse vector.
    if (pos === 'absolute' || pos === 'fixed') continue;
    const authored = (s[args.axis] ?? '').trim();
    const isPercent = /%$/.test(authored);
    const isFill = axisIsMain && isFillMode(s.flex ?? '');
    if (!isPercent && !isFill) continue;
    const px = args.measure(c.id);
    if (px == null || !Number.isFinite(px) || px <= 0) continue;
    const styles: Record<string, string> = { [args.axis]: `${Math.round(px)}px` };
    if (isFill) styles.flex = '0 0 auto';
    out.push({ id: c.id, styles });
  }
  return out;
}

/**
 * When switching a frame's width/height to auto/fit while it ALREADY has a
 * layout (so `injectFlexLayoutOnFrame` — which does this conversion as part
 * of injection — never runs), direct flow children sized in `%` (or FILL
 * grow-flex on the frame's own main axis) make that axis CIRCULAR: 90% of an
 * auto parent resolves to 0 and the whole frame collapses (user report
 * 2026-07-29: 1440px flex parent + 90%-wide child → width auto → collapse).
 * Freeze those children to their current rendered px on that axis first.
 * Returns the converted child ids (empty = nothing needed).
 */
export function freezeParentRelativeChildrenForAuto(
  nodeId: string,
  axis: 'width' | 'height',
  nodes: Map<string, CanvasNode>,
  vpId: string = 'desktop',
): string[] {
  const contentEl = getContentRoot();
  const node = nodes.get(nodeId);
  if (!contentEl || !node) return [];
  const patches = planChildAutoFreeze({
    axis,
    frameFlexDirection: node.styles?.flexDirection ?? 'row',
    children: node.children
      .map((id) => nodes.get(id))
      .filter((c): c is CanvasNode => !!c)
      .map((c) => ({ id: c.id, styles: c.styles })),
    measure: (id) => measureCssPx(id, vpId, axis),
  });
  for (const p of patches) {
    updateNodeStyles({ id: p.id, styles: p.styles, contentEl });
  }
  if (patches.length > 0) {
    trace.action('layout-injection:auto-freeze-children', {
      nodeId, axis, ids: patches.map((p) => p.id),
    });
  }
  return patches.map((p) => p.id);
}

export function injectFlexLayoutOnFrame(
  nodeId: string,
  nodes: Map<string, CanvasNode>,
  vpId: string = 'desktop',
): void {
  const contentEl = getContentRoot();
  if (!contentEl) return;
  const node = nodes.get(nodeId);
  if (!node) return;

  // PARENT FIRST — the ordering is load-bearing. Each child conversion below
  // clears left/top/right/bottom, and updateNodeStyles' style-override-removal
  // path synchronously flushes + force-renders the code AS QUEUED SO FAR. With
  // children first, that render shipped the half-converted state — child
  // `position:relative` inside a NOT-yet-flex parent — and the child visibly
  // flashed at the parent's 0,0 before the flex centering landed (user trace
  // 2026-08-05). Parent first, every mid-injection flush renders a flex parent:
  // still-absolute children ignore it (identical to the pre-action frame) and
  // converted children center immediately.
  //
  // If the element is currently hidden (`display: 'none'`), don't
  // overwrite `display` here — Visible:No must stay independent of
  // Layout config (standard). The flex props alone are enough;
  // a later unhide auto-restores `display: 'flex'` via
  // `updateNodeStyles`'s auto-display-restore.
  const isHidden = node.styles?.display === 'none';
  const layoutStyles: Record<string, string> = {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
  };
  if (!isHidden) layoutStyles.display = 'flex';
  updateNodeStyles({
    id: nodeId,
    styles: layoutStyles,
    contentEl,
  });

  // REPLICA NEUTRALIZATION — on a non-primary viewport the '' clears below
  // only DELETE this vp's band override, and the PRIMARY's absolute-layout
  // left/top/transform cascade straight back into the now-relative child
  // (left/top/translate offset `position: relative` elements too), shoving
  // it out of the injected layout (user report 2026-08-05: tablet-only
  // layout, child kept desktop's left:50% + top:120px + translateX(-50%)).
  // Any base-carried inset/transform gets an explicit NEUTRAL override in
  // this vp's band instead of a removal. Primary keeps '' (real removal).
  const neutralize = !isPrimaryViewport(vpId);

  const childIds: string[] = [];
  for (const childId of node.children) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    const childNodeStyles = childNode.styles;

    const childStyles: Record<string, string> = {
      position: 'relative',
      left: neutralize && childNodeStyles.left ? 'auto' : '',
      top: neutralize && childNodeStyles.top ? 'auto' : '',
      right: neutralize && childNodeStyles.right ? 'auto' : '',
      bottom: neutralize && childNodeStyles.bottom ? 'auto' : '',
    };

    // Lock %/vw/etc. (parent-relative) to px when entering layout, but KEEP
    // auto/min-content/fit-content (isFitSize) — they hug content inside flex.
    // measureCssPx, not findNodeSize: the raw bridge rect is canvas-scaled,
    // so locking at 50% zoom froze half the true size (same class as the
    // auto-freeze zoom bug, 2026-07-29).
    if (childNodeStyles.width && !isFitSize(childNodeStyles.width) && !childNodeStyles.width.endsWith('px')) {
      const px = measureCssPx(childId, vpId, 'width');
      if (px != null) childStyles.width = `${Math.round(px)}px`;
    }
    if (childNodeStyles.height && !isFitSize(childNodeStyles.height) && !childNodeStyles.height.endsWith('px')) {
      const px = measureCssPx(childId, vpId, 'height');
      if (px != null) childStyles.height = `${Math.round(px)}px`;
    }

    if (childNodeStyles.flex) childStyles.flex = '';
    if (childNodeStyles.flexGrow) childStyles.flexGrow = '';
    if (childNodeStyles.flexShrink) childStyles.flexShrink = '';
    if (childNodeStyles.flexBasis) childStyles.flexBasis = '';
    // A base alignSelf must be MASKED on a replica ('auto' = flex initial),
    // same reasoning as the insets above.
    if (childNodeStyles.alignSelf) childStyles.alignSelf = neutralize ? 'auto' : '';

    if (childNodeStyles.transform) {
      const stripped = childNodeStyles.transform
        .replace(/translate[XY]?\([^)]*\)/g, '')
        .replace(/translate3d\([^)]*\)/g, '')
        .trim();
      // Replica + fully-translate transform: '' would just drop the band
      // entry and the base translate would re-apply — write 'none' to mask
      // it. A residual (rotate/scale) part is written as-is on both paths.
      childStyles.transform = stripped || (neutralize ? 'none' : '');
    }

    updateNodeStyles({
      id: childId,
      styles: { ...childStyles, flex: '0 0 auto' },
      contentEl,
    });
    childIds.push(childId);
  }

  trace.action('layout-injection:add', { nodeId, childCount: childIds.length, isHidden });
}

// ─── Direction flip ──────────────────────────────────────────────────────────

/**
 * Flipping a container's flex-direction rotates the axis its children's `flex`
 * shorthand applies to — re-base them so their FILL keeps its dimension.
 *
 * Called alongside the `flexDirection` write (LayoutTool's Direction row).
 * Without it, a row-authored `flex: 1 0 0px` child becomes height-sharing under
 * a `column` flip and its `height` stops applying entirely — the reported
 * "height says 213px but nothing moves" (2026-07-26). Users were working around
 * it by hitting Width → Fill, which pairs the same re-base in via
 * `crossAxisFillPatch`; this makes the flip do it up front.
 *
 * Writes route through `getReplicaContext().styleUpdate` — the same router the
 * parent's direction write uses — so the child overrides land in the SAME scope:
 * a page replica's `@media` band (which is what the dialect requires: re-base
 * next to the flip, not on the base), a component variant's per-variant channel,
 * or plain base styles on the primary.
 *
 * `overrides` comes from `containerOverridesAtom` — passed in rather than read
 * here so this stays callable outside React (and testable without a store).
 *
 * Returns how many children were re-based.
 */
export function rebaseChildrenForDirectionFlip(opts: {
  nodeId: string;
  fromDirection: string;
  toDirection: string;
  vpId: string;
  nodes: Map<string, CanvasNode>;
  overrides: ContainerOverrideMap;
  vpWidths: Record<string, number>;
  activeFilePath: string;
}): number {
  const { nodeId, fromDirection, toDirection, vpId, nodes, overrides, vpWidths, activeFilePath } = opts;
  const node = nodes.get(nodeId);
  if (!node) return 0;

  // Read each child's EFFECTIVE sizing for the tile being edited: a band that
  // already carries `flex: 0 0 auto` (hand-fixed, or from a Fill write) must not
  // be re-based off its stale BASE fill. The primary has no band by definition.
  const isPrimary = isPrimaryViewport(vpId);
  const vpWidth = isPrimary ? undefined : (vpWidths[vpId] ?? 0);
  const children = [];
  for (const childId of node.children) {
    const child = nodes.get(childId);
    if (!child) continue;
    const eff = resolveEffectiveStylesForViewport(child.styles, childId, vpWidth, overrides);
    children.push({
      id: childId,
      flex: eff.flex,
      width: eff.width,
      height: eff.height,
      position: eff.position,
    });
  }

  const plan = planDirectionFlipRebase(children, fromDirection, toDirection);
  trace.action('layout-injection:direction-flip-rebase', {
    nodeId, fromDirection, toDirection, vpId, isPrimary, vpWidth,
    childCount: children.length, rebasedCount: plan.length,
    plan: plan.map(p => ({ id: p.id, styles: p.styles })),
  });
  if (plan.length === 0) return 0;

  const ctx = getReplicaContext(vpId, activeFilePath, vpWidths);
  for (const entry of plan) {
    for (const update of ctx.styleUpdate(entry.id, entry.styles)) {
      queueMutation(update as Parameters<typeof queueMutation>[0]);
    }
  }
  return plan.length;
}
