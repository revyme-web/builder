// paste/index.ts — Paste orchestrator.
//
// Public entrypoint for "user pressed Ctrl+V":
//   1. Build PasteContext from caller-supplied data
//   2. Find matching rule
//   3. Execute via executor
//   4. Return created IDs for the call-site to select

import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';
import type { Transform } from '@/shared/types';
import { findMatchingRule } from './rules';
import { executePaste as executeWithConfig } from './executor';
import { createIdMapper, type IdMapper } from '../core/id-mapper';
import { getClipboardData } from '../copy';
import { injectEffectsBundle } from './effects-injector';
import { modifyProjectFile } from '@/code/project/modify-file';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { projectFS } from '@/code/project/project-fs';
import { reattachPastedOverlayInCode, stripPastedOverlayInCode } from '@/code/generation/overlay-gen';
import { rebuildPastedCollectionInCode } from '@/code/generation/cms-paste-gen';
import { copySlotConnectionsInCode } from '@/code/generation/slot-ops';
import { rehydrateCmsBindings } from '@/code/generation/cms-detach-gen';
import type { OverlayConfig, OverlayTriggerConfig } from '@/shared/types';
import type { ClipboardData, PasteContext, PasteResult } from '../types';

export interface PasteOptions {
  selectedIds: string[];
  nodes: Map<string, CanvasNode>;

  // Optional canvas geometry — without these, 'visible-center' falls back to default position.
  transform?: Transform;
  containerWidth?: number;
  containerHeight?: number;

  // Optional drop overrides (template/toolbar drops).
  forceInsertIndex?: number;
  forcePosition?: { x: number; y: number };
  forceNoLayoutPosition?: { x: number; y: number };

  /**
   * Replica-aware paste: when set to a non-primary viewport, the new node
   * gets `display: none` in every OTHER viewport (via @container CSS for
   * pages, variant entry for components). Same logic as the drag system's
   * `getReplicaContext().hideInAllOthers()` — pasting on tablet should leave
   * the node visible only on tablet.
   */
  interactingVpId?: string;
  viewportWidths?: Record<string, number>;
  activeFilePath?: string;

  /**
   * If provided, skip reading from localStorage and treat this as the
   * clipboard payload. Lets non-paste call sites (cmd+K palette, drag-
   * from-library, drop-from-template) reuse the full paste rule engine
   * without round-tripping through localStorage. The engine treats
   * these nodes identically to user-copied nodes — same target
   * resolution, same positioning rules.
   */
  overrideClipboard?: ClipboardData;
}

/**
 * Read clipboard (or use the override), find rule, execute. Returns
 * created root IDs + the rule that ran (for traces / tests).
 */
