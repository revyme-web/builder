// PixelGrid.tsx — Shows 1px grid lines when zoomed in past 500%.
// Uses CSS background gradient for efficient rendering.
// Ported from old builder's Canvas.tsx PixelGrid component.

import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { transformManager } from '../transform';
import { showPixelGridAtom } from '@/code/stores/user-preferences-store';

/**
 * PixelGrid — Shows 1px grid lines when zoomed in past 500%.
 * Uses CSS background gradient for efficient rendering.
 * Ported from old builder's Canvas.tsx PixelGrid component.
 */
export default function PixelGrid() {
  const [transform, setTransform] = useState(transformManager.getTransform());
  // Show-pixel-grid pref. When OFF, we skip the grid entirely regardless
  // of zoom — no DOM at all, no transform subscription work to speak of
  // (the subscriber still runs but the early-return short-circuits the
  // expensive bg-image render). When ON we keep the existing zoom>=5x
  // gate so the grid only appears when it's actually useful.
  const showPixelGrid = useAtomValue(showPixelGridAtom);

  useEffect(() => {
    return transformManager.subscribe(() => {
      const t = transformManager.getTransform();
      // Only update state if scale crossed the 5x threshold or position changed while visible
      setTransform(prev => {
        const wasVisible = prev.scale >= 5;
        const isVisible = t.scale >= 5;
        if (!wasVisible && !isVisible) return prev; // Both invisible, skip
        if (prev.scale === t.scale && prev.x === t.x && prev.y === t.y) return prev;
        return t;
      });
    });
  }, []);

  if (!showPixelGrid) return null;
  if (transform.scale < 5) return null;

  const gridSize = transform.scale; // 1 CSS pixel = scale screen pixels

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1,
        // Neutral mid-gray, not white: the grid overlays page content
        // (any color) at 500%+ zoom, so a 50%-gray line at low opacity
        // stays visible on both light and dark backgrounds. The old
        // `rgba(255,255,255,…)` only showed up against a dark canvas.
        backgroundImage:
          'linear-gradient(to right, rgba(128,128,128,0.22) 1px, transparent 1px),' +
          'linear-gradient(to bottom, rgba(128,128,128,0.22) 1px, transparent 1px)',
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${transform.x % gridSize}px ${transform.y % gridSize}px`,
      }}
    />
  );
}
