// GradientStopsBar.tsx — Draggable color stops bar for the gradient editor.
// Uses pointer events for drag (per lesson 01). Stop markers are positioned
// absolutely along a horizontal gradient preview bar.

import { useRef, useCallback, useMemo } from 'react';
import { trace } from '@/shared/debug-trace';
import type { GradientStop } from '@/shared/gradient-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GradientStopsBarProps {
  stops: GradientStop[];
  selectedStopId: string | null;
  onSelectStop: (id: string) => void;
  onUpdateStop: (id: string, updates: Partial<GradientStop>) => void;
  onAddStop: (position: number, color: string) => void;
  onRemoveStop: (id: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GradientStopsBar({
  stops,
  selectedStopId,
  onSelectStop,
  onUpdateStop,
  onAddStop,
  onRemoveStop,
}: GradientStopsBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  // rAF throttle for the stop drag — coalesce multiple pointermoves (120Hz
  // trackpads fire ~2× per frame) into ONE update per animation frame.
  const dragRafRef = useRef<number | null>(null);
  const pendingPosRef = useRef<number | null>(null);

  trace.fn('GradientStopsBar:render', { stopCount: stops.length, selectedStopId });

  // The preview bar ALWAYS renders the stops as a horizontal (left→right)
  // gradient — it's a 1D representation of the color stops, NOT the actual
  // gradient. The gradient's direction/angle/type must NOT rotate this bar
  // (a 180° linear or a radial would otherwise make the stop track unreadable
  // / misaligned with the draggable markers, which are positioned left→right).
  const barBackground = useMemo(() => {
    const sorted = [...stops].sort((a, b) => a.position - b.position);
    if (sorted.length === 0) return 'transparent';
    return `linear-gradient(to right, ${sorted.map(s => `${s.color} ${s.position}%`).join(', ')})`;
  }, [stops]);

  // ─── Click on bar to add a stop ──────────────────────────────────────────

  const handleBarClick = useCallback((e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return;

    // Only handle clicks directly on the bar, not on stop markers
    if (e.target !== bar) return;

    const rect = bar.getBoundingClientRect();
    const position = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));

    // Interpolate color from neighboring stops
    const color = interpolateColor(stops, position);
    trace.action('gradient-stops:add', { position, color });
    onAddStop(position, color);
  }, [stops, onAddStop]);

  // ─── Drag a stop marker ──────────────────────────────────────────────────

  const handleStopPointerDown = useCallback((e: React.PointerEvent, stopId: string) => {
    e.preventDefault();
    e.stopPropagation();

    const bar = barRef.current;
    if (!bar) return;

    onSelectStop(stopId);
    trace.action('gradient-stops:drag-start', { stopId });

    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const flush = () => {
      dragRafRef.current = null;
      if (pendingPosRef.current != null) onUpdateStop(stopId, { position: pendingPosRef.current });
    };

    const handleMove = (ev: PointerEvent) => {
      const rect = bar.getBoundingClientRect();
      pendingPosRef.current = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      // Coalesce to one onUpdateStop per frame — the heavy work (formatGradient
      // + canvas write + overlay) then runs at most 60×/s, not per raw event.
      if (dragRafRef.current == null) dragRafRef.current = requestAnimationFrame(flush);
    };

    const handleUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerup', handleUp);
      // Commit the final position immediately (don't drop the last frame).
      if (dragRafRef.current != null) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null; }
      if (pendingPosRef.current != null) { onUpdateStop(stopId, { position: pendingPosRef.current }); pendingPosRef.current = null; }
      trace.action('gradient-stops:drag-end', { stopId });
    };

    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerup', handleUp);
  }, [onSelectStop, onUpdateStop]);

  // ─── Double-click to remove stop ─────────────────────────────────────────

  const handleStopDoubleClick = useCallback((e: React.MouseEvent, stopId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (stops.length <= 2) return; // Minimum 2 stops always
    trace.action('gradient-stops:remove', { stopId });
    onRemoveStop(stopId);
  }, [stops.length, onRemoveStop]);

  return (
    <div className="relative py-3">
      {/* Gradient preview bar */}
      <div
        ref={barRef}
        className="h-3 rounded-full cursor-pointer relative touch-none"
        style={{ background: barBackground }}
        onPointerDown={handleBarClick}
      >
        {/* Stop markers */}
        {stops.map(stop => {
          const isSelected = stop.id === selectedStopId;
          return (
            <div
              key={stop.id}
              className={`absolute top-1/2 cursor-pointer touch-none ${isSelected ? 'z-20' : 'z-10'}`}
              style={{
                left: `${stop.position}%`,
                transform: 'translate(-50%, -50%)',
              }}
              onPointerDown={(e) => handleStopPointerDown(e, stop.id)}
              onDoubleClick={(e) => handleStopDoubleClick(e, stop.id)}
            >
              {isSelected ? (
                // Selected: larger circle with blue ring
                <div
                  className="w-4 h-4 rounded-full border-2 border-blue-500 shadow-md"
                  style={{ backgroundColor: stop.color }}
                >
                  <div
                    className="w-full h-full rounded-full border border-white/80"
                    style={{ backgroundColor: stop.color }}
                  />
                </div>
              ) : (
                // Unselected: smaller colored circle with white border
                <div
                  className="w-3 h-3 rounded-full border-2 border-white shadow-sm"
                  style={{ backgroundColor: stop.color }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Interpolate a color from neighboring stops at a given position. */
function interpolateColor(stops: GradientStop[], position: number): string {
  if (stops.length === 0) return '#808080';

  const sorted = [...stops].sort((a, b) => a.position - b.position);

  // Before first stop
  if (position <= sorted[0].position) return sorted[0].color;
  // After last stop
  if (position >= sorted[sorted.length - 1].position) return sorted[sorted.length - 1].color;

  // Find the two neighboring stops
  for (let i = 0; i < sorted.length - 1; i++) {
    if (position >= sorted[i].position && position <= sorted[i + 1].position) {
      // Simple: return the color of the nearest stop
      const distA = position - sorted[i].position;
      const distB = sorted[i + 1].position - position;
      return distA <= distB ? sorted[i].color : sorted[i + 1].color;
    }
  }

  return sorted[0].color;
}
