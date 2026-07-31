// plugins/sdk-impl/ui.ts — ui.* namespace (window controls + notifications).
//
// `show`, `hide`, `resize` are mostly observed by `PluginIframeBody`
// (which auto-sizes via ResizeObserver on the iframe content), so
// these are no-ops on the host side — accepted so plugins don't
// crash, ignored so plugin authors don't have to remove the calls.
// When per-plugin window resizing UI lands, these handlers wire to
// it.
//
// `closePlugin` is the only mutation here — it clears both
// installed-plugin and Tier 2 launched-plugin atoms, which causes
// the popup host to unmount.

import { getDefaultStore } from 'jotai';
import { launchedProjectPluginAtom, openPluginIdAtom } from '@/plugins/registry';
import type { RpcHandler } from '../plugin-types';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

export const uiHandlers: Record<string, RpcHandler> = {
  'ui.show': async () => {},
  'ui.hide': async () => {},
  'ui.resize': async (params, ctx) => {
    const p = params as { width?: unknown; height?: unknown };
    const width = typeof p?.width === 'number' && p.width > 0 ? Math.round(p.width) : null;
    const height = typeof p?.height === 'number' && p.height > 0 ? Math.round(p.height) : null;
    if (width == null && height == null) return;
    // MERGE, don't replace — width and height are independent axes. The SDK
    // auto-reports height-only on every layout change (create-plugin.ts
    // reportHeight); a plugin that once set an explicit width via
    // ui.resize({ width }) must keep it across those height-only reports.
    // Replacing here wiped the width back to null → the panel snapped to
    // defaultWidth on the next height tick.
    const prev = pluginSizeRequests.get(ctx.manifest.id);
    pluginSizeRequests.set(ctx.manifest.id, {
      width: width ?? prev?.width ?? null,
      height: height ?? prev?.height ?? null,
    });
    // Notify any subscribed PluginRuntimeWindow instance.
    for (const cb of sizeListeners) cb(ctx.manifest.id);
    trace.action('plugin:ui.resize', { id: ctx.manifest.id, width, height });
  },

  'ui.notify': async (params) => {
    const p = params as { message?: unknown; level?: unknown };
    if (typeof p?.message === 'string') {
       
      console.log(`[plugin notify ${p.level ?? 'info'}]`, p.message);
    }
  },

  'ui.closePlugin': async (_params, ctx): Promise<void> => {
    store.set(openPluginIdAtom, null);
    store.set(launchedProjectPluginAtom, null);
    trace.action('plugin:ui.closePlugin', { id: ctx.manifest.id });
  },

  /**
   * Background message — shown in the editor's toast area while the
   * plugin's window is hidden. Pass 2 ships a stub that traces the
   * value but doesn't render it; when the host's plugin-status
   * surface lands, this displays. Plugins can rely on the call
   * succeeding without crashing.
   */
  'ui.setBackgroundMessage': async (params, ctx) => {
    const p = params as { message?: unknown };
    trace.action('plugin:ui.setBackgroundMessage', { id: ctx.manifest.id, message: p?.message });
  },

  /**
   * Close-confirmation. Stored on a per-plugin module-scoped map
   * so the popup host can read it before unmounting. Pass 2: we
   * store the warning; the actual modal-on-close requires the
   * popup host to read this map, deferred to when needed.
   */
  'ui.setCloseWarning': async (params, ctx) => {
    const p = params as { message?: unknown };
    if (p?.message === null) {
      closeWarnings.delete(ctx.manifest.id);
    } else if (typeof p?.message === 'string') {
      closeWarnings.set(ctx.manifest.id, p.message);
    } else {
      throw new Error('ui.setCloseWarning: message must be string or null');
    }
  },

  /**
   * Top-level menu registration. Stored on a module-scoped map keyed
   * by plugin id. The host's menu-bar component reads this map and
   * renders entries when it grows that integration. For Pass 2 the
   * call succeeds and the entries are accessible via `getRegisteredMenus`
   * (used by future host-UI work).
   */
  'ui.setMenu': async (params, ctx) => {
    const p = params as { items?: unknown };
    if (!Array.isArray(p?.items)) throw new Error('ui.setMenu: items[] required');
    registeredMenus.set(ctx.manifest.id, p.items);
  },

  /**
   * Show a context menu at a given screen position. The host renders
   * the menu via the existing DropdownMenu component, anchored at the
   * cursor coords. Resolves with the chosen item's id, or null if
   * dismissed.
   */
  'ui.showContextMenu': async (params): Promise<string | null> => {
    const p = params as {
      items?: Array<{ id: string; label: string; disabled?: boolean }>;
      pos?: { x: number; y: number };
    };
    if (!Array.isArray(p?.items) || !p?.pos) {
      throw new Error('ui.showContextMenu: items[] + pos required');
    }
    return new Promise<string | null>((resolve) => {
      const handler = (chosenId: string | null) => resolve(chosenId);
      // Dispatch on a custom event the editor listens for. The host's
      // PluginContextMenuHost component subscribes to this event,
      // renders the menu, and calls back via the resolver.
      window.dispatchEvent(new CustomEvent('plugin-context-menu', {
        detail: { items: p.items, pos: p.pos, resolve: handler },
      }));
      // Fallback timeout — if no host component handles the event,
      // resolve with null after 50ms so plugins don't hang forever.
      setTimeout(() => resolve(null), 50);
    });
  },
};

/** Per-plugin close-warning messages. Read by the popup host on close. */
const closeWarnings = new Map<string, string>();

/** Per-plugin registered top-level menus. Read by the editor's menu bar. */
const registeredMenus = new Map<string, unknown[]>();

/**
 * Per-plugin desired window size, written by `ui.resize`. Plain module
 * map (not an atom) because the runtime window subscribes via a tiny
 * listener registry below — keeps this file Jotai-free and lets the
 * Window component pick up size changes without depending on a specific
 * atom store. `width`/`height` are independent (a plugin may request
 * just one).
 */
const pluginSizeRequests = new Map<string, { width: number | null; height: number | null }>();

/** Subscribers — Window instances register on mount, get called with the plugin id whose size changed. */
const sizeListeners = new Set<(pluginId: string) => void>();
function getRegisteredMenus(): Map<string, unknown[]> {
  return registeredMenus;
}

/** Read the plugin's most recent `ui.resize` request, or null if none. */
export function getPluginSizeRequest(pluginId: string): { width: number | null; height: number | null } | null {
  return pluginSizeRequests.get(pluginId) ?? null;
}

/** Subscribe to size-request changes. Returns an unsubscribe function. */
export function subscribePluginSizeRequests(cb: (pluginId: string) => void): () => void {
  sizeListeners.add(cb);
  return () => sizeListeners.delete(cb);
}
