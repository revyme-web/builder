// src/canvas/hooks/useCanvasTransform.ts
//
// Attaches the camera transform listeners (wheel zoom, middle-mouse pan).
// Registers contentRef + vpOverlayRef with the transformManager so it can
// apply transforms automatically and forward the viewport transform to the
// sandbox iframe on every pan/zoom tick.
//
// Also owns:
//   - transformManager subscribe → viewport header position updates + bridge forwarding
//   - wheel + middle-mouse-pan native event listeners
//   - iframe wheel forwarding (postMessage → synthesized WheelEvent)
//   - startViewportHeaderTracking continuous position polling
//   - observeDOM debug trace observer
//
// Auto-pan attachment lives in Canvas.tsx until Task 9 folds it into
// CanvasDragOrchestrator.

import { useEffect } from 'react';
import {
  transformManager,
  handleWheel,
  attachMiddleMousePan,
} from '../transform';
import {
  updateViewportHeaderPositions,
  setViewportHeadersVisible,
  startViewportHeaderTracking,
} from '../ViewportHeaderManager';
import { useSetAtom } from 'jotai';
import { canvasInteractingAtom } from '@/code/stores/store';
import { trace, observeDOM } from '@/shared/debug-trace';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';

export interface UseCanvasTransformOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  vpOverlayRef: React.RefObject<HTMLDivElement | null>;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  postMessageBridgeRef: React.RefObject<PostMessageBridge | null>;
  dragCoordinatorRef: React.RefObject<{ isDragging?: boolean } | null>;
  // setPanCursor drives the cursor + hand-tool highlight during middle-mouse pan
  setPanCursor: (v: boolean) => void;
}

