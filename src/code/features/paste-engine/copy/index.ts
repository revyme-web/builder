// copy/index.ts — Copy orchestrator.
//
// Walks selected node trees, captures everything paste needs:
//   - Subtree (children recursively) — so paste can recreate the hierarchy
//   - computedDimensions for ROOT nodes with auto/%/fill width/height —
//     prevents collapse when pasting on canvas (auto needs a parent context)
//   - Overlays whose targetId is on a copied trigger — same trick as builder
//
// Stores to localStorage under 'revyme_clipboard'. Versioned so we can break
// the format later without crashing on stale data.

import { trace } from '@/shared/debug-trace';
import { findNodeRect, getActiveFilePath, getActiveTransform } from '@/canvas/node-ops';
import { projectFS } from '@/code/project/project-fs';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ClipboardData, ClipboardNode, CopyResult } from '../types';
import { extractEffectsForNodes } from './effects-extractor';
import { captureCollectionForPaste } from '@/code/generation/cms-paste-gen';
import { dormantizeCloneBindings, bakeCmsValuesOnClone } from '@/code/generation/cms-detach-gen';
import { resolveCmsRowValues } from '@/code/generation/cms-row-resolve';
import { captureComponentMasters } from './capture-components';
import { extractStyleCSS } from '@/code/parsing/parser';
import { extractBorderAfterRuleBody } from '@/editor/ui/border-utils';
import { getProjectId } from '@/backend/project-id';
import { readTranslationText } from '@/code/project/translation-ops';
import { getI18nConfig } from '@/code/project/locale-ops';

const CLIPBOARD_STORAGE_KEY = 'revyme_clipboard';

// ─── Subtree collection ──────────────────────────────────────────────────────

function collectSubtree(
  rootId: string,
  nodes: Map<string, CanvasNode>,
  collected: Map<string, CanvasNode>,
): void {
  if (collected.has(rootId)) return;
  const node = nodes.get(rootId);
  if (!node) return;
  collected.set(rootId, node);
  // A DESIGN component instance's `children` are its EXPANDED master content —
  // virtual nodes that live in the component file, NOT in the page source.
  // Recursing into them copies the instance AND its internals, so paste
  // recreates `<Instance>…internals…</Instance>` (double render) instead of the
  // childless `<Instance/>` tag. Treat the instance as a leaf for copy.
  // (Code components — `isCodeComponent`, e.g. a Marquee with real passed-in
  // children — are NOT expanded, so they keep recursing normally.)
  if (node.isComponentInstance) return;
  for (const childId of node.children) {
    collectSubtree(childId, nodes, collected);
  }
}

// ─── Node → ClipboardNode ────────────────────────────────────────────────────

/** A TRANSLATED text node (`{t('key')}`) carries no literal text in JSX —
 *  the copy lives in the SOURCE project's messages/<locale>.json, which the
 *  destination project doesn't have. Resolve at COPY time and bake the
 *  default-locale string as plain textContent, so pasting into any project
 *  (localized or not) lands normal, resolved text (the cross-project
 *  "all texts missing" find, 2026-07-23). Same for attr keys (placeholder…). */
function bakeTranslations(node: CanvasNode): { textContent?: string; attrs?: Record<string, string> } {
  const out: { textContent?: string; attrs?: Record<string, string> } = {};
  if (!node.translationKey && !node.attrTranslationKeys) return out;
  const filePath = getActiveFilePath();
  const defaultLocale = getI18nConfig().defaultLocale;
  if (node.translationKey && !node.textContent) {
    const resolved = readTranslationText({ filePath, key: node.translationKey, locale: defaultLocale });
    if (resolved != null) out.textContent = resolved;
  }
  if (node.attrTranslationKeys && node.attrs) {
    const attrs = { ...node.attrs };
    for (const [attr, key] of Object.entries(node.attrTranslationKeys)) {
      const resolved = readTranslationText({ filePath, key, locale: defaultLocale });
      if (resolved != null) attrs[attr] = resolved;
    }
    out.attrs = attrs;
  }
  trace.action('copy:bake-translations', { nodeId: node.id, text: !!out.textContent, attrs: !!out.attrs });
  return out;
}

