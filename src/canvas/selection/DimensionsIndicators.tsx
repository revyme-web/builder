// DimensionsIndicators.tsx — CTRL+ALT dimensions tooltip showing W×H below element.
// Uses bridge helpers for computed width/height reads.

import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { selectedNodeAtom, canvasInteractingAtom } from '@/code/stores/store';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { findNodeRect, findNodeComputedStyles } from '@/canvas/node-ops';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import StyleIndicator from '@/design-system/StyleIndicator';
import { useModifierKeys } from '@/canvas/hooks/useModifierKeys';

// Tokens, not literals — these were left on the pre-rebrand blue/purple.
// The pill sits over the user's artwork, so it uses the SELECTION colour on a
// page (same family as the selection box it accompanies) and the component
// colour on a master, each with its matching label.
const BG_PAGE = 'var(--selection)';
const BG_COMP = 'var(--accent-secondary)';
const FG_PAGE = '#ffffff';
const FG_COMP = 'var(--accent-secondary-fg)';

export default function DimensionsIndicators() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const isComp = isComponentFilePath(activeFile);
  const [dims, setDims] = useState<{ w: number; h: number; cx: number; by: number } | null>(null);
  const { alt, ctrl } = useModifierKeys();

  useEffect(() => {
    if (!alt || !ctrl || !selectedId) { setDims(null); return; }

    let rafId: number;
    const update = () => {
      const er = findNodeRect(selectedId, vpId);
      if (!er) { rafId = requestAnimationFrame(update); return; }
      const cs = findNodeComputedStyles(selectedId, vpId, ['width', 'height']);
      setDims({
        w: Math.round(parseFloat(cs['width']) || er.width),
        h: Math.round(parseFloat(cs['height']) || er.height),
        cx: er.left + er.width / 2,
        by: er.bottom + 20,
      });
      rafId = requestAnimationFrame(update);
    };
    update();
    return () => { cancelAnimationFrame(rafId); };
  }, [alt, ctrl, selectedId, vpId]);

  if (!dims || !alt || !ctrl || isInteracting) return null;

  return (
    <StyleIndicator x={dims.cx} y={dims.by} color={isComp ? BG_COMP : BG_PAGE} fg={isComp ? FG_COMP : FG_PAGE}>
      {dims.w}px × {dims.h}px
    </StyleIndicator>
  );
}
