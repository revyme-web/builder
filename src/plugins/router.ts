// plugins/router.ts — postMessage dispatch for one plugin iframe.
//
// One Router instance per loaded plugin. Owns:
//   - A reference to the plugin's iframe contentWindow (for posting back)
//   - The plugin's manifest (for permission checks)
//   - A map of method-name → handler (the SDK impl)
//   - A map of subscription-id → dispose fn (so unsubscribe works)
//
// Lifecycle:
//   1. `attach(iframe)` — registers the message listener. Plugin's
//      handshake fires; we ack with the host name + protocol version.
//   2. Plugin sends `rpc` requests; we look up the method handler,
//      run it inside a try/catch, post `rpc-response` back.
//   3. Plugin sends `subscribe`; we open the subscription via
//      `openSubscription`, store its dispose fn, and start pushing
//      `event` messages.
//   4. Plugin sends `unsubscribe`; we call the stored dispose fn.
//   5. Plugin sends `close` OR `detach()` is called; we tear down the
//      listener and dispose every open subscription.
//
// Error handling: any throw inside a handler turns into a
// `RpcResponse { ok: false, error }`. Plugins see a rejected promise
// in their `await revyme.canvas.foo()` call. Unknown methods reply
// with `ok: false, error: 'NOT_IMPLEMENTED:<method>'` so plugin
// authors can detect host capability gaps.

import type {
  HostToPluginMessage,
  PluginToHostMessage,
  HandshakeAck,
  RpcResponse,
  EventPush,
} from './protocol';
import { HOST_NAME, PROTOCOL_VERSION } from './protocol';
import type { PluginManifest } from '@revyme/plugin-sdk';
import { assertCan, NotImplementedError, PermissionDeniedError } from './permission-gate';
import { startLayoutDrag, updateLayoutDrag, endLayoutDrag, cancelLayoutDrag, type LayoutDragSpec } from '@/canvas/drag/toolbar-drag-bridge';
// One handler module per SDK namespace — files are named for what
// they do, not when they were added. The router spreads them all
// into a single dispatch table; methods missing from this table
// auto-return `NOT_IMPLEMENTED:<method>` (see `onRpc` below).
import { canvasHandlers } from './sdk-impl/canvas';
import { openSubscription } from './sdk-impl/subscribe';
import { metaHandlers } from './sdk-impl/meta';
import { pluginDataHandlers } from './sdk-impl/plugin-data';
import { pagesHandlers } from './sdk-impl/pages';
import { textHandlers } from './sdk-impl/text';
import { componentsHandlers } from './sdk-impl/components';
import { sketchesHandlers } from './sdk-impl/sketches';
import { vectorsHandlers } from './sdk-impl/vectors';
import { presetsHandlers } from './sdk-impl/presets';
import { fontsHandlers } from './sdk-impl/fonts';
import { assetsHandlers } from './sdk-impl/assets';
import { variablesHandlers } from './sdk-impl/variables';
import { animationsHandlers } from './sdk-impl/animations';
import { uiHandlers } from './sdk-impl/ui';
import { codeFilesHandlers } from './sdk-impl/code-files';
import { customCodeHandlers } from './sdk-impl/custom-code';
import { secretsHandlers } from './sdk-impl/secrets';
import { networkHandlers } from './sdk-impl/network';
import { permissionsHandlers } from './sdk-impl/permissions';
import { cmsHandlers } from './sdk-impl/cms';
import { localizationHandlers } from './sdk-impl/localization';
import { redirectsHandlers } from './sdk-impl/redirects';
import { trace } from '@/shared/debug-trace';

// RpcHandler/RpcHandlerContext live in plugin-types.ts (leaf) so sdk-impl
// modules can import them without a router ↔ sdk-impl cycle; re-exported.
import type { RpcHandler } from './plugin-types';

/**
 * Year-1 method registry. Add a namespace = add its handlers here.
 * Methods NOT in this map return `NOT_IMPLEMENTED:<method>` to the
 * plugin — the typed SDK declares the full year-1 surface so plugin
 * authors get autocomplete, but only methods registered here have
 * working implementations. As host primitives stabilize, more
 * namespaces light up by adding their handlers to this spread.
 */
const handlers: Record<string, RpcHandler> = {
  ...canvasHandlers,
  ...metaHandlers,
  ...pluginDataHandlers,
  ...pagesHandlers,
  ...textHandlers,
  ...componentsHandlers,
  ...sketchesHandlers,
  ...vectorsHandlers,
  ...presetsHandlers,
  ...fontsHandlers,
  ...assetsHandlers,
  ...variablesHandlers,
  ...animationsHandlers,
  ...uiHandlers,
  ...codeFilesHandlers,
  ...customCodeHandlers,
  ...secretsHandlers,
  ...networkHandlers,
  ...permissionsHandlers,
  ...cmsHandlers,
  ...localizationHandlers,
  ...redirectsHandlers,
};

export class PluginRouter {
  private iframe: HTMLIFrameElement | null = null;
  private listener: ((e: MessageEvent) => void) | null = null;
  private subscriptions = new Map<string, () => void>();

  constructor(private readonly manifest: PluginManifest) {}

  attach(iframe: HTMLIFrameElement): void {
    if (this.iframe) throw new Error('PluginRouter already attached');
    this.iframe = iframe;
    this.listener = (e: MessageEvent) => this.onMessage(e);
    window.addEventListener('message', this.listener);
    trace.action('plugin-router:attach', { id: this.manifest.id });
  }

