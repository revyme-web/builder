// CollaboratorCursors.tsx — Pixel-for-pixel port of the old builder's
// `revyme-old/builder/.../CollaboratorCursors.tsx`. Two states per
// remote cursor:
//
//   1. ON-CANVAS — full pointer SVG + accent-colored avatar/name pill
//      anchored to the cursor tip. Pill is clickable: pans the local
//      canvas so the remote user's position lands in the center.
//
//   2. OFF-CANVAS — when the remote cursor's mapped screen point falls
//      outside the visible canvas area (clamped INSIDE the toolbar
//      regions), we render a 32 px circle pinned to the edge of the
//      canvas viewport. Same click-to-pan behavior.
//
// Coordinate spaces (mirrored from the old builder):
//   - Stored canvas-space coords (sender's `screenToCanvas` output)
//   - Converted to screen-space on every render using the LOCAL
//     transform (pan + zoom). Different viewers may have different
//     transforms; cursors still line up with the same content because
//     each viewer maps the same content-point through its own camera.
//
// Hide states:
//   - Local user is panning/zooming  → no cursors (matches old builder)
//   - Preview overlay is open        → no cursors
//   - Cursor's `page` doesn't match  → that one is filtered out

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { canvasInteractingAtom } from '@/code/stores/store';
import { previewModeAtom } from '@/code/stores/editor-store';
import { transformManager, type Transform } from '@/canvas/transform/TransformManager';
import { panToCanvasPoint } from '@/canvas/transform/CameraCommands';
import { trace } from '@/shared/debug-trace';
import { useCollaboration } from './CollaborationProvider';

// ─── Toolbar regions (excluded from cursor render area) ────────────────────
// Numbers chosen to match the actual chrome widths in Revyme:
//   LeftMenu  52px  (src/editor/left-toolbar/LeftMenu.tsx)
//   LeftPanel 256px (src/editor/left-toolbar/LeftPanel.tsx — always open)
//   RightSidebar 260px (src/editor/PropertiesPanel.tsx, header RIGHT 260px)
//   Header    52px  (LeftHeader/RightHeader)
//   BottomToolbar 48px (BottomToolbar.tsx)
//   + EDGE_PADDING so the off-screen pip sits 20px inside the boundary
const LEFT_MENU_WIDTH = 52;
const LEFT_PANEL_WIDTH = 256;
const RIGHT_TOOLBAR_WIDTH = 260;
const TOP_HEADER_HEIGHT = 52;
const BOTTOM_TOOLBAR_HEIGHT = 48;
const EDGE_PADDING = 20;

/** Identity-stable rect compare — the RAF poll must NOT re-render React
 *  with a fresh (but equal) DOMRect every frame. Exported for tests. */
