// collectViewportUnitEntries — which styles a width scrub must re-resolve
// live. The full gesture (pin → tick → commit) is covered end-to-end by
// e2e/viewport-width-rewrite.spec.ts; this pins the pure collection rules.

import { describe, it, expect, vi } from 'vitest';
import { collectViewportUnitEntries } from './viewport-width-scrub';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/canvas/node-ops', () => ({
  getContentRoot: () => null,
  patchNodeStyles: vi.fn(),
  getViewportPrefix: () => '',
  forceCanvasRender: vi.fn(),
}));
vi.mock('@/code/stores/store', () => ({ getAllCachedNodes: () => [] }));

const overrides = (
  entries: Array<[string, number, Record<string, string>]>,
): Map<string, Map<number, Map<string, string>>> => {
  const m = new Map<string, Map<number, Map<string, string>>>();
  for (const [id, w, props] of entries) {
    if (!m.has(id)) m.set(id, new Map());
    m.get(id)!.set(w, new Map(Object.entries(props)));
  }
  return m;
};

describe('collectViewportUnitEntries', () => {
  it('collects base styles carrying vh or vw', () => {
    const out = collectViewportUnitEntries(
      [{ id: 'hero', styles: { height: '89vh', width: '100%', fontSize: 'clamp(16px, 4vw, 48px)' } }],
      new Map(), 375,
    );
    expect(out).toEqual([
      { nodeId: 'hero', key: 'height', raw: '89vh' },
      { nodeId: 'hero', key: 'fontSize', raw: 'clamp(16px, 4vw, 48px)' },
    ]);
  });

  it('covering band value wins over the base', () => {
    const out = collectViewportUnitEntries(
      [{ id: 'hero', styles: { height: '89vh' } }],
      overrides([['hero', 500, { height: '50vh' }]]),
      375,
    );
    expect(out).toEqual([{ nodeId: 'hero', key: 'height', raw: '50vh' }]);
  });

  it('a band override with a concrete px value removes the base vh entry', () => {
    const out = collectViewportUnitEntries(
      [{ id: 'hero', styles: { height: '89vh' } }],
      overrides([['hero', 500, { height: '600px' }]]),
      375,
    );
    expect(out).toEqual([]);
  });

  it('a band ABOVE the pinned width does not apply (base stands)', () => {
    const out = collectViewportUnitEntries(
      [{ id: 'hero', styles: { height: '89vh' } }],
      overrides([['hero', 500, { height: '50vh' }]]),
      900,
    );
    expect(out).toEqual([{ nodeId: 'hero', key: 'height', raw: '89vh' }]);
  });

  it('nodes with no viewport units contribute nothing', () => {
    const out = collectViewportUnitEntries(
      [{ id: 'a', styles: { width: '100%', padding: '16px' } }, { id: 'b' }],
      new Map(), 375,
    );
    expect(out).toEqual([]);
  });
});
