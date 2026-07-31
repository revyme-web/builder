// plugins/PluginRuntimeWindow.tsx — global free-floating plugin window.
//
// Why this isn't a ToolPopup: ToolPopup uses a global single-popup
// registry (`globalCloseCallback`), so opening any other tool popup
// kicks the plugin out. Plugin runtime windows need to behave like
// independent floating windows — they stay open until the user
// explicitly closes them, regardless of what other panels / tool
// popups come and go in the rest of the editor.
//
// Mounted ONCE in App.tsx. Reads two atoms:
//   - `openPluginIdAtom`         → installed (Tier 1) plugin
//   - `launchedProjectPluginAtom` → in-project (Tier 2) plugin source
// At most one is non-null at a time (the row-click handlers clear
// the other before setting their own — see PluginsSection).
//
// Chrome: rounded dark window with a draggable header (title + ×).
// Position is local state, initialized to the right side of the
// viewport. Drag updates the local position. Closing the window
// = clearing whichever atom was set.

import { useEffect, useMemo, useRef, useState, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  openPluginIdAtom,
  launchedProjectPluginAtom,
  installedPluginsAtom,
  getInstalledPlugin,
  getPluginEntryUrl,
  installPluginFromUrl,
} from './registry';
import { readPluginSource, deriveTier2Manifest, TIER3_DEFAULT_PERMISSIONS } from '@/editor/plugin-editor/plugin-files';
import { bundlePluginToBlobUrl } from '@/editor/plugin-editor/plugin-bundler';
import PluginIframeBody from './PluginIframeBody';
import { getPluginSizeRequest, subscribePluginSizeRequests } from './sdk-impl/ui';
import {
  installedCloudPluginsAtom,
  launchedCloudPluginAtom,
} from './cloud-plugins';
import type { PluginManifest } from '@revyme/plugin-sdk';
import { trace } from '@/shared/debug-trace';

const DEFAULT_WIDTH = 320;

export default function PluginRuntimeWindow(props: { hidden?: boolean } = {}) {
  const hidden = props.hidden ?? false;
  const installedId = useAtomValue(openPluginIdAtom);
  const projectFilePath = useAtomValue(launchedProjectPluginAtom);
  const cloudId = useAtomValue(launchedCloudPluginAtom);
  const cloudPlugins = useAtomValue(installedCloudPluginsAtom);
  // Subscribe so a manifest re-fetch (installPluginFromUrl) re-renders us with
  // the fresh entry (new installedAt + updated permissions/size).
  const installedPlugins = useAtomValue(installedPluginsAtom);
  const setInstalledId = useSetAtom(openPluginIdAtom);
  const setProjectFilePath = useSetAtom(launchedProjectPluginAtom);
  const setCloudId = useSetAtom(launchedCloudPluginAtom);

  // Dev-plugin live refresh: each time a Tier-1 dev plugin OPENS, re-fetch its
  // manifest (cache-busted, in registry.installPluginFromUrl) so the author's
  // manifest edits — new permissions, panel size — apply on reopen WITHOUT a
  // manual remove + re-add. The re-fetch bumps `installedAt`, which is in the
  // Window key below, so the iframe also remounts and reloads fresh code.
  const refreshedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!installedId) { refreshedRef.current = null; return; } // reset so a reopen re-fetches
    if (refreshedRef.current === installedId) return;
    const p = getInstalledPlugin(installedId);
    if (!p) return;
    refreshedRef.current = installedId;
    installPluginFromUrl(p.url).catch(() => {});
  }, [installedId]);

  // Tier 3 — cloud plugin. Iframe `src` points directly at the
  // marketplace bundle URL; no local compilation. Wins over the other
  // tiers when set (PluginGrid clears any local launch before setting
  // a cloud one). Manifest is synthesized from the install record so
  // the runtime window still has a name, version, and default width.
  if (cloudId) {
    const cloud = cloudPlugins.find((p) => p.id === cloudId);
    if (!cloud) {
      // Stale id — clear it so we don't render an empty window forever.
      setCloudId(null);
      return null;
    }
    // Cloud-installed plugins are granted the full SDK permission set
    // by default — installing from the marketplace is the user's
    // explicit consent (mirrors how Tier 2 plugins, also user-authored,
    // get full access). When per-plugin permission prompts ship, this
    // becomes the SUPERSET, and the install dialog narrows it based on
    // what the plugin's manifest declares.
    const manifest: PluginManifest = {
      id: `cloud.${cloud.id}`,
      name: cloud.name,
      version: cloud.version,
      entry: cloud.bundleUrl,
      sdkVersion: '^1.0.0',
      mode: 'panel',
      permissions: TIER3_DEFAULT_PERMISSIONS as PluginManifest['permissions'],
    };
    return (
      <Window
        key={`cloud.${cloud.id}@${cloud.version}`}
        manifest={manifest}
        srcUrl={cloud.bundleUrl}
        onClose={() => setCloudId(null)}
        hidden={hidden}
      />
    );
  }

  // Tier 2 — in-project plugin source. Build a fresh blob URL on
  // mount + revoke on unmount.
  if (projectFilePath) {
    return (
      <Tier2Window
        key={projectFilePath}
        filePath={projectFilePath}
        onClose={() => setProjectFilePath(null)}
        hidden={hidden}
      />
    );
  }

  // Tier 1 — installed plugin via dev URL. Read from the reactive list so a
  // manifest re-fetch re-renders with the fresh entry.
  if (installedId) {
    const plugin = installedPlugins.find((p) => p.manifest.id === installedId);
    if (!plugin) {
      // Stale id — clear it so we don't render an empty window forever.
      setInstalledId(null);
      return null;
    }
    return (
      <Window
        // installedAt in the key → a manifest re-fetch (which bumps it)
        // remounts the window so the iframe reloads the author's latest code.
        key={`${plugin.manifest.id}@${plugin.installedAt}`}
        manifest={plugin.manifest}
        srcUrl={`${getPluginEntryUrl(plugin)}?t=${plugin.installedAt}`}
        onClose={() => setInstalledId(null)}
        hidden={hidden}
      />
    );
  }

  return null;
}