export function sameRect(a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

export default function CollaboratorCursors() {
  const { isConnected, remoteUsers, cursors } = useCollaboration();
  const activePage = useAtomValue(activeFilePathAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const isPreviewing = useAtomValue(previewModeAtom);
  const [transform, setTransform] = useState<Transform>(() => transformManager.getTransform());
  const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);

  // Track the local pan/zoom so re-renders happen the instant the
  // viewer pans — the remote cursor's CANVAS coords haven't changed,
  // only how we map them to screen.
  useEffect(() => {
    return transformManager.subscribe(() => {
      setTransform({ ...transformManager.getTransform() });
    });
  }, []);

  // Poll the canvas root's bounding rect at rAF cadence — but ONLY while
  // there are remote cursors to place, and ONLY re-render when the rect
  // actually changed. The previous version called setCanvasRect with a
  // FRESH DOMRect every frame (new identity → React re-render 60×/s,
  // forever, even with zero remote cursors) — profiled at ~16ms/frame of
  // parent-side work whenever any canvas animation kept frames busy.
  useEffect(() => {
    if (!isConnected || isPreviewing || cursors.size === 0) return;
    let raf = 0;
    const tick = () => {
      const root = document.querySelector('[data-canvas-root]') as HTMLElement | null;
      const rect = root?.getBoundingClientRect();
      if (rect) {
        setCanvasRect((prev) => (prev && sameRect(prev, rect) ? prev : rect));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isConnected, isPreviewing, cursors.size]);

  if (!isConnected) return null;
  // Hide while local user is dragging / panning / zooming so the
  // cursors don't strobe during interaction. Matches the old builder.
  if (isInteracting) return null;
  if (isPreviewing) return null;
  if (typeof document === 'undefined') return null;
  if (!canvasRect) return null;

  const userById = new Map(remoteUsers.map((u) => [u.id, u]));

  return createPortal(
    <>
      {Array.from(cursors.values()).map((c) => {
        const user = userById.get(c.userId);
        if (!user) return null;
        if (c.page && activePage && c.page !== activePage) return null;
        return (
          <CollaboratorCursor
            key={c.userId}
            canvasX={c.x}
            canvasY={c.y}
            name={user.name}
            color={user.color}
            avatar={user.avatar}
            transform={transform}
            canvasRect={canvasRect}
          />
        );
      })}
    </>,
    document.body,
  );
}

// ─── Single cursor ─────────────────────────────────────────────────────────

interface CursorProps {
  canvasX: number;
  canvasY: number;
  name: string;
  color: string;
  avatar: string | null;
  transform: Transform;
  canvasRect: DOMRect;
}

function CollaboratorCursor({
  canvasX,
  canvasY,
  name,
  color,
  avatar,
  transform,
  canvasRect,
}: CursorProps) {
  // canvas → screen (inverse of useCollaborationCursor's screenToCanvas)
  const screenX = canvasX * transform.scale + transform.x + canvasRect.left;
  const screenY = canvasY * transform.scale + transform.y + canvasRect.top;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  // Canvas-area bounds — the rectangle BETWEEN the toolbars. Same
  // exclusion zones as the old builder. Hand-tuned to the chrome
  // widths declared at module top.
  const canvasLeft = LEFT_MENU_WIDTH + LEFT_PANEL_WIDTH;
  const canvasRight = viewportWidth - RIGHT_TOOLBAR_WIDTH;
  const canvasTop = TOP_HEADER_HEIGHT;
  const canvasBottom = viewportHeight - BOTTOM_TOOLBAR_HEIGHT;

  const inCanvas =
    screenX >= canvasLeft &&
    screenX <= canvasRight &&
    screenY >= canvasTop &&
    screenY <= canvasBottom;

  const handleClick = () => {
    trace.action('collab:pan-to-cursor', { name });
    panToCanvasPoint(canvasX, canvasY, 400);
  };

  if (inCanvas) {
    return (
      <div
        className="fixed z-[1] transition-all duration-75 ease-out"
        style={{
          left: screenX,
          top: screenY,
          transform: 'translate(-2px, -2px)',
        }}
      >
        {/* Pointer SVG — rounded teardrop shape, same path the old
            builder uses. Filter gives it a 1-px drop shadow so it
            reads on both light and dark canvases. `pointer-events-
            none` so the local user's input passes through unblocked. */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={20}
          height={20}
          viewBox="0 0 24 24"
          style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}
          className="pointer-events-none"
        >
          <path
            fill={color}
            fillRule="evenodd"
            d="M4.38 3.075a1 1 0 0 0-1.305 1.306l7 17a1 1 0 0 0 1.844.013l2.685-6.265a1 1 0 0 1 .525-.525l6.265-2.685a1 1 0 0 0-.013-1.844z"
            clipRule="evenodd"
          />
        </svg>

        {/* Avatar + name pill — accent-tinted bubble offset from the
            cursor tip. Clickable: pans canvas to center on the remote
            user's position.

            `w-max` is load-bearing: the pill is absolutely positioned
            inside a `fixed` wrapper that's only as wide as the 20px
            pointer SVG. Without an explicit width the pill resolves to
            a shrink-to-fit width clamped by that tiny containing block,
            which squishes the avatar and clips the name. `w-max` sizes
            the pill to its content regardless of the containing block. */}
        <div
          onClick={handleClick}
          // text-[var(--accent-fg)], NOT text-primary: the label sits ON the
          // accent pill, and themes with a light accent pair it with a dark
          // label — text-primary is white on dark themes (unreadable on
          // khaki). --accent-fg is the per-theme "label on accent" token.
          className="absolute left-4 top-4 w-max flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[var(--accent-fg)] text-[10px] font-medium whitespace-nowrap shadow-lg bg-[var(--accent)] cursor-pointer hover:scale-105 transition-transform"
          title={`Click to center on ${name}`}
        >
          {avatar ? (
            <img
              src={avatar}
              alt={name}
              className="w-4 h-4 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div
              className="w-4 h-4 shrink-0 rounded-full flex items-center justify-center text-[8px] font-bold text-white"
              style={{ backgroundColor: color }}
            >
              {getInitials(name)}
            </div>
          )}
          <span>{name}</span>
        </div>
      </div>
    );
  }

  // Off-canvas — clamp to the canvas-area edges and render a compact
  // 32 px avatar pip. Clickable too, so the local user can jump to
  // the remote user with one click.
  const edgeX = Math.max(canvasLeft + EDGE_PADDING, Math.min(canvasRight - EDGE_PADDING, screenX));
  const edgeY = Math.max(canvasTop + EDGE_PADDING, Math.min(canvasBottom - EDGE_PADDING, screenY));

  return (
    <div
      onClick={handleClick}
      className="fixed z-[1] transition-all duration-100 ease-out cursor-pointer hover:scale-110"
      style={{
        left: edgeX,
        top: edgeY,
        transform: 'translate(-50%, -50%)',
      }}
      title={`Click to jump to ${name}`}
    >
      <div
        className="flex items-center justify-center w-8 h-8 rounded-full shadow-lg border-2 border-[var(--border-light)]"
        style={{ backgroundColor: avatar ? 'transparent' : color }}
      >
        {avatar ? (
          <img src={avatar} alt={name} className="w-full h-full rounded-full object-cover" />
        ) : (
          <span className="text-white text-[10px] font-bold">{getInitials(name)}</span>
        )}
      </div>
      {/* `w-max` for the same reason as the on-canvas pill — the label
          is absolutely positioned inside a 32px-wide wrapper, so without
          an explicit content width it gets clamped and clips the name. */}
      {/* Label on accent → --accent-fg (same pairing rule as the pill above). */}
      <div className="absolute left-1/2 -translate-x-1/2 mt-1 w-max px-2.5 py-1 rounded text-[var(--accent-fg)] text-[9px] font-medium whitespace-nowrap shadow-md bg-[var(--accent)]">
        {name}
      </div>
    </div>
  );
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
