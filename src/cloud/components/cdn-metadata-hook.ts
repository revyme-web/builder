// cdn-metadata-hook.ts — Fetch + cache the "who shared this" metadata
// for a CDN-linked component URL. Used by the Library panel to group
// imported components under the original creator's name (standard
// `Components → Project / <Creator> / <Creator2> / …` sub-folders) and
// by LinkedComponentModal to gate Unlink on `closedSource`.
//
// Backend endpoint: GET /api/components/metadata?hash=<hash> (public).
// Returns `{ hash, name, creator: { id, name, avatar } | null, createdAt }`.
//
// One Jotai atom keyed by URL caches everything; concurrent loads of
// the same URL coalesce into one request via a separate `loading` set
// (same shape as `cdn-source-hook.ts`). A fetch FAILURE caches the
// `'error'` sentinel so consumers can resolve their pending state
// (LinkedComponentModal fails-open to the Unlink buttons — the server
// still enforces closed-source on the actual unlink); the next
// `ensure` call for that URL retries.

import { atom, getDefaultStore, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { stableNodesAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

interface CdnComponentCreator {
  id: string;
  name: string | null;
  avatar: string | null;
}

export interface CdnComponentMetadata {
  hash: string;
  name: string;
  creator: CdnComponentCreator | null;
  createdAt: string;
  /** True when the marketplace listing hides this component's code from the
   *  CALLER (closed source) — Unlink / import-to-local is unavailable. */
  closedSource?: boolean;
  /** Canvas insert size from the creator's `@defaultWidth`/`@defaultHeight`
   *  annotations (server-parsed — available for closed source too). Null per
   *  axis when the component doesn't declare one. */
  defaultWidth?: number | null;
  defaultHeight?: number | null;
}

/** Cache entry: metadata, `'missing'` (404 — orphan URL) or `'error'`
 *  (network/server failure — resolvable, retried on the next ensure). */
export type CdnMetadataCacheEntry = CdnComponentMetadata | 'missing' | 'error';

const cdnMetadataCacheAtom = atom<Map<string, CdnMetadataCacheEntry>>(
  new Map<string, CdnMetadataCacheEntry>(),
);
const cdnMetadataLoadingAtom = atom<Set<string>>(new Set<string>());

/** Last failure time per URL — dampens `'error'` retries so render-driven
 *  ensure calls (Library panel lists every URL each render) don't hot-loop
 *  a failing endpoint. One retry per window, not per render. */
const lastErrorAt = new Map<string, number>();
const ERROR_RETRY_MS = 30_000;

/** Synchronous cache read for non-React callers (e.g. the Library drag
 *  handler seeding a dropped instance's size). The library scanner + the
 *  active-page prefetch warm the cache, so by drag time it's usually hot;
 *  null when not (fetch never blocks a drag). */
export function getCachedCdnMetadata(url: string): CdnComponentMetadata | null {
  const cached = getDefaultStore().get(cdnMetadataCacheAtom).get(url);
  return cached && cached !== 'missing' && cached !== 'error' ? cached : null;
}

/** Read-only access to the full metadata cache. Library panel uses this
 *  to group ALL imported URLs by creator without firing N hook calls. */
export function useCdnMetadataCache(): Map<string, CdnMetadataCacheEntry> {
  return useAtomValue(cdnMetadataCacheAtom);
}

/**
 * Imperative ensure — kick off the metadata fetch for a URL unless it's
 * already cached (a prior `'error'` retries) or in flight. Single shared
 * implementation behind both the hook and non-React callers (canvas
 * controllers, prefetchers).
 */
export function ensureCdnMetadataFetched(url: string): void {
  if (!url) return;
  const store = getDefaultStore();
  const cached = store.get(cdnMetadataCacheAtom).get(url);
  if (cached !== undefined && cached !== 'error') return;
  // Retry a failed fetch only after the backoff window — render-driven
  // callers re-ensure constantly and must not hammer a failing endpoint.
  if (cached === 'error' && Date.now() - (lastErrorAt.get(url) ?? 0) < ERROR_RETRY_MS) return;
  if (store.get(cdnMetadataLoadingAtom).has(url)) return;

  const hashMatch = url.match(/@([a-f0-9]+)\.(?:js|tsx)$/);
  if (!hashMatch) return;
  const hash = hashMatch[1];

  store.set(cdnMetadataLoadingAtom, (prev: Set<string>) => {
    const next = new Set(prev);
    next.add(url);
    return next;
  });
  trace.action('cdn-metadata:fetch-start', { url, hash });

  (async () => {
    let result: CdnMetadataCacheEntry;
    try {
      const r = await fetch(`/api/components/metadata?hash=${encodeURIComponent(hash)}`);
      if (r.status === 404) {
        result = 'missing';
      } else if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      } else {
        result = (await r.json()) as CdnComponentMetadata;
      }
      trace.action('cdn-metadata:fetched', { url, found: result !== 'missing' });
    } catch (err) {
      // Cache the failure so pending consumers RESOLVE (the modal's
      // "checking" state must not hang forever); retried after the backoff.
      result = 'error';
      lastErrorAt.set(url, Date.now());
      trace.error('cdn-metadata:fetch-failed', { url, error: err instanceof Error ? err.message : String(err) });
    }
    store.set(cdnMetadataCacheAtom, (prev: Map<string, CdnMetadataCacheEntry>) => {
      const next = new Map(prev);
      next.set(url, result);
      return next;
    });
    store.set(cdnMetadataLoadingAtom, (prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(url);
      return next;
    });
  })();
}

/** Hook form of the ensure — kept for existing call sites; delegates to the
 *  shared imperative implementation. */
export function useEnsureCdnMetadata(): (url: string) => void {
  return useCallback((url: string) => ensureCdnMetadataFetched(url), []);
}

/**
 * Prefetch metadata for EVERY CDN-linked instance on the active page, as soon
 * as the node map loads. This is what makes the LinkedComponentModal's
 * closed-source verdict INSTANT on double-click — the answer is already in the
 * cache instead of racing the modal open (the "Unlink flashes before the
 * closed-source message" bug). Mounted once next to the modal (App.tsx).
 * Cache + loading guards in `ensureCdnMetadataFetched` make re-runs free.
 */
export function usePrefetchCdnMetadataForActiveFile(): void {
  const nodes = useAtomValue(stableNodesAtom);
  useEffect(() => {
    for (const node of nodes.values()) {
      const cf = (node as { componentFile?: string }).componentFile;
      if (cf && cf.startsWith('http')) ensureCdnMetadataFetched(cf);
    }
  }, [nodes]);
}
