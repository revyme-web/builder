// shortcuts.ts — All keyboard shortcuts, extracted from Canvas.tsx.
// Registers with KeyboardManager. Returns cleanup function.

import { keyboard } from './KeyboardManager';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import {
  setSpaceBarDown,
  zoomIn, zoomOut, zoomTo100, zoomToFit, zoomToFitSelection,
} from './transform';
import { cancelFrameCreation } from './creators/FrameCreator';
import {
  selectParent, selectChildren, selectNextSibling, selectPrevSibling,
  selectNextReplica,
  deleteNode, toggleLock, toggleVisibility, wrapInFrame, wrapInLayout, unfoldChildren,
  duplicateSelection,
} from './commands';
import { getContentRoot } from './node-ops';
import { getCanvasBridge } from './canvas-bridge';
import { undo, redo } from '../code/mutation/history';
import { copyNodes } from '../code/features/paste-engine';
import { executePaste } from '../code/features/paste-engine/execute-from-ui';
import { isComponentUrl, importComponentFromUrl } from '../cloud/components/component-paste';
import {
  hasClipboardImageInDataTransfer,
  handleClipboardImagePasteFromEvent,
  handleClipboardImagePasteFromKeyboard,
} from './image-paste';
import { handleClipboardTextPaste } from './text-paste';
import { readFigmaClipboard, handleFigmaPaste } from './figma-paste';
import { hasClipboard as hasInternalClipboard, setExternalClipboardData } from '../code/features/paste-engine';
import { parsePluginUrl } from '@/editor/command-palette/marketplace-client';
import { paletteOpenAtom, paletteQueryAtom } from '@/code/stores/palette-store';
import { getDefaultStore as getJotaiStore } from 'jotai';
import { trace } from '../shared/debug-trace';
import type { CanvasNode } from '../code/parsing/parser';
import { getDefaultStore } from 'jotai';
import { shapeEditingIdAtom, selectedPointAtom, groupEditingIdAtom, activeContainerIdAtom } from '../code/stores/shape-edit-store';
import { flushNow } from '../code/mutation/mutation-queue';
import { groupSvgs, ungroupSvgs } from '../code/svg/group-svgs';
import { buildGroupSvgsOpts } from './svg-group-helper';
import { activeFilePathAtom, isIconSetFilePath } from '../code/project/active-file-store';
import { renamingNodeIdAtom } from '../code/stores/context-menu-store';
import { createAndOpenProject } from '../editor/header/menu-builders';
import { nudgeSelection, flushPendingNudge, type NudgeDirection } from './arrow-nudge';
import { selectAllPageNodeIds } from './selection/select-all';
import { interactingViewportIdAtom } from '../code/stores/viewport-store';


export interface ShortcutRefs {
  selectedIdRef: { current: string | null };
  selectedIdsRef: { current: string[] };
  nodesRef: { current: Map<string, CanvasNode> };
  contentRef: { current: HTMLElement | null };
  /** Truthy when a text-edit session is active. Post-iframe-migration the
   *  editor itself lives in the sandbox; the parent only knows whether
   *  editing is in flight via this ref's nodeId. */
  editingNodeIdRef: { current: string | null };
  toolModeRef: { current: string };
  setToolMode: (mode: string) => void;
  setSelectedIds: (ids: string[]) => void;
  commitTextEdit: () => void;
  handleNodeMouseDown: (nodeId: string, e: MouseEvent) => void;
  setPanHighlight?: (v: boolean) => void;
}