export function executePaste(opts: PasteOptions): PasteResult {
  const data = opts.overrideClipboard ?? getClipboardData();
  if (!data || data.nodes.length === 0) {
    return { success: false, createdIds: [], message: 'Empty clipboard' };
  }

  const ctx: PasteContext = {
    selectedIds: opts.selectedIds,
    clipboardNodes: data.nodes,
    nodes: opts.nodes,
    transform: opts.transform,
    containerWidth: opts.containerWidth,
    containerHeight: opts.containerHeight,
    forceInsertIndex: opts.forceInsertIndex,
    forcePosition: opts.forcePosition,
    forceNoLayoutPosition: opts.forceNoLayoutPosition,
    interactingVpId: opts.interactingVpId,
    viewportWidths: opts.viewportWidths,
    activeFilePath: opts.activeFilePath,
  };

  const rule = findMatchingRule(ctx);
  if (!rule) {
    trace.action('paste:no-rule-matched', { selectedIds: opts.selectedIds });
    return { success: false, createdIds: [], message: 'No matching paste rule' };
  }

  trace.action('paste:rule-matched', { ruleId: rule.id, name: rule.name });

  try {
    const idMapper = createIdMapper();
    const createdIds = executeWithConfig(ctx, rule.config, idMapper);
    // Reattach copied overlays. CANVAS targets keep a STATIC canvas overlay (configs
    // repointed via the queue); RUNTIME targets rebuild the AnimatePresence/useState/
    // positioner machine. Runs BEFORE effects — the runtime path goes through
    // `modifyProjectFile` (flush → read → transform), so the effects injector then
    // sees final IDs. (`addNode`/`addCanvasNode` only re-emit the bare overlay.)
    if (opts.activeFilePath) {
      const isCanvasPaste = rule.config.targetMode === 'canvas' || rule.config.targetMode === 'canvas-frame-children';
      rebuildPastedOverlays(ctx, idMapper, opts.activeFilePath, isCanvasPaste);
    }
    // Inject function-scope effects (scroll transforms, tool
    // annotations) if the clipboard carried any. Runs AFTER the
    // JSX mutations are queued because `modifyProjectFile` flushes the
    // queue first — so the file read inside the modifier already has
    // the just-pasted JSX. The injector remaps source-node IDs to the
    // freshly-allocated pasted IDs (`idMapper.getAllMappings()`); IDs
    // not in the map stay verbatim (cross-references that the user
    // declined to copy along — they'll resolve to null on the
    // destination, making those effects no-ops).
    if (data.effects && opts.activeFilePath) {
      injectEffects(data.effects, idMapper, opts.activeFilePath);
    }
    // Rebuild CMS Collection Lists VERBATIM. The engine pasted a plain container
    // (no `.map()` → empty); swap its inner for the captured id-renamed `.map()` JSX
    // + inject pagination hooks + add CMS/LoadMore imports. Runs LAST via
    // modifyProjectFile (flushes the paste mutations first → the plain container is
    // in the code), like the effects/overlay post-steps.
    if (data.collections && data.collections.length > 0 && opts.activeFilePath) {
      injectCollections(data.collections, idMapper, opts.activeFilePath);
    }
    // Re-wire slot connections onto the pasted copies. A `{cn_<id>}` slot
    // reference is a JSX expression child, not a clipboard node, so the
    // rebuilt JSX loses it and a duplicated section's code component comes
    // out with an empty slot ("Connect Content"). The copy points at the
    // SAME hoisted canvas nodes — sharing is what the reference model is
    // for — so the source keeps rendering exactly as before.
    if (opts.activeFilePath) {
      copySlotConnections(idMapper, opts.activeFilePath);
    }
    // Re-bind CMS bindings that copy stashed as `data-cms-orphan`. A paste
    // INSIDE a collection list re-binds to that list's iterator; anywhere else
    // this is a no-op and the copy keeps its "Missing" pill. Exactly the
    // exit/entry pair the drag paths use.
    if (opts.activeFilePath) {
      rehydratePastedCmsBindings(idMapper, opts.activeFilePath);
    }
    return {
      success: true,
      createdIds,
      message: `Pasted ${createdIds.length} via ${rule.id}`,
    };
  } catch (err) {
    trace.error('paste:exec-failed', err);
    return {
      success: false,
      createdIds: [],
      message: err instanceof Error ? err.message : 'Paste failed',
    };
  }
}

// ─── Overlay reattach helper ────────────────────────────────────────────────

/**
 * Rebuild every copied overlay against its pasted trigger. For each clipboard
 * trigger that pointed at an overlay, look up the new pasted IDs (trigger + overlay)
 * from the idMapper and read both configs off the copied attrs.
 *
 *   - CANVAS paste (`isCanvasPaste`): the overlay stays a STATIC canvas overlay. We
 *     repoint both configs (`data-overlay-trigger.targetId` + `data-overlay.triggerId`)
 *     to the new IDs via QUEUED `updateHtmlAttrs` — these flush WITH the pending
 *     `addCanvasNode` mutations, so the structural-flush heals see a consistent
 *     trigger↔overlay pair and don't prune the pasted overlay copy (it would otherwise
 *     be pruned as a duplicate of the source same-file, or an orphan cross-file). No
 *     runtime machine, children preserved. Works same-file AND across files.
 *   - RUNTIME paste (viewport / variant / replica / sibling): rebuild the full
 *     AnimatePresence + useState + positioner machine via `reattachPastedOverlayInCode`
 *     in a whole-file `modifyProjectFile` pass (flushes the paste mutations first).
 *
 * 1-to-1 ID mapping (Revyme has no synced viewports).
 */