function toClipboardNode(node: CanvasNode, nodes: Map<string, CanvasNode>): ClipboardNode {
  // Surface the overlay-trigger targetId to a top-level field for the post-paste
  // remap to find without parsing data-overlay-trigger JSON twice.
  let overlayTriggerTargetId: string | undefined;
  const trigAttr = node.attrs?.['data-overlay-trigger'];
  if (trigAttr) {
    try {
      const parsed = JSON.parse(trigAttr);
      if (parsed?.targetId) overlayTriggerTargetId = parsed.targetId;
    } catch {
      // Invalid JSON — ignore.
    }
  }

  const baked = bakeTranslations(node);

  // CMS bindings are JSX expressions (`<h3>{item.title}</h3>`,
  // `src={item.image}`), not values — none of them survive a rebuild from the
  // plain node fields below, and a `{item.…}` ref would crash outside its
  // `.map()` anyway. Stash the intent in `data-cms-orphan` exactly like the
  // drag-out clone path: paste OUTSIDE a collection list then shows the
  // "Missing" pill, and the post-paste rehydrate re-binds when the copy lands
  // back INSIDE one. Without this a duplicated bound `<h3>` pasted as an empty
  // text node (user report 2026-07-25).
  const dormant = bakeCmsValuesOnClone(dormantizeCloneBindings({
    textContent: baked.textContent ?? node.textContent,
    styles: { ...node.styles },
    attrs: baked.attrs ?? (node.attrs ? { ...node.attrs } : undefined),
    textField: node.binding?.property === 'text' ? node.binding.field : undefined,
    attrBindings: node.attrBindings,
    styleBindings: node.styleBindings,
    propBindings: node.propBindings,
  }), resolveCmsRowValues(node, nodes));

  return {
    id: node.id,
    type: node.type,
    parentId: node.parentId,
    // A design component instance is copied as a childless tag (its `children`
    // are virtual master content, never collected) — keep the clipboard node's
    // children list consistent with that so nothing references uncopied ids.
    children: node.isComponentInstance ? [] : [...node.children],
    order: node.order ?? 0,
    styles: dormant.styles,
    attrs: dormant.attrs,
    name: node.name,
    textContent: dormant.textContent,
    hasMixedContent: node.hasMixedContent,
    isCanvasNode: node.isCanvasNode,
    componentFile: node.componentFile,
    componentInstanceId: node.componentInstanceId,
    overlayTriggerTargetId,
    // Appear/Hover/Tap/declarative-Loop live as tag props, not styles/attrs —
    // capture them so paste can re-inject (they'd silently vanish otherwise).
    motionProps: node.motionProps ?? undefined,
  };
}

// ─── Computed dimensions snapshot ────────────────────────────────────────────

/**
 * For ROOT clipboard nodes whose width/height is auto/%/fill, capture
 * resolved px values from the live DOM. Without this, pasting on canvas
 * (where there's no flex parent to size against) collapses the node.
 */
function captureComputedDimensions(
  clipboardNodes: ClipboardNode[],
  selectedRootIds: Set<string>,
): void {
  const scale = getActiveTransform().scale || 1;

  for (const cn of clipboardNodes) {
    if (!selectedRootIds.has(cn.id)) continue;

    const w = cn.styles.width;
    const h = cn.styles.height;
    const needsW = !w || w === 'auto' || w.includes('%');
    const needsH = !h || h === 'auto' || h.includes('%');
    if (!needsW && !needsH) continue;

    const rect = findNodeRect(cn.id, 'desktop');
    if (!rect) continue;

    const dims: { width?: string; height?: string } = {};
    if (needsW && rect.width > 0) dims.width = `${Math.round(rect.width / scale)}px`;
    if (needsH && rect.height > 0) dims.height = `${Math.round(rect.height / scale)}px`;
    if (Object.keys(dims).length > 0) cn.computedDimensions = dims;
  }
}

// ─── Border ::after overlay capture ──────────────────────────────────────────

/**
 * Carry each copied node's `::after` border-overlay rule. The border tool's
 * overlay mode renders through a `[data-id="<id>"]::after` rule in the page's
 * `<style>` block — nothing of it lives on the node itself, so the clipboard
 * tree alone loses the border on paste. Scans ALL collected nodes (a border
 * on a grandchild travels when the user copies the parent).
 */