export function useCanvasTransform(opts: UseCanvasTransformOptions) {
  const {
    containerRef,
    contentRef,
    vpOverlayRef,
    iframeRef,
    postMessageBridgeRef,
    dragCoordinatorRef,
    setPanCursor,
  } = opts;

  const setCanvasInteracting = useSetAtom(canvasInteractingAtom);

  // ─── TransformManager element registration + subscribe ─────────────────
  useEffect(() => {
    const content = contentRef.current;
    const vpOverlay = vpOverlayRef.current;

    trace.action('canvas-transform:setup', {
      hasContent: !!content,
      hasVpOverlay: !!vpOverlay,
    });

    // Register elements with TransformManager — it applies transforms automatically.
    // contentRef is a hidden parent-frame anchor (kept for SelectionBox/DragCoordinator refs);
    // sandbox transforms are forwarded via postMessage below.
    if (content) {
      transformManager.addElement(content);
    }
    if (vpOverlay) transformManager.addElement(vpOverlay);

    // Subscribe for transform updates:
    // 1. Update viewport header positions
    // 2. Hide visual helpers during interaction (debounced — show again 100ms after last update)
    // 3. Forward transform to sandbox iframe
    let interactTimeout: ReturnType<typeof setTimeout> | null = null;
    const unsub = transformManager.subscribe(() => {
      if (vpOverlay) {
        updateViewportHeaderPositions(vpOverlay);
        setViewportHeadersVisible(vpOverlay, false);
      }
      setCanvasInteracting(true);

      if (postMessageBridgeRef.current?.isReady) {
        const t = transformManager.getTransform();
        trace.action('canvas-transform:bridge-forward', { x: t.x, y: t.y, scale: t.scale });
        // Per-tick live forwarding for BOTH pan and zoom. A surface-freeze
        // experiment (compositing zoom gestures on the iframe element,
        // 2026-07-19) was REMOVED: any freeze window shows partially-
        // revealed content during a zoom-out, which reads as nodes
        // appearing "bit by bit" — user-rejected. Live forwarding keeps the
        // canvas complete at every tick; culled tiles show their grey
        // placeholders and materialise via the staggered idle restore.
        postMessageBridgeRef.current.setViewportTransform(t.x, t.y, t.scale);
      }

      if (interactTimeout) clearTimeout(interactTimeout);
      interactTimeout = setTimeout(() => {
        // While a drag is in flight, leave canvasInteracting alone — the
        // drag's own start/end transitions own the flag. This debounce
        // used to fire 100 ms after the last auto-pan tick (i.e. when
        // the user moved the cursor back off the edge mid-drag).
        // Letting it run flipped `canvasInteracting` to false MID-DRAG,
        // which propagated through the
        // `setDndInteracting(canvasInteractingVal)` effect and told the
        // iframe's canvas-dnd to stop forwarding pointermove events to
        // the parent. The strategy's `onMove` then never ran for cursor
        // positions over the iframe, so the drop-line and
        // parent-highlight stopped updating until drag end. Skipping
        // this branch during a drag keeps the iframe's pointer
        // forwarding alive for the rest of the gesture.
        if (!dragCoordinatorRef.current?.isDragging) {
          setCanvasInteracting(false);
        }
        if (vpOverlay) setViewportHeadersVisible(vpOverlay, true);
      }, 100);
    });

    // Send initial transform to sandbox
    if (postMessageBridgeRef.current?.isReady) {
      const t = transformManager.getTransform();
      trace.action('canvas-transform:initial-forward', { x: t.x, y: t.y, scale: t.scale });
      postMessageBridgeRef.current.setViewportTransform(t.x, t.y, t.scale);
    }

    return () => {
      trace.action('canvas-transform:teardown', {
        hasContent: !!content,
        hasVpOverlay: !!vpOverlay,
      });
      if (content) transformManager.removeElement(content);
      if (vpOverlay) transformManager.removeElement(vpOverlay);
      unsub();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Continuously track viewport header positions ───────────────────────
  // Covers viewport drag/resize/add — which all change the iframe DOM rect
  // on their own timeline, separate from React renders.
  useEffect(() => {
    const vpOverlay = vpOverlayRef.current;
    if (!vpOverlay) return;
    trace.action('canvas-transform:header-tracking-start', {});
    return startViewportHeaderTracking(vpOverlay);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── DOM mutation observer for debug trace ──────────────────────────────
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    trace.action('canvas-transform:dom-observer-start', {});
    return observeDOM(content);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Wheel + middle-mouse pan: native event listeners ───────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    trace.action('canvas-transform:wheel-attach', {});

    const onWheel = (e: WheelEvent) => handleWheel(e, container.getBoundingClientRect());
    container.addEventListener('wheel', onWheel, { passive: false });

    // Middle-mouse pan via native pointer events + pointer capture.
    // This prevents browser auto-scroll AND gives reliable button-matched up/down.
    const detachMiddlePan = attachMiddleMousePan(container, setPanCursor);

    // Wheel events INSIDE the iframe don't bubble to parent — sandbox forwards
    // them via postMessage. Synthesize a WheelEvent here so handleWheel works
    // unchanged. Coordinates from the message are iframe-local; add the
    // iframe's screen offset so handleWheel's container-relative math is correct.
    const onIframeWheel = (e: MessageEvent) => {
      if (!e.data || e.data.type !== 'wheel') return;
      const iframe = iframeRef.current;
      if (!iframe) return;
      const ir = iframe.getBoundingClientRect();
      const synthetic = new WheelEvent('wheel', {
        deltaX: e.data.deltaX,
        deltaY: e.data.deltaY,
        ctrlKey: e.data.ctrlKey,
        metaKey: e.data.metaKey,
        clientX: e.data.clientX + ir.left,
        clientY: e.data.clientY + ir.top,
      });
      handleWheel(synthetic, container.getBoundingClientRect());
    };
    window.addEventListener('message', onIframeWheel);

    return () => {
      trace.action('canvas-transform:wheel-detach', {});
      container.removeEventListener('wheel', onWheel);
      detachMiddlePan();
      window.removeEventListener('message', onIframeWheel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