  detach(): void {
    if (this.listener) window.removeEventListener('message', this.listener);
    for (const dispose of this.subscriptions.values()) {
      try { dispose(); } catch (e) {
        trace.error('plugin-router:dispose-failed', { error: String(e) });
      }
    }
    this.subscriptions.clear();
    this.iframe = null;
    this.listener = null;
    trace.action('plugin-router:detach', { id: this.manifest.id });
  }

  private post(msg: HostToPluginMessage): void {
    const cw = this.iframe?.contentWindow;
    if (!cw) return;
    cw.postMessage(msg, '*');
  }

  private onMessage(e: MessageEvent): void {
    // Source filtering: only accept messages whose `source` matches
    // OUR iframe's window. Other plugin iframes on the page will fire
    // listeners on this same global event handler — we'd otherwise
    // route their messages here and get cross-plugin contamination.
    if (e.source !== this.iframe?.contentWindow) return;
    const data = e.data as PluginToHostMessage | undefined;
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'handshake':
        return this.onHandshake();
      case 'rpc':
        return void this.onRpc(data.id, data.method, data.params);
      case 'subscribe':
        return this.onSubscribe(data.id, data.event);
      case 'unsubscribe':
        return this.onUnsubscribe(data.subscriptionId);
      case 'close':
        return this.onClose();
    }
  }

  private onHandshake(): void {
    const ack: HandshakeAck = {
      type: 'handshake-ack',
      protocolVersion: PROTOCOL_VERSION,
      hostName: HOST_NAME,
    };
    trace.action('plugin-router:handshake-ack', { id: this.manifest.id });
    this.post(ack);
  }

  private async onRpc(id: string, method: string, params: unknown): Promise<void> {
    // Layout drag is handled at the ROUTER level (not a generic sdk-impl
    // handler) because it needs the plugin iframe's on-screen position to
    // translate the plugin-local pointer into the parent-frame coordinate the
    // native DragCoordinator expects. `startLayoutDrag`/`cancelLayoutDrag` live
    // in the toolbar-drag-bridge (parent frame), reusing the exact drag the
    // Insert panel uses — line indicators, reparent, tree insert, all for free.
    if (
      method === 'canvas.startLayoutDrag' || method === 'canvas.updateLayoutDrag' ||
      method === 'canvas.endLayoutDrag' || method === 'canvas.cancelLayoutDrag'
    ) {
      try {
        assertCan(this.manifest, method);
        // Plugin-iframe pointer coords → parent-frame coords (the plugin
        // captures the mouse for the whole drag and forwards every move).
        const p = params as { spec?: LayoutDragSpec; x?: number; y?: number };
        const rect = this.iframe?.getBoundingClientRect();
        const x = (rect?.left ?? 0) + (typeof p?.x === 'number' ? p.x : 0);
        const y = (rect?.top ?? 0) + (typeof p?.y === 'number' ? p.y : 0);
        if (method === 'canvas.cancelLayoutDrag') {
          cancelLayoutDrag();
        } else if (method === 'canvas.updateLayoutDrag') {
          updateLayoutDrag(x, y);
        } else if (method === 'canvas.endLayoutDrag') {
          endLayoutDrag(x, y);
        } else {
          if (!p?.spec) throw new Error('canvas.startLayoutDrag: spec required');
          startLayoutDrag(p.spec, x, y);
        }
        this.post({ type: 'rpc-response', id, ok: true, result: null });
      } catch (err) {
        const message = err instanceof PermissionDeniedError
          ? `PERMISSION_DENIED:${err.required}`
          : (err as Error).message;
        this.post(this.errorResponse(id, message));
      }
      return;
    }

    const handler = handlers[method];
    if (!handler) {
      this.post(this.errorResponse(id, `NOT_IMPLEMENTED:${method}`));
      return;
    }
    try {
      assertCan(this.manifest, method);
      const result = await handler(params, { manifest: this.manifest });
      const response: RpcResponse = { type: 'rpc-response', id, ok: true, result };
      this.post(response);
    } catch (err) {
      const message =
        err instanceof PermissionDeniedError
          ? `PERMISSION_DENIED:${err.required}`
          : err instanceof NotImplementedError
            ? `NOT_IMPLEMENTED:${err.method}`
            : (err as Error).message;
      this.post(this.errorResponse(id, message));
      trace.error('plugin-router:rpc-error', { id: this.manifest.id, method, message });
    }
  }

  private onSubscribe(subId: string, event: string): void {
    if (this.subscriptions.has(subId)) {
      // Duplicate id — silently ignore (defensive against retry loops).
      return;
    }
    try {
      const dispose = openSubscription(event, (payload) => {
        const push: EventPush = { type: 'event', event, payload };
        this.post(push);
      });
      this.subscriptions.set(subId, dispose);
    } catch (e) {
      // Surface as a fake rpc-response on the subscribe id — the SDK
      // doesn't await subscribe (it's fire-and-forget), but we still
      // log so plugin authors see "Unknown subscription event 'foo'"
      // in the host console.
      trace.error('plugin-router:subscribe-failed', { event, error: String(e) });
    }
  }

  private onUnsubscribe(subId: string): void {
    const dispose = this.subscriptions.get(subId);
    if (!dispose) return;
    this.subscriptions.delete(subId);
    try { dispose(); } catch {/* ignore */}
  }

  private onClose(): void {
    this.detach();
  }

  private errorResponse(id: string, error: string): RpcResponse {
    return { type: 'rpc-response', id, ok: false, error };
  }
}