export function registerShortcuts(refs: ShortcutRefs): () => void {
  const {
    selectedIdRef, selectedIdsRef, nodesRef, contentRef, editingNodeIdRef, toolModeRef,
    setToolMode, setSelectedIds, commitTextEdit, handleNodeMouseDown, setPanHighlight,
  } = refs;
  const cleanups: (() => void)[] = [];

  // Helpers: focused-toolbar masters where most creators are no-ops.
  //   - Icon-set master: only shape tools (rect / circle / triangle /
  //     path) apply. Frame / Text / Layout / Sketch keys are
  //     swallowed.
  // Gated per-handler so the keyboard binding still exists (avoids
  // "shortcut not registered" surprises in the global help overlay)
  // but does nothing when the user happens to be on a focused master.
  const isOnIconSetMaster = (): boolean =>
    isIconSetFilePath(getDefaultStore().get(activeFilePathAtom));
  const isOnContainerSetMaster = (): boolean =>
    isOnIconSetMaster();

  // ─── Tools ───────────────────────────────────────────────────────
  cleanups.push(keyboard.register({ key: 'v', label: 'Select tool', category: 'tools', viewerAllowed: true, handler: () => setToolMode('select') }));
  cleanups.push(keyboard.register({ key: 'f', label: 'Frame tool', category: 'tools', handler: () => {
    if (isOnContainerSetMaster()) return;
    setToolMode(toolModeRef.current === 'frame' ? 'select' : 'frame');
  }}));
  cleanups.push(keyboard.register({ key: 't', label: 'Text tool', category: 'tools', handler: () => {
    if (isOnContainerSetMaster()) return;
    setToolMode(toolModeRef.current === 'text' ? 'select' : 'text');
  }}));
  cleanups.push(keyboard.register({ key: 'h', label: 'Hand tool', category: 'tools', viewerAllowed: true, handler: () => setToolMode(toolModeRef.current === 'hand' ? 'select' : 'hand') }));
  cleanups.push(keyboard.register({ key: 'r', shift: true, label: 'Rows layout tool', category: 'tools', handler: () => {
    if (isOnContainerSetMaster()) return;
    setToolMode(toolModeRef.current === 'layout-rows' ? 'select' : 'layout-rows');
  }}));
  cleanups.push(keyboard.register({ key: 'c', shift: true, label: 'Columns layout tool', category: 'tools', handler: () => {
    if (isOnContainerSetMaster()) return;
    setToolMode(toolModeRef.current === 'layout-columns' ? 'select' : 'layout-columns');
  }}));
  cleanups.push(keyboard.register({ key: 'g', shift: true, label: 'Grid layout tool', category: 'tools', handler: () => {
    if (isOnContainerSetMaster()) return;
    setToolMode(toolModeRef.current === 'layout-grids' ? 'select' : 'layout-grids');
  }}));

  // Shape tools — match the BottomToolbar dropdown shortcuts:
  //   R           → Square (shape-rect)
  //   O           → Circle (shape-ellipse)
  //   Shift+T     → Triangle (shape-triangle)
  //   P           → Path (shape-path)
  // Each toggles back to 'select' if its mode is already active so the
  // user can press the same key twice to cancel a half-started draw.
  cleanups.push(keyboard.register({ key: 'r', label: 'Square tool', category: 'tools', handler: () => {
    setToolMode(toolModeRef.current === 'shape-rect' ? 'select' : 'shape-rect');
  }}));
  cleanups.push(keyboard.register({ key: 'o', label: 'Circle tool', category: 'tools', handler: () => {
    setToolMode(toolModeRef.current === 'shape-ellipse' ? 'select' : 'shape-ellipse');
  }}));
  cleanups.push(keyboard.register({ key: 't', shift: true, label: 'Triangle tool', category: 'tools', handler: () => {
    setToolMode(toolModeRef.current === 'shape-triangle' ? 'select' : 'shape-triangle');
  }}));
  cleanups.push(keyboard.register({ key: 'p', label: 'Path tool', category: 'tools', handler: () => {
    setToolMode(toolModeRef.current === 'shape-path' ? 'select' : 'shape-path');
  }}));
  // Sketch (Pencil) — enabled everywhere now: regular pages AND vector-set
  // (icon-set) masters, since sketches bundle into vector sets.
  cleanups.push(keyboard.register({ key: 'k', label: 'Sketch tool', category: 'tools', handler: () => {
    setToolMode(toolModeRef.current === 'sketch' ? 'select' : 'sketch');
  }}));

  // ─── General ─────────────────────────────────────────────────────
  cleanups.push(keyboard.register({ key: 'escape', label: 'Escape / Select Parent', category: 'general', handler: () => {
    // Exit shape edit mode first (highest priority after text edit)
    const store = getDefaultStore();
    const shapeEditId = store.get(shapeEditingIdAtom);
    if (shapeEditId) {
      trace.action('canvas:shape-edit-exit', { reason: 'escape', nodeId: shapeEditId });
      store.set(shapeEditingIdAtom, null);
      store.set(selectedPointAtom, null);
      return;
    }
    // Exit group-edit isolation next: pops one level out (selecting the
    // group itself instead of its children) without affecting the rest of
    // the shortcut chain. Distinct from "select parent" — when in
    // isolation, Escape feels like "leave the group", not "go up the tree".
    const groupEditId = store.get(groupEditingIdAtom);
    if (groupEditId) {
      trace.action('canvas:group-edit-exit', { reason: 'escape', nodeId: groupEditId });
      store.set(groupEditingIdAtom, null);
      setSelectedIds([groupEditId]);
      return;
    }
    // Pop the Figma-style nested-selection container by ONE level. With
    // direct-selection OFF, dblclick on a frame with children sets that
    // frame as the active container; ESC walks back out — same UX as
    // group-edit's exit, just at the page-tree scope. Sets activeContainer
    // to the popped frame's parent (or null if it was top-level), and
    // selects the popped frame so the user keeps a visible selection
    // rather than blanking the canvas.
    const activeContainer = store.get(activeContainerIdAtom);
    if (activeContainer) {
      const popped = nodesRef.current.get(activeContainer);
      const newContainer = popped?.parentId ?? null;
      store.set(activeContainerIdAtom, newContainer);
      setSelectedIds([activeContainer]);
      trace.action('canvas:direct-selection-pop-esc', {
        from: activeContainer, to: newContainer,
      });
      return;
    }
    if (editingNodeIdRef.current) { commitTextEdit(); return; }
    if (toolModeRef.current !== 'select') { setToolMode('select'); return; }
    cancelFrameCreation();
    // Select parent first; if no parent, deselect
    const sel = selectedIdRef.current;
    if (sel) {
      const parentId = selectParent(sel, nodesRef.current);
      if (parentId) { setSelectedIds([parentId]); return; }
    }
    setSelectedIds([]);
  }}));

  // ─── Navigation ──────────────────────────────────────────────────
  cleanups.push(keyboard.register({ key: ' ', label: 'Pan (hold)', category: 'navigation', allowRepeat: true, handler: () => {
    if (!editingNodeIdRef.current) {
      setSpaceBarDown(true);
      setPanHighlight?.(true);
    }
  }}));
  cleanups.push(keyboard.registerKeyUp(' ', () => {
    setSpaceBarDown(false);
    setPanHighlight?.(false);
  }));

  // ─── Zoom ────────────────────────────────────────────────────────
  cleanups.push(keyboard.register({ key: ['+', '='], ctrl: true, label: 'Zoom in', category: 'zoom', handler: () => zoomIn() }));
  cleanups.push(keyboard.register({ key: ['-', '_'], ctrl: true, label: 'Zoom out', category: 'zoom', handler: () => zoomOut() }));
  cleanups.push(keyboard.register({ key: ['1', '!'], shift: true, label: 'Zoom to fit', category: 'zoom', handler: () => {
    const el = contentRef.current; if (el) zoomToFit(el);
  }}));
  cleanups.push(keyboard.register({ key: ['2', '@'], shift: true, label: 'Zoom to selection', category: 'zoom', handler: () => {
    const el = contentRef.current; if (el) zoomToFitSelection(el, selectedIdRef.current ? [selectedIdRef.current] : []);
  }}));
  cleanups.push(keyboard.register({ key: ['3', '#'], shift: true, label: 'Zoom to 100%', category: 'zoom', handler: () => zoomTo100() }));

  // ─── Project lifecycle ───────────────────────────────────────────
  // Ctrl+Alt+N matches the File → New project menu shortcut. Goes
  // through the same `createAndOpenProject` helper the menu uses, so
  // the keyboard path and the menu path can never drift.
  cleanups.push(keyboard.register({ key: 'n', ctrl: true, alt: true, label: 'New project', category: 'general', handler: () => createAndOpenProject() }));

  // ─── Undo/Redo ───────────────────────────────────────────────────
  // Force-flush any pending debounced arrow-nudge before undo/redo so the
  // source is current — otherwise an undo within the 200ms nudge window
  // would target the pre-nudge history entry while the nudge's queued
  // mutations land afterward, desyncing the visible DOM from the source.
  //
  // SHAPE-EDIT session: while shapeEditingIdAtom is set, Cmd+Z/Shift+Z route
  // to the sandbox's IN-SESSION stack (per-gesture vertex undo, Framer-style)
  // instead of the global history. The session's edits are live-DOM only —
  // the source still holds the PRE-session state, so a global undo here
  // would rip the page out from under the live editor. Never fall through,
  // even when the session stack is empty. The iframe-focused twin of this
  // routing lives in shape-edit-host's own capture keydown listener (after
  // an anchor click, keys land in the iframe and this handler never fires).
  const shapeEditHistoryCmd = (cmd: 'undo' | 'redo'): boolean => {
    if (!getDefaultStore().get(shapeEditingIdAtom)) return false;
    const bridge = getCanvasBridge() as { undoShapeEdit?: () => unknown; redoShapeEdit?: () => unknown } | null;
    trace.action('canvas:shape-edit-history', { cmd });
    if (cmd === 'undo') void bridge?.undoShapeEdit?.();
    else void bridge?.redoShapeEdit?.();
    return true;
  };
  cleanups.push(keyboard.register({ key: 'z', ctrl: true, label: 'Undo', category: 'general', handler: () => {
    if (shapeEditHistoryCmd('undo')) return;
    flushPendingNudge(); undo();
  } }));
  cleanups.push(keyboard.register({ key: 'z', ctrl: true, shift: true, label: 'Redo', category: 'general', handler: () => {
    if (shapeEditHistoryCmd('redo')) return;
    flushPendingNudge(); redo();
  } }));
  cleanups.push(keyboard.register({ key: 'y', ctrl: true, label: 'Redo', category: 'general', handler: () => {
    if (shapeEditHistoryCmd('redo')) return;
    flushPendingNudge(); redo();
  } }));

  // ─── Delete ──────────────────────────────────────────────────────
  cleanups.push(keyboard.register({ key: ['backspace', 'delete'], label: 'Delete', category: 'general', handler: () => {
    const ids = selectedIdsRef.current;
    if (ids.length === 0) return;
    const contentEl = contentRef.current;
    if (contentEl) { deleteNode(ids, contentEl); setSelectedIds([]); }
  }}));

  // ─── Selection Navigation ──────────────────────────────────────
  cleanups.push(keyboard.register({ key: 'tab', label: 'Select next sibling', category: 'selection', handler: () => {
    const sel = selectedIdRef.current;
    if (!sel) return;
    const next = selectNextSibling(sel, nodesRef.current);
    if (next) setSelectedIds([next]);
  }}));

  cleanups.push(keyboard.register({ key: 'tab', shift: true, label: 'Select prev sibling', category: 'selection', handler: () => {
    const sel = selectedIdRef.current;
    if (!sel) return;
    const prev = selectPrevSibling(sel, nodesRef.current);
    if (prev) setSelectedIds([prev]);
  }}));

  cleanups.push(keyboard.register({ key: 'enter', label: 'Select children', category: 'selection', handler: () => {
    // Select ALL direct children from all selected nodes (like old builder)
    const ids = selectedIdsRef.current;
    if (ids.length === 0) return;
    const allChildren: string[] = [];
    for (const id of ids) {
      const children = selectChildren(id, nodesRef.current);
      allChildren.push(...children);
    }
    if (allChildren.length > 0) setSelectedIds(allChildren);
  }}));

  // ─── Replica Selection ───────────────────────────────────────
  cleanups.push(keyboard.register({ key: 'b', shift: true, label: 'Select replica', category: 'selection', handler: () => {
    const sel = selectedIdRef.current;
    if (!sel) return;
    const contentEl = getContentRoot();
    if (!contentEl) return;
    const nextVpId = selectNextReplica(sel, contentEl);
    if (nextVpId) {
      // Switch interacting viewport and select the same node there
      // The setInteractingViewport is called from Canvas.tsx — dispatch a custom event
      window.dispatchEvent(new CustomEvent('revyme:select-viewport', { detail: { nodeId: sel, vpId: nextVpId } }));
    }
  }}));

  // ─── Structure Operations ─────────────────────────────────────
  cleanups.push(keyboard.register({ key: 'a', shift: true, label: 'Create Layout', category: 'structure', handler: () => {
    const ids = selectedIdsRef.current.length > 0
      ? selectedIdsRef.current
      : (selectedIdRef.current ? [selectedIdRef.current] : []);
    const contentEl = contentRef.current;
    if (ids.length === 0 || !contentEl) return;
    const frameId = wrapInLayout(ids, nodesRef.current, contentEl, handleNodeMouseDown);
    if (frameId) { flushNow(); setSelectedIds([frameId]); }
  }}));

  cleanups.push(keyboard.register({ key: 'a', shift: true, alt: true, label: 'Create Frame', category: 'structure', handler: () => {
    const ids = selectedIdsRef.current.length > 0
      ? selectedIdsRef.current
      : (selectedIdRef.current ? [selectedIdRef.current] : []);
    const contentEl = contentRef.current;
    if (ids.length === 0 || !contentEl) return;
    const frameId = wrapInFrame(ids, nodesRef.current, contentEl, handleNodeMouseDown);
    if (frameId) { flushNow(); setSelectedIds([frameId]); }
  }}));

  // Group SVGs (Ctrl+G) — wraps 2+ selected SVGs sharing a parent into a
  // single composite <svg>. Bails silently for non-SVG / single selections
  // so the shortcut doesn't surprise the user when they just want browser
  // find-in-page (which Ctrl+F handles, but Ctrl+G is the default browser
  // "find next"; we override only when the selection is groupable).
  cleanups.push(keyboard.register({ key: 'g', ctrl: true, label: 'Group SVGs', category: 'structure', handler: () => {
    const ids = selectedIdsRef.current;
    // Bails are traced (not silent): "Cmd+G does nothing on my sketches" is
    // undiagnosable from a debug trace otherwise — the trace must show the
    // ids + how the gate saw them (user report 2026-07-29, pure-sketch
    // group unreproducible locally).
    if (ids.length < 2) {
      trace.action('shortcut:group-svgs-bail', { reason: 'need-2-selected', ids: [...ids] });
      return;
    }
    const allSvg = ids.every(id => nodesRef.current.get(id)?.type === 'svg');
    if (!allSvg) {
      trace.action('shortcut:group-svgs-bail', {
        reason: 'not-all-svg',
        ids: [...ids],
        types: ids.map(id => nodesRef.current.get(id)?.type ?? 'MISSING-FROM-MAP'),
      });
      return;
    }
    const firstParent = nodesRef.current.get(ids[0])?.parentId;
    const sameParent = ids.every(id => nodesRef.current.get(id)?.parentId === firstParent);
    if (!sameParent) {
      trace.action('shortcut:group-svgs-bail', {
        reason: 'mixed-parents',
        ids: [...ids],
        parents: ids.map(id => nodesRef.current.get(id)?.parentId ?? null),
      });
      return;
    }
    const filePath = getDefaultStore().get(activeFilePathAtom);
    const vpId = getDefaultStore().get(interactingViewportIdAtom) || 'desktop';
    const newId = groupSvgs(ids, nodesRef.current, filePath, buildGroupSvgsOpts(ids, vpId));
    trace.action('shortcut:group-svgs', { ids, newId });
    if (newId) { flushNow(); setSelectedIds([newId]); }
  }}));

  // Ungroup SVGs (Ctrl+Shift+G) — inverse of Group. Bails silently unless
  // the single selected node IS a group (an <svg> whose children are all
  // nested <svg> wrappers), so it doesn't surprise other Ctrl+Shift+G uses.
  cleanups.push(keyboard.register({ key: 'g', ctrl: true, shift: true, label: 'Ungroup SVGs', category: 'structure', handler: () => {
    const sel = selectedIdRef.current;
    if (!sel) return;
    const node = nodesRef.current.get(sel);
    const kids = node?.children ?? [];
    if (node?.type !== 'svg' || kids.length === 0 || !kids.every(id => nodesRef.current.get(id)?.type === 'svg')) return;
    const filePath = getDefaultStore().get(activeFilePathAtom);
    const ids = ungroupSvgs(sel, nodesRef.current, filePath);
    trace.action('shortcut:ungroup-svgs', { groupId: sel, resultIds: ids });
    if (ids && ids.length > 0) { flushNow(); setSelectedIds(ids); }
  }}));

  cleanups.push(keyboard.register({ key: 'backspace', ctrl: true, label: 'Unfold Children', category: 'structure', handler: () => {
    const sel = selectedIdRef.current;
    const contentEl = contentRef.current;
    if (!sel || !contentEl) return;
    unfoldChildren(sel, nodesRef.current, contentEl);
    // DESELECT — the unfolded frame is gone. We deliberately do NOT re-select
    // the freed children: on a big page that recomputes the selection overlay +
    // every properties tool for N nodes (the slowdown the user hit) for no
    // benefit. Dropping the synchronous flushNow() too lets the queued
    // move+remove auto-flush on the next frame instead of freezing the UI ~0.3s
    // — unfoldChildren already blanked the frame's paint, so it reads as gone
    // instantly.
    setSelectedIds([]);
  }}));

  // ─── Lock / Hide ──────────────────────────────────────────────
  cleanups.push(keyboard.register({ key: 'l', ctrl: true, label: 'Lock/Unlock', category: 'general', handler: () => {
    const sel = selectedIdRef.current;
    const contentEl = contentRef.current;
    if (sel && contentEl) toggleLock(sel, contentEl, nodesRef.current);
  }}));

  cleanups.push(keyboard.register({ key: 'h', ctrl: true, label: 'Hide/Show', category: 'general', handler: () => {
    const sel = selectedIdRef.current;
    const contentEl = contentRef.current;
    if (sel && contentEl) toggleVisibility(sel, contentEl, nodesRef.current);
  }}));

  // ─── Rename (Layers-panel inline edit for the selected node) ──────
  // Matches the context menu's "Rename · Alt+R". Setting renamingNodeIdAtom is
  // exactly what ContextMenu.handleRename does → the Layers panel enters edit mode.
  cleanups.push(keyboard.register({ key: 'r', alt: true, label: 'Rename', category: 'general', handler: () => {
    const sel = selectedIdRef.current;
    if (sel) getDefaultStore().set(renamingNodeIdAtom, sel);
  }}));

  // ─── Copy/Paste/Cut/Duplicate ────────────────────────────────────
  // Select All — everything selectable at PAGE level: the primary viewport's
  // sections + top-level canvas nodes (template chrome / ghosts / overlays
  // excluded — see select-all.ts). KeyboardManager's typing guard keeps
  // Cmd+A native inside inputs and TipTap text editing.
  cleanups.push(keyboard.register({ key: 'a', ctrl: true, label: 'Select All', category: 'general', handler: () => {
    if (editingNodeIdRef.current) return; // text edit owns select-all
    const ids = selectAllPageNodeIds(nodesRef.current);
    trace.action('shortcuts:select-all', { count: ids.length });
    if (ids.length > 0) setSelectedIds(ids);
  }}));

  cleanups.push(keyboard.register({ key: 'c', ctrl: true, label: 'Copy', category: 'general', handler: () => {
    const ids = selectedIdsRef.current;
    if (ids.length > 0) copyNodes(ids, nodesRef.current);
  }}));

  cleanups.push(keyboard.register({ key: 'v', ctrl: true, label: 'Paste', category: 'general', handler: () => {
    trace.action('clipboard:ctrl-v-pressed');
    // Image-paste check FIRST. The KeyboardManager calls
    // `preventDefault()` on the keydown, so the browser never fires
    // the native `paste` event when Ctrl+V is pressed — meaning the
    // paste-event listener further down can't see image clipboards
    // from this code path. Read the image asynchronously via
    // `navigator.clipboard.read()` (the only API that returns binary
    // blobs outside a paste-event context). If an image is found,
    // route it through the paste engine and return. Otherwise fall
    // through to the existing text-clipboard logic.
    handleClipboardImagePasteFromKeyboard().then((imageUrl) => {
      if (imageUrl) {
        trace.action('image-paste:handled-from-ctrl-v', { url: imageUrl });
        return;
      }
      // Figma "Import to Revyme" clipboard — the plugin copies a hidden
      // text/html flavor carrying the design payload. Must be checked from
      // the HTML flavor (the text/plain flavor is a single space).
      readFigmaClipboard().then((figmaPayload) => {
        if (figmaPayload) {
          trace.action('figma-paste:detected-from-ctrl-v', { nodes: figmaPayload.nodes.length });
          void handleFigmaPaste(figmaPayload);
          return;
        }
        doTextPaste();
      }).catch((err) => {
        trace.error('figma-paste:ctrl-v-failed', err);
        doTextPaste();
      });
    }).catch((err) => {
      trace.error('image-paste:ctrl-v-failed', err);
      doTextPaste();
    });

    function doTextPaste() {
    navigator.clipboard.readText().then(text => {
      const trimmed = text?.trim() ?? '';
      const pluginUrl = trimmed ? parsePluginUrl(trimmed) : null;
      trace.action('clipboard:read-text', {
        text: trimmed.slice(0, 100),
        length: trimmed.length,
        isComponentUrl: trimmed ? isComponentUrl(trimmed) : false,
        isPluginUrl: !!pluginUrl,
      });
      // 1. Plugin URL — open cmd+K palette pre-filled. Wins over
      //    component URL because plugin URLs include `/api/plugins/`,
      //    a more specific pattern than the bare component CDN URL.
      if (CLOUD_ENABLED && pluginUrl) {
        trace.action('plugin-paste:detected-from-ctrl-v', { url: trimmed, id: pluginUrl.id });
        const store = getJotaiStore();
        store.set(paletteQueryAtom, trimmed);
        store.set(paletteOpenAtom, true);
        return;
      }
      // 2. Component CDN URL — import as a Code component node. Code AND design
      //    components share the same URL pattern. Cloud-only: the CDN and
      //    its share/fetch endpoints are Revyme infrastructure.
      if (CLOUD_ENABLED && isComponentUrl(trimmed)) {
        trace.action('component-paste:detected-from-ctrl-v', { url: trimmed });
        importComponentFromUrl(trimmed).then(ok => {
          trace.action('component-paste:import-result', { ok });
        });
        return;
      }
      // 2.5 reshaders "Copy for Revyme" — a FULL ClipboardData payload as
      //     JSON text (marker key `revymeClipboard: 1`). reshaders runs on
      //     a different origin, so the usual localStorage clipboard can't
      //     carry it; the payload rides the OS clipboard instead. Store it
      //     as the internal clipboard and run the standard paste — the
      //     component master materializes via ensureLocalComponentImports
      //     (no sourceProjectId → same-project path).
      if (trimmed.startsWith('{') && trimmed.includes('"revymeClipboard"')) {
        try {
          const payload = JSON.parse(trimmed);
          if (payload && payload.revymeClipboard === 1 && setExternalClipboardData(payload.data)) {
            trace.action('reshaders-paste:detected-from-ctrl-v', {
              nodes: payload.data?.nodes?.length,
              components: payload.data?.components?.length,
            });
            executePaste(nodesRef.current, contentRef.current, selectedIdRef.current, (id) => setSelectedIds(id ? [id] : []), handleNodeMouseDown);
            return;
          }
        } catch { /* not a reshaders payload — fall through */ }
      }
      // 2.6 reshaders component CODE ("Copy code" instead of "Copy for
      //     Revyme") — the raw TSX carries @shaderDoc + a default export.
      //     Synthesize the same ClipboardData so either button installs.
      if (trimmed.startsWith("'use client'") && trimmed.includes('@shaderDoc')) {
        const nameMatch = trimmed.match(/export default withResponsiveProps\((\w+)\)/) ||
          trimmed.match(/export default function (\w+)/);
        if (nameMatch) {
          const tag = nameMatch[1];
          const hMatch = trimmed.match(/@defaultHeight (\d+)/);
          const h = hMatch ? parseInt(hMatch[1], 10) : 400;
          const ok = setExternalClipboardData({
            version: 1,
            timestamp: Date.now(),
            nodes: [{
              id: `rs${Date.now().toString(36)}`,
              type: tag,
              parentId: null,
              children: [],
              order: 0,
              styles: { position: 'relative', width: '600px', height: `${h}px`, flex: '0 0 auto' },
              name: tag,
              componentFile: `components/${tag}.tsx`,
            }],
            components: [{
              tagName: tag,
              masterPath: `components/${tag}.tsx`,
              kind: 'code',
              files: [{ path: `components/${tag}.tsx`, content: trimmed }],
            }],
          } as never);
          if (ok) {
            trace.action('reshaders-paste:tsx-from-ctrl-v', { tag });
            executePaste(nodesRef.current, contentRef.current, selectedIdRef.current, (id) => setSelectedIds(id ? [id] : []), handleNodeMouseDown);
            return;
          }
        }
      }
      // 3. Internal node paste from localStorage `canvas_clipboard`.
      //    Only run when there's actually something in the internal
      //    clipboard — otherwise `executePaste` would surface an
      //    "Empty clipboard" error toast for what's actually a
      //    plain-text paste (handled at step 4).
      if (hasInternalClipboard()) {
        executePaste(nodesRef.current, contentRef.current, selectedIdRef.current, (id) => setSelectedIds(id ? [id] : []), handleNodeMouseDown);
        return;
      }
      // 4. Plain-text fallback — user copied real text from outside
      //    the editor (browser, document, terminal) and pasted on
      //    the canvas. Create a default-styled text node carrying
      //    that content, routed through the same paste engine so
      //    the target / positioning rules match other pastes.
      if (trimmed) {
        trace.action('text-paste:detected-from-ctrl-v', { length: trimmed.length });
        handleClipboardTextPaste(trimmed);
      }
    }).catch((err) => {
      trace.error('clipboard:read-text-failed', err);
      // Clipboard API failed (permissions) — fall back to internal
      // paste from localStorage. Best we can do without API access.
      executePaste(nodesRef.current, contentRef.current, selectedIdRef.current, (id) => setSelectedIds(id ? [id] : []), handleNodeMouseDown);
    });
    } // doTextPaste
  }}));

  cleanups.push(keyboard.register({ key: 'x', ctrl: true, label: 'Cut', category: 'general', handler: () => {
    const ids = selectedIdsRef.current;
    if (ids.length === 0) return;
    copyNodes(ids, nodesRef.current);
    const contentEl = contentRef.current;
    if (contentEl) { deleteNode(ids, contentEl); setSelectedIds([]); }
    trace.action('clipboard:cut', { nodeIds: ids });
  }}));

  cleanups.push(keyboard.register({ key: 'd', ctrl: true, label: 'Duplicate', category: 'general', handler: () => {
    const sel = selectedIdRef.current;
    if (!sel) return;
    duplicateSelection({
      nodes: nodesRef.current,
      primaryId: sel,
      contentEl: contentRef.current,
      setSelectedIds,
      handleNodeMouseDown,
    });
    trace.action('clipboard:duplicate', { nodeId: sel });
  }}));

  // ─── URL paste detection (Code component + Plugin) ──────────────────────────
  // Intercepts native paste event to detect Revyme URLs in the clipboard.
  // Two kinds detected here, both opted out when the user is typing in
  // an editable surface (input/textarea/contenteditable):
  //   1. Component CDN URLs  → import the Code component as a node (existing).
  //   2. Plugin draft/approved URLs → open the cmd+K palette pre-filled
  //      with the URL so the install card renders and the user can click
  //      "Install" to add the cloud plugin to the project.
  // Both branches preventDefault + stopPropagation so the paste doesn't
  // additionally trigger node-paste / text-insert side effects.
  const handlePasteEvent = (e: ClipboardEvent) => {
    // Don't intercept if user is typing in an input/textarea/contenteditable
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    // Image paste — checked BEFORE the text branch because the
    // clipboard often carries BOTH a file AND a text representation
    // of the image (e.g. screenshots from macOS Preview ship a file
    // plus a `text/html` describing it). If we let the text branch
    // run first an image paste of a Revyme URL'd component would
    // mis-route to the component-paste flow. The file branch is
    // unambiguous: presence of an `image/*` file means the user
    // wants to insert an image, full stop.
    if (hasClipboardImageInDataTransfer(e.clipboardData)) {
      e.preventDefault();
      e.stopPropagation();
      trace.action('image-paste:detected-from-event');
      // Fire-and-forget — handler owns its own error toasts + traces,
      // so we don't need to await. Awaiting would block the paste
      // event handler which the browser doesn't expect.
      void handleClipboardImagePasteFromEvent(e.clipboardData);
      return;
    }

    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (!text) return;

    if (isComponentUrl(text)) {
      e.preventDefault();
      e.stopPropagation();
      trace.action('component-paste:detected', { url: text });
      importComponentFromUrl(text);
      return;
    }

    if (parsePluginUrl(text)) {
      e.preventDefault();
      e.stopPropagation();
      trace.action('plugin-paste:detected', { url: text });
      const store = getJotaiStore();
      store.set(paletteQueryAtom, text);
      store.set(paletteOpenAtom, true);
      return;
    }
  };
  window.addEventListener('paste', handlePasteEvent, true);
  cleanups.push(() => window.removeEventListener('paste', handlePasteEvent, true));

  // ─── Arrow-key Nudge ─────────────────────────────────────────────
  // Absolute nodes: move by 1px (plain) / 10px (Shift) / 100px (Shift+Ctrl),
  // adjusting whichever sides the Position tool has pinned. Layout children:
  // arrow along the container's main axis moves the node's `order` one slot
  // (step is ignored for reorder). Replica-aware via nudgeSelection.
  const runNudge = (dir: NudgeDirection, step: number) => {
    if (editingNodeIdRef.current) return;
    const store = getDefaultStore();
    if (store.get(shapeEditingIdAtom)) return;
    if (store.get(groupEditingIdAtom)) return;
    if (toolModeRef.current !== 'select') return;
    const ids = selectedIdsRef.current;
    const contentEl = contentRef.current;
    if (ids.length === 0 || !contentEl) return;
    const vpId = store.get(interactingViewportIdAtom);
    trace.action('shortcut:arrow-nudge', { dir, step, ids, vpId });
    nudgeSelection(dir, step, {
      selectedIds: ids,
      nodes: nodesRef.current,
      contentEl,
      vpId,
    });
  };
  const nudgeKeys: Array<{ key: string; dir: NudgeDirection }> = [
    { key: 'arrowup', dir: 'up' },
    { key: 'arrowdown', dir: 'down' },
    { key: 'arrowleft', dir: 'left' },
    { key: 'arrowright', dir: 'right' },
  ];
  // Help-modal collapse: the four directions of each step are ONE logical
  // shortcut — only the 'up' registration carries the help row (label +
  // arrow-cluster helpKeys), the other three are hidden from the modal.
  const NUDGE_HELP_KEYS = ['↑', '↓', '←', '→'];
  for (const { key, dir } of nudgeKeys) {
    const help = dir === 'up'
      ? { helpKeys: NUDGE_HELP_KEYS }
      : { hideFromHelp: true };
    cleanups.push(keyboard.register({ key, label: dir === 'up' ? 'Nudge 1px' : `Nudge ${dir} 1px`, category: 'general', allowRepeat: true, ...help, handler: () => runNudge(dir, 1) }));
    cleanups.push(keyboard.register({ key, shift: true, label: dir === 'up' ? 'Nudge 10px' : `Nudge ${dir} 10px`, category: 'general', allowRepeat: true, ...help, handler: () => runNudge(dir, 10) }));
    cleanups.push(keyboard.register({ key, shift: true, ctrl: true, label: dir === 'up' ? 'Nudge 100px' : `Nudge ${dir} 100px`, category: 'general', allowRepeat: true, ...help, handler: () => runNudge(dir, 100) }));
  }

  // ─── Start listening ─────────────────────────────────────────────
  cleanups.push(keyboard.listen());

  return () => cleanups.forEach(fn => fn());
}
