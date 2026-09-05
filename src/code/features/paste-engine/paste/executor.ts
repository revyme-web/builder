// executor.ts — Generic paste executor.
//
// Takes a (context, config, idMapper) tuple and creates the nodes. Every
// rule in rules.ts ends up here. This is a single function in Revyme —
// the builder splits this into target-specific handlers because of synced
// viewports and component instances; we don't need that.
//
// Flow:
//   1. Resolve targets via target-resolver.
//   2. Find clipboard root nodes (subtrees pasted as units).
//   3. Calculate position once (canvas-mode) or per-target (sibling/frame).
//   4. createNode() per root → emits queueMutation.
//   5. After all nodes created, run post-paste passes: overlay target remap.

import { trace } from '@/shared/debug-trace';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { isPrimaryViewport } from '@/canvas/node-ops';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { queueReplicaCreationUnhide } from '@/canvas/creators/creator-utils';
import {
  calculatePosition,
  findRootNodes,
} from '../core/position';
import { createNode } from '../core/node-creator';
import { resolveTargets } from '../core/target-resolver';
import { reinjectMotionProps } from './motion-reinject';
import { reinjectResponsiveBands, reinjectBorderOverlays, reinjectPlaceholderStyles } from './border-reinject';
import type {
  ClipboardNode,
  PasteConfig,
  PasteContext,
  PasteTarget,
} from '../types';
import type { IdMapper } from '../core/id-mapper';

// ─── Replica visibility cascade (post-paste) ─────────────────────────────────

/**
 * When the user pastes on a non-primary viewport (tablet, mobile, or a
 * non-default component variant), the new node should be visible ONLY in
 * that viewport. Mirrors the drag system's `getReplicaContext().hideInAllOthers()`
 * exactly:
 *
 *   - Page file + replica viewport → emit `updateContainerStyle` for each
 *     OTHER viewport with `display: none`.
 *   - Component file + replica variant → also emit inline `display: none`
 *     plus `updateVariantStyle` for the dropped variant with `display: ''`,
 *     so the master state hides everywhere by default and only shows in
 *     the target variant.
 *
 * Children inherit visibility from their parent — we only need to apply
 * this to the ROOT pasted nodes (`createdIds`).
 */
function applyReplicaCascade(
  ctx: PasteContext,
  idMapper: IdMapper,
  createdRootIds: string[],
): void {
  const vpId = ctx.interactingVpId;
  if (!vpId || isPrimaryViewport(vpId)) return; // Primary paste — nothing to cascade.

  if (!ctx.viewportWidths || !ctx.activeFilePath) {
    trace.action('paste:cascade-skipped-missing-context', {
      hasWidths: !!ctx.viewportWidths,
      hasFilePath: !!ctx.activeFilePath,
    });
    return;
  }

  const rctx = getReplicaContext(vpId, ctx.activeFilePath, ctx.viewportWidths);

  trace.action('paste:replica-cascade', {
    vpId,
    isComponent: rctx.isComponent,
    rootCount: createdRootIds.length,
    otherViewports: Object.keys(ctx.viewportWidths).filter(v => v !== vpId),
  });

  for (const newId of createdRootIds) {
    if (!rctx.isComponent) {
      // PAGE replica — the drag path's documented trio, parts (1) and (3),
      // which this cascade was missing (only part 2 ran): the duplicate
      // stayed visible on the PRIMARY, because no @container band can hide
      // the primary — only an inline `display: none` can, with the entered
      // band un-hiding it back (live find 2026-09-05: duplicate on tablet
      // hid on mobile but leaked onto desktop).
      //
      // The un-hide restores the node's REAL display (flex/grid from the
      // baked clipboard styles), not a blind `unset` — same contract the
      // creators use, so a duplicated flex card keeps its layout on the
      // tile it was duplicated on.
      const cn = ctx.clipboardNodes.find((n) => idMapper.getNewIdsForClipboard(n.id).includes(newId));
      const enteredWidth = ctx.viewportWidths![vpId];
      queueMutation({ type: 'updateStyles', nodeId: newId, styles: { display: 'none' } });
      if (typeof enteredWidth === 'number') {
        queueReplicaCreationUnhide(newId, vpId, enteredWidth, cn?.styles?.display);
      }
    }
    if (rctx.isComponent) {
      // Component: hide as base inline + show only in target variant.
      // Use `display: 'unset'` for the per-variant un-hide override —
      // empty string in `updateVariantStyleInCode` means "reset
      // override / delete the key", which would drop the entry and
      // make the variant inherit the default's `display: 'none'`.
      // 'unset' is the established convention (see
      // `queueReplicaCreationUnhide` in creator-utils.ts).
      queueMutation({ type: 'updateStyles', nodeId: newId, styles: { display: 'none' } });
      queueMutation({
        type: 'updateVariantStyle',
        nodeId: newId,
        variantName: rctx.variantName ?? vpId,
        styles: { display: 'unset' },
      });
    }

    // Page + component: hide in every OTHER viewport via @container / variant entry.
    for (const update of rctx.hideInAllOthers(newId)) {
      // `PendingUpdate.type` uses 'style' / 'updateContainerStyle' /
      // 'updateVariantStyle'. Map 'style' → mutation queue's 'updateStyles'.
      const u = update as { type: string; nodeId: string; styles?: Record<string, string>; variantName?: string; maxWidth?: number };
      if (u.type === 'updateContainerStyle' && u.styles && typeof u.maxWidth === 'number') {
        queueMutation({ type: 'updateContainerStyle', nodeId: u.nodeId, maxWidth: u.maxWidth, styles: u.styles });
      } else if (u.type === 'updateVariantStyle' && u.styles && u.variantName) {
        queueMutation({ type: 'updateVariantStyle', nodeId: u.nodeId, variantName: u.variantName, styles: u.styles });
      }
    }
  }
}

