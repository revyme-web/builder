// CanvasOverlay.tsx — Fixed overlay container above the canvas content.
// All visual helpers (selection, hover, resize handles, snap guides) render inside this.
// pointer-events: none on the container, pointer-events: all on interactive children.

export default function CanvasOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      overflow: 'visible',
      zIndex: 10,
    }}>
      {children}
    </div>
  );
}
