// paste/index.ts — Paste orchestrator.
//
// Public entrypoint for "user pressed Ctrl+V":
//   1. Build PasteContext from caller-supplied data
//   2. Find matching rule
//   3. Execute via executor
//   4. Return created IDs for the call-site to select

import { reinjectTranslations } from './translations-reinject';
import { wouldCreateComponentCycle } from '@/code/components/component-cycle';
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
import { isOverlayNode, parseOverlayTriggerCalls } from '@/code/parsing/overlay-parser';
import { rebuildPastedCollectionInCode } from '@/code/generation/cms-paste-gen';
import { copySlotConnectionsInCode } from '@/code/generation/slot-ops';
import { rehydrateCmsBindings } from '@/code/generation/cms-detach-gen';
import { addTextAnimInCode } from '@/code/generation/text-anim-gen';
import { setCodeOverridesInCode } from '@/code/generation/code-override-gen';
import { setTickerInCode } from '@/code/generation/ticker-gen';
import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';
import type { OverlayConfig, OverlayTriggerConfig } from '@/shared/types';
import type { ClipboardData, PasteContext, PasteResult, ClipboardNode } from '../types';

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

  /** Does the selected node's parent lay out ON THE ACTIVE VIEWPORT? Resolved
   *  by the caller from the rendered element; see PasteContext.parentHasLayout. */
  parentHasLayout?: boolean;

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

  // A clipboard that carries an instance of the ACTIVE master (or of a master
  // whose chain renders it) can't land here — the master would render itself
  // forever and the parser bails (same rule as the library drag guard).
  if (opts.activeFilePath) {
    const cyclic = data.nodes.find((n) => n.componentFile && wouldCreateComponentCycle(n.componentFile, opts.activeFilePath!));
    if (cyclic) {
      trace.action('paste:refused-component-cycle', { componentFile: cyclic.componentFile, activeFilePath: opts.activeFilePath });
      return { success: false, createdIds: [], userFacing: true, message: cyclic.componentFile === opts.activeFilePath
        ? 'A component can’t be pasted inside its own master.'
        : 'That component already contains this one — pasting it here would create a loop.' };
    }
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
    parentHasLayout: opts.parentHasLayout,
    activeFilePath: opts.activeFilePath,
    sourceFilePath: data.sourceFilePath ?? null,
  };

  // FRAMER PARITY (2026-09-07): copying an OVERLAY alone and pasting with
  // another node selected ATTACHES a copy of that overlay to the selected node
  // (same content, same side/align/offset/trigger). Before: the overlay pasted
  // as a plain frame inside the selection (invalid — an overlay must be the
  // root's last child — and wired to nothing).
  const attached = attachCopiedOverlayToSelection(ctx, opts);
  if (attached) return attached;

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
      // Re-seed per-locale translations on the copies (see the module header
      // for why this runs HERE, after the nodes are guaranteed in the file).
      reinjectTranslations(ctx.clipboardNodes, idMapper, opts.activeFilePath);
      // Re-apply text effects on the copies — same whole-file pass, after the
      // nodes are guaranteed in the file (the wrapper is JSX, not a style).
      reinjectTextAnims(ctx.clipboardNodes, idMapper, opts.activeFilePath);
      reinjectCodeOverrides(ctx.clipboardNodes, idMapper, opts.activeFilePath);
      reinjectTickers(ctx.clipboardNodes, idMapper, opts.activeFilePath);
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

/** Clipboard = exactly one OVERLAY node (no trigger copied) + exactly one
 *  selected non-overlay node → paste the overlay element, then rebuild the
 *  runtime machine with the SELECTED node as its trigger. Returns null when the
 *  shape doesn't match so the normal rules run. */
