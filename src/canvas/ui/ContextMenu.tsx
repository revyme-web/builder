// ContextMenu.tsx — Right-click context menu for canvas nodes and layer rows.
// Exact styling from old builder. Backdrop prevents canvas interaction while open.

import { useEffect, useRef, useCallback, useState } from 'react';
import { CDN_HOST_BARE } from '@/shared/hosts';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { createPortal } from 'react-dom';
import { contextMenuAtom, renamingNodeIdAtom } from '@/code/stores/context-menu-store';
import { codeAtom, nodesAtom, selectedNodeAtom, selectedIdsAtom, updatingFromCanvasAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNode, useNodesComputed } from '@/code/stores/node-family';
import type { CanvasNode } from '@/code/parsing/parser';
import { copyNodes, hasClipboard } from '@/code/features/paste-engine';
import {
  deleteNode, toggleLock, toggleVisibility,
  selectParent, selectChildren, selectNextSibling, selectPrevSibling, selectNextReplica,
  wrapInFrame, wrapInLayout, unfoldChildren,
} from '../commands';
import { getContentRoot, findNodeRect, parseRectCacheKey } from '../node-ops';
import { isTextTag } from '@/shared/constants';
import { getCanvasBridge } from '../canvas-bridge';
import { transformManager } from '../transform';
import { makeComponent, detachInstance, type ViewportDimensions } from '@/code/components/component-ops';
import { makeIconSetFromNodes } from '@/code/icons/icon-set-ops';
import { suppressSelectionOverlayAtom } from '@/code/stores/editor-store';
import { groupSvgs, ungroupSvgs } from '@/code/svg/group-svgs';
import { buildGroupSvgsOpts } from '@/canvas/svg-group-helper';
import { setForceRender, syncQueueCode, flushNow } from '@/code/mutation/mutation-queue';
import { activeFilePathAtom, componentBreadcrumbAtom, isComponentFilePath, isDesignComponentFile } from '@/code/project/active-file-store';
import { viewportsConfigAtom, interactingViewportIdAtom, isReplicaViewportAtom, isComponentVariantViewportAtom } from '@/code/stores/viewport-store';
import { enterComponentFile } from '@/canvas/component-navigation';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { trace } from '@/shared/debug-trace';
import NameInputModal from '@/editor/ui/NameInputModal';
import { useSuppressCanvasHover, stopHoverProbe } from './useSuppressCanvasHover';
import ReplaceWithMenu from './ReplaceWithMenu';

// ─── Menu Item Components ───────────────────────────────────────────────────

