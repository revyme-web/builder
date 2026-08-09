// ViewportHeaderManager.ts — Imperative viewport headers.
// Pure DOM, no React. Same pattern as Renderer.ts.
// Creates header bars above each viewport with drag, hover, click, snap.

import type { ViewportConfig, SnapGuide, SpacingGuide, Rect } from '@/shared/types';
import { transformManager } from './transform';
import { calculateSnap, getMouseVelocity } from './drag/handlers/snap-handler';
import { getActiveRulerGuideSnapLines } from '@/code/stores/ruler-guides-store';
import { SNAP_THRESHOLD } from '@/shared/constants';
import { el } from '@/shared/dom-utils';
import { findViewportElement, getViewportPrefix } from './node-ops';
import { getCanvasRectById } from './canvas-math';
import { getCanvasBridge } from './canvas-bridge';
import { trace } from '@/shared/debug-trace';
import { isViewerMode } from '@/code/stores/viewer-mode-store';

const HEADER_HEIGHT = 36;
const HEADER_MARGIN = 10;
const DRAG_THRESHOLD = 3;

// ─── Overlay edit mode ───────────────────────────────────────────────────────
// While the user edits an overlay, the viewport header becomes the exit
// affordance (standard): accent background, "Editing Overlay" label, and a
// "Done" button replacing the `+`. Module state (not per-header) because
// headers are torn down + rebuilt on every parent re-render — the RAF tracker
// and createHeader both read this and restyle accordingly.
let overlayEditActive = false;
let overlayEditOnDone: (() => void) | null = null;

export function setViewportHeaderOverlayEditMode(active: boolean, onDone?: () => void): void {
  overlayEditActive = active;
  overlayEditOnDone = active ? (onDone ?? null) : null;
  trace.action('viewport-header:overlay-edit-mode', { active });
}

/** Apply normal vs overlay-edit styling to one header. Idempotent — called on
 *  creation AND every RAF tick so a mode flip restyles within a frame even
 *  though headers rebuild constantly. */
function applyHeaderModeStyles(header: HTMLElement, scale: number): void {
  const title = header.querySelector('[data-header-title]') as HTMLElement | null;
  const widthBadge = header.querySelector('[data-header-width]') as HTMLElement | null;
  const addBtn = header.querySelector('[data-header-add]') as HTMLElement | null;
  const doneBtn = header.querySelector('[data-header-done]') as HTMLElement | null;

  if (overlayEditActive) {
    header.style.backgroundColor = 'var(--accent)';
    header.style.borderColor = 'var(--accent)';
    if (title) {
      // Same rule as the + glyph: the whole header is `--accent` in this
      // mode, so its text takes `--accent-fg`, not a fixed white.
      // (`--accent-text` is the OTHER direction — accent-coloured text on
      // chrome, like the width badge below — and is unreadable here.)
      title.textContent = `Editing Overlay · ${header.getAttribute('data-vp-label') || ''}`;
      title.style.color = 'var(--accent-fg)';
      title.parentElement!.style.color = 'var(--accent-fg)';
    }
    if (widthBadge) widthBadge.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (doneBtn) {
      doneBtn.style.display = 'flex';
      doneBtn.style.fontSize = `${11 / scale}px`;
      doneBtn.style.padding = `0 ${4 / scale}px`;
    }
  } else {
    header.style.backgroundColor = 'var(--canvas-chrome-bg)';
    header.style.borderColor = 'var(--canvas-chrome-border)';
    if (title) {
      title.textContent = header.getAttribute('data-vp-label') || '';
      title.style.color = '';
      title.parentElement!.style.color = 'var(--text-secondary)';
    }
    if (widthBadge) widthBadge.style.display = '';
    if (addBtn) addBtn.style.display = scale >= 0.15 && !isViewerMode() ? 'flex' : 'none';
    if (doneBtn) doneBtn.style.display = 'none';
  }
}

/**
 * Get viewport element position data (left, top, width, height in canvas-space).
 * Reads the screen-space rect via the bridge and converts to canvas-space.
 *
 * The viewport frame is ALWAYS `root`. On a templated page the template
 * (navbar/header/footer) is merged ONTO the page root — the template root
 * takes over the `root` id and the page's sections splice into the
 * template's `{children}` slot — so `root` already spans the full frame
 * (navbar included). There is no separate `layout::root` layer anymore.
 */
