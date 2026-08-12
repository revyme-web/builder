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
//
// FAILURES ARE CACHED TOO, and that is load-bearing (mirrors
// `cdn-metadata-hook.ts`). `/source` answers 403 for a CLOSED-SOURCE
// marketplace listing — a permanent, correct "no" that no amount of
// retrying will turn into a yes. Caching only successes meant
// `cache.has(url)` stayed false forever while the effect's own writes to
// the `loading` atom re-triggered it, so a single closed-source instance
// on the page re-fetched without bound: hundreds of 403s per second in
// the console and against production. Two rules keep that shut:
//   1. Every outcome writes a cache entry — `'forbidden'` / `'missing'`
//      are terminal, `'error'` retries after a backoff window.
//   2. The effect depends ONLY on `url` and reads its guards straight
//      from the store, so mutating cache/loading can't re-enter it.

import { atom, getDefaultStore, useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { trace } from '@/shared/debug-trace';

/** Cache entry: the TSX, or why it isn't available.
 *  - `'forbidden'` — closed-source listing (403). Terminal: the server will
 *    never hand this caller the code, so it must never be retried.
 *  - `'missing'`   — no source row for this hash (404). Terminal.
 *  - `'error'`     — network / 5xx. Transient, retried after the backoff. */
export type CdnSourceCacheEntry = string | 'forbidden' | 'missing' | 'error';

const cdnSourceCacheAtom = atom<Map<string, CdnSourceCacheEntry>>(
  new Map<string, CdnSourceCacheEntry>(),
);
const cdnSourceLoadingAtom = atom<Set<string>>(new Set<string>());

/** Last transient-failure time per URL — one retry per window, so a flapping
 *  endpoint can't be hot-looped by a re-rendering panel. */
const lastErrorAt = new Map<string, number>();
const ERROR_RETRY_MS = 30_000;

const isTerminal = (e: CdnSourceCacheEntry | undefined): boolean =>
  e !== undefined && e !== 'error';

export interface CdnSourceState {
  source: string | null;
  loading: boolean;
  /** True when the source is known to be unavailable — closed source or no
   *  such hash. Lets consumers render "not available" instead of a spinner
   *  that would otherwise never resolve. */
  unavailable: boolean;
  /** True specifically for a closed-source listing (403). */
  closedSource: boolean;
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
    // Guards read from the STORE, not from the subscribed values above: the
    // effect writes both atoms, and depending on them here is what turned a
    // permanent 403 into an unbounded refetch loop.
    const store = getDefaultStore();
    const cached = store.get(cdnSourceCacheAtom).get(url);
    if (isTerminal(cached)) return;
    if (cached === 'error' && Date.now() - (lastErrorAt.get(url) ?? 0) < ERROR_RETRY_MS) return;
    if (store.get(cdnSourceLoadingAtom).has(url)) return;

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

    (async () => {
      let result: CdnSourceCacheEntry;
      try {
        const r = await fetch(`/api/components/source?hash=${encodeURIComponent(hash)}`, {
          credentials: 'include',
        });
        if (r.status === 403) {
          // Closed source — the intended answer, not a fault. Cache and stop.
          result = 'forbidden';
          trace.action('cdn-source-hook:closed-source', { url });
        } else if (r.status === 404) {
          result = 'missing';
          trace.action('cdn-source-hook:missing', { url });
        } else if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        } else {
          result = await r.text();
          trace.action('cdn-source-hook:fetched', { url, size: result.length });
        }
      } catch (err) {
        result = 'error';
        lastErrorAt.set(url, Date.now());
        trace.error('cdn-source-hook:fetch-failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      setCache((prev: Map<string, CdnSourceCacheEntry>) => {
        const next = new Map(prev);
        next.set(url, result);
        return next;
      });
      setLoading((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    })();
  }, [url, setCache, setLoading]);

  if (!url) return { source: null, loading: false, unavailable: false, closedSource: false };
  const entry = cache.get(url);
  const resolved = typeof entry === 'string' && entry !== 'forbidden' && entry !== 'missing' && entry !== 'error';
  return {
    source: resolved ? (entry as string) : null,
    loading: loading.has(url),
    unavailable: entry === 'forbidden' || entry === 'missing',
    closedSource: entry === 'forbidden',
  };
}