function MenuItem({ label, shortcut, onClick, disabled }: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  // Stop propagation on the FULL pointer-down → up cycle so the canvas's
  // pointerdown / mousedown listeners (which run BEFORE React's synthetic
  // onClick) don't receive the press and re-select whatever node is sitting
  // visually behind the menu. Without these, clicking "Create Frame" on a
  // peach square fires a canvas pointerdown that lands on the title text
  // below the menu — selection jumps to the title and the wrap action runs
  // against the wrong target.
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };
  return (
    <button
      onPointerDown={stop}
      onMouseDown={stop}
      onPointerUp={stop}
      onMouseUp={stop}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      disabled={disabled}
      className={`group flex items-center gap-3 mx-1.5 px-2 h-8 w-[calc(100%-12px)] text-left cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--accent)] ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] flex-1">
        {label}
      </span>
      {shortcut && (
        <span className="text-[10px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]/70">
          {shortcut}
        </span>
      )}
    </button>
  );
}

function Separator() {
  return <div className="h-px bg-white/10 mx-2 my-1" />;
}

function SubMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button className="group flex items-center gap-3 mx-1.5 px-2 h-8 w-[calc(100%-12px)] text-left cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--accent)]">
        <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] flex-1">{label}</span>
        <span className="text-[10px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]/70">▸</span>
      </button>
      {open && (
        <>
          {/* Transparent hover bridge — fills the visual gap between the
              parent row and the submenu. Without this, the cursor briefly
              leaves the SubMenu's relative wrapper while crossing 2px of
              empty space, fires `onMouseLeave`, and the submenu closes
              before the user can reach it. */}
          <div className="absolute left-full top-0 w-1 h-full" aria-hidden="true" />
          <div className="absolute left-full top-0 ml-0.5 bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-2 min-w-[200px] border border-[var(--border-light)] space-y-0.5">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Vector-set classification ──────────────────────────────────────────────
// A "set" is a collection of variants. We classify a selection by its
// DIRECT vector members: all SVGs (icons and/or sketches) → vector set,
// any non-SVG member → neither.

type VectorSetKind = 'vector' | 'none';

// Sketches are vectors now — a sketch (SVG freehand path) and an icon (SVG)
// bundle into the SAME "vector set". So any SVG node, or any group whose direct
// children are ALL SVG (icons and/or sketches, in any mix), is a valid vector
// set. Only a non-SVG direct child disqualifies it.
function classifyVectorSet(nodeId: string, nodes: Map<string, CanvasNode>): VectorSetKind {
  const root = nodes.get(nodeId);
  if (!root || root.type !== 'svg') return 'none';

  const svgChildren = root.children
    .map(id => nodes.get(id))
    .filter((n): n is CanvasNode => !!n && n.type === 'svg');

  // Single SVG node (icon or sketch) — itself the member.
  if (svgChildren.length === 0) return 'vector';

  // Group — any non-SVG direct child disqualifies a clean vector set.
  const hasNonSvg = root.children.some(id => { const c = nodes.get(id); return !!c && c.type !== 'svg'; });
  return hasNonSvg ? 'none' : 'vector';
}

// ─── Context Menu ───────────────────────────────────────────────────────────

export default function ContextMenu() {
  const [menu, setMenu] = useAtom(contextMenuAtom);
  const jotaiStore = useStore();
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setRenamingId = useSetAtom(renamingNodeIdAtom);
  const setCode = useSetAtom(codeAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const setActiveFile = useSetAtom(activeFilePathAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setInteractingVp = useSetAtom(interactingViewportIdAtom);
  const interactingVp = useAtomValue(interactingViewportIdAtom);
  const setComponentEditorFile = useSetAtom(componentEditorFileAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const menuRef = useRef<HTMLDivElement>(null);
  // No hover hit-testing behind the open menu (and clear the lingering one).
  useSuppressCanvasHover(menu.show);
  const [makeCompModal, setMakeCompModal] = useState<{ nodeId: string } | null>(null);
  const [makeCompName, setMakeCompName] = useState('');
  // Make-icon-set modal — same pattern as makeCompModal but routes to the
  // icon-set ops. Kept as separate state so an in-progress component name
  // entry doesn't bleed across modals if the user changes their mind.
  const [makeIconSetModal, setMakeIconSetModal] = useState<{ nodeIds: string[] } | null>(null);
  const [makeIconSetName, setMakeIconSetName] = useState('');

  // Adjust position to stay on screen
  useEffect(() => {
    if (!menu.show || !menuRef.current) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = menu.x;
    let y = menu.y;

    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [menu.show, menu.x, menu.y]);

  // Close on Escape
  useEffect(() => {
    if (!menu.show) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setMenu(prev => ({ ...prev, show: false })); }
    };
    window.addEventListener('keydown', handleKey, true); // capture phase
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [menu.show, setMenu]);

  const close = useCallback(() => {
    setMenu(prev => ({ ...prev, show: false }));
  }, [setMenu]);

  const getContentEl = useCallback(() => getContentRoot(), []);

  const viewports = useAtomValue(viewportsConfigAtom);
  // "Make Component" must run on a PRIMARY element only — never a replica viewport (tablet/mobile on a page)
  // nor a non-default variant artboard (inside a design component). Both write to non-primary code paths that
  // can't host a brand-new component. True = the right-clicked artboard is NOT primary → disable the action.
  const isReplicaVp = useAtomValue(isReplicaViewportAtom);
  const isNonPrimaryVariantVp = useAtomValue(isComponentVariantViewportAtom);
  const isNonPrimaryArtboard = isReplicaVp || isNonPrimaryVariantVp;

  const handleMakeComponentConfirm = () => {
    if (!makeCompModal || !makeCompName.trim()) return;
    const nodes = getNodesSnapshot();
    const targetNodeId = makeCompModal.nodeId;

    // Detect if this node is a direct child of the page root (viewport child).
    // The page root has data-id="root" in the JSX. After layout merge, it may be
    // reparented but its own id stays "root".
    const targetNode = nodes.get(targetNodeId);
    const isPageFile = !isComponentFilePath(activeFilePath);
    const parentNode = targetNode?.parentId ? nodes.get(targetNode.parentId) : null;
    // Walk up: is any ancestor the page root?
    let isDirectViewportChild = false;
    if (isPageFile && parentNode) {
      // Direct parent check
      if (parentNode.id === 'root' || parentNode.name === 'Page') {
        isDirectViewportChild = true;
      }
      // Layout merge: parent might be the layout's {children} placeholder parent
      // In that case, check if grandparent or great-grandparent is the page root
      if (!isDirectViewportChild) {
        let ancestor: CanvasNode | null = parentNode;
        for (let depth = 0; depth < 3 && ancestor; depth++) {
          if (ancestor.id === 'root' || ancestor.name === 'Page') {
            // Only count as direct child if depth is 0 (actual direct child)
            // Layout wrappers don't count
            if (depth === 0) isDirectViewportChild = true;
            break;
          }
          ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) ?? null : null;
        }
      }
    }

    // Capture computed dimensions from DOM BEFORE extraction
    const scale = transformManager.getTransform().scale;
    const vpDims: ViewportDimensions[] = [];

    trace.action('component-ops:detect-viewport-child', {
      targetNodeId,
      isPageFile,
      parentId: targetNode?.parentId,
      parentNodeId: parentNode?.id,
      parentName: parentNode?.name,
      parentParentId: parentNode?.parentId,
      isDirectViewportChild,
      viewportCount: viewports.length,
    });

    if (isDirectViewportChild && viewports.length > 1) {
      // Capture from each viewport's copy of this node
      for (const vp of viewports) {
        const rect = findNodeRect(targetNodeId, vp.id);
        trace.action('component-ops:find-viewport-el', { vpId: vp.id, nodeId: targetNodeId, found: !!rect });
        if (rect) {
          vpDims.push({
            vpId: vp.id,
            vpLabel: vp.label,
            width: Math.round(rect.width / scale),
            height: Math.round(rect.height / scale),
            vpWidth: vp.width || 1440,
          });
        }
      }
    } else {
      // Single viewport — capture from primary
      const rect = findNodeRect(targetNodeId, 'desktop');
      if (rect) {
        vpDims.push({
          vpId: 'desktop',
          vpLabel: 'Desktop',
          width: Math.round(rect.width / scale),
          height: Math.round(rect.height / scale),
          vpWidth: 1440,
        });
      }
    }

    // CMS COMPONENT (Mechanism B) — if the node lives inside a `.map()` collection
    // list, find the iterator var on the nearest collectionList ancestor so
    // makeComponent can auto-wire its `item.field` bindings into props + pass them
    // per item on the instance. (`collectionList` sits on the element CONTAINING
    // the .map(), i.e. an ancestor of the template root being componentized.)
    let cmsItemVar: string | undefined;
    let cmsSource: string | undefined;
    {
      let cursor: typeof targetNode | null = targetNode ?? null;
      for (let i = 0; i < 12 && cursor; i++) {
        // `source` (the collection slug) lets makeComponent seed prop defaults + types
        // from the collection's first item — so the new master renders real content.
        if (cursor.collectionList) { cmsItemVar = cursor.collectionList.itemVar; cmsSource = cursor.collectionList.source; break; }
        cursor = cursor.parentId ? nodes.get(cursor.parentId) ?? null : null;
      }
    }

    // Make Component on a PURE TEXT node → wrap it in a FRAME root sized to the
    // text FIRST (design-tool parity). A bare text component root lays out awkwardly
    // (position:absolute, no box); wrapInFrame builds a frame at the text's bbox
    // (auto → computed px), moves the text inside, and we componentize the FRAME.
    // vpDims (measured from the text) equals the frame's bbox, so it stays valid.
    let compTargetId = targetNodeId;
    if (targetNode && isTextTag(targetNode.type) && (!targetNode.children || targetNode.children.length === 0)) {
      const wrapEl = getContentRoot();
      if (wrapEl) {
        const frameId = wrapInFrame([targetNodeId], nodes, wrapEl);
        if (frameId) {
          compTargetId = frameId;
          trace.action('component-ops:make-component-wrap-text', { textId: targetNodeId, frameId });
        }
      }
    }

    const result = makeComponent(
      activeFilePath, compTargetId, makeCompName.trim(),
      !!isDirectViewportChild && vpDims.length > 1,
      vpDims.length > 0 ? vpDims : undefined,
      cmsItemVar,
      cmsSource,
    );
    if (result) {
      setForceRender();
      setCode(result.updatedPageCode);
      syncQueueCode(result.updatedPageCode);
      setVersion(v => v + 1);
      setSelectedIds([]);

      // Navigate INTO the freshly-created component master so the user can
      // start editing the variant immediately. Centralized helper mirrors
      // the double-click-on-instance and Edit-Component-button flows so all
      // three behave identically (timing, breadcrumb, zoom strength).
      // `setSuppressSelectionOverlay` is wired here so the SelectionBorder
      // doesn't flash huge against stale rect-cache entries during the
      // file switch — same suppression the dbl-click path uses.
      enterComponentFile(
        // focusVariantName: 'default' so the camera centers on the
        // primary variant viewport, not the (way-out) union of all
        // variants laid side-by-side. Matches the dbl-click flow.
        { fromFilePath: activeFilePath, componentFilePath: result.componentFilePath, initialVariant: 'default', focusVariantName: 'default' },
        {
          setActiveFile,
          setBreadcrumb,
          setSelectedIds,
          setUpdatingFromCanvas,
          setInteractingViewport: setInteractingVp,
          getNodes: () => jotaiStore.get(nodesAtom),
          openCodeEditor: setComponentEditorFile,
          setSuppressSelectionOverlay: (v) => jotaiStore.set(suppressSelectionOverlayAtom, v),
        },
      );
    }
    setMakeCompModal(null);
    setMakeCompName('');
  };

  const nodeId = menu.show ? (menu.nodeId || selectedId) : null;
  // Fine-grained subscriptions: the menu's render only needs THIS node, its
  // parent, and the vector-set classification — not the whole map.
  const nodeFromFamily = useNode(nodeId);
  const node = nodeId ? nodeFromFamily ?? null : null;
  const parentNode = useNode(node?.parentId);
  // Vector-set / svg-group gates — bounded children walks over the map,
  // grouped into ONE computed subscription. Only meaningful while the menu is
  // open (nodeId is null when hidden → cheap 'none'/false results).
  const vectorGates = useNodesComputed((nodes) => {
    const setKind: VectorSetKind = nodeId ? classifyVectorSet(nodeId, nodes) : 'none';
    // Multi-select → multi-variant: 2+ sibling nodes, each itself a valid vector
    // set member (a single SVG OR an all-SVG group). Each selected node becomes
    // its own variant, sized individually to its shape; a selected group bundles
    // into ONE variant. See `makeIconSetFromNodes`.
    const canMakeVectorSetMulti = (() => {
      if (selectedIds.length < 2) return false;
      const firstParent = nodes.get(selectedIds[0])?.parentId;
      if (!selectedIds.every(id => nodes.get(id)?.parentId === firstParent)) return false;
      return selectedIds.every(id => classifyVectorSet(id, nodes) === 'vector');
    })();
    const canGroupSvgs = (() => {
      if (selectedIds.length < 2) return false;
      if (!selectedIds.every(id => nodes.get(id)?.type === 'svg')) return false;
      const firstParent = nodes.get(selectedIds[0])?.parentId;
      return selectedIds.every(id => nodes.get(id)?.parentId === firstParent);
    })();
    const canUngroupSvg = (() => {
      if (!node || node.type !== 'svg') return false;
      const kids = node.children ?? [];
      return kids.length > 0 && kids.every(id => nodes.get(id)?.type === 'svg');
    })();
    return { setKind, canMakeVectorSetMulti, canGroupSvgs, canUngroupSvg };
  }, [nodeId, selectedIds, node]);

  // Make Component modal — uses centralized NameInputModal
  const handleCloseCompModal = () => { setMakeCompModal(null); setMakeCompName(''); };
  const makeCompModalEl = (
    <NameInputModal
      isOpen={!!makeCompModal}
      onClose={handleCloseCompModal}
      onSubmit={(name) => { setMakeCompName(name); setTimeout(() => handleMakeComponentConfirm(), 0); }}
      title="Name Component"
      placeholder="Component name"
      defaultValue={makeCompName || node?.name || ''}
      submitLabel="Create Component"
      // Component flows use the purple component-system accent; the
      // sibling "Make Vector Set" modal below keeps the
      // default blue because vectors live in the Vectors section.
      accentColor="var(--accent-secondary, #9a66ff)"
    />
  );

  // Make Vector Set modal — separate state
  // so the flows don't share an in-progress name across modals. We
  // pass the typed name DIRECTLY to the confirm handler (rather than
  // going through state + setTimeout like the Make Component flow
  // does) so no closure-staleness can drop the action between submit
  // and the actual op call.
  const handleCloseIconSetModal = () => { setMakeIconSetModal(null); setMakeIconSetName(''); };
  const makeIconSetModalEl = (
    <NameInputModal
      isOpen={!!makeIconSetModal}
      onClose={handleCloseIconSetModal}
      onSubmit={(name) => { setMakeIconSetName(name); handleMakeIconSetConfirm(name); }}
      title="Name Vector Set"
      placeholder="Vector set name"
      defaultValue={makeIconSetName || node?.name || ''}
      submitLabel="Create Vector Set"
    />
  );

  if (!menu.show) return <>{makeCompModalEl}{makeIconSetModalEl}</>;
  const hasChildren = node ? node.children.length > 0 : false;
  // A component INSTANCE (`<MyComp/>`) carries `componentFile`. Its construction/structure items
  // (Make Component, Make into Map, Unfold Children) are meaningless — it's already a component
  // whose children come from the master — so we hide them and offer "Detach Instance" instead.
  const isInstance = !!node?.componentFile;
  // "Detach Instance" inlines the master's JSX as plain nodes — only meaningful for a
  // DESIGN component (visually authored, has variantConfig/@name). A CODE component is
  // arbitrary user React with no inlineable node tree, so Detach is hidden for it.
  const isDesignInstance = isInstance && !!node?.componentFile && isDesignComponentFile(node.componentFile);
  // SVG shapes (and SVG groups) only offer "Make Vector Set" —
  // "Make Component" and "Make into Map" are meaningless for a raw vector.
  const isSvg = node?.type === 'svg';
  const instanceComponentFile = node?.componentFile ?? null;
  // "Replace with" applies to REAL component instances only — design OR code
  // components (interchangeable), but NOT icon sets. Mirrors the
  // isComponentSelectedAtom qualifier (under components/ or the CDN prefix).
  const isComponentInstanceForReplace = isInstance && !!instanceComponentFile &&
    (isComponentFilePath(instanceComponentFile) || instanceComponentFile.includes(`${CDN_HOST_BARE}/components/`));
  const isLocked = node?.styles.pointerEvents === 'none';
  const isHidden = node?.styles.display === 'none';
  const hasSiblings = node?.parentId ? (parentNode?.children.length ?? 0) > 1 : false;

  // ─── Top "construction" section visibility ───────────────────────────────
  // Each conditional item above the first Separator. Computed here so the
  // LEADING Separator can be hidden when the whole section is empty — e.g. a
  // sketch (not an instance, IS an svg, nothing to group/ungroup, no set) would
  // otherwise leave an orphaned divider at the very top of the menu.
  // (setKind / canMakeVectorSetMulti / canGroupSvgs / canUngroupSvg come from
  // the `vectorGates` computed subscription above the early return.)
  const { setKind, canMakeVectorSetMulti, canGroupSvgs, canUngroupSvg } = vectorGates;
  trace.action('context-menu:icon-set-gate', { nodeType: node?.type, nodeId, kind: setKind, canMakeVectorSetMulti, selCount: selectedIds.length });
  const showMakeVectorSet = setKind === 'vector' || canMakeVectorSetMulti;
  // Make Component — PRIMARY artboards ONLY. Hidden entirely (not greyed) on a replica viewport / non-default
  // variant artboard: a brand-new component can't be hosted there (writes route to per-viewport/per-variant
  // overrides). Baked in here so `hasTopSection` (the separator guard) drops with it — no orphaned separator.
  // SINGLE selection only: Make Component wraps ONE node — offering it on a
  // multi-selection made no sense (the reference hides it too; user report 2026-08-06).
  const showComponentOrMap = !isInstance && !isSvg && !isNonPrimaryArtboard && selectedIds.length <= 1; // (Make into Map retired)
  // Detach Instance is the only instance-gated top item, and it's now design-only
  // (`isDesignInstance`). Using the broader `isInstance` here left the leading
  // separator orphaned at the top for CODE-component instances (Detach hidden,
  // nothing else in the section).
  const hasTopSection = isDesignInstance || showComponentOrMap || showMakeVectorSet
    || canGroupSvgs || canUngroupSvg;

  const contentEl = getContentRoot();
  // Count replicas via bridge rectCache
  const hasReplicas = (() => {
    if (!nodeId) return false;
    const bridge = getCanvasBridge();
    if (!('rectCache' in bridge)) return false;
    const cache = (bridge as any).rectCache as Map<string, DOMRect>;
    let count = 0;
    for (const key of cache.keys()) {
      const cachedNodeId = parseRectCacheKey(key)?.nodeId ?? key;
      if (cachedNodeId === nodeId) count++;
      if (count > 1) return true;
    }
    return false;
  })();

  // ─── Handlers ─────────────────────────────────────────────────────

  const handleCopy = () => {
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length > 0) copyNodes(ids, getNodesSnapshot());
    close();
  };

  const handleCut = () => {
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length === 0) return;
    copyNodes(ids, getNodesSnapshot());
    const contentEl = getContentEl();
    if (contentEl) deleteNode(ids, contentEl);
    setSelectedIds([]);
    close();
  };

  const handlePaste = () => {
    close();
    // Small delay so context menu closes before paste creates nodes
    setTimeout(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
    }, 10);
  };

  const handleDuplicate = () => {
    close();
    setTimeout(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
    }, 10);
  };

  const handleDelete = () => {
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length === 0) return;
    const contentEl = getContentEl();
    if (contentEl) deleteNode(ids, contentEl);
    setSelectedIds([]);
    close();
  };

  const handleSelectParent = () => {
    if (!nodeId) return;
    const parentId = selectParent(nodeId, getNodesSnapshot());
    if (parentId) setSelectedIds([parentId]);
    close();
  };

  const handleSelectChildren = () => {
    // Select ALL direct children (like old builder)
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    const nodes = getNodesSnapshot();
    const allChildren: string[] = [];
    for (const id of ids) {
      allChildren.push(...selectChildren(id, nodes));
    }
    if (allChildren.length > 0) setSelectedIds(allChildren);
    close();
  };

  const handleSelectNextSibling = () => {
    if (!nodeId) return;
    const next = selectNextSibling(nodeId, getNodesSnapshot());
    if (next) setSelectedIds([next]);
    close();
  };

  const handleSelectPrevSibling = () => {
    if (!nodeId) return;
    const prev = selectPrevSibling(nodeId, getNodesSnapshot());
    if (prev) setSelectedIds([prev]);
    close();
  };

  const handleSelectReplica = () => {
    if (!nodeId) return;
    const contentEl = getContentRoot();
    if (!contentEl) return;
    const nextVpId = selectNextReplica(nodeId, contentEl);
    if (nextVpId) {
      window.dispatchEvent(new CustomEvent('revyme:select-viewport', { detail: { nodeId, vpId: nextVpId } }));
    }
    close();
  };

  const handleCreateFrame = () => {
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length === 0) return;
    const contentEl = getContentEl();
    if (!contentEl) return;
    const frameId = wrapInFrame(ids, getNodesSnapshot(), contentEl);
    if (frameId) {
      // Force the queued addNode + moves to land in JSX before we set
      // selection — otherwise the panel reads stale node data.
      flushNow();
      setSelectedIds([frameId]);
    }
    close();
  };

  const handleCreateLayout = () => {
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length === 0) return;
    const contentEl = getContentEl();
    if (!contentEl) return;
    const frameId = wrapInLayout(ids, getNodesSnapshot(), contentEl);
    if (frameId) {
      flushNow();
      setSelectedIds([frameId]);
    }
    close();
  };

  const handleUnfold = () => {
    if (!nodeId) return;
    const contentEl = getContentEl();
    if (!contentEl) return;
    unfoldChildren(nodeId, getNodesSnapshot(), contentEl);
    // DESELECT — don't re-select the freed children: recomputing the selection
    // overlay + every tool for N nodes on a big page is the slow part, for no
    // benefit. No synchronous flushNow either — the queued move+remove
    // auto-flushes next frame while the imperatively-blanked frame already reads
    // as gone, instead of freezing the UI ~0.3s.
    setSelectedIds([]);
    close();
  };

  const handleDetachInstance = () => {
    if (!nodeId) return;
    const inst = getNodesSnapshot().get(nodeId);
    const compFile = inst?.componentFile;
    if (!compFile) return;
    // Bake the variant the instance currently resolves to (its base initialVariant; per-viewport
    // data-responsive overrides fall back to 'default' on the primary, which is the usual detach view).
    const resolvedVariant = inst?.attrs?.initialVariant || 'default';
    syncQueueCode(jotaiStore.get(codeAtom));
    flushNow();
    const detachOut: { rootId?: string } = {};
    const newCode = detachInstance(activeFilePath, nodeId, compFile, resolvedVariant, detachOut);
    if (newCode) {
      setForceRender();
      setCode(newCode);
      syncQueueCode(newCode);
      setVersion(v => v + 1);
      // Re-select the detached node (now a normal node with a fresh det-* id) so the
      // user keeps working on it — the old instance id is gone after the re-parse.
      setSelectedIds(detachOut.rootId ? [detachOut.rootId] : []);
    }
    trace.action('context-menu:detach-instance', { nodeId, componentFile: compFile, resolvedVariant, newRootId: detachOut.rootId });
    close();
  };

  const handleToggleLock = () => {
    if (!nodeId) return;
    const contentEl = getContentEl();
    if (contentEl) toggleLock(nodeId, contentEl, getNodesSnapshot());
    close();
  };

  const handleToggleVisibility = () => {
    if (!nodeId) return;
    const contentEl = getContentEl();
    if (contentEl) toggleVisibility(nodeId, contentEl, getNodesSnapshot());
    close();
  };

  const handleRename = () => {
    if (!nodeId) return;
    setRenamingId(nodeId);
    close();
  };

  const handleMakeComponent = () => {
    if (!nodeId) return;
    // PRIMARY-ONLY: a replica viewport / non-default variant artboard can't host a brand-new component
    // (its writes route to per-viewport / per-variant overrides). Guard here so the Ctrl+Alt+K shortcut is
    // blocked too, not just the (already-disabled) menu item.
    if (isNonPrimaryArtboard) {
      trace.action('context-menu:make-component-blocked-non-primary', { nodeId, isReplicaVp, isNonPrimaryVariantVp });
      return;
    }
    // Open modal instead of prompt — use node name as default
    setMakeCompName(node?.name || node?.type || '');
    setMakeCompModal({ nodeId });
    close();
  };

  // Group — wrap N selected SVGs into a single composite <svg>. Routes
  // through the orphaned `groupSvgs` helper which writes to ProjectFS via
  // modifyProjectFile + computes the union bounding box. Selection lands on
  // the new group so the user can immediately reposition / resize it.
  const handleGroupSvgs = () => {
    const ids = selectedIds.length > 0 ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length < 2) return;
    const newId = groupSvgs(ids, getNodesSnapshot(), activeFilePath, buildGroupSvgsOpts(ids, interactingVp || 'desktop'));
    trace.action('context-menu:group-svgs', { ids, newId });
    if (newId) {
      flushNow();
      setSelectedIds([newId]);
    }
    close();
  };

  // Ungroup — the inverse of Group. Replaces a group <svg> with its direct
  // child SVGs lifted back to independent top-level SVGs at the same spot.
  // Selection lands on all the freed children.
  const handleUngroupSvgs = () => {
    if (!nodeId) return;
    const ids = ungroupSvgs(nodeId, getNodesSnapshot(), activeFilePath);
    trace.action('context-menu:ungroup-svgs', { nodeId, resultIds: ids });
    if (ids && ids.length > 0) {
      flushNow();
      setSelectedIds(ids);
    }
    close();
  };

  // Make Vector Set — meaningful only for SVG
  // selections. Mirror
  // Make Component: open the name modal → on submit, extract the SVG
  // into a fresh master file and navigate into it.
  const handleMakeVectorSet = () => {
    // Multi-select → bundle every selected node as its own variant; otherwise
    // the single right-clicked node becomes a one-variant set.
    const ids = canMakeVectorSetMulti ? selectedIds : (nodeId ? [nodeId] : []);
    if (ids.length === 0) return;
    setMakeIconSetName(ids.length > 1 ? 'Vector Set' : (node?.name || 'Vector Set'));
    setMakeIconSetModal({ nodeIds: ids });
    close();
  };

  // Function declaration (not a `const` arrow) so it's hoisted to the top
  // of the component body. Necessary because the modal JSX that references
  // this handler is constructed BEFORE this point in source order, AND the
  // function early-returns at `if (!menu.show)` before any `const` below
  // would be initialized — the modal still renders from the early-return
  // branch, so its onSubmit closure must reach a usable handler. A `const`
  // arrow declared down here is in TDZ when the early-return path renders;
  // a function declaration is hoisted and always available.
  function handleMakeIconSetConfirm(submittedName?: string) {
    // The modal's onSubmit passes the user-typed name directly so we don't
    // depend on the setMakeIconSetName state having flushed yet (the
    // closure of any setTimeout deferred from onSubmit would otherwise
    // see the previous render's value). Falls back to the state for
    // call-sites that don't pass a name (Enter shortcut path).
    const finalName = (submittedName ?? makeIconSetName).trim();
    trace.action('icon-set:confirm-modal', { hasModal: !!makeIconSetModal, finalName, activeFilePath });
    if (!makeIconSetModal || !finalName) {
      trace.error('icon-set:confirm-bail', { reason: !makeIconSetModal ? 'no-modal' : 'empty-name' });
      return;
    }
    const targetNodeIds = makeIconSetModal.nodeIds;

    // Sketches are vectors now — icons, sketches, and mixed groups all bundle
    // into a vector set via `makeIconSetFromNodes`. Multiple selected nodes →
    // one set with a variant per node, each sized to its own shape.
    const r = makeIconSetFromNodes(activeFilePath, targetNodeIds, finalName);
    const result = r ? { masterFilePath: r.iconSetFilePath, updatedPageCode: r.updatedPageCode } : null;
    trace.action('vector-set:confirm-result', { ok: !!result, targetNodeIds, finalName });
    if (result) {
      setForceRender();
      setCode(result.updatedPageCode);
      syncQueueCode(result.updatedPageCode);
      setVersion(v => v + 1);
      setSelectedIds([]);

      // Navigate INTO the freshly-created master, same as Make
      // Component. enterComponentFile handles the breadcrumb push,
      // viewport switch, and zoom-to-fit. Pass:
      //   - `focusNodeId`: the only variant in a freshly-made set is
      //     `icon-1` (per `makeIconSet`),
      //     so threading the id lets `computeFileEntryBounds` zoom to
      //     that one variant card with the same SVG-aware geometry the
      //     dbl-click flow uses — no jump from "all-content fit" to
      //     "single-variant focus" mid-transition.
      //   - `setSuppressSelectionOverlay`: the same overlay-flash
      //     suppression the dbl-click path wires. Without it, the
      //     SelectionBorder polls stale rect-cache entries from the
      //     previous file for one frame and visibly flashes huge
      //     before the new master's rects land in the cache. Wiring
      //     it makes Make Vector Set use the same
      //     no-flash transition the canvas dbl-click already uses.
      // We deliberately omit `openCodeEditor` — icon-set
      // files navigate to the master canvas, not a code-editor overlay
      // (they don't carry @controls so the helper wouldn't route
      // there anyway, but explicit-is-better-than-implicit).
      const focusId = 'icon-1';
      enterComponentFile(
        {
          fromFilePath: activeFilePath,
          componentFilePath: result.masterFilePath,
          initialVariant: 'default',
          focusNodeId: focusId,
        },
        {
          setActiveFile,
          setBreadcrumb,
          setSelectedIds,
          setUpdatingFromCanvas,
          setInteractingViewport: setInteractingVp,
          getNodes: () => jotaiStore.get(nodesAtom),
          setSuppressSelectionOverlay: (v) => jotaiStore.set(suppressSelectionOverlayAtom, v),
        },
      );
    }
    setMakeIconSetModal(null);
    setMakeIconSetName('');
  }

  trace.action('context-menu:render', { nodeId });

  const contextMenuEl = createPortal(
    <>
      {/* Invisible backdrop — blocks canvas interaction, closes on click.
          Stops pointer-down too: without it, the press half of the click
          fires through the backdrop into the canvas' pointer handlers,
          which run before React's synthetic onClick and re-select whatever
          is behind the menu.

          z-index: the right-click menu must sit ABOVE everything else —
          BottomToolbar (z-9998), the headers (z-9999), the PageChat AI bar
          (z-9997), and even the dev DebugToolbar (zIndex 999999). It was
          previously z-1000, so it rendered BEHIND all of those. */}
      <div
        className="fixed inset-0 z-[1000000]"
        {...stopHoverProbe}
        onPointerDown={(e) => { e.stopPropagation(); close(); }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={close}
        onContextMenu={(e) => { e.preventDefault(); close(); }}
        onWheel={(e) => e.preventDefault()}
      />

      {/* Menu — one above the backdrop, above all other UI (see comment above) */}
      <div
        ref={menuRef}
        className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] rounded-[var(--radius-md)] py-2 z-[1000001] min-w-[240px] border border-[var(--border-light)] space-y-0.5"
        style={{ left: menu.x, top: menu.y }}
        {...stopHoverProbe}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Construction shortcuts — most-used surface, kept at top */}
        {/* Detach Instance — only for component instances; inlines the master's content as normal
            nodes (resolving variables/variant/styles), keeping any NESTED instances as instances. */}
        {isDesignInstance && (
          <MenuItem label="Detach Instance" shortcut="Ctrl+Alt+B" onClick={handleDetachInstance} disabled={!nodeId} />
        )}
        {showComponentOrMap && (
          <MenuItem label="Make Component" shortcut="Ctrl+Alt+K" onClick={handleMakeComponent} disabled={!nodeId} />
        )}
        {/* Make Vector Set — any SVG node or all-SVG group (icons and/or
            sketches; sketches bundle into vector sets). */}
        {showMakeVectorSet && (
          <MenuItem label="Make Vector Set" onClick={handleMakeVectorSet} disabled={!nodeId && !canMakeVectorSetMulti} />
        )}
        {/* Group — collapse 2+ SVGs that share a parent into a single composite <svg>. */}
        {canGroupSvgs && (
          <MenuItem label="Group" shortcut="Ctrl+G" onClick={handleGroupSvgs} />
        )}
        {/* Ungroup — the right-clicked node IS a group: an <svg> whose children
            are ALL nested <svg> wrappers. Inverse of Group. */}
        {canUngroupSvg && (
          <MenuItem label="Ungroup" shortcut="Ctrl+Shift+G" onClick={handleUngroupSvgs} />
        )}
        {/* "Make into Map" (inline .map() repeater) was retired — CMS
            collection lists are the single authoring path for repeats now.
            The inline-map ENGINE (parser `inlineMapData` + Renderer ghosts +
            map-gen) is kept so any EXISTING inline maps still render/edit. */}
        {/* No "Unbind from <collection>" item — the reference has no such action; a
            collection list is removed by deleting it, not unbound in place.
            (Binding happens by dragging a collection from the Insert panel.) */}

        {/* Leading separator — only when the construction section above it
            actually rendered something, else it orphans at the top of the menu. */}
        {hasTopSection && <Separator />}

        {/* Replace with — design/code component instances only. A trailing
            separator divides it from the edit operations below. */}
        {isComponentInstanceForReplace && nodeId && (
          <>
            <ReplaceWithMenu
              nodeId={nodeId}
              currentFile={instanceComponentFile}
              width={node?.styles.width}
              height={node?.styles.height}
              onDone={close}
            />
            <Separator />
          </>
        )}

        {/* Edit operations */}
        <MenuItem label="Cut" shortcut="Ctrl+X" onClick={handleCut} disabled={!nodeId} />
        <MenuItem label="Copy" shortcut="Ctrl+C" onClick={handleCopy} disabled={!nodeId} />
        <MenuItem label="Paste" shortcut="Ctrl+V" onClick={handlePaste} disabled={!hasClipboard()} />
        <MenuItem label="Duplicate" shortcut="Ctrl+D" onClick={handleDuplicate} disabled={!nodeId} />

        <Separator />

        {/* Selection submenu */}
        <SubMenu label="Select">
          <MenuItem label="Parent" shortcut="Esc" onClick={handleSelectParent} disabled={!node?.parentId} />
          <MenuItem label="Children" shortcut="Enter" onClick={handleSelectChildren} disabled={!hasChildren} />
          <Separator />
          <MenuItem label="Next Sibling" shortcut="Tab" onClick={handleSelectNextSibling} disabled={!hasSiblings} />
          <MenuItem label="Previous Sibling" shortcut="Shift+Tab" onClick={handleSelectPrevSibling} disabled={!hasSiblings} />
          <Separator />
          <MenuItem label="Replica" shortcut="Shift+B" onClick={handleSelectReplica} disabled={!hasReplicas} />
        </SubMenu>

        <Separator />

        {/* Structure */}
        <MenuItem label="Create Layout" shortcut="Shift+A" onClick={handleCreateLayout} disabled={!nodeId} />
        <MenuItem label="Create Frame" shortcut="Shift+Alt+A" onClick={handleCreateFrame} disabled={!nodeId} />
        {!isInstance && (
          <MenuItem label="Unfold Children" shortcut="Ctrl+Bksp" onClick={handleUnfold} disabled={!hasChildren} />
        )}

        <Separator />

        <MenuItem label="Rename" shortcut="Alt+R" onClick={handleRename} disabled={!nodeId} />

        <MenuItem label={isLocked ? 'Unlock' : 'Lock'} shortcut="Ctrl+L" onClick={handleToggleLock} disabled={!nodeId} />
        <MenuItem label={isHidden ? 'Show' : 'Hide'} shortcut="Ctrl+H" onClick={handleToggleVisibility} disabled={!nodeId} />

        <Separator />

        {/* Delete */}
        <MenuItem label="Delete" shortcut="Del" onClick={handleDelete} disabled={!nodeId} />
      </div>
    </>,
    document.body,
  );
  return <>{contextMenuEl}{makeCompModalEl}{makeIconSetModalEl}</>;
}
