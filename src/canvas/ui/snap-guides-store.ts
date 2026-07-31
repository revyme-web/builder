// snap-guides-store.ts — per-frame snap/spacing guide state kept OUTSIDE the
// Canvas React subtree. During a drag the snap handler pushes a fresh guide
// array EVERY FRAME; as Canvas-level useState that re-rendered the ENTIRE
// Canvas subtree per frame — traced on a big page as renderViewportHeaders +
// AddViewportMenu + tool re-renders at ~37fps for the whole gesture (the
// "sluggish drag on big pages" find, 2026-07-17). A module store with
// useSyncExternalStore isolates the per-frame re-render to
// SnapGuidesOverlay itself. Same pattern as drag-state-store.

import type { SnapGuide, SpacingGuide } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

type Listener = () => void;

let snapGuides: SnapGuide[] = [];
let spacingGuides: SpacingGuide[] = [];
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

export const snapGuidesOps = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  getSnap(): SnapGuide[] {
    return snapGuides;
  },
  getSpacing(): SpacingGuide[] {
    return spacingGuides;
  },
  setSnap(g: SnapGuide[]): void {
    // Keep the empty-array identity stable — clearing an already-empty set
    // must not wake subscribers (most drag frames have no snap).
    if (g === snapGuides || (g.length === 0 && snapGuides.length === 0)) return;
    snapGuides = g;
    trace.fn('snap-guides-store:set-snap', { count: g.length });
    notify();
  },
  setSpacing(g: SpacingGuide[]): void {
    if (g === spacingGuides || (g.length === 0 && spacingGuides.length === 0)) return;
    spacingGuides = g;
    notify();
  },
};
