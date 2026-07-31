// preset-live-update.ts — Centralized "live edit" of a preset token. Used by
// every place that lets a user scrub on an existing preset value
// (PresetsPanel, LibraryPanel, ColorInput, TypographyPresetControl,
// ShadowControl pill, EditBorderPresetPanel).
//
// Two things must happen on every value change:
//   1. Bridge: set the CSS variable directly on the iframe's contentRoot —
//      every `var(--name)` consumer in the canvas repaints next frame
//      *without* waiting for the mutation queue to flush. Without this, the
//      canvas lags hundreds of ms behind a slider drag.
//   2. Queue: persist the change to tokens.css via the mutation queue.
//
// What this helper deliberately does NOT do: schedule any version bump or
// atom refresh. Callers debounce that themselves (300ms is the convention)
// because the right cadence depends on what subscribes to the version atom
// in that surface.

import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';

export function liveUpdatePresetToken(name: string, value: string): void {
  trace.fn('liveUpdatePresetToken', { name, value });
  const bridge = getCanvasBridge() as any;
  if (typeof bridge?.setCanvasTokenVar === 'function') {
    bridge.setCanvasTokenVar(name, value);
  }
  queueMutation({ type: 'updatePresetToken', name, value });
}
