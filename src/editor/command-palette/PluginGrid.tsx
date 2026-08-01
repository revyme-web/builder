// PluginGrid.tsx — Grid of plugin cards inside the cmd+K palette.
//
// Ported pixel-perfect from builder/`PluginSearchResults.tsx`. Differences:
//  - Revyme plugins are iframe-mounted (not Function-eval'd), so the
//    "open" handler delegates to atoms that PluginRuntimeWindow listens to
//  - paid/owned fields are dropped — Revyme MVP is free-only
//  - filter dropdown is dropped for now (no free/paid distinction)

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { paletteQueryAtom, paletteOpenAtom } from '@/code/stores/palette-store';
import {
  fetchMarketplacePlugins,
  fetchPluginByIdOrDraft,
  parsePluginUrl,
  type MarketplacePlugin,
} from './marketplace-client';
import {
  installCloudPlugin,
  launchedCloudPluginAtom,
} from '@/plugins/cloud-plugins';
import { openPluginIdAtom, launchedProjectPluginAtom } from '@/plugins/registry';
import { trace } from '@/shared/debug-trace';

interface PluginCardProps {
  plugin: MarketplacePlugin;
  onClick: () => void;
  loading?: boolean;
}

function PluginCard({ plugin, onClick, loading }: PluginCardProps) {
  const thumbnail = plugin.galleryUrls?.[0] || plugin.thumbnailUrl || plugin.iconUrl;
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="group relative rounded-lg overflow-hidden p-2 flex flex-col gap-2 bg-black/[0.03] dark:bg-white/[0.03] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors disabled:opacity-60"
      title={plugin.description || plugin.name}
    >
      <div className="relative w-full aspect-[16/10] rounded-md overflow-hidden bg-[var(--bg-tertiary)] flex items-center justify-center">
        {thumbnail ? (
          <img src={thumbnail} alt={plugin.name} className="w-full h-full object-cover" />
        ) : (
          <PuzzleIcon className="w-5 h-5 text-[var(--text-tertiary)]" />
        )}
      </div>
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1 min-w-0">
          {loading && <SpinnerIcon className="w-3 h-3 text-[var(--text-tertiary)] animate-spin shrink-0" />}
          <span className="text-[10px] text-[var(--text-secondary)] truncate text-left">
            {plugin.name}
          </span>
        </div>
      </div>
    </button>
  );
}

