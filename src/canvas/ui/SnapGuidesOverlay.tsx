// SnapGuidesOverlay.tsx — Renders snap alignment guides (pink lines) and
// equal-spacing distance bands (pink rectangles with px labels) during drag.
// Reads guides from snap-guides-store (NOT Canvas useState) so the per-frame
// updates re-render only THIS component, never the Canvas subtree.

import { useSyncExternalStore } from 'react';
import { transformManager } from '../transform';
import { snapGuidesOps } from './snap-guides-store';
import { useDropLineActive } from '../selection/drop-line-store';

export default function SnapGuidesOverlay() {
  const snapGuides = useSyncExternalStore(snapGuidesOps.subscribe, snapGuidesOps.getSnap, snapGuidesOps.getSnap);
  const spacingGuides = useSyncExternalStore(snapGuidesOps.subscribe, snapGuidesOps.getSpacing, snapGuidesOps.getSpacing);
  const dropLineActive = useDropLineActive();
  if (dropLineActive) return null;

  return (
    <>
      {snapGuides.length > 0 && (
        <svg style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
          {snapGuides.map((guide, i) => {
            const t = transformManager.getTransform();
            if (guide.axis === 'x') {
              const screenX = guide.position * t.scale + t.x;
              return <line key={i} x1={screenX} y1={-9999} x2={screenX} y2={9999} stroke="#f472b6" strokeWidth={1} opacity={0.6} />;
            } else {
              const screenY = guide.position * t.scale + t.y;
              return <line key={i} x1={-9999} y1={screenY} x2={9999} y2={screenY} stroke="#f472b6" strokeWidth={1} opacity={0.6} />;
            }
          })}
        </svg>
      )}
      {spacingGuides.length > 0 && (() => {
        const t = transformManager.getTransform();
        return spacingGuides.map((sg, gi) =>
          sg.segments.map((seg, si) => {
            const isH = sg.axis === 'h';
            const left = isH ? seg.start * t.scale + t.x : seg.crossMin * t.scale + t.x;
            const top = isH ? seg.crossMin * t.scale + t.y : seg.start * t.scale + t.y;
            const width = isH ? (seg.end - seg.start) * t.scale : (seg.crossMax - seg.crossMin) * t.scale;
            const height = isH ? (seg.crossMax - seg.crossMin) * t.scale : (seg.end - seg.start) * t.scale;
            return (
              <div key={`sg-${gi}-${si}`} style={{ position: 'absolute', pointerEvents: 'none' }}>
                {/* Pink band */}
                <div style={{ position: 'absolute', left, top, width, height, backgroundColor: 'rgba(244, 114, 182, 0.12)' }} />
                {/* Distance label */}
                <div className="cut-corners cut-sm" style={{
                  position: 'absolute', left: left + width / 2, top: top + height / 2,
                  transform: 'translate(-50%, -50%)',
                  backgroundColor: 'rgba(244, 114, 182, 0.85)', color: '#fff',
                  padding: '1px 5px', fontSize: 10, fontFamily: 'monospace',
                  whiteSpace: 'nowrap',
                }}>
                  {Math.round(sg.distance)}px
                </div>
              </div>
            );
          })
        );
      })()}
    </>
  );
}
