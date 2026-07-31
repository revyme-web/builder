// AddVariantUI.tsx — Floating buttons next to a selected variant root:
//   - "Add Variant" to the right (always offered for non-interaction-state
//     variants).
//   - "Hover / Pressed" strip below — offered when the source variant is
//     missing at least one interaction state. When the user has selected
//     an INTERACTION STATE root, the strip resolves to the SOURCE variant
//     so further hover/pressed buttons belong to the same source family
//     (mirrors the old builder's `effectiveSourceNode` rule).
//
// Placement polling + the card markup live in the shared AddEntryUI
// skeleton (AddEntryCard / useAddEntryPlacement / whenNodeRectReady);
// this file keeps the variant-specific parts: what clicking creates,
// where the obstacle rects come from, and the Hover/Pressed dropdown.

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { selectedNodeAtom, selectedIdsAtom, codeAtom, canvasInteractingAtom, getNodesSnapshot } from '@/code/stores/store';
import { useNode } from '@/code/stores/node-family';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { addVariant, addInteractionState } from '@/code/variants/variant-ops';
import { parseVariantConfig, hasInteractionState } from '@/code/variants/variant-config';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { transformManager, panToNode } from '@/canvas/transform';
import { getContentRoot, findNodeRect } from '@/canvas/node-ops';
import { getFreeCanvasNodeRects } from '@/canvas/ui/free-canvas-node-rects';
import { AddEntryCard, useAddEntryPlacement, whenNodeRectReady } from '@/canvas/ui/AddEntryUI';
import { screenPointToCanvas } from '@/canvas/drag/helpers/coords';
import { PlusBadgeIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

/** One row in the Hover/Pressed dropdown — `+` icon + label, hover highlight. */
function HPMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
        fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)',
        background: hov ? 'var(--bg-hover)' : 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      <PlusBadgeIcon size={16} />
      {label}
    </div>
  );
}