function rebuildPastedOverlays(
  ctx: PasteContext,
  idMapper: IdMapper,
  destFilePath: string,
  isCanvasPaste: boolean,
): void {
  const mappings = idMapper.getAllMappings();
  if (mappings.size === 0) return;

  // A DESIGN-COMPONENT MASTER (`export default withResponsiveProps(...)`) does NOT
  // resolve FIXED (full-viewport modal) overlays — a modal inside a variant makes no
  // sense. So any pasted fixed overlay here (on a normal node OR a component instance)
  // is STRIPPED: the overlay element is dropped and the trigger becomes a plain node.
  // On a PAGE, fixed overlays paste/duplicate normally.
  const destIsComponentMaster = /export\s+default\s+withResponsiveProps\s*\(/.test(
    projectFS.readFile(destFilePath) ?? '',
  );

  const runtimePairs: Array<{
    newTriggerId: string;
    newOverlayId: string;
    overlayConfig: OverlayConfig;
    triggerConfig: OverlayTriggerConfig;
  }> = [];
  const stripPairs: Array<{ newTriggerId: string; newOverlayId: string }> = [];

  for (const cn of ctx.clipboardNodes) {
    if (!cn.overlayTriggerTargetId) continue;
    const newTriggerId = mappings.get(cn.id)?.[0];
    const newOverlayId = mappings.get(cn.overlayTriggerTargetId)?.[0];
    if (!newTriggerId || !newOverlayId) continue;

    const overlayCn = ctx.clipboardNodes.find(n => n.id === cn.overlayTriggerTargetId);
    let triggerConfig: OverlayTriggerConfig;
    let overlayConfig: OverlayConfig;
    try { triggerConfig = JSON.parse(cn.attrs?.['data-overlay-trigger'] || '{}'); } catch { continue; }
    try { overlayConfig = JSON.parse(overlayCn?.attrs?.['data-overlay'] || '{}'); } catch { continue; }
    if (!overlayConfig.type) continue; // not a real overlay node

    if (destIsComponentMaster && overlayConfig.type === 'fixed') {
      stripPairs.push({ newTriggerId, newOverlayId });
    } else if (isCanvasPaste) {
      // Repoint both configs BEFORE the structural heals run (same flush) so the
      // static canvas overlay copy isn't pruned. Canvas paste already forced the
      // overlay element to `position: absolute` + `data-canvas-node`.
      queueMutation({
        type: 'updateHtmlAttrs',
        nodeId: newTriggerId,
        attrs: { 'data-overlay-trigger': JSON.stringify({ ...triggerConfig, targetId: newOverlayId }) },
      });
      queueMutation({
        type: 'updateHtmlAttrs',
        nodeId: newOverlayId,
        attrs: { 'data-overlay': JSON.stringify({ ...overlayConfig, triggerId: newTriggerId }) },
      });
    } else {
      runtimePairs.push({ newTriggerId, newOverlayId, overlayConfig, triggerConfig });
    }
  }

  // Canvas repoints are queued (flush with addCanvasNode). Runtime reattach + fixed
  // strips run as a single whole-file pass (flushes the paste mutations first).
  if (runtimePairs.length === 0 && stripPairs.length === 0) {
    if (isCanvasPaste) trace.action('paste:overlays-repointed-canvas', {});
    return;
  }

  modifyProjectFile(destFilePath, code => {
    let c = code;
    for (const p of runtimePairs) {
      c = reattachPastedOverlayInCode(c, p.newTriggerId, p.newOverlayId, p.overlayConfig, p.triggerConfig);
    }
    for (const p of stripPairs) {
      c = stripPastedOverlayInCode(c, p.newTriggerId, p.newOverlayId);
    }
    return c;
  });
  trace.action('paste:overlays-processed', { reattached: runtimePairs.length, strippedFixed: stripPairs.length });
}

// ─── Effects injection helper ──────────────────────────────────────────────

/**
 * Flatten the (oldId → newId[]) mapping into a single (oldId → newId)
 * map and run the effects injector through `modifyProjectFile`, which
 * flushes the mutation queue first, reads fresh code, runs the
 * transform, then re-syncs imports + the queue. Effects code that
 * references hooks (`useScroll`, `useTransform`, `useSpring`) lands in
 * the import lines automatically via `syncImports`.
 */
function injectEffects(
  effects: NonNullable<ClipboardData['effects']>,
  idMapper: IdMapper,
  destFilePath: string,
): void {
  const flatIdMap = new Map<string, string>();
  for (const [oldId, newIds] of idMapper.getAllMappings()) {
    // Revyme is 1-to-1 (no per-viewport synced IDs) — pick the
    // first new ID. If a future change introduces multi-mapping the
    // injector will still produce sensible output by remapping all
    // owned-id occurrences to the first dest.
    if (newIds.length > 0) flatIdMap.set(oldId, newIds[0]);
  }

  if (flatIdMap.size === 0) {
    trace.action('paste:effects-skip-no-id-map');
    return;
  }

  try {
    modifyProjectFile(destFilePath, code => injectEffectsBundle(code, effects, flatIdMap));
    trace.action('paste:effects-injected', {
      slices: effects.sourceSlices.length,
      idMapSize: flatIdMap.size,
    });
  } catch (err) {
    trace.error('paste:effects-inject-failed', err);
  }
}

// ─── CMS Collection List rebuild helper ─────────────────────────────────────

/**
 * Re-insert every copied CMS Collection List VERBATIM. For each captured list,
 * swap the plain pasted container's inner content for the exact id-renamed `.map()`
 * JSX, inject the (renamed) pagination hooks, and add the CMS/LoadMore imports —
 * in one whole-file pass (modifyProjectFile flushes the paste mutations first, so the
 * plain container is already in the code). The id map is the engine's oldId→newId
 * (flattened 1-to-1).
 */
function injectCollections(
  collections: NonNullable<ClipboardData['collections']>,
  idMapper: IdMapper,
  destFilePath: string,
): void {
  const flatIdMap = new Map<string, string>();
  for (const [oldId, newIds] of idMapper.getAllMappings()) {
    if (newIds.length > 0) flatIdMap.set(oldId, newIds[0]);
  }
  if (flatIdMap.size === 0) return;
  try {
    modifyProjectFile(destFilePath, code => {
      let c = code;
      for (const cap of collections) c = rebuildPastedCollectionInCode(c, cap, flatIdMap);
      return c;
    });
    trace.action('paste:collections-rebuilt', { count: collections.length, idMapSize: flatIdMap.size });
  } catch (err) {
    trace.error('paste:collections-rebuild-failed', err);
  }
}

/**
 * Mirror slot connections from each copied element onto its pasted copy.
 *
 * Whole-file `modifyProjectFile` pass like the overlay / effects / collection
 * steps above (the flush puts the pasted JSX in the code before we read it).
 * `copySlotConnectionsInCode` filters the pairs itself and returns the code
 * untouched — no babel reprint — when nothing in the paste was wired.
 */
function copySlotConnections(idMapper: IdMapper, destFilePath: string): void {
  const pairs: Array<{ fromId: string; toId: string }> = [];
  for (const [oldId, newIds] of idMapper.getAllMappings()) {
    if (newIds.length > 0) pairs.push({ fromId: oldId, toId: newIds[0] });
  }
  if (pairs.length === 0) return;
  try {
    modifyProjectFile(destFilePath, code => copySlotConnectionsInCode(code, pairs));
    trace.action('paste:slot-connections-copied', { pairs: pairs.length });
  } catch (err) {
    trace.error('paste:slot-connections-copy-failed', err);
  }
}

/**
 * Rehydrate the CMS bindings copy stashed on each pasted node.
 *
 * `rehydrateCmsBindings` finds the node's ENCLOSING `.map()` iterator and
 * re-emits `{iter.field}` for every `data-cms-orphan` entry, dropping the
 * stash. It returns the code untouched when the node isn't inside a `.map()`,
 * so a paste onto the canvas simply keeps the dormant "Missing" state — the
 * same asymmetry the drag-out / drag-in strategies rely on.
 */
function rehydratePastedCmsBindings(idMapper: IdMapper, destFilePath: string): void {
  const newIds: string[] = [];
  for (const [, ids] of idMapper.getAllMappings()) newIds.push(...ids);
  if (newIds.length === 0) return;
  try {
    modifyProjectFile(destFilePath, code => {
      // Cheap gate — the stash attr is the only thing this pass acts on.
      if (!code.includes('data-cms-orphan')) return code;
      let c = code;
      for (const id of newIds) c = rehydrateCmsBindings(c, id);
      return c;
    });
    trace.action('paste:cms-bindings-rehydrated', { nodes: newIds.length });
  } catch (err) {
    trace.error('paste:cms-rehydrate-failed', err);
  }
}

// Re-exports so call-sites can pick a single import path.
export { findMatchingRule, getRuleById } from './rules';
export { conditionCheckers, checkConditions } from './conditions';