/** Return the nodeId of the actual viewport frame for this viewport — always `root`. */
function getViewportFrameNodeId(_vpId: string): string {
  return 'root';
}

function getViewportPositionData(vpId: string, _vpEl: HTMLElement | null): { left: number; top: number; width: number; height: number } | null {
  // Identical math to canvas-math's shared helper: screen rect via the bridge,
  // converted to canvas-space against the container rect.
  return getCanvasRectById(getViewportFrameNodeId(vpId), getViewportPrefix(vpId), transformManager.getTransform());
}

export interface ViewportHeaderCallbacks {
  onSelect: (vpId: string) => void;
  onHover: (nodeId: string | null, viewportId?: string) => void;
  onInteractingViewport: (vpId: string) => void;
  onPositionCommit: (vpId: string, x: number, y: number) => void;
  onSnapGuidesChange: (guides: SnapGuide[]) => void;
  onSpacingGuidesChange: (guides: SpacingGuide[]) => void;
  onDragStateChange?: (dragging: boolean) => void;
  onAddViewport?: (sourceVpId: string, x: number, y: number) => void;
}

/**
 * Render viewport headers into a container. Imperative — no React.
 * Call this after renderNodes to position headers above viewport containers.
 */
/** Show/hide all viewport headers (called when canvas interaction state changes).
 *  Toggles `visibility` on the overlay container — NOT per-header display.
 *  The render effect tears down + recreates header elements on every parent
 *  re-render (which happens constantly during drag as atoms churn), so a
 *  per-header style would get wiped. A container-level style survives the
 *  per-frame header reconstruction. */
export function setViewportHeadersVisible(container: HTMLElement, visible: boolean): void {
  container.style.visibility = visible ? '' : 'hidden';
}

export function renderViewportHeaders(
  container: HTMLElement,
  viewports: ViewportConfig[],
  callbacks: ViewportHeaderCallbacks,
): void {
  trace.fn('renderViewportHeaders', { count: viewports.length });

  // Remove old headers
  container.querySelectorAll('[data-viewport-header]').forEach(el => el.remove());

  for (const vp of viewports) {
    const vpEl = findViewportElement(vp.id);
    // In iframe mode vpEl might be null, but we can still get position from bridge
    let posData = getViewportPositionData(vp.id, vpEl);
    // Bridge cache empty (a file switch just wiped it and the new file's
    // allRects hasn't landed yet) → fall back to the viewport CONFIG, which
    // always knows x/y/width. Skipping instead left the template view with NO
    // headers at all: this effect re-runs on render ticks, not on cache
    // fills, so one empty-cache pass blanked them until the next full render
    // (user report 2026-07-27). Height 0 is fine — headers sit ABOVE the
    // tile; only the drag preview reads height, and it re-derives live.
    if (!posData && typeof vp.x === 'number' && vp.width > 0) {
      posData = { left: vp.x, top: vp.y ?? 0, width: vp.width, height: 0 };
    }
    if (!posData) continue;

    const header = createHeader(vp, vpEl, posData, viewports, callbacks);
    container.appendChild(header);
  }
}

/**
 * Start a RAF loop that continuously refits header positions to whatever the
 * bridge rectCache currently says. Returns a stop function.
 *
 * Why a continuous loop instead of event-driven updates? Header positions
 * depend on viewport rects which change in many places: viewport drag (during
 * the drag the iframe DOM moves but no React re-render fires), resize, add
 * viewport, pan, zoom, AI-driven changes. Reacting to every source is fragile
 * — easier to mirror the rectCache directly.
 *
 * The loop is cheap: querySelectorAll on the small overlay + style writes per
 * header. Skipped when no headers exist.
 */
