// canvas-commands-bridge.ts — Module-level dispatch surface for
// canvas-coupled commands that need closure-captured Canvas.tsx refs.
//
// Background: paste/cut/duplicate and selection navigation
// (parent/children/sibling/replica) all read live atoms via refs that
// Canvas.tsx wires into `registerShortcuts(refs)` at mount. UI surfaces
// outside that scope (cmd+K palette, context menu commands, future
// menu-bar entries) can't reproduce the same plumbing.
//
// This module is the bridge: Canvas.tsx calls `setCanvasCommandsRefs`
// with its refs on mount, and any caller anywhere can then invoke
// `dispatchPaste()` / `dispatchSelectChildren()` / etc. — same exact
// code path as the keyboard handler.
//
// Same pattern as `toolbar-drag-bridge.ts` (`setToolbarDragCoordinator`).
// Singleton, cleared to null on Canvas unmount, trace-logged when calls
// happen before mount or after unmount so we don't silently no-op.

import { getDefaultStore } from 'jotai';
import { copyNodes } from '@/code/features/paste-engine';
import { executePaste } from '@/code/features/paste-engine/execute-from-ui';
import {
  deleteNode,
  selectChildren as cmdSelectChildren,
  selectParent as cmdSelectParent,
  selectNextReplica as cmdSelectNextReplica,
  duplicateSelection,
} from './commands';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { flushNow } from '@/code/mutation/mutation-queue';
import { groupSvgs } from '@/code/svg/group-svgs';
import { buildGroupSvgsOpts } from '@/canvas/svg-group-helper';
import { trace } from '@/shared/debug-trace';
import type { CanvasNode } from '@/code/parsing/parser';

export interface CanvasCommandsRefs {
  selectedIdRef: { current: string | null };
  selectedIdsRef: { current: string[] };
  nodesRef: { current: Map<string, CanvasNode> };
  contentRef: { current: HTMLElement | null };
  setSelectedIds: (ids: string[]) => void;
  handleNodeMouseDown: (nodeId: string, e: MouseEvent) => void;
}

let _refs: CanvasCommandsRefs | null = null;

export function setCanvasCommandsRefs(refs: CanvasCommandsRefs | null): void {
  _refs = refs;
  trace.fn('canvas-commands-bridge:set', { hasRefs: !!refs });
}

function getRefs(action: string): CanvasCommandsRefs | null {
  if (!_refs) {
    trace.error('canvas-commands-bridge:no-refs', { action });
    return null;
  }
  return _refs;
}

// ─── Clipboard ──────────────────────────────────────────────────────────────

export function dispatchCopy(): void {
  const r = getRefs('copy');
  if (!r) return;
  const ids = r.selectedIdsRef.current;
  if (ids.length === 0) return;
  copyNodes(ids, r.nodesRef.current);
  trace.action('canvas-commands-bridge:copy', { count: ids.length });
}

export function dispatchPaste(): void {
  const r = getRefs('paste');
  if (!r) return;
  executePaste(
    r.nodesRef.current,
    r.contentRef.current,
    r.selectedIdRef.current,
    (id) => r.setSelectedIds(id ? [id] : []),
    r.handleNodeMouseDown,
  );
  trace.action('canvas-commands-bridge:paste');
}

export function dispatchCut(): void {
  const r = getRefs('cut');
  if (!r) return;
  const ids = r.selectedIdsRef.current;
  if (ids.length === 0) return;
  copyNodes(ids, r.nodesRef.current);
  const contentEl = r.contentRef.current;
  if (contentEl) {
    deleteNode(ids, contentEl);
    r.setSelectedIds([]);
  }
  trace.action('canvas-commands-bridge:cut', { count: ids.length });
}

export function dispatchDuplicate(): void {
  const r = getRefs('duplicate');
  if (!r) return;
  const sel = r.selectedIdRef.current;
  if (!sel) return;
  duplicateSelection({
    nodes: r.nodesRef.current,
    primaryId: sel,
    contentEl: r.contentRef.current,
    setSelectedIds: r.setSelectedIds,
    handleNodeMouseDown: r.handleNodeMouseDown,
  });
  trace.action('canvas-commands-bridge:duplicate', { nodeId: sel });
}

// ─── Selection navigation ───────────────────────────────────────────────────

export function dispatchSelectParent(): void {
  const r = getRefs('select-parent');
  if (!r) return;
  const sel = r.selectedIdRef.current;
  if (!sel) return;
  const parent = cmdSelectParent(sel, r.nodesRef.current);
  if (parent) r.setSelectedIds([parent]);
  trace.action('canvas-commands-bridge:select-parent', { from: sel, to: parent });
}

export function dispatchSelectChildren(): void {
  const r = getRefs('select-children');
  if (!r) return;
  const sel = r.selectedIdRef.current;
  if (!sel) return;
  const children = cmdSelectChildren(sel, r.nodesRef.current);
  if (children.length > 0) {
    // Children includes the first descendant chain — mirror the
    // keyboard handler which selects all returned ids.
    r.setSelectedIds(children);
  }
  trace.action('canvas-commands-bridge:select-children', { from: sel, count: children.length });
}

// ─── Structure ──────────────────────────────────────────────────────────────

/**
 * Group 2+ selected SVG nodes sharing a parent into a single
 * composite SVG. Bails silently for non-SVG / single selections /
 * mixed-parent selections — same gate as the keyboard handler.
 */
export function dispatchGroupSvgs(): void {
  const r = getRefs('group-svgs');
  if (!r) return;
  const ids = r.selectedIdsRef.current;
  if (ids.length < 2) return;
  const nodes = r.nodesRef.current;
  const allSvg = ids.every((id) => nodes.get(id)?.type === 'svg');
  if (!allSvg) return;
  const firstParent = nodes.get(ids[0])?.parentId;
  const sameParent = ids.every((id) => nodes.get(id)?.parentId === firstParent);
  if (!sameParent) return;
  const filePath = getDefaultStore().get(activeFilePathAtom);
  const gvpId = getDefaultStore().get(interactingViewportIdAtom) || 'desktop';
  const newId = groupSvgs(ids, nodes, filePath, buildGroupSvgsOpts(ids, gvpId));
  trace.action('canvas-commands-bridge:group-svgs', { ids, newId });
  if (newId) {
    flushNow();
    r.setSelectedIds([newId]);
  }
}

/**
 * "Select next replica" cycles selection across viewport copies of
 * the same node id. Mirrors the Shift+B keyboard handler — `commands.
 * selectNextReplica` returns the next vpId; we set the interacting
 * viewport atom and dispatch the same custom event Canvas.tsx
 * listens for so the visible selection actually updates.
 */
export function dispatchSelectReplica(): void {
  const r = getRefs('select-replica');
  if (!r) return;
  const sel = r.selectedIdRef.current;
  const contentEl = r.contentRef.current;
  if (!sel || !contentEl) return;
  const nextVp = cmdSelectNextReplica(sel, contentEl);
  if (!nextVp) return;
  getDefaultStore().set(interactingViewportIdAtom, nextVp);
  window.dispatchEvent(
    new CustomEvent('revyme:select-viewport', { detail: { nodeId: sel, vpId: nextVp } }),
  );
  trace.action('canvas-commands-bridge:select-replica', { nodeId: sel, vpId: nextVp });
}