export default function AddVariantUI() {
  const selectedId = useAtomValue(selectedNodeAtom);
  // Per-node subscription + imperative callback reads — no whole-map
  // subscription (this affordance only cares about the selected master root).
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const setCode = useSetAtom(codeAtom);
  const setVersion = useSetAtom(projectVersionAtom);
  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setInteractingVp = useSetAtom(interactingViewportIdAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const code = useAtomValue(codeAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);

  // Component master files store variants in `variantConfig`, NOT in a
  // `@canvas` block. viewportsConfigAtom only reads `@canvas` and falls
  // back to default page viewports (desktop/tablet/mobile) when there
  // isn't one — so it returns the wrong list on master files. Build the
  // actual variant viewport list from parseVariantConfig the same way
  // Canvas.tsx does.
  const variantConfigs = useMemo(() => parseVariantConfig(code), [code]);
  const variantViewports = useMemo(() => variantConfigs.map((v, i) => ({
    id: v.name === 'default' ? 'desktop' : v.name,
    isPrimary: v.isPrimary ?? i === 0,
  })), [variantConfigs]);

  // The variant the user currently has interacting context on. `vpId`
  // 'desktop' is the universal alias for the primary variant 'default'.
  const currentVariantName = vpId === 'desktop' ? 'default' : vpId;
  const currentVariantConfig = variantConfigs.find(v => v.name === currentVariantName) ?? null;
  const isOnInteractionState = !!currentVariantConfig?.interactionType;
  // When the user is on an interaction state, the SOURCE variant is the
  // parent it cascades from — that's the variant we attach further
  // hover/pressed states to. Mirrors `effectiveSourceNode` from the
  // builder's `handleAddInteractionState`.
  const effectiveSourceVariant = isOnInteractionState
    ? currentVariantConfig!.parentVariant!
    : currentVariantName;

  const hoverExists = hasInteractionState(variantConfigs, effectiveSourceVariant, 'hover');
  const pressedExists = hasInteractionState(variantConfigs, effectiveSourceVariant, 'pressed');
  const showHover = !hoverExists;
  const showPressed = !pressedExists;
  const showHPStrip = showHover || showPressed;

  const [hpMenuOpen, setHpMenuOpen] = useState(false);
  // Screen point the dropdown anchors to — the cursor position at click.
  const [hpMenuPos, setHpMenuPos] = useState<{ x: number; y: number } | null>(null);

  const isComponentFile = isComponentFilePath(activeFilePath);
  const selectedNode = useNode(selectedId) ?? null;
  const isTopLevel = selectedNode && !selectedNode.parentId && !selectedNode.isCanvasNode;
  const shouldShow = isComponentFile && isTopLevel && !!selectedId;

  // Position polling — scan past sibling variant blocks on each axis so
  // the buttons never sit ON TOP of another variant viewport. Right scan
  // for the Add Variant button, downward scan for the HP strip. The two
  // scans share the same overlap-test list (below).
  //
  // All other variants' renderings of the same source root: variants
  // share the JSX tree (same data-id), only data-node-id differs by
  // viewport prefix — so the same selectedId resolves under each
  // variant's vpId.
  const getObstacleRects = useCallback(() => {
    const allTopLevelRects: DOMRect[] = [];
    for (const vp of variantViewports) {
      if (vp.id === vpId) continue;
      const rect = findNodeRect(selectedId!, vp.id);
      if (rect) allTopLevelRects.push(rect);
    }
    // Also avoid landing on top of any FREE canvas-node on the master
    // (canvasNodes fragment entries + hoisted slot consts). Without
    // this the "+ Variant" / "+ Hover/Pressed" card can spawn right
    // over a slot-connected canvas-node sitting next to the source
    // variant — visible symptom: the placeholder card overlaps a
    // floating frame to the source's right or below.
    allTopLevelRects.push(...getFreeCanvasNodeRects(getNodesSnapshot(), vpId));
    return allTopLevelRects;
  }, [variantViewports, vpId, selectedId]);

  const { right: screenPosRight, below: screenPosBelow } = useAddEntryPlacement({
    enabled: !!shouldShow,
    sourceId: selectedId,
    vpId,
    getObstacleRects,
    scanBelow: true,
  });

  // Close the Hover/Pressed dropdown when the selection or variant context
  // changes (e.g. right after a state is added and the canvas re-targets).
  useEffect(() => { setHpMenuOpen(false); }, [selectedId, vpId]);

  const handleAddVariant = useCallback(() => {
    const freshCode = projectFS.readFile(activeFilePath) || '';
    const existingVariants = parseVariantConfig(freshCode);
    const existingNames = new Set(existingVariants.map(v => v.name));
    let counter = existingVariants.length;
    let name = `variant-${counter}`;
    while (existingNames.has(name)) { counter++; name = `variant-${counter}`; }

    let canvasPos: { x: number; y: number } | undefined;
    if (screenPosRight) {
      const transform = transformManager.getTransform();
      canvasPos = screenPointToCanvas({ x: screenPosRight.left, y: screenPosRight.top }, transform);
    }

    const sourceLabel = selectedNode?.name || 'Variant';
    const sourceVariantName = vpId === 'desktop' ? 'default' : vpId;
    const sourceDataId = selectedId;
    const result = addVariant(activeFilePath, name, canvasPos, sourceLabel, sourceVariantName);
    if (result) {
      setVersion(v => v + 1);
      const newCode = projectFS.readFile(activeFilePath);
      if (newCode) {
        setCode(newCode);

        if (sourceDataId) {
          whenNodeRectReady(sourceDataId, name, () => {
            setInteractingVp(name);
            setSelectedIds([sourceDataId]);
            const newDataNodeId = `${name}-${sourceDataId}`;
            const contentEl = getContentRoot();
            if (contentEl) {
              setTimeout(() => panToNode(contentEl, newDataNodeId), 50);
            }
          });
        }
      }
      trace.action('add-variant-ui:add', { name, canvasPos });
    }
  }, [activeFilePath, screenPosRight, selectedId, setCode, setVersion, setSelectedIds, setInteractingVp, selectedNode, vpId]);

  // Add a hover/pressed state to the EFFECTIVE source variant. The new
  // state's canvas position is computed from where the HP-strip button
  // visually sits — same convention the builder uses (positioning
  // matches the visible affordance, not the underlying source variant).
  const handleAddInteractionState = useCallback((type: 'hover' | 'pressed') => {
    if (!screenPosBelow) return;

    const transform = transformManager.getTransform();
    const canvasPos = screenPointToCanvas({ x: screenPosBelow.left, y: screenPosBelow.top }, transform);

    const result = addInteractionState(activeFilePath, effectiveSourceVariant, type, canvasPos);
    if (!result) return;

    setVersion(v => v + 1);
    const newCode = projectFS.readFile(activeFilePath);
    if (newCode) setCode(newCode);

    const newVariantName = `${effectiveSourceVariant}-${type}`;
    const sourceDataId = selectedId;
    if (sourceDataId) {
      whenNodeRectReady(sourceDataId, newVariantName, () => {
        setInteractingVp(newVariantName);
        setSelectedIds([sourceDataId]);
        const newDataNodeId = `${newVariantName}-${sourceDataId}`;
        const contentEl = getContentRoot();
        if (contentEl) {
          setTimeout(() => panToNode(contentEl, newDataNodeId), 50);
        }
      });
    }
    trace.action('add-variant-ui:add-interaction-state', {
      type, parentVariant: effectiveSourceVariant, canvasPos,
    });
  }, [activeFilePath, screenPosBelow, effectiveSourceVariant, selectedId, setCode, setVersion, setSelectedIds, setInteractingVp]);

  if (!shouldShow) return null;

  const scale = transformManager.getTransform().scale;
  if (scale < 0.1) return null;

  // Show the regular Variant button only when the user is NOT inside an
  // interaction state — entering hover/pressed contextually means
  // "configure this state" (and add MORE states), not "fork another
  // top-level variant". The HP strip is the only useful affordance there.
  const showVariantButton = !isOnInteractionState;

  // Single-button label — reflects whichever interaction states are still
  // available to add.
  const hpLabel = showHover && showPressed
    ? 'Hover / Pressed'
    : showHover ? 'Hover' : 'Pressed';

  return createPortal(
    <>
      {showVariantButton && screenPosRight && (
        <AddEntryCard
          rect={screenPosRight}
          label="Variant"
          title="Add Variant"
          isInteracting={isInteracting}
          onClick={handleAddVariant}
        />
      )}
      {showHPStrip && screenPosBelow && (
        <>
          {/* Single button — the WHOLE thing is clickable and opens a
              mini dropdown to pick Hover or Pressed. */}
          <AddEntryCard
            rect={screenPosBelow}
            label={hpLabel}
            title="Add interaction state"
            isInteracting={isInteracting}
            forceHover={hpMenuOpen}
            onClick={(e) => {
              const willOpen = !hpMenuOpen;
              trace.action('add-variant-ui:hp-menu-toggle', { willOpen });
              // Anchor the dropdown to the exact cursor position, not the
              // button — `clientX/Y` are viewport coords (the menu is fixed).
              if (willOpen) setHpMenuPos({ x: e.clientX, y: e.clientY });
              setHpMenuOpen(willOpen);
            }}
          />

          {hpMenuOpen && (
            <>
              {/* Full-screen backdrop — any outside click closes the menu. */}
              <div
                onPointerDown={(e) => { e.stopPropagation(); }}
                onMouseDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); setHpMenuOpen(false); }}
                style={{ position: 'fixed', inset: 0, zIndex: 2002 }}
              />
              {/* Dropdown — positioned just below the button. */}
              <div
                onPointerDown={(e) => { e.stopPropagation(); }}
                onMouseDown={(e) => { e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); }}
                style={{
                  position: 'fixed',
                  left: hpMenuPos?.x ?? screenPosBelow.left,
                  top: hpMenuPos?.y ?? screenPosBelow.top + screenPosBelow.height + 4,
                  minWidth: 140,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-light)',
                  borderRadius: 6,
                  padding: 4,
                  zIndex: 2003,
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: 'var(--shadow-lg)',
                }}
              >
                {showHover && (
                  <HPMenuItem
                    label="Hover"
                    onClick={() => { setHpMenuOpen(false); handleAddInteractionState('hover'); }}
                  />
                )}
                {showPressed && (
                  <HPMenuItem
                    label="Pressed"
                    onClick={() => { setHpMenuOpen(false); handleAddInteractionState('pressed'); }}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </>,
    document.body,
  );
}
