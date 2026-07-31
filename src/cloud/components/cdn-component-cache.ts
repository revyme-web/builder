// cdn-component-cache.ts — Module-level cache for CDN-hosted components.
//
// Stores LOADED React components (the result of `await import(url)`) keyed
// by URL. The CDN URL points at a compiled ESM JS bundle (produced by the
// backend's `/api/components/share`); we dynamic-import it once, cache the
// module's default export, and reuse it on every subsequent render of an
// instance with the same URL.
//
// Earlier version of this file cached TSX source text and ran in-browser
// Babel compilation per render — replaced because (a) the backend now
// ships pre-compiled JS, (b) dynamic import is ~10× faster than fetch +
// Babel.transform, and (c) the same URL works in any external React
// project (Next.js / Vite / etc.) without any compilation step.

import type { ComponentType } from 'react';
import { trace } from '@/shared/debug-trace';

const _components = new Map<string, ComponentType<unknown>>();
const _pending = new Map<string, Promise<ComponentType<unknown> | null>>();

/** Get a previously-loaded component, or null if not yet loaded. */
export function getCdnComponent(url: string): ComponentType<unknown> | null {
  return _components.get(url) ?? null;
}

/** Trigger an async dynamic import. Resolves to the component or null on
 *  failure. Subsequent calls return the same promise (deduped). Fires
 *  the `revyme:cdn-component-loaded` window event on success so renderers
 *  can re-render and pick up the now-available component. */
export function loadCdnComponent(url: string): Promise<ComponentType<unknown> | null> {
  if (_components.has(url)) return Promise.resolve(_components.get(url)!);
  const existing = _pending.get(url);
  if (existing) return existing;

  trace.action('cdn-component:load-start', { url });
  // `@vite-ignore` tells Vite not to try to pre-bundle the dynamic URL
  // at build time — the URL only resolves at runtime.
  const promise = import(/* @vite-ignore */ url)
    .then((mod) => {
      _pending.delete(url);
      const Component = (mod && (mod.default ?? mod)) as ComponentType<unknown> | undefined;
      if (typeof Component !== 'function' && (typeof Component !== 'object' || Component === null)) {
        trace.error('cdn-component:no-default-export', { url });
        return null;
      }
      _components.set(url, Component);
      trace.action('cdn-component:load-success', { url });
      window.dispatchEvent(new CustomEvent('revyme:cdn-component-loaded'));
      return Component;
    })
    .catch((err) => {
      _pending.delete(url);
      trace.error('cdn-component:load-error', { url, error: String(err) });
      return null;
    });
  _pending.set(url, promise);
  return promise;
}

/** True while a load is in flight for the given URL. */
export function isCdnComponentPending(url: string): boolean {
  return _pending.has(url);
}

/** All cached components — used by component-registry to scan for
 *  prop signatures of CDN-loaded components when populating the
 *  ComponentPropsTool. */
export function getAllCdnComponents(): Map<string, ComponentType<unknown>> {
  return _components;
}