export function PluginGrid() {
  const query = useAtomValue(paletteQueryAtom);
  const setPaletteOpen = useSetAtom(paletteOpenAtom);
  const setLaunchedCloud = useSetAtom(launchedCloudPluginAtom);
  const setOpenPluginId = useSetAtom(openPluginIdAtom);
  const setLaunchedProject = useSetAtom(launchedProjectPluginAtom);
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingPluginId, setLoadingPluginId] = useState<string | null>(null);
  // When the query is a pasteable plugin URL, we fetch the single
  // plugin it points at and offer an "Install from URL" card above
  // the marketplace results. Null = query isn't a URL.
  const [urlPreview, setUrlPreview] = useState<MarketplacePlugin | null>(null);
  const [urlPreviewLoading, setUrlPreviewLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastQueryRef = useRef('');

  const fetchPlugins = useCallback(async (search?: string) => {
    setIsLoading(true);
    try {
      const results = await fetchMarketplacePlugins(search, 30);
      setPlugins(results);
    } catch {
      setPlugins([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  useEffect(() => {
    if (query === lastQueryRef.current) return;
    lastQueryRef.current = query;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // URL paste — fetch the single plugin and show as preview row.
    // Skips the marketplace search since the user already knows what
    // they want (they pasted a URL).
    const parsed = parsePluginUrl(query);
    if (parsed) {
      setUrlPreviewLoading(true);
      fetchPluginByIdOrDraft(parsed.id, parsed.kind).then((p) => {
        setUrlPreview(p);
        setUrlPreviewLoading(false);
      });
      return;
    }
    setUrlPreview(null);
    setUrlPreviewLoading(false);

    if (query.trim().length < 2) {
      fetchPlugins();
      return;
    }
    debounceRef.current = setTimeout(() => fetchPlugins(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchPlugins]);

  // Click a card → install the plugin pointer into this project and
  // immediately launch the cloud iframe. Closes the palette. If the
  // plugin is already installed this just re-launches the existing
  // pointer (the install call is idempotent — same id replaces the
  // existing row). "Import locally" for open plugins lives in the
  // LibraryPanel right-click menu, not here.
  const handleClick = async (plugin: MarketplacePlugin) => {
    setLoadingPluginId(plugin.id);
    try {
      installCloudPlugin({
        id: plugin.id,
        name: plugin.name,
        slug: plugin.slug,
        bundleUrl: plugin.bundleUrl,
        sourceUrl: plugin.sourceUrl,
        sourceKind: plugin.sourceKind,
        version: plugin.version,
        visibility: plugin.visibility,
        iconUrl: plugin.iconUrl,
        author: plugin.author,
      });
      // Clear any other launched plugin window so they don't fight
      // over the singleton runtime window slot.
      setOpenPluginId(null);
      setLaunchedProject(null);
      setLaunchedCloud(plugin.id);
      setPaletteOpen(false);
      trace.action('palette:plugin-launch', { id: plugin.id, name: plugin.name });
    } finally {
      setLoadingPluginId(null);
    }
  };

  // URL paste — show a single tall row with the resolved plugin info
  // + install button. Wins over both the loading skeleton and the
  // empty-state placeholder. If the URL was malformed or the plugin
  // not found, show a not-found message instead of falling through.
  if (parsePluginUrl(query)) {
    return (
      <div className="px-3 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
          Install from URL
        </div>
        {urlPreviewLoading ? (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-black/[0.03] dark:bg-white/[0.03]">
            <SpinnerIcon className="w-4 h-4 text-[var(--text-tertiary)] animate-spin" />
            <span className="text-[11px] text-[var(--text-secondary)]">Fetching plugin...</span>
          </div>
        ) : urlPreview ? (
          <button
            onClick={() => handleClick(urlPreview)}
            disabled={loadingPluginId === urlPreview.id}
            className="w-full flex items-center gap-3 p-3 rounded-lg bg-black/[0.03] dark:bg-white/[0.03] hover:bg-black/[0.06] dark:hover:bg-white/[0.06] transition-colors text-left"
          >
            <div className="w-12 h-12 rounded-md overflow-hidden bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0">
              {urlPreview.thumbnailUrl ? (
                <img src={urlPreview.thumbnailUrl} alt={urlPreview.name} className="w-full h-full object-cover" />
              ) : (
                <PuzzleIcon className="w-5 h-5 text-[var(--text-tertiary)]" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--text-primary)] font-medium truncate">{urlPreview.name}</div>
              {urlPreview.description && (
                <div className="text-[10px] text-[var(--text-tertiary)] line-clamp-1">{urlPreview.description}</div>
              )}
              <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">
                v{urlPreview.version} · {urlPreview.visibility === 'open' ? 'Open source' : 'Closed source'}
              </div>
            </div>
            <div className="text-[10px] text-[var(--accent-fg)] bg-[var(--accent)] px-2 py-1 rounded shrink-0">
              {loadingPluginId === urlPreview.id ? '...' : 'Install'}
            </div>
          </button>
        ) : (
          <div className="py-6 text-center">
            <p className="text-xs text-[var(--text-secondary)]">Plugin not found at that URL</p>
            <p className="text-[10px] text-[var(--text-tertiary)] mt-1">Check the link and try again</p>
          </div>
        )}
      </div>
    );
  }

  if (isLoading && plugins.length === 0) {
    return (
      <div className="px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
            Plugins
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col gap-1.5 bg-black/[0.03] dark:bg-white/[0.03] rounded-lg p-2">
              <div className="w-full aspect-[16/10] rounded-md bg-black/[0.05] dark:bg-white/[0.05] animate-pulse" />
              <div className="h-3 w-3/4 rounded bg-black/[0.05] dark:bg-white/[0.05] animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div className="py-8 text-center">
        <PuzzleIcon className="w-6 h-6 text-[var(--text-tertiary)] mx-auto mb-2" />
        <p className="text-xs text-[var(--text-secondary)]">No plugins found</p>
        <p className="text-[10px] text-[var(--text-tertiary)] mt-1">Marketplace coming soon</p>
      </div>
    );
  }

  return (
    <div className="px-3 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          Plugins
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            loading={loadingPluginId === plugin.id}
            onClick={() => handleClick(plugin)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Local icons (lucide-react isn't in Revyme deps) ────────────────

function PuzzleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02z"/>
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
