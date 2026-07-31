// cdn-component-cache.test.ts — Locks down the loaded-component cache
// semantics: miss → null, in-flight dedupe via the pending map, failure →
// resolves null (never throws), and the loaded-event fire on success.
// (The old test targeted the pre-2026 SOURCE-text cache API that was
// replaced by dynamic-import of pre-compiled bundles — see the module
// header.) Uses data: URLs so `import()` resolves without a network.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const MODULE_URL = (body: string) =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(body)}`;

describe('cdn-component-cache', () => {
  // Fresh module registry per test — the cache maps are module-level.
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null for URLs that were never loaded', async () => {
    const { getCdnComponent } = await import('./cdn-component-cache');
    expect(getCdnComponent('https://assets.revyme.app/components/nope@000000.js')).toBeNull();
  });

  it('loads a module, caches its default export, and fires the loaded event', async () => {
    const { getCdnComponent, loadCdnComponent } = await import('./cdn-component-cache');
    const url = MODULE_URL('export default function Test() { return null; }');
    const fired = new Promise<void>((resolve) => {
      window.addEventListener('revyme:cdn-component-loaded', () => resolve(), { once: true });
    });

    const Component = await loadCdnComponent(url);
    expect(typeof Component).toBe('function');
    // Sync getter now hits the cache.
    expect(getCdnComponent(url)).toBe(Component);
    await fired;
  });

  it('dedupes concurrent loads of the same URL to one promise', async () => {
    const { loadCdnComponent, isCdnComponentPending } = await import('./cdn-component-cache');
    const url = MODULE_URL('export default function Once() { return null; }');

    const p1 = loadCdnComponent(url);
    const p2 = loadCdnComponent(url);
    expect(p2).toBe(p1);
    expect(isCdnComponentPending(url)).toBe(true);

    await p1;
    expect(isCdnComponentPending(url)).toBe(false);
  });

  it('resolves null (does not throw) when the import fails', async () => {
    const { loadCdnComponent, getCdnComponent } = await import('./cdn-component-cache');
    const url = MODULE_URL('this is not javascript {{{');
    await expect(loadCdnComponent(url)).resolves.toBeNull();
    expect(getCdnComponent(url)).toBeNull();
  });

  it('getAllCdnComponents exposes the cache map for registry scans', async () => {
    const { loadCdnComponent, getAllCdnComponents } = await import('./cdn-component-cache');
    const url = MODULE_URL('export default function InMap() { return null; }');
    await loadCdnComponent(url);
    expect(getAllCdnComponents().has(url)).toBe(true);
  });
});
