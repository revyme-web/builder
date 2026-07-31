import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { findCodeIdMissingFromMap, shouldSkipLaggingForcedRender } from './render-integrity';
import type { CanvasNode } from '@/code/parsing/parser';

const mapOf = (...ids: string[]) => new Map(ids.map((id) => [id, { id } as CanvasNode]));

describe('render-integrity — forced renders must not ship maps that lag the committed code', () => {
  // EMPIRICAL PIN, live find 2026-07-29: a freshly drawn frame vanished from
  // the canvas (~1 in 50) while code + Layers kept it — a mid-gesture forced
  // render shipped the imperative cache before the parse had added the node.
  it('detects a code id missing from the map (the vanished-frame race)', () => {
    const code = `<div data-id="root"><div data-id="frame-new-1"></div></div>`;
    expect(findCodeIdMissingFromMap(code, mapOf('root'))).toBe('frame-new-1');
    expect(shouldSkipLaggingForcedRender(code, mapOf('root'))).toBe(true);
  });

  it('passes when the map covers every code id', () => {
    const code = `<div data-id="root"><p data-id="t-1">x</p></div>`;
    expect(findCodeIdMissingFromMap(code, mapOf('root', 't-1'))).toBeNull();
    expect(shouldSkipLaggingForcedRender(code, mapOf('root', 't-1'))).toBe(false);
  });

  it('ignores CSS selectors in generated <style> blocks — `[data-id="x"]` is not a node', () => {
    // Responsive pages carry @media override blocks whose selectors would
    // otherwise read as permanently-missing ids and skip every forced render.
    const code = `<div data-id="root"><style>{\`@media (max-width: 768px) { [data-id="pr-grid"] { grid-template-columns: 1fr !important; } }\`}</style></div>`;
    expect(findCodeIdMissingFromMap(code, mapOf('root'))).toBeNull();
  });

  it('ignores querySelector strings with bracketed selectors', () => {
    const code = `<div data-id="root"></div>\nconst el = document.querySelector('[data-id="ghost-9"]');`;
    expect(findCodeIdMissingFromMap(code, mapOf('root'))).toBeNull();
  });

  it('empty code / empty map are quiet', () => {
    expect(findCodeIdMissingFromMap('', mapOf())).toBeNull();
    expect(findCodeIdMissingFromMap('no jsx here', mapOf('root'))).toBeNull();
  });
});
