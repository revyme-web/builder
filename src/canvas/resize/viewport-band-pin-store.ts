// viewport-band-pin-store.ts — during a VIEWPORT-ROOT width drag, the page
// content of the dragged tile must keep resolving its responsive state at the
// gesture's START width ("the viewport keeps its own overrides while I drag"),
// while template chrome (layout:: nodes) deliberately keeps resolving at the
// LIVE width so the nav/footer adapt at breakpoint crossings.
//
// WHY renderer-level and not CSS: the first attempt injected the tile's band
// values as pinned !important CSS — but the band-crossing re-renders stamp
// each node's resolved band state INLINE (the @container↔inline parity merge),
// and a fresh stamp at the live width out-ranks any stylesheet. The pin has to
// live where resolution happens: every width-keyed resolver asks
// `pinnedResolveWidth(nodeId, vpWidth)` before bucketing (2026-08-06, the
// "everything goes desktop during the drag" report).
//
// Matching is by WIDTH: at each crossing the drag loop records the width it's
// about to render (`updateLiveWidth`), and only the tile rendering at exactly
// that width is pinned — other tiles render at their own breakpoint widths.
// Parent-side, gesture-scoped: set at resize start, cleared on every exit.

import { trace } from '@/shared/debug-trace';

let pin: { vpId: string; pinWidth: number; liveWidth: number } | null = null;

export const viewportBandPinOps = {
  set(vpId: string, pinWidth: number): void {
    pin = { vpId, pinWidth, liveWidth: pinWidth };
    trace.action('viewport-band-pin:set', { vpId, pinWidth });
  },
  updateLiveWidth(w: number): void {
    if (pin) pin.liveWidth = w;
  },
  clear(): void {
    if (pin) trace.action('viewport-band-pin:clear', { vpId: pin.vpId });
    pin = null;
  },
  get(): { vpId: string; pinWidth: number; liveWidth: number } | null {
    return pin;
  },
  /** SANDBOX-side seed. The Renderer runs inside the iframe bundle with its
   *  OWN instance of this module — the parent's set() never reaches it (the
   *  first pin round was a silent no-op in the real canvas because of this).
   *  The parent ships its pin state on every RenderInput (bridge-host) and
   *  bridge-sandbox adopts it here before renderNodes. */
  adopt(state: { vpId: string; pinWidth: number; liveWidth: number } | null | undefined): void {
    pin = state ?? null;
  },
};

/** The width RESOLUTION should use for `nodeId` rendering at `vpWidth`.
 *  Template chrome resolves live; the dragged tile's page nodes resolve at
 *  the gesture's start width; everything else is untouched. */
export function pinnedResolveWidth(nodeId: string | undefined, vpWidth: number): number {
  if (!pin || vpWidth !== pin.liveWidth) return vpWidth;
  if (nodeId && nodeId.startsWith('layout::')) return vpWidth;
  return pin.pinWidth;
}
