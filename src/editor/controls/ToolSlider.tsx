// ToolSlider.tsx — Radix-based slider control.
// Exact port from old builder's shadcn Slider component.
// Track: h-1, rounded-full, --slider-bg background.
// Range fill: --accent color.
// Thumb: h-4 w-4 white circle with border.

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { useSetAtom } from 'jotai';
import { canvasInteractingAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

interface Props {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Fires on every tick during drag — use for live preview only. */
  onChange: (value: number) => void;
  /** Fires once on pointer-up. Use for expensive work (file writes, parse) so
   *  it doesn't run 60×/sec during the drag. Falls back to onChange when
   *  omitted. */
  onCommit?: (value: number) => void;
  className?: string;
  /** If true, slider is greyed out and non-interactive */
  disabled?: boolean;
}

export default function ToolSlider({ value, min = 0, max = 100, step = 1, onChange, onCommit, className, disabled }: Props) {
  // Local drag state. While the user is mid-drag we don't round-trip through
  // the parent's controlled `value` prop (callers that defer their file write
  // to onCommit don't update `value` per tick — without this the Radix thumb
  // snaps back to the stale source-of-truth on every move). On commit we
  // clear the drag state so the controlled `value` takes over again.
  const [dragValue, setDragValue] = React.useState<number | null>(null);
  const displayValue = dragValue ?? value;

  // Mirror the slider's drag state into `canvasInteractingAtom` so the
  // canvas overlays (selection border, gap/padding handles, hover
  // highlight, snap guides) hide while the user drags the slider —
  // same UX as on-canvas drag/resize. Without this, the overlays
  // re-layout-thrash with the canvas on every tick: a gap slider
  // moves children every frame, the selection border RAF-polls the
  // selected node's rect, and you get a visible jiggle.
  const setCanvasInteracting = useSetAtom(canvasInteractingAtom);
  const isInteractingRef = React.useRef(false);

  const handleValueChange = React.useCallback((values: number[]) => {
    if (!isInteractingRef.current) {
      isInteractingRef.current = true;
      setCanvasInteracting(true);
    }
    setDragValue(values[0]);
    onChange(values[0]);
    trace.action('tool-slider:change', { value: values[0] });
  }, [onChange, setCanvasInteracting]);

  const handleValueCommit = React.useCallback((values: number[]) => {
    if (onCommit) {
      onCommit(values[0]);
      trace.action('tool-slider:commit', { value: values[0] });
    }
    setDragValue(null);
    if (isInteractingRef.current) {
      isInteractingRef.current = false;
      setCanvasInteracting(false);
    }
  }, [onCommit, setCanvasInteracting]);

  // Safety: if the slider unmounts mid-drag (e.g. selection changes),
  // make sure we don't leave canvas-interacting stuck on.
  React.useEffect(() => () => {
    if (isInteractingRef.current) {
      isInteractingRef.current = false;
      setCanvasInteracting(false);
    }
  }, [setCanvasInteracting]);

  return (
    <SliderPrimitive.Root
      disabled={disabled}
      className={`relative flex w-full touch-none select-none items-center ${disabled ? 'opacity-40 pointer-events-none' : ''} ${className ?? ''}`}
      value={[displayValue]}
      min={min}
      max={max}
      step={step}
      onValueChange={handleValueChange}
      onValueCommit={handleValueCommit}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-[var(--slider-bg)]">
        <SliderPrimitive.Range className="absolute h-full bg-[var(--accent)]" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-[var(--slider-thumb-border)] bg-white shadow transition-colors focus-visible:outline-none disabled:pointer-events-none" />
    </SliderPrimitive.Root>
  );
}
