// cdn-metadata-hook.test.ts — the imperative ensure: caching, 404 vs error
// sentinels, and the error-retry backoff that keeps render-driven callers
// from hot-looping a failing endpoint. Uses the jotai default store (module
// atoms), so each test uses DISTINCT URLs to avoid cross-test bleed.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureCdnMetadataFetched, getCachedCdnMetadata } from './cdn-metadata-hook';

const META = { hash: 'abc123', name: 'FancyCard', creator: null, createdAt: '2026-01-01', closedSource: true };

function url(tag: string) {
  return `https://assets.revyme.app/components/FancyCard-${tag}@abcdef0123456789.js`;
}

/** Await until the fetch IIFE settles (microtasks + the real setTimeout(0)). */
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ensureCdnMetadataFetched', () => {
  it('fetches once, caches the metadata (closedSource readable synchronously)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => META });
    vi.stubGlobal('fetch', fetchMock);
    const u = url('ok');

    ensureCdnMetadataFetched(u);
    ensureCdnMetadataFetched(u); // in-flight dedupe
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCachedCdnMetadata(u)?.closedSource).toBe(true);

    ensureCdnMetadataFetched(u); // cached → no refetch
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches 404 as missing (resolved — getCached returns null, no refetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const u = url('gone');

    ensureCdnMetadataFetched(u);
    await settle();
    expect(getCachedCdnMetadata(u)).toBeNull();

    ensureCdnMetadataFetched(u);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 'missing' is permanent
  });

  it("caches failures as 'error' and RESOLVES consumers (no hang), with retry backoff", async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // fake only Date — keep real timers for settle()
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const u = url('down');

    ensureCdnMetadataFetched(u);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCachedCdnMetadata(u)).toBeNull(); // sentinel → null for sync readers

    // Within the backoff window: render-driven re-ensure must NOT refetch.
    ensureCdnMetadataFetched(u);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the window: one retry allowed (and it can now succeed).
    vi.setSystemTime(Date.now() + 31_000);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => META });
    ensureCdnMetadataFetched(u);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCachedCdnMetadata(u)?.name).toBe('FancyCard');
  });

  it('ignores URLs without a content-hash shape (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    ensureCdnMetadataFetched('https://example.com/not-a-cdn-component.js');
    ensureCdnMetadataFetched('');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
