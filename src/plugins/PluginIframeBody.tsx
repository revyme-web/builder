// plugins/PluginIframeBody.tsx — sandboxed iframe + router attach + content auto-size.
//
// Renders just the plugin's iframe (no chrome, no positioning). Lives
// inside whatever shell the caller picks — `ToolPopup` for Library
// rows, a full editor pane for the in-browser plugin editor's preview,
// or a future floating window for `mode: 'floating'` plugins.
//
// AUTO-SIZING. Iframes are replaced elements — they don't shrink to
// content like a div would. To make the popup fit the plugin's actual
// height, we read `iframe.contentDocument.documentElement.scrollHeight`
// after each render in the iframe and apply that to `iframe.style.height`.
// A `ResizeObserver` on the iframe's documentElement keeps it in sync
// as the plugin re-renders. Works because `allow-same-origin` lets us
// reach into the iframe's document. ToolPopup's outer ResizeObserver
// then picks up the iframe size change and the popup container itself
// shrinks/grows. Result: the popup is exactly as tall as the plugin
// content — no empty void below the cards.
//
// Width stays fixed (caller's `width` prop) because ToolPopup is a
// fixed-width component. Plugins can request a different width via
// the manifest's `ui.defaultWidth`; future passes will let plugins
// resize at runtime via `revyme.ui.resize({ width, height })`.
//
// Owns:
//   - The iframe element (via ref).
//   - A `PluginRouter` attached on mount, detached on unmount.
//   - A `ResizeObserver` on the iframe's documentElement.
//
// Iframe sandbox: `allow-scripts allow-same-origin allow-forms
// allow-popups`. `allow-same-origin` is required for the SDK's
// `window.parent` postMessage handshake (`e.source === window.parent`
// strict equality) AND for the auto-size path here. `allow-top-navigation`
// is intentionally omitted so a plugin can't navigate the editor away.

import { useEffect, useMemo, useRef, useState } from 'react';
import { PluginRouter } from './router';
import { getPluginSizeRequest, subscribePluginSizeRequests } from './sdk-impl/ui';
import type { PluginManifest } from '@revyme/plugin-sdk';
import { trace } from '@/shared/debug-trace';

interface PluginIframeBodyProps {
  manifest: PluginManifest;
  srcUrl: string;
  /** Min height while content is still loading / measuring. Default 80 px. */
  minHeight?: number;
  /** Hard cap so a runaway plugin doesn't push the popup off-screen.
   *  Iframe stays scrollable past this point. Default 600 px — fits
   *  comfortably below the row anchor on a typical 900-1080 px viewport. */
  maxHeight?: number;
}

const DEFAULT_PLUGIN_MIN_HEIGHT = 80;
// Bumped from 600 → 820 to fit plugins with hero previews + palettes +
// controls stacked (e.g. the gradient generator example). Still well
// short of a 900 px viewport so the popup never spills off-screen.
const DEFAULT_PLUGIN_MAX_HEIGHT = 820;