function captureBorderOverlays(
  clipboardNodes: ClipboardNode[],
  sourceCode: string,
): void {
  const css = extractStyleCSS(sourceCode);
  if (!css) return;
  let count = 0;
  for (const cn of clipboardNodes) {
    const body = extractBorderAfterRuleBody(css, cn.id);
    if (body && body.trim()) {
      cn.borderAfterCSS = body.trim();
      count++;
    }
  }
  if (count > 0) trace.action('copy:border-overlays-captured', { count });
}

// ─── Overlay collection ──────────────────────────────────────────────────────

/**
 * If any copied node has data-overlay-trigger pointing at an overlay node,
 * also include that overlay (and its descendants) in the clipboard so paste
 * can recreate it and remap the targetId.
 */
function collectOverlays(
  clipboardNodes: ClipboardNode[],
  nodes: Map<string, CanvasNode>,
  collected: Map<string, CanvasNode>,
): CanvasNode[] {
  const targetIds = new Set<string>();
  for (const cn of clipboardNodes) {
    if (cn.overlayTriggerTargetId) targetIds.add(cn.overlayTriggerTargetId);
  }
  if (targetIds.size === 0) return [];

  const overlayNodes: CanvasNode[] = [];
  for (const targetId of targetIds) {
    if (collected.has(targetId)) continue; // Already in our subtree.
    const overlayCollected = new Map<string, CanvasNode>();
    collectSubtree(targetId, nodes, overlayCollected);
    for (const node of overlayCollected.values()) {
      if (!collected.has(node.id)) overlayNodes.push(node);
    }
  }
  return overlayNodes;
}

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * Copy selected nodes (and their subtrees) to localStorage.
 *
 * Returns CopyResult so the call-site can show a toast on failure — but most
 * call-sites today fire-and-forget. Failures are also traced.
 */
