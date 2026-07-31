// src/canvas/hooks/useSandboxBridge.ts
//
// React wrapper for SandboxBridgeManager.
//
// Mounts the manager once on first render, returns:
//   - `bridgeRef`        stable ref to the PostMessageBridge (safe to pass to
//                        other hooks that accept a ref, so their effects don't
//                        re-run when the bridge reference is first populated)
//   - `sandboxReady`     boolean: both iframe-loaded + sandbox-ready-message
//   - `iframeRenderTick` increments on each iframe render-complete (used as a
//                        dep by viewport-header render effects)
//   - `handleIframeLoad` stable callback to wire to <iframe onLoad>
//
// All SandboxBridgeCallbacks are forwarded through a stable optsRef so the
// manager always calls the latest closures even as Canvas.tsx re-renders.

import { useEffect, useRef, useState, useCallback } from 'react';
import { SandboxBridgeManager } from '../SandboxBridgeManager';
import type { SandboxBridgeCallbacks } from '../SandboxBridgeManager';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import { trace } from '@/shared/debug-trace';

export type { SandboxBridgeCallbacks };

export interface UseSandboxBridgeOptions
  extends Omit<SandboxBridgeCallbacks, 'onReadyChange'> {
  /**
   * Optional: called when the bridge is first constructed (before iframe
   * loads). Use to wire renderer.setBridge(bridge) immediately.
   */
  onBridgeCreated?: (bridge: PostMessageBridge) => void;
}

export interface UseSandboxBridgeResult {
  /** Stable ref to the bridge. Populated synchronously on mount; null before. */
  bridgeRef: React.MutableRefObject<PostMessageBridge | null>;
  sandboxReady: boolean;
  iframeRenderTick: number;
  /** Wire to <iframe onLoad>. Calls manager.setIframe + notifyIframeLoaded. */
  handleIframeLoad: () => void;
}

export function useSandboxBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  opts: UseSandboxBridgeOptions,
): UseSandboxBridgeResult {
  const [sandboxReady, setSandboxReady] = useState(false);
  const [iframeRenderTick, setIframeRenderTick] = useState(0);

  // Stable ref to the bridge — downstream hooks (useRendererSync,
  // useCanvasTransform) receive it as a RefObject so their effects don't
  // re-run on every render when the value hasn't changed.
  const bridgeRef = useRef<PostMessageBridge | null>(null);
  // Ref to the manager so handleIframeLoad can call setIframe/notifyIframeLoaded.
  const managerRef = useRef<SandboxBridgeManager | null>(null);

  // Mirror opts so the manager's once-registered handlers always call the
  // latest closures (React re-renders may capture fresher state).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    trace.action('use-sandbox-bridge:mount', {});

    const manager = new SandboxBridgeManager({
      // Handshake
      onReadyChange: (ready) => {
        trace.action('use-sandbox-bridge:ready-change', { ready });
        setSandboxReady(ready);
      },

      // Render lifecycle — iframeRenderTick bump lives here; the onRenderComplete
      // option is forwarded so Canvas.tsx can run additional logic (e.g. clearing
      // shapeEditCommitPendingAtom via double-RAF).
      onRenderComplete: () => {
        setIframeRenderTick((n) => n + 1);
        optsRef.current.onRenderComplete();
      },

      // All remaining callbacks forwarded through optsRef for stable closures:
      onNodeMouseDown: (nodeId, event) =>
        optsRef.current.onNodeMouseDown(nodeId, event),
      onSandboxMouseMove: (x, y) =>
        optsRef.current.onSandboxMouseMove(x, y),
      onDndCommit: (updates) =>
        optsRef.current.onDndCommit(updates),
      onDndSelect: (ids) =>
        optsRef.current.onDndSelect(ids),
      onDndHover: (id) =>
        optsRef.current.onDndHover(id),
      onDndViewportHit: (vp) =>
        optsRef.current.onDndViewportHit(vp),
      onDndDragState: (state) =>
        optsRef.current.onDndDragState(state),
      onTextEditSelectionChanged: (snapshot) =>
        optsRef.current.onTextEditSelectionChanged(snapshot),
      onTextEditContentChanged: (html) =>
        optsRef.current.onTextEditContentChanged(html),
      onTextEditCommitted: (html, fit) =>
        optsRef.current.onTextEditCommitted(html, fit),
      onTextEditCancelled: () =>
        optsRef.current.onTextEditCancelled(),
      onShapeEditCancelled: () =>
        optsRef.current.onShapeEditCancelled(),
      onShapeEditDone: () =>
        optsRef.current.onShapeEditDone(),
      onAnchorInfo: (info) =>
        optsRef.current.onAnchorInfo(info),
    });

    managerRef.current = manager;
    bridgeRef.current = manager.bridge;

    // Notify caller that a bridge instance now exists (e.g. renderer.setBridge).
    optsRef.current.onBridgeCreated?.(manager.bridge);

    return () => {
      trace.action('use-sandbox-bridge:unmount', {});
      manager.dispose();
      managerRef.current = null;
      bridgeRef.current = null;
      setSandboxReady(false);
    };
     
  }, []);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const manager = managerRef.current;
    if (!iframe || !manager) {
      trace.action('use-sandbox-bridge:iframe-load-skipped', {
        hasIframe: !!iframe,
        hasManager: !!manager,
      });
      return;
    }
    manager.setIframe(iframe);
    manager.notifyIframeLoaded();
    trace.action('use-sandbox-bridge:iframe-load-complete', { src: iframe.src });
  }, [iframeRef]);

  return {
    bridgeRef,
    sandboxReady,
    iframeRenderTick,
    handleIframeLoad,
  };
}
