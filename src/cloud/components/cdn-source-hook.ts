// cdn-source-hook.ts — Fetch + cache the original TSX source for a
// CDN-linked component instance, so panels (ComponentPropsTool, etc.)
// can extract variants / prop signatures / display name the same way
// they do for local components.
//
// The bundle hash is parsed out of the URL — `assets.revyme.app/
// components/<Name>@<hash>.js` → `<hash>`. We fetch from
// `/api/components/source?hash=<hash>` (the auth-gated source endpoint
// used by Unlink) and stash the TSX in a Jotai atom keyed by URL.
// Subsequent lookups for the same URL hit the cache instantly.
//
// Loading state is tracked separately so concurrent calls for the same
// URL coalesce into one network request, and the hook can return the
// cached value AND a "loading" flag without thrashing.

import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { trace } from '@/shared/debug-trace';

const cdnSourceCacheAtom = atom<Map<string, string>>(new Map<string, string>());
const cdnSourceLoadingAtom = atom<Set<string>>(new Set<string>());

export interface CdnSourceState {
  source: string | null;
  loading: boolean;
}

/**
 * Fetch the TSX source for a CDN-linked component URL. Returns the
 * cached source or null while loading. Pass null/undefined to skip.
 */
export function useCdnSource(url: string | null | undefined): CdnSourceState {
  const cache = useAtomValue(cdnSourceCacheAtom);
  const setCache = useSetAtom(cdnSourceCacheAtom);
  const loading = useAtomValue(cdnSourceLoadingAtom);
  const setLoading = useSetAtom(cdnSourceLoadingAtom);

  useEffect(() => {
    if (!url) return;
    if (cache.has(url)) return;
    if (loading.has(url)) return;

    const hashMatch = url.match(/@([a-f0-9]+)\.(?:js|tsx)$/);
    if (!hashMatch) {
      trace.error('cdn-source-hook:bad-url', { url });
      return;
    }
    const hash = hashMatch[1];

    setLoading((prev: Set<string>) => {
      const next = new Set(prev);
      next.add(url);
      return next;
    });
    trace.action('cdn-source-hook:fetch-start', { url, hash });

    fetch(`/api/components/source?hash=${encodeURIComponent(hash)}`, {
      credentials: 'include',
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(text => {
        setCache((prev: Map<string, string>) => {
          const next = new Map(prev);
          next.set(url, text);
          return next;
        });
        trace.action('cdn-source-hook:fetched', { url, size: text.length });
      })
      .catch(err => {
        trace.error('cdn-source-hook:fetch-failed', { url, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        setLoading((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(url);
          return next;
        });
      });
  }, [url, cache, loading, setCache, setLoading]);

  if (!url) return { source: null, loading: false };
  return {
    source: cache.get(url) ?? null,
    loading: loading.has(url),
  };
}