export default function PluginIframeBody({
  manifest, srcUrl,
  minHeight = DEFAULT_PLUGIN_MIN_HEIGHT,
  maxHeight = DEFAULT_PLUGIN_MAX_HEIGHT,
}: PluginIframeBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Measured content height — starts at minHeight so the iframe has
  // SOMETHING to render into during the first measurement cycle.
  // Updated via ResizeObserver below (same-origin) OR via the plugin's
  // own `ui.resize` calls (cross-origin path, used by cloud plugins
  // loaded from R2 where contentDocument is unreachable from the host).
  // Clamped to [minHeight, maxHeight] in either case.
  const [contentHeight, setContentHeight] = useState<number>(minHeight);

  // Subscribe to size requests for this plugin id — the SDK runtime
  // inside every plugin iframe auto-reports its content height via
  // `ui.resize` (see plugin-sdk-runtime.ts). For cross-origin cloud
  // plugins this is the ONLY way to size them correctly. For local
  // (blob URL) plugins it's redundant with the ResizeObserver below
  // but cheap, and lets the two paths converge to the same number.
  useEffect(() => {
    const apply = () => {
      const req = getPluginSizeRequest(manifest.id);
      if (req?.height) {
        const clamped = Math.min(maxHeight, Math.max(minHeight, req.height));
        setContentHeight(clamped);
      }
    };
    apply();
    return subscribePluginSizeRequests((id) => {
      if (id === manifest.id) apply();
    });
  }, [manifest.id, minHeight, maxHeight]);

  // Memoized router — created once per (id, version). When the popup
  // is closed and reopened, the parent unmounts this component and
  // we get a fresh router on remount.
  const router = useMemo(() => new PluginRouter(manifest), [manifest]);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    router.attach(el);
    trace.action('plugin-iframe-body:attach', { id: manifest.id });
    return () => {
      router.detach();
      trace.action('plugin-iframe-body:detach', { id: manifest.id });
    };
  }, [manifest.id, router]);

  // Auto-size: observe the iframe's documentElement and update height.
  // Re-runs when the iframe URL changes (a fresh load = fresh
  // contentDocument). A defensive check around contentDocument access
  // because cross-origin loading (shouldn't happen but if a plugin's
  // sandbox is later tightened) would throw a SecurityError.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    const measureNow = () => {
      try {
        const doc = el.contentDocument;
        if (!doc) return;
        // Use documentElement.scrollHeight (full content extent),
        // NOT body.scrollHeight — body sometimes reports 0 when its
        // children are absolutely positioned with no flow content.
        const h = doc.documentElement.scrollHeight;
        if (cancelled) return;
        if (h > 0) {
          const clamped = Math.min(maxHeight, Math.max(minHeight, h));
          setContentHeight(clamped);
        }
      } catch (err) {
        // Cross-origin or torn-down doc — ignore. Iframe will keep
        // last known height; user can close + reopen if it gets stuck.
        trace.error('plugin-iframe-body:measure-failed', { error: String(err) });
      }
    };

    const onLoad = () => {
      // First measurement after the iframe finishes loading. Use
      // requestAnimationFrame so React inside the iframe has had a
      // chance to commit before we measure — without it, the first
      // measure often catches the empty `<div id="root"></div>`
      // before React mounts and the popup snaps to full height
      // ~one frame later.
      requestAnimationFrame(() => {
        measureNow();
        try {
          const doc = el.contentDocument;
          if (!doc || cancelled) return;
          observer = new ResizeObserver(() => measureNow());
          observer.observe(doc.documentElement);
        } catch (err) {
          trace.error('plugin-iframe-body:observe-failed', { error: String(err) });
        }
      });
    };

    // The iframe may already be loaded by the time this effect runs
    // (browsers fire `load` before our useEffect commits when the src
    // is a blob URL). Cover both cases: hook future loads AND check
    // readiness now.
    el.addEventListener('load', onLoad);
    if (el.contentDocument?.readyState === 'complete') onLoad();

    return () => {
      cancelled = true;
      el.removeEventListener('load', onLoad);
      if (observer) observer.disconnect();
    };
  }, [srcUrl, minHeight, maxHeight]);

  return (
    <iframe
      ref={iframeRef}
      src={srcUrl}
      title={manifest.name}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      // Let plugins use navigator.clipboard.writeText (e.g. "Copy CSS"); the
      // cross-origin iframe otherwise blocks it without this permission policy.
      allow="clipboard-write"
      style={{
        // Width: fill whatever container the caller put us in.
        // ToolPopup wraps children in `px-3` (12 px each side) so the
        // iframe naturally sits inside that padding. Hard-coding a
        // pixel width here would either clip on the right (when too
        // wide) or leave a gap (when too narrow) — `100%` is robust
        // to ToolPopup's internal layout choices.
        width: '100%',
        height: contentHeight,
        border: 'none',
        background: 'transparent',
        display: 'block',
      }}
    />
  );
}