// ─── Per-target node creation ────────────────────────────────────────────────

/**
 * Create root + descendants in a single target. Builder spreads roots
 * horizontally for canvas paste; we do the same so multi-select copies
 * don't stack on top of each other.
 */
function executeForTarget(
  rootNodes: ClipboardNode[],
  allClipboard: ClipboardNode[],
  target: PasteTarget,
  ctx: PasteContext,
  config: PasteConfig,
  idMapper: IdMapper,
): string[] {
  const createdIds: string[] = [];
  const isCanvasTarget = target.parentId === null;

  // Position is calculated once for canvas mode (we'll offset roots) and
  // not at all for sibling/child mode (insertIndex carries the order).
  const basePos = isCanvasTarget
    ? calculatePosition(ctx, config.positioning, config)
    : null;

  // For abs-in-frame siblings, position-override copies left/top from selected.
  const positionOverride =
    config.positioning === 'at-selected-position' || config.positioning === 'center-in-parent'
      ? calculatePosition(ctx, config.positioning, config)
      : ctx.forceNoLayoutPosition && config.styleTransform === 'to-absolute-in-frame'
        ? ctx.forceNoLayoutPosition
        : undefined;

  let xOffset = 0;
  for (let i = 0; i < rootNodes.length; i++) {
    const root = rootNodes[i];

    let canvasPosition: { x: number; y: number } | undefined;
    if (isCanvasTarget && basePos) {
      canvasPosition = { x: basePos.x + xOffset, y: basePos.y };
      const w = parseFloat(root.styles.width || '200') || 200;
      xOffset += w + (config.gap ?? 100);
    }

    // For sibling paste with multiple roots, increment insertIndex per root
    // so they end up in the same order as selected.
    const target_i: PasteTarget = !isCanvasTarget && target.insertIndex !== undefined
      ? { ...target, insertIndex: target.insertIndex + i }
      : target;

    const newId = createNode({
      clipboardNode: root,
      allClipboardNodes: allClipboard,
      target: target_i,
      ctx,
      idMapper,
      styleTransform: config.styleTransform,
      positionOverride,
      canvasPosition,
    });
    createdIds.push(newId);
  }

  return createdIds;
}

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * Execute a paste with the given config. Returns IDs of root nodes created
 * (children's IDs are inside the AddNodeDef tree but not surfaced here).
 */
export function executePaste(
  ctx: PasteContext,
  config: PasteConfig,
  idMapper: IdMapper,
): string[] {
  trace.fn('executor.executePaste', { targetMode: config.targetMode });

  const targets = resolveTargets(ctx, config.targetMode);
  if (targets.length === 0) {
    trace.action('paste:no-targets', { targetMode: config.targetMode });
    return [];
  }

  const rootNodes = findRootNodes(ctx.clipboardNodes);
  if (rootNodes.length === 0) {
    trace.action('paste:no-roots');
    return [];
  }

  const createdIds: string[] = [];
  for (const target of targets) {
    const ids = executeForTarget(rootNodes, ctx.clipboardNodes, target, ctx, config, idMapper);
    createdIds.push(...ids);
  }

  // Post-paste pass — replica visibility cascade. Overlay reattach (rebuilding
  // the AnimatePresence/useState/positioner machine + repointing both configs to
  // the new IDs) runs as a whole-file pass in `paste/index.ts` AFTER these queued
  // mutations flush, because it's a string transform, not a per-node mutation.
  applyReplicaCascade(ctx, idMapper, createdIds);

  // Post-paste pass — re-inject framer-motion tag props (Appear/Hover/Tap/
  // declarative Loop) for every pasted copy, descendants included. Queued
  // after the addNode mutations, so the same flush applies them in order.
  reinjectMotionProps(ctx.clipboardNodes, idMapper);

  // Post-paste pass — re-inject ::after border-overlay rules under the new
  // ids (the border lives in the <style> block, not on the node — it would
  // silently vanish from every pasted copy otherwise).
  reinjectBorderOverlays(ctx.clipboardNodes, idMapper);

  // Post-paste pass — re-inject ::placeholder rules (Input tool Placeholder
  // Color) under the new ids; same style-block failure mode as the border.
  reinjectPlaceholderStyles(ctx.clipboardNodes, idMapper);

  // Post-paste pass — rebuild per-breakpoint @media overrides under the new
  // ids (same style-block failure mode as the border: the duplicate showed
  // base styles on every replica tile, descendants included).
  reinjectResponsiveBands(ctx.clipboardNodes, idMapper);

  return createdIds;
}