function attachCopiedOverlayToSelection(ctx: PasteContext, opts: PasteOptions): PasteResult | null {
  const inClipboard = new Set(ctx.clipboardNodes.map((n) => n.id));
  const roots = ctx.clipboardNodes.filter((n) => !n.parentId || !inClipboard.has(n.parentId));
  if (roots.length !== 1) return null;
  const root = roots[0]!;
  if (!isOverlayNode(root)) return null;
  if (ctx.clipboardNodes.some((n) => n.overlayTriggerTargetId)) return null; // trigger + overlay pair → normal reattach path
  if (ctx.selectedIds.length !== 1 || !opts.activeFilePath) return null;
  const selectedId = ctx.selectedIds[0]!;
  const selected = ctx.nodes.get(selectedId);
  if (!selected || isOverlayNode(selected) || selectedId === root.id) return null;
  let overlayConfig: OverlayConfig;
  try { overlayConfig = JSON.parse(root.attrs?.['data-overlay'] || '{}'); } catch { return null; }
  if (!overlayConfig.type) return null;
  const code = projectFS.readFile(opts.activeFilePath) ?? '';
  const triggers = parseOverlayTriggerCalls(code);
  if (triggers.some((t) => t.triggerId === selectedId)) {
    trace.action('paste:overlay-attach-refused-has-overlay', { selectedId });
    return { success: false, createdIds: [], message: 'This element already has an overlay' };
  }
  const destIsComponentMaster = /export\s+default\s+withResponsiveProps\s*\(/.test(code);
  if (destIsComponentMaster && overlayConfig.type === 'fixed') {
    trace.action('paste:overlay-attach-refused-fixed-in-master', { selectedId });
    return { success: false, createdIds: [], message: 'Fixed overlays are not available inside a component' };
  }
  // The copied overlay's own trigger config (same file) or the defaults.
  const sourceTrigger = triggers.find((t) => t.config.targetId === root.id || t.triggerId === overlayConfig.triggerId);
  const triggerConfig: OverlayTriggerConfig = sourceTrigger
    ? { ...sourceTrigger.config, targetId: '' }
    : { targetId: '', trigger: 'click', dismiss: 'outside' };
  // 1. Land the bare overlay element as a root child (no per-viewport hide
  //    cascade — an overlay is not a viewport-scoped node).
  const idMapper = createIdMapper();
  // `viewport-children` resolves against the PAGE ROOT: walk up from the
  // selected node to its top-level ancestor (the page/master root).
  let rootId = selectedId;
  for (let cur: CanvasNode | undefined = selected, i = 0; cur?.parentId && i < 64; i++) { rootId = cur.parentId; cur = ctx.nodes.get(cur.parentId); }
  const bareCtx: PasteContext = { ...ctx, selectedIds: [rootId], interactingVpId: undefined };
  executeWithConfig(bareCtx, { targetMode: 'viewport-children', positioning: 'last-child', styleTransform: 'preserve' }, idMapper);
  const newOverlayId = idMapper.getAllMappings().get(root.id)?.[0];
  if (!newOverlayId) return { success: false, createdIds: [], message: 'Overlay paste failed' };
  // 2. Rebuild the machine around it with the SELECTED node as trigger.
  modifyProjectFile(opts.activeFilePath, (c) => reattachPastedOverlayInCode(
    c, selectedId, newOverlayId,
    { ...overlayConfig, triggerId: selectedId },
    { ...triggerConfig, targetId: newOverlayId },
  ));
  trace.action('paste:overlay-attached-to-selection', { selectedId, newOverlayId, from: root.id, trigger: triggerConfig.trigger });
  return { success: true, createdIds: [newOverlayId], attachedOverlayId: newOverlayId };
}

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


/**
 * TEXT EFFECTS travel as a config captured at copy (`ClipboardNode.textAnim`,
 * read off the source's `data-text-anim`). The pasted node is plain text, so
 * re-wrap it: `addTextAnimInCode` writes the attribute + the `<RevymeSplitText>`
 * wrapper (+ the runtime import) on every new id the copy mapped to.
 */
/** Code overrides travel like text effects: re-wrap every new id in the same
 *  `<Override>`, importing the override into the destination file. */
function reinjectCodeOverrides(clipboardNodes: ClipboardNode[], idMapper: IdMapper, destFilePath: string): void {
  const withOverrides = clipboardNodes.filter(n => n.codeOverrides?.length);
  if (withOverrides.length === 0) return;
  const mappings = idMapper.getAllMappings();
  const work: Array<{ newId: string; overrides: Array<{ file: string; name: string }> }> = [];
  for (const n of withOverrides) {
    for (const newId of mappings.get(n.id) ?? []) work.push({ newId, overrides: n.codeOverrides! });
  }
  if (work.length === 0) return;
  modifyProjectFile(destFilePath, code => {
    let next = code;
    for (const w of work) next = setCodeOverridesInCode(next, w.newId, w.overrides);
    return next;
  });
  trace.action('paste:code-overrides-reinjected', { count: work.length });
}

/** The Ticker effect travels the same way: re-wrap every new frame id in a
 *  `<RevymeTicker>` with the copied settings (setTickerInCode keeps any code
 *  override inside it and adds the runtime import). */
function reinjectTickers(clipboardNodes: ClipboardNode[], idMapper: IdMapper, destFilePath: string): void {
  const withTicker = clipboardNodes.filter(n => n.ticker);
  if (withTicker.length === 0) return;
  const mappings = idMapper.getAllMappings();
  const work: Array<{ newId: string; ticker: NonNullable<ClipboardNode['ticker']> }> = [];
  for (const n of withTicker) {
    for (const newId of mappings.get(n.id) ?? []) work.push({ newId, ticker: n.ticker! });
  }
  if (work.length === 0) return;
  modifyProjectFile(destFilePath, code => {
    let next = code;
    for (const w of work) next = setTickerInCode(next, w.newId, w.ticker);
    return next;
  });
  trace.action('paste:tickers-reinjected', { count: work.length });
}

function reinjectTextAnims(clipboardNodes: ClipboardNode[], idMapper: IdMapper, destFilePath: string): void {
  const withAnim = clipboardNodes.filter(n => n.textAnim);
  if (withAnim.length === 0) return;
  const mappings = idMapper.getAllMappings();
  const work: Array<{ newId: string; config: TextAnimConfig }> = [];
  for (const n of withAnim) {
    for (const newId of mappings.get(n.id) ?? []) work.push({ newId, config: n.textAnim as unknown as TextAnimConfig });
  }
  if (work.length === 0) return;
  modifyProjectFile(destFilePath, code => {
    let next = code;
    for (const w of work) next = addTextAnimInCode(next, w.newId, w.config);
    return next;
  });
  trace.action('paste:text-anims-reinjected', { count: work.length });
}
