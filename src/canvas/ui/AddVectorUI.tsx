// AddVectorUI.tsx — "+ Vector" button shown next to a selected vector
// on an icon-set master. Shares AddVariantUI's placement/poll/render
// skeleton (AddEntryUI: AddEntryCard / useAddEntryPlacement /
// whenNodeRectReady) but operates on icon-set vectors instead of
// component variants. Kept as its own file so the variant flow stays
// untouched and icon-set semantics (no Hover/Pressed strip, "Vector"
// labels, addIconToSet routing) don't bleed into AddVariantUI.

import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { selectedNodeAtom, selectedIdsAtom, codeAtom, canvasInteractingAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNode } from '@/code/stores/node-family';
import { activeFilePathAtom, isIconSetFilePath } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { addIconToSet } from '@/code/icons/icon-set-ops';
import { parseIconSetConfig, ICON_DEFAULT_GAP } from '@/code/icons/icon-set-config';
import { transformManager, panToNode } from '@/canvas/transform';
import { getContentRoot, findNodeRect } from '@/canvas/node-ops';
import { getFreeCanvasNodeRects } from '@/canvas/ui/free-canvas-node-rects';
import { AddEntryCard, useAddEntryPlacement, whenNodeRectReady } from '@/canvas/ui/AddEntryUI';
import { screenPointToCanvas } from '@/canvas/drag/helpers/coords';
import { trace } from '@/shared/debug-trace';

export default function AddVectorUI() {
  const selectedId = useAtomValue(selectedNodeAtom);
  // Per-node subscription + imperative callback reads — no whole-map
  // subscription (this "+" affordance only cares about the selected vector).
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);

  const isIconSetFile = isIconSetFilePath(activeFilePath);
  const selectedNode = useNode(selectedId) ?? null;
  // The selected node must be a vector — a direct child of the master root.
  // Accept either the new template (parent='root') or legacy ('iconset-master').
  const isVectorSelected = !!selectedNode && isIconSetFile &&
    (selectedNode.parentId === 'root' || selectedNode.parentId === 'iconset-master');
  const shouldShow = isIconSetFile && isVectorSelected && !!selectedId;

  // Position polling — scan right past sibling vectors so the "+" never
  // sits ON TOP of another vector. Same skeleton as AddVariantUI (shared
  // useAddEntryPlacement) but the overlap test reads sibling RECTS (other
  // children of the master root) rather than the same node under
  // different variant viewports.
  const getObstacleRects = useCallback(() => {
    // Sibling vectors = other children of the master root.
    const siblingRects: DOMRect[] = [];
    const nodes = getNodesSnapshot();
    const parentId = selectedNode?.parentId;
    if (parentId) {
      const parent = nodes.get(parentId);
      if (parent) {
        for (const childId of parent.children) {
          if (childId === selectedId) continue;
          const r = findNodeRect(childId, 'desktop');
          if (r) siblingRects.push(r);
        }
      }
    }
    // Also avoid landing the "+" on any FREE canvas-node on the master
    // (canvasNodes fragment + hoisted slot consts). Icon-set masters
    // rarely host canvas-nodes today, but the guard is consistent with
    // AddVariantUI and harmless when the list is empty.
    siblingRects.push(...getFreeCanvasNodeRects(nodes, 'desktop'));
    return siblingRects;
  }, [selectedNode, selectedId]);

  const { right: screenPos } = useAddEntryPlacement({
    enabled: shouldShow,
    sourceId: selectedId,
    vpId: 'desktop',
    getObstacleRects,
  });

  const handleAddVector = useCallback(() => {
    if (!selectedNode) return;
    // Place the new vector EXACTLY where the "+" button is shown — same
    // semantics as component variants (see AddVariantUI.handleAddVariant).
    // The + button position has already been computed by the shared
    // placement poll above (scans past sibling vectors so it never
    // overlaps). Convert from screen-space to canvas-space and use that
    // as the root-relative left/top — the master root sits at canvas
    // (0,0) for icon-set files, so canvas-space and root-space coincide.
    let position: { left: number; top: number };
    // Capture the source vector's size so the new card matches the
    // variant the user is currently viewing (without this, an
    // 800×400 source spawns a 240×240 sibling and the row staggers).
    // Reads iconConfig (source of truth) with a styles fallback.
    let sourceSize: { width: number; height: number } | undefined;
    if (screenPos) {
      const transform = transformManager.getTransform();
      const canvasPos = screenPointToCanvas(
        { x: screenPos.left, y: screenPos.top },
        transform,
      );
      position = {
        left: Math.round(canvasPos.x),
        top: Math.round(canvasPos.y),
      };
      const code = projectFS.readFile(activeFilePath) || '';
      const cfg = parseIconSetConfig(code).find(c => c.name === selectedId);
      if (cfg) sourceSize = { width: cfg.width, height: cfg.height };
    } else {
      // Fallback if poll hasn't landed yet — place to the right of source
      // using its iconConfig (or inline style for legacy files).
      const code = projectFS.readFile(activeFilePath) || '';
      const configs = parseIconSetConfig(code);
      const srcCfg = configs.find(c => c.name === selectedId);
      if (srcCfg) {
        position = {
          left: Math.round(srcCfg.x + srcCfg.width + ICON_DEFAULT_GAP),
          top: Math.round(srcCfg.y),
        };
        sourceSize = { width: srcCfg.width, height: srcCfg.height };
      } else {
        const sourceLeft = parseFloat(selectedNode.styles.left || '0') || 0;
        const sourceTop = parseFloat(selectedNode.styles.top || '0') || 0;
        const sourceWidth = parseFloat(selectedNode.styles.width || '0') || 240;
        const sourceHeight = parseFloat(selectedNode.styles.height || '0') || 240;
        position = {
          left: Math.round(sourceLeft + sourceWidth + ICON_DEFAULT_GAP),
          top: Math.round(sourceTop),
        };
        sourceSize = { width: sourceWidth, height: sourceHeight };
      }
    }

    const result = addIconToSet(activeFilePath, { position, size: sourceSize });
    if (!result) return;
    setVersion(v => v + 1);
    const newCode = projectFS.readFile(activeFilePath);
    if (newCode) setCode(newCode);
    trace.action('add-vector-ui:add', { iconId: result.iconId, position });

    // Wait for the new vector's DOM to land, then select + pan.
    const newIconId = result.iconId;
    whenNodeRectReady(newIconId, 'desktop', () => {
      setSelectedIds([newIconId]);
      const contentEl = getContentRoot();
      // vpId 'desktop' = no prefix, so data-node-id IS the icon id.
      if (contentEl) setTimeout(() => panToNode(contentEl, newIconId), 50);
    });
  }, [activeFilePath, selectedId, selectedNode, screenPos, setCode, setVersion, setSelectedIds]);

  if (!shouldShow || !screenPos) return null;
  const scale = transformManager.getTransform().scale;
  if (scale < 0.1) return null;

  return createPortal(
    <AddEntryCard
      rect={screenPos}
      label="Vector"
      title="Add Vector"
      isInteracting={isInteracting}
      onClick={handleAddVector}
    />,
    document.body,
  );
}