export function startViewportHeaderTracking(container: HTMLElement): () => void {
  let rafId: number | null = null;
  const tick = () => {
    if (container.querySelector('[data-viewport-header]')) {
      updateViewportHeaderPositions(container);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  };
}

/**
 * Update header positions without rebuilding (call on transform change).
 */
// Per-header dirty key — the tracking RAF loop calls this EVERY frame, and
// re-writing ~20 identical style strings per header per frame is pure style
// churn while the camera is still. Writes only happen when position/scale/
// viewer/overlay-mode actually changed.
const _lastHeaderKey = new WeakMap<HTMLElement, string>();

export function updateViewportHeaderPositions(container: HTMLElement): void {
  const scale = transformManager.getTransform().scale;
  const scaledH = HEADER_HEIGHT / scale;
  const scaledM = HEADER_MARGIN / scale;

  container.querySelectorAll<HTMLElement>('[data-viewport-header]').forEach(header => {
    const vpId = header.getAttribute('data-viewport-header')!;
    const vpEl = findViewportElement(vpId);
    const posData = getViewportPositionData(vpId, vpEl);
    if (!posData) return;

    const { left, top, width } = posData;

    const dirtyKey = `${left.toFixed(1)}:${top.toFixed(1)}:${width.toFixed(1)}:${scale.toFixed(4)}:${overlayEditActive}:${isViewerMode()}`;
    if (_lastHeaderKey.get(header) === dirtyKey) return;
    _lastHeaderKey.set(header, dirtyKey);

    header.style.left = `${left}px`;
    header.style.top = `${top - scaledH - scaledM}px`;
    header.style.width = `${width}px`;
    header.style.height = `${scaledH}px`;
    header.style.padding = `0 ${8 / scale}px`;
    header.style.borderWidth = `${1 / scale}px`;
    header.style.borderRadius = `${8 / scale}px`;

    // Update inner text sizes
    const label = header.querySelector('[data-header-label]') as HTMLElement;
    if (label) {
      label.style.fontSize = `${11 / scale}px`;
      label.style.lineHeight = `${scaledH}px`;
      label.style.gap = `${4 / scale}px`;
    }

    const widthBadge = header.querySelector('[data-header-width]') as HTMLElement;
    if (widthBadge) {
      widthBadge.textContent = `${Math.round(width)}`;
      widthBadge.style.marginLeft = `${8 / scale}px`;
    }

    const addBtn = header.querySelector('[data-header-add]') as HTMLElement;
    if (addBtn) {
      addBtn.style.width = `${24 / scale}px`;
      addBtn.style.height = `${24 / scale}px`;
      addBtn.style.borderRadius = `${6 / scale}px`;
      addBtn.style.fontSize = `${14 / scale}px`;
      // Keep the viewer check in sync with the creation-time style
      // below — this per-transform update would otherwise re-show the
      // button for viewers on the next zoom/pan.
      addBtn.style.display = scale >= 0.15 && !isViewerMode() ? 'flex' : 'none';
    }

    // Overlay-edit mode styling LAST so it wins over the default add-btn
    // display set above. Runs every tick — a mode flip restyles within a frame.
    applyHeaderModeStyles(header, scale);
  });
}

function createHeader(
  vp: ViewportConfig,
  vpEl: HTMLElement | null,
  posData: { left: number; top: number; width: number; height: number },
  allViewports: ViewportConfig[],
  callbacks: ViewportHeaderCallbacks,
): HTMLElement {
  const scale = transformManager.getTransform().scale;
  const scaledH = HEADER_HEIGHT / scale;
  const scaledM = HEADER_MARGIN / scale;

  const { left, top, width } = posData;

  const addBtn = el('button', {
    attrs: { 'data-header-add': '' },
    text: '+',
    styles: {
      // Hidden below 0.15 zoom (too small to hit) AND for viewers —
      // adding a breakpoint/viewport is a write action.
      display: scale >= 0.15 && !isViewerMode() ? 'flex' : 'none',
      alignItems: 'center', justifyContent: 'center',
      width: `${24 / scale}px`, height: `${24 / scale}px`,
      borderRadius: `${6 / scale}px`, backgroundColor: 'transparent',
      // `--text-primary` so the glyph is black on the light-mode header
      // and white on the dark one. On hover the bg flips to `--accent`,
      // so the glyph switches to `--accent-fg` — the theme's own ink for
      // text sitting ON an accent fill (see the handlers).
      border: 'none', color: 'var(--text-primary)', cursor: 'pointer',
      pointerEvents: 'auto', fontSize: `${14 / scale}px`, lineHeight: '1',
      transition: 'background-color 0.15s, color 0.15s',
    },
    on: {
      // Stop both mousedown AND pointerdown — the header's drag handler is
      // wired on pointerdown, and mousedown.stopPropagation() doesn't block
      // pointer events. Without pointerdown.stopPropagation, clicking the
      // button selects the viewport (via the header's pointerdown handler)
      // and the menu never opens.
      mousedown: (e: Event) => e.stopPropagation(),
      pointerdown: (e: Event) => e.stopPropagation(),
      // Hardcoding white here made the glyph invisible on pale accents
      // (khaki, sand, mint): those palettes set `--accent-fg` to near-black
      // precisely because white fails on them.
      mouseover: () => { addBtn.style.backgroundColor = 'var(--accent)'; addBtn.style.color = 'var(--accent-fg)'; },
      mouseout: () => { addBtn.style.backgroundColor = 'transparent'; addBtn.style.color = 'var(--text-primary)'; },
      click: (e: Event) => {
        e.stopPropagation();
        const rect = addBtn.getBoundingClientRect();
        callbacks.onAddViewport?.(vp.id, rect.right, rect.bottom);
      },
    },
  });

  // Done button — only visible in overlay-edit mode (see applyHeaderModeStyles).
  // Exits the mode via the module-level onDone callback, standard.
  const doneBtn = el('button', {
    attrs: { 'data-header-done': '' },
    text: 'Done',
    styles: {
      display: 'none', alignItems: 'center', justifyContent: 'center',
      // Only rendered in overlay-edit mode, where the header background is
      // `--accent` — so it takes the accent's ink too.
      backgroundColor: 'transparent', border: 'none', color: 'var(--accent-fg)',
      fontWeight: '600', fontSize: `${11 / scale}px`, lineHeight: '1',
      fontFamily: 'Inter, system-ui, sans-serif', cursor: 'pointer',
      pointerEvents: 'auto', padding: `0 ${4 / scale}px`,
    },
    on: {
      // Block the header's drag/select handlers, same as the + button.
      mousedown: (e: Event) => e.stopPropagation(),
      pointerdown: (e: Event) => e.stopPropagation(),
      mouseover: () => { doneBtn.style.opacity = '0.8'; },
      mouseout: () => { doneBtn.style.opacity = '1'; },
      click: (e: Event) => {
        e.stopPropagation();
        trace.action('viewport-header:overlay-done-click', { vpId: vp.id });
        overlayEditOnDone?.();
      },
    },
  });

  const header = el('div', {
    attrs: { 'data-viewport-header': vp.id, 'data-vp-label': vp.label },
    styles: {
      position: 'absolute', left: `${left}px`, top: `${top - scaledH - scaledM}px`,
      width: `${width}px`, height: `${scaledH}px`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: `0 ${8 / scale}px`, backgroundColor: 'var(--canvas-chrome-bg)',
      border: `${1 / scale}px solid var(--canvas-chrome-border)`,
      borderRadius: `${8 / scale}px`, boxShadow: 'var(--shadow-sm)',
      userSelect: 'none', pointerEvents: 'auto', cursor: 'grab',
      zIndex: '9999', overflow: 'hidden', boxSizing: 'border-box',
    },
    children: [
      el('div', {
        attrs: { 'data-header-label': '' },
        styles: {
          display: 'flex', alignItems: 'center', gap: `${4 / scale}px`,
          fontSize: `${11 / scale}px`, fontFamily: 'Inter, system-ui, sans-serif',
          lineHeight: `${scaledH}px`, color: 'var(--text-secondary)', whiteSpace: 'nowrap', pointerEvents: 'none',
        },
        children: [
          el('span', { attrs: { 'data-header-title': '' }, text: vp.label, styles: {} }),
          el('span', { attrs: { 'data-header-width': '' }, text: `${Math.round(width)}`, styles: { color: 'var(--accent-text)', marginLeft: `${8 / scale}px` } }),
        ],
      }),
      addBtn,
      doneBtn,
    ],
  });

  // Apply overlay-edit styling immediately — headers rebuild on every parent
  // re-render, so a freshly created header must not flash the default style
  // while overlay mode is active.
  applyHeaderModeStyles(header, scale);

  // ─── Events ──────────────────────────────────────────────────────────

  // Hover — suppressed during drag to avoid React re-renders
  let headerDragging = false;
  header.addEventListener('mouseover', (e) => {
    e.stopPropagation();
    if (!headerDragging) {
      // Use vpEl.getAttribute if available, else the viewport frame id
      // (covers full layout) so the hover outline matches the full viewport.
      const vpNodeId = vpEl?.getAttribute('data-id') || getViewportFrameNodeId(vp.id);
      callbacks.onHover(vpNodeId, vp.id);
    }
  });
  header.addEventListener('mouseout', (e) => {
    e.stopPropagation();
    if (!headerDragging) {
      callbacks.onHover(null);
    }
  });
  // Prevent Canvas mousemove from clearing hover
  header.addEventListener('mousemove', (e) => e.stopPropagation());

  // Drag — use pointer events (mousemove can be eaten by native drag behavior)
  header.addEventListener('pointerdown', (e) => {
    // Middle mouse (button 1) = canvas pan via attachMiddleMousePan (registered
    // on the canvas container in capture phase). The pan handler has already
    // fired by the time we get here. If we stopPropagation + start a drag,
    // we end up panning the canvas AND moving the viewport at the same time.
    // Right-click (button 2) is also not a drag — let it bubble for context
    // menus etc. Only treat left-click (button 0) as a viewport drag start.
    if (e.button !== 0) {
      trace.action('viewport-header:non-primary-button-skip', { vpId: vp.id, button: e.button });
      return;
    }
    // View-only: the header is neither draggable nor a select trigger.
    // Bare return (no stopPropagation) lets the event bubble to the
    // canvas mousedown handler, which is itself viewer-gated — so a
    // header click does nothing instead of moving the viewport.
    if (isViewerMode()) {
      trace.action('viewport-header:pointerdown-blocked-viewer', { vpId: vp.id });
      return;
    }
    e.stopPropagation();
    e.preventDefault();

    try {
    // Select the viewport frame node — always `root`. On a templated page
    // the template is merged onto `root`, so its rect already covers the
    // full viewport (navbar/footer included); on a plain page it's the page
    // root. Either way the selection outline wraps the whole frame.
    const vpNodeId = vpEl?.getAttribute('data-id') || getViewportFrameNodeId(vp.id);
    callbacks.onSelect(vpNodeId);
    callbacks.onInteractingViewport(vp.id);

    trace.action('viewport-header:mousedown', { vpId: vp.id });

    const startX = e.clientX;
    const startY = e.clientY;
    // Get initial position from helper (works in both modes)
    const currentPosData = getViewportPositionData(vp.id, vpEl);
    const startLeft = currentPosData?.left ?? 0;
    const startTop = currentPosData?.top ?? 0;
    const vpWidth = currentPosData?.width ?? 0;
    const vpHeight = currentPosData?.height ?? 0;
    const dragScale = transformManager.getTransform().scale;
    let started = false;
    let prevMouse = { x: startX, y: startY };
    let lastGuideCount = 0;
    let lastSpacingCount = 0;
    // Track the latest position so onUp can commit it without parsing back
    // out of style.transform (which is empty in iframe mode where the
    // viewport translate is applied via bridge, not on a parent-frame el).
    let latestFinalLeft = startLeft;
    let latestFinalTop = startTop;

    // Sibling rects for snap — use getViewportPositionData (bridge-compatible)
    const siblingRects: { id: string; rect: Rect }[] = [];
    for (const other of allViewports) {
      if (other.id === vp.id) continue;
      const otherEl = findViewportElement(other.id);
      const otherPos = getViewportPositionData(other.id, otherEl);
      if (!otherPos) continue;
      siblingRects.push({
        id: other.id,
        rect: {
          left: otherPos.left,
          top: otherPos.top,
          width: otherPos.width,
          height: otherPos.height,
        },
      });
    }

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      if (!started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        started = true;
        headerDragging = true;
        header.style.cursor = 'grabbing';
        // Hide ALL headers — including the dragged one. The viewport itself
        // is the visual feedback; a header floating above an empty drag
        // path is noisy. onDragStateChange triggers setViewportHeadersVisible
        // (false) on every header. Pointer capture keeps mousemove flowing
        // to this element even while it's display:none.
        callbacks.onDragStateChange?.(true);
        trace.action('viewport-header:drag-start', { vpId: vp.id, vpElInDOM: vpEl?.isConnected ?? false, headerInDOM: header.isConnected, vpWidth, vpHeight, startLeft, startTop, dragScale });
      }

      const canvasDx = Math.round(dx / dragScale);
      const canvasDy = Math.round(dy / dragScale);
      const newLeft = startLeft + canvasDx;
      const newTop = startTop + canvasDy;

      // Snap
      const draggedRect: Rect = { left: newLeft, top: newTop, width: vpWidth, height: vpHeight };
      const velocity = getMouseVelocity(prevMouse, { x: me.clientX, y: me.clientY });
      const currentScale = transformManager.getTransform().scale;
      const snap = calculateSnap(
        draggedRect,
        siblingRects,
        velocity,
        SNAP_THRESHOLD / currentScale,
        undefined,
        undefined,
        getActiveRulerGuideSnapLines(),
      );
      prevMouse = { x: me.clientX, y: me.clientY };

      const finalLeft = snap.snappedX ? snap.x : newLeft;
      const finalTop = snap.snappedY ? snap.y : newTop;
      latestFinalLeft = finalLeft;
      latestFinalTop = finalTop;

      // Use translate for GPU compositing (no layout recalc for children)
      const tx = finalLeft - startLeft;
      const ty = finalTop - startTop;
      const transform = `translate(${tx}px, ${ty}px)`;
      if (vpEl) {
        // Direct DOM mode (no iframe). Move both via transform — the parent
        // frame doesn't have a rect cache that would refit the header on
        // its own, so the header needs a manual visual offset.
        vpEl.style.transform = transform;
        header.style.transform = transform;
      } else {
        // Iframe mode — viewport lives in the sandbox. Forward the live
        // transform through the bridge; the resulting rectUpdate event
        // refreshes rectCache, and the RAF tracker (Canvas.tsx) refits the
        // header to the new position on the next frame. No header.transform
        // here — that would double-offset the header against the cache.
        // Target the viewport FRAME node (`root`). On a templated page the
        // template is merged onto `root`, so translating `root` moves the
        // whole frame (navbar + page content + footer) together.
        const vpPrefix = getViewportPrefix(vp.id);
        const frameId = getViewportFrameNodeId(vp.id);
        getCanvasBridge().patchStyles(frameId, vpPrefix, { transform }, false);
      }

      trace.action('viewport-header:drag-move', { vpId: vp.id, tx, ty, finalLeft, finalTop, snappedX: snap.snappedX, snappedY: snap.snappedY });

      // Only update snap guide state when it actually changes
      const guideCount = snap.guides.length;
      const spacingCount = snap.spacingGuides.length;
      if (guideCount !== lastGuideCount) {
        callbacks.onSnapGuidesChange(snap.guides);
        lastGuideCount = guideCount;
      }
      if (spacingCount !== lastSpacingCount) {
        callbacks.onSpacingGuidesChange(snap.spacingGuides);
        lastSpacingCount = spacingCount;
      }
    };

    const onUp = () => {
      headerDragging = false;
      callbacks.onDragStateChange?.(false);
      if (started) {
        const finalLeft = latestFinalLeft;
        const finalTop = latestFinalTop;

        // Clear transform, set final left/top (one layout pass, not during drag)
        if (vpEl) {
          vpEl.style.transform = '';
          vpEl.style.willChange = '';
          vpEl.style.left = `${finalLeft}px`;
          vpEl.style.top = `${finalTop}px`;
        } else {
          // Iframe mode — atomically clear the live transform AND write the
          // final left/top. Without writing left/top here, the viewport
          // visually snaps back to its pre-drag position for one frame
          // (transform cleared, but new vp.x/vp.y haven't reached the
          // iframe yet via setVpPositions → renderer.render). The renderer
          // will write the same left/top values shortly via the regular
          // path, so no double-paint — just no flash.
          const vpPrefix = getViewportPrefix(vp.id);
          const frameId = getViewportFrameNodeId(vp.id);
          getCanvasBridge().patchStyles(frameId, vpPrefix, {
            transform: '',
            left: `${finalLeft}px`,
            top: `${finalTop}px`,
          }, false);
        }
        header.style.transform = '';

        trace.action('viewport-header:drag-end', { vpId: vp.id, x: finalLeft, y: finalTop });
        callbacks.onPositionCommit(vp.id, finalLeft, finalTop);
      }
      header.style.cursor = 'grab';
      if (lastGuideCount > 0) callbacks.onSnapGuidesChange([]);
      if (lastSpacingCount > 0) callbacks.onSpacingGuidesChange([]);
      lastGuideCount = 0;
      lastSpacingCount = 0;
      window.removeEventListener('pointermove', onMove);
    };

    // Use pointermove instead of mousemove — more reliable for drag interactions.
    // In some browsers, mousedown + drag on certain elements can initiate native drag
    // which captures mouse events. Pointer events are not affected by this.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    trace.action('viewport-header:listeners-added', { vpId: vp.id });

    } catch (err) {
      trace.error('viewport-header:mousedown-error', err);
    }
  });

  return header;
}
