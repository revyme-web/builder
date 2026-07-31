// src/canvas/SandboxBridgeManager.ts
//
// Owns the parent-side PostMessageBridge for the canvas sandbox iframe:
//   - mounts the bridge against an <iframe> element via setIframe()
//   - tracks the two-flag handshake (iframe onLoad + sandbox 'ready' message)
//   - registers handlers for ALL bridge events and forwards them to Canvas.tsx
//     via callback slots
//   - exposes the bridge instance for callers that need direct RPC access
//
// Disposing calls bridge.destroy() (removes window message listener + Comlink
// proxy) and clears the active bridge singleton.
//
// IMPORTANT: The PostMessageBridge exposes callbacks as plain nullable
// properties (not addEventListener-style methods). Assignments happen in the
// constructor so they are stable for the lifetime of the manager.

import { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import type { TextEditFitResult } from '@/canvas-sandbox/protocol';
import { setActiveBridge, resetActiveBridge } from './canvas-bridge';
import { trace } from '@/shared/debug-trace';
import type { TextEditSnapshot } from '@/canvas-sandbox/protocol';

// ─── Callback interface ──────────────────────────────────────────────────────

export interface SandboxBridgeCallbacks {
  // Handshake
  onReadyChange: (ready: boolean) => void;

  // Render lifecycle
  onRenderComplete: () => void;

  // Mouse / hover from sandbox
  onNodeMouseDown: (
    nodeId: string,
    event: {
      clientX: number;
      clientY: number;
      button: number;
      shiftKey: boolean;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
    },
  ) => void;
  onSandboxMouseMove: (clientX: number, clientY: number) => void;

  // Canvas-dnd events
  onDndCommit: (
    updates: Array<{
      type: string;
      nodeId: string;
      newParentId?: string | null;
      newIndex?: number;
      styles?: Record<string, string>;
    }>,
  ) => void;
  onDndSelect: (selectedIds: string[]) => void;
  onDndHover: (hoveredId: string | null) => void;
  onDndViewportHit: (viewport: string) => void;
  onDndDragState: (state: { isDragging: boolean; source: string }) => void;

  // Text-edit events (sandbox-hosted TipTap)
  onTextEditSelectionChanged: (snapshot: TextEditSnapshot) => void;
  onTextEditContentChanged: (html: string) => void;
  onTextEditCommitted: (html: string, fit?: TextEditFitResult) => void;
  onTextEditCancelled: () => void;

  // Shape-edit events
  onShapeEditCancelled: () => void;
  onShapeEditDone: () => void;
  onAnchorInfo: (
    info: null | {
      shapeIndex: number;
      anchorIndex: number;
      x: number;
      y: number;
      handleMode: 'straight' | 'mirrored' | 'disconnected';
    },
  ) => void;
}

// ─── Manager class ───────────────────────────────────────────────────────────

export class SandboxBridgeManager {
  readonly bridge: PostMessageBridge;

  /** True once the iframe's onLoad fires. */
  private iframeLoaded = false;
  /** True once the sandbox posts its 'sandboxReady' message. */
  private sandboxReadyMsg = false;

  private readonly callbacks: SandboxBridgeCallbacks;

  constructor(callbacks: SandboxBridgeCallbacks) {
    this.callbacks = callbacks;
    this.bridge = new PostMessageBridge();

    // ─── Handshake ────────────────────────────────────────────────────────
    // The bridge fires onReady when it receives the 'sandboxReady' message
    // from the iframe. Combined with the iframe onLoad flag from
    // notifyIframeLoaded(), both flags being true means the sandbox is ready
    // to receive commands.
    this.bridge.onReady = () => {
      trace.action('sandbox-bridge:sandbox-ready-msg', {});
      this.sandboxReadyMsg = true;
      this.checkReady();
    };

    // ─── Render lifecycle ─────────────────────────────────────────────────
    this.bridge.onRenderComplete = () => {
      trace.action('sandbox-bridge:render-complete', {});
      this.callbacks.onRenderComplete();
    };

    // ─── Mouse / hover ────────────────────────────────────────────────────
    this.bridge.onNodeMouseDown = (nodeId, event) => {
      trace.action('sandbox-bridge:node-mousedown', { nodeId });
      this.callbacks.onNodeMouseDown(nodeId, event);
    };

    this.bridge.onSandboxMouseMove = (clientX, clientY) => {
      this.callbacks.onSandboxMouseMove(clientX, clientY);
    };

    // ─── Canvas-dnd events ────────────────────────────────────────────────
    this.bridge.onDndCommit = (updates) => {
      trace.action('sandbox-bridge:dnd-commit', { count: updates.length });
      this.callbacks.onDndCommit(updates);
    };

    this.bridge.onDndSelect = (ids) => {
      trace.action('sandbox-bridge:dnd-select', { count: ids.length });
      this.callbacks.onDndSelect(ids);
    };

    this.bridge.onDndHover = (id) => {
      this.callbacks.onDndHover(id);
    };

    this.bridge.onDndViewportHit = (vpId) => {
      trace.action('sandbox-bridge:dnd-viewport-hit', { vpId });
      this.callbacks.onDndViewportHit(vpId);
    };

    this.bridge.onDndDragState = (state) => {
      trace.action('sandbox-bridge:dnd-drag-state', state);
      this.callbacks.onDndDragState(state);
    };

    // ─── Text-edit events ─────────────────────────────────────────────────
    this.bridge.onTextEditSelectionChanged = (snapshot) => {
      this.callbacks.onTextEditSelectionChanged(snapshot);
    };

    this.bridge.onTextEditContentChanged = (html) => {
      this.callbacks.onTextEditContentChanged(html);
    };

    this.bridge.onTextEditCommitted = (html, fit) => {
      trace.action('sandbox-bridge:text-edit-committed', { htmlLen: html.length });
      this.callbacks.onTextEditCommitted(html, fit);
    };

    this.bridge.onTextEditCancelled = () => {
      trace.action('sandbox-bridge:text-edit-cancelled', {});
      this.callbacks.onTextEditCancelled();
    };

    // ─── Shape-edit events ────────────────────────────────────────────────
    this.bridge.onShapeEditCancelled = () => {
      trace.action('sandbox-bridge:shape-edit-cancelled', {});
      this.callbacks.onShapeEditCancelled();
    };
    this.bridge.onShapeEditDone = () => {
      trace.action('sandbox-bridge:shape-edit-done', {});
      this.callbacks.onShapeEditDone();
    };

    this.bridge.onAnchorInfo = (info) => {
      trace.action('sandbox-bridge:anchor-info', info ?? { info: null });
      this.callbacks.onAnchorInfo(info);
    };

    trace.action('sandbox-bridge:created', {});
  }

  /**
   * Wire the bridge to the loaded iframe element. Also calls setActiveBridge()
   * so imperative node-ops helpers can reach the bridge.
   * Must be called after the iframe's onLoad fires.
   */
  setIframe(iframe: HTMLIFrameElement): void {
    this.bridge.setIframe(iframe);
    setActiveBridge(this.bridge);
    trace.action('sandbox-bridge:iframe-set', { src: iframe.src });
  }

  /**
   * Record that the iframe's onLoad event fired. Combined with the sandbox's
   * 'ready' message, both flags true → onReadyChange(true).
   */
  notifyIframeLoaded(): void {
    this.iframeLoaded = true;
    trace.action('sandbox-bridge:iframe-loaded', { sandboxReadyMsg: this.sandboxReadyMsg });
    this.checkReady();
  }

  private checkReady(): void {
    if (this.iframeLoaded && this.sandboxReadyMsg) {
      trace.action('sandbox-bridge:ready', {
        iframeLoaded: this.iframeLoaded,
        sandboxReadyMsg: this.sandboxReadyMsg,
      });
      this.callbacks.onReadyChange(true);
    }
  }

  /**
   * Tear down: removes the window message listener, releases the Comlink
   * proxy, and clears the active bridge singleton. Safe to call multiple
   * times.
   */
  dispose(): void {
    this.bridge.destroy();
    resetActiveBridge();
    trace.action('sandbox-bridge:disposed', {});
  }
}