// ─── Tier 2 mount — bundle plugin source on demand ────────────────────────

function Tier2Window({ filePath, onClose, hidden = false }: { filePath: string; onClose: () => void; hidden?: boolean }) {
  const manifest = useMemo(() => deriveTier2Manifest(filePath), [filePath]);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    try {
      const source = readPluginSource(filePath);
      if (!source) {
        setError(`Plugin source missing: ${filePath}`);
        return;
      }
      url = bundlePluginToBlobUrl(source, {
        pluginId: manifest.id,
        pluginName: manifest.name,
      });
      setBlobUrl(url);
      trace.action('plugin-runtime:tier2-launch', { filePath });
    } catch (e) {
      setError(`Bundle error: ${(e as Error).message}`);
      trace.error('plugin-runtime:tier2-bundle-failed', { filePath, error: String(e) });
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [filePath, manifest.id, manifest.name]);

  if (error) {
    return (
      <Window manifest={manifest} srcUrl={null} error={error} onClose={onClose} hidden={hidden} />
    );
  }
  if (!blobUrl) return null;
  return <Window manifest={manifest} srcUrl={blobUrl} onClose={onClose} hidden={hidden} />;
}

// ─── Free-floating window ─────────────────────────────────────────────────

interface WindowProps {
  manifest: PluginManifest;
  srcUrl: string | null;
  error?: string;
  onClose: () => void;
  hidden?: boolean;
}

function Window({ manifest, srcUrl, error, onClose, hidden = false }: WindowProps) {
  // Position: default to the right side of the viewport, just below
  // the editor header. State so the user can drag it; persisted only
  // for the current session (closing + reopening resets to default).
  // Width: starts from manifest default; the plugin can call
  // `revyme.ui.resize({ width, height })` at runtime to request a
  // different size — we subscribe to the size-request registry from
  // sdk-impl/ui.ts and re-render when our plugin's id is updated.
  const [sizeRequest, setSizeRequest] = useState(() => getPluginSizeRequest(manifest.id));
  useEffect(() => {
    setSizeRequest(getPluginSizeRequest(manifest.id));
    return subscribePluginSizeRequests((id) => {
      if (id === manifest.id) setSizeRequest(getPluginSizeRequest(manifest.id));
    });
  }, [manifest.id]);

  const width = sizeRequest?.width ?? manifest.ui?.defaultWidth ?? DEFAULT_WIDTH;
  const [pos, setPos] = useState(() => ({
    x: typeof window !== 'undefined' ? window.innerWidth - width - 24 : 200,
    y: 80,
  }));

  // Keep the window fully on-screen when its width changes. A plugin can GROW
  // itself via ui.resize AFTER mount (e.g. 380 → 640), but the initial x was
  // computed from the old width, so the right edge overflowed the viewport.
  // Re-clamp x so pos.x + width always fits (also handles viewport resize).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPos((p) => {
      const maxX = Math.max(16, window.innerWidth - width - 16);
      const x = Math.min(Math.max(16, p.x), maxX);
      return x === p.x ? p : { ...p, x };
    });
  }, [width]);

  // Draggable header — same pattern ToolPopup uses, simplified:
  // pointerdown on header captures pointer, move updates pos, up
  // releases. We track via a ref so re-renders don't re-bind.
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const handleDragStart = useCallback((e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    };
    const onUp = () => {
      dragRef.current.dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pos.x, pos.y]);

  return createPortal(
    <div
      // High z-index so the window stays above tool popups, the
      // properties panel, and other floating UI. Lower than modal
      // backdrops (which are at 99999) so a true modal can still
      // cover this. Plugin runtime is always-on; modals are interrupts.
      className="fixed bg-[var(--bg-surface)] border border-[var(--border-light)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
      style={{
        left: pos.x,
        top: pos.y,
        width,
        zIndex: 99000,
        // Hidden (not unmounted) during preview mode — the iframe stays alive so
        // the plugin keeps its state and reappears exactly as it was on close.
        display: hidden ? 'none' : undefined,
      }}
    >
      <div
        onPointerDown={handleDragStart}
        className="flex items-center justify-between px-3 py-2 cursor-grab active:cursor-grabbing select-none border-b border-[var(--border-light)]"
      >
        <span className="text-xs font-bold text-[var(--text-primary)] truncate flex-1">{manifest.name}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close plugin"
          className="p-0.5 ml-2 rounded transition-colors text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {error ? (
        <div className="p-3 text-[#ff7474] text-[11px] font-mono whitespace-pre-wrap">{error}</div>
      ) : srcUrl ? (
        <PluginIframeBody manifest={manifest} srcUrl={srcUrl} />
      ) : null}
    </div>,
    document.body,
  );
}