export function copyNodes(
  nodeIds: string[],
  nodes: Map<string, CanvasNode>,
): CopyResult {
  trace.fn('paste-engine.copyNodes', { count: nodeIds.length });

  if (nodeIds.length === 0) {
    return { success: false, nodeCount: 0, message: 'Nothing to copy' };
  }

  // 1. Collect subtree.
  const collected = new Map<string, CanvasNode>();
  for (const id of nodeIds) collectSubtree(id, nodes, collected);

  // 2. Collect overlays triggered by copied nodes.
  const tempClipboard = Array.from(collected.values()).map(n => toClipboardNode(n, nodes));
  const overlays = collectOverlays(tempClipboard, nodes, collected);
  for (const o of overlays) collected.set(o.id, o);

  // 3. Convert all to ClipboardNode.
  const clipboardNodes = Array.from(collected.values()).map(n => toClipboardNode(n, nodes));

  // 4. Capture computed dims for the user-selected ROOTS only (not descendants
  //    or overlays — they'll size against their pasted parents).
  captureComputedDimensions(clipboardNodes, new Set(nodeIds));

  // 4b. Capture function-scope effects (scroll transforms, hooks, tool
  //     annotations) that mention ANY node in the collected subtree —
  //     parents AND grandchildren AND every multi-select root. The
  //     ownership scan is name-based (var-prefix + data-id literal),
  //     and the injector re-renames everything to the new pasted IDs.
  //
  //     EXCLUDE overlay nodes (`data-overlay`): their `useState` + positioner
  //     `useLayoutEffect`/`useEffect` reference the overlay id, so the extractor
  //     would capture them as "effects" — and the paste-side overlay REATTACH
  //     (`reattachPastedOverlayInCode`) ALSO rebuilds that exact machine. Both
  //     firing produced a DUPLICATE `const [xOpen, setXOpen] = useState(false)`
  //     → "Identifier already declared" crash. Reattach owns the overlay runtime;
  //     the effects pipeline must not touch it. (Children of the overlay keep
  //     their own ids in the rename map, so their real effects still travel.)
  let effects: ClipboardData['effects'] = null;
  try {
    const sourceCode = projectFS.readFile(getActiveFilePath()) ?? '';
    if (sourceCode) {
      const allOwnedIds = clipboardNodes.filter(n => !n.attrs?.['data-overlay']).map(n => n.id);
      effects = extractEffectsForNodes(sourceCode, allOwnedIds);
    }
  } catch (err) {
    trace.error('clipboard:effects-extract-failed', err);
  }

  // 4c. Capture CMS Collection Lists VERBATIM. The flat clipboard tree can't carry
  //     the `.map()` repeater / CMS bindings / pagination, so for every copied
  //     container that IS a collection list we stash its exact source JSX + pagination
  //     hooks + imports; the paste post-step re-inserts it id-renamed. Reuses the
  //     `sourceCode` already read above (active file).
  let collections: ClipboardData['collections'];
  try {
    const sourceCode = projectFS.readFile(getActiveFilePath()) ?? '';
    if (sourceCode) {
      const caps = [];
      for (const node of collected.values()) {
        if (node.collectionList?.source) {
          const cap = captureCollectionForPaste(sourceCode, node.id, node.collectionList.source);
          if (cap) caps.push(cap);
        }
      }
      if (caps.length > 0) collections = caps;
    }
  } catch (err) {
    trace.error('clipboard:collection-capture-failed', err);
  }

  // 4d. Capture component MASTERS (full source bundles) + the source
  //     project id. This is what lets a paste into ANOTHER project link
  //     the instances (cloud: CDN share; standalone: local materialize)
  //     instead of emitting bare tags whose masters don't exist there.
  //     Copy time is the only moment the source files are still in
  //     projectFS — share itself stays lazy (only on cross-project paste),
  //     so nothing is uploaded for copies that never leave the project.
  let components: ClipboardData['components'];
  try {
    const sourceCode = projectFS.readFile(getActiveFilePath()) ?? '';
    const captured = captureComponentMasters(clipboardNodes, sourceCode);
    if (captured.length > 0) components = captured;
  } catch (err) {
    trace.error('clipboard:component-capture-failed', err);
  }
  let sourceProjectId: string | null = null;
  try { sourceProjectId = getProjectId() || null; } catch { /* standalone edge */ }

  // 4e. Carry ::after border-overlay rules for every collected node — the
  //     border tool's overlay mode lives in the page's <style> block, keyed
  //     by data-id, so paste must re-inject it under the new ids.
  try {
    const sourceCode = projectFS.readFile(getActiveFilePath()) ?? '';
    if (sourceCode) captureBorderOverlays(clipboardNodes, sourceCode);
  } catch (err) {
    trace.error('clipboard:border-capture-failed', err);
  }

  // 5. Persist.
  const data: ClipboardData = {
    version: 1,
    timestamp: Date.now(),
    nodes: clipboardNodes,
    effects,
    collections,
    sourceProjectId,
    components,
  };

  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(data));
    // Overwrite the OS clipboard with a marker so any existing IMAGE
    // (e.g. a screenshot the user took earlier) gets evicted. The
    // Ctrl+V handler reads the OS clipboard for an image BEFORE
    // falling through to the internal node clipboard — without this,
    // the user's "copy node → paste" flow pastes their previously-
    // captured screenshot instead of the just-copied node.
    //
    // `navigator.clipboard.writeText` replaces ALL formats on the
    // clipboard (image + text + html), so the next Ctrl+V's image-
    // detection probe finds nothing and the paste handler routes to
    // the internal localStorage clipboard as intended.
    //
    // Fire-and-forget: we don't want copy to block on the async
    // clipboard write, and a permission error is harmless — paste
    // will then prefer the OS image, which is the OLD (pre-fix)
    // behavior.
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      const marker = `revyme-node:${nodeIds.join(',')}`;
      navigator.clipboard.writeText(marker).catch((err) => {
        trace.action('clipboard:os-write-failed', { error: String(err) });
      });
    }
    trace.action('clipboard:copy', { count: clipboardNodes.length, ids: nodeIds });
    return { success: true, nodeCount: clipboardNodes.length };
  } catch (err) {
    trace.error('clipboard:copy-failed', err);
    return { success: false, nodeCount: 0, message: 'localStorage write failed' };
  }
}

/** Read raw clipboard data — null if missing or unparseable. */
export function getClipboardData(): ClipboardData | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as ClipboardData;
    if (data.version !== 1) return null;
    return data;
  } catch (err) {
    trace.error('clipboard:read-failed', err);
    return null;
  }
}

export function hasClipboard(): boolean {
  return getClipboardData() !== null;
}
