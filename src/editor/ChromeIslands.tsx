// ChromeIslands.tsx — the two floating chrome slabs (Spline-style layout).
//
// LEFT island = LeftHeader + LeftMenu rail + LeftPanel; RIGHT island =
// RightHeader + the right sidebar. The individual components keep all
// their logic and z-order but render TRANSPARENT, positioned on top of
// these two fixed glass backdrops (z-4998, under all chrome at z-5000+).
// One surface per side means one border, one blur pass, one pair of cut
// corners — no seams between header/rail/panel.
//
// Geometry contract (mirrored by the pieces):
//   left slab:      DOCKED to the screen edges (user call 2026-08-20) —
//                   0 / 0, 308 wide (52 rail + 256 panel), full height,
//                   border-r only, bottom-right cut.
//   right header:   DOCKED to the top-right corner — 260×52 at 0 / 0,
//                   border-b/l, top-left cut (the original signature side).
//   right body:     DOCKED to the right edge under the header — 260 wide,
//                   top 52, full remaining height, border-l only, no cut.
// If these move, LeftHeader / LeftMenu / LeftPanel / RightHeader / the
// right sidebar shells' offsets move with them.
//
// The cut corners are windows onto the canvas, so they square off while a
// takeover overlay covers the workspace — same rule as the panels had.

import { useAtomValue } from 'jotai';
import { workspaceOverlayOpenAtom } from '@/code/stores/workspace-overlay-store';
import { useTopChromeHeight } from '@/canvas/ui/use-top-chrome-height';

const GLASS: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--bg-surface) 93%, transparent)',
  backdropFilter: 'blur(18px) saturate(1.15)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
  ['--cut-border-color' as string]: 'var(--border-light)',
};

export default function ChromeIslands() {
  const overlayOpen = useAtomValue(workspaceOverlayOpenAtom);
  // The right header's top-left notch is a window onto the CANVAS. When a
  // dynamic breadcrumb bar occupies the top strip (component/template/slug
  // pages), the notch would look through onto the glass bar instead —
  // reading as a transparent hole — so it squares off while one exists.
  // Same DOM-truth source the rulers use (see use-top-chrome-height).
  const topBarPresent = useTopChromeHeight() > 0;
  const cutLeft = overlayOpen ? '' : 'cut-br cut-lg';
  return (
    <>
      <div
        aria-hidden
        className={`fixed z-[4998] border-r border-[var(--border-light)] ${cutLeft}`}
        style={{ left: 0, top: 0, width: 308, height: '100vh', ...GLASS }}
      />
      <div
        aria-hidden
        className={`fixed z-[4998] border-b border-l border-[var(--border-light)] [--cut-border-color:var(--border-light)] ${overlayOpen || topBarPresent ? '' : 'cut-tl cut-border cut-lg'}`}
        style={{ right: 0, top: 0, width: 260, height: 52, ...GLASS }}
      />
      <div
        aria-hidden
        className="fixed z-[4998] border-l border-[var(--border-light)]"
        style={{ right: 0, top: 52, width: 260, height: 'calc(100vh - 52px)', ...GLASS }}
      />
    </>
  );
}
