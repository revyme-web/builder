// CanvasRenderer input dedupe: a React effect re-fire with semantically
// identical inputs must not forward a second full render to the iframe.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CanvasRenderer, type RenderInput } from './CanvasRenderer';

function makeInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    nodes: new Map(),
    viewports: [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true } as any],
    code: 'code-a',
    css: '',
    globalsCss: ':root {}',
    layoutCss: '',
    activeLocale: undefined,
    defaultLocale: undefined,
    localeOverrides: undefined,
    cmsCollections: { schemas: {}, data: {} },
    ...overrides,
  };
}

describe('CanvasRenderer — duplicate-input render dedupe', () => {
  let renderer: CanvasRenderer;
  let bridgeRender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    renderer = new CanvasRenderer();
    bridgeRender = vi.fn();
    renderer.setBridge({ render: bridgeRender } as any);
    renderer.setSandboxReady(true);
  });

  it('forwards the first render and skips an identical second one', () => {
    const input = makeInput();
    renderer.render(input);
    renderer.render(input);
    expect(bridgeRender).toHaveBeenCalledTimes(1);
  });

  it('forwards again when nodes identity changes', () => {
    const input = makeInput();
    renderer.render(input);
    renderer.render(makeInput({ nodes: new Map([['a', {} as any]]) }));
    expect(bridgeRender).toHaveBeenCalledTimes(2);
  });

  it('forwards again when code or CSS changes', () => {
    renderer.render(makeInput());
    renderer.render(makeInput({ code: 'code-b' }));
    renderer.render(makeInput({ code: 'code-b', globalsCss: ':root { --x: 1; }' }));
    expect(bridgeRender).toHaveBeenCalledTimes(3);
  });

  it('forwards again when a CMS collection value ref changes', () => {
    const nodes = new Map();
    const items = [{ id: '1' }];
    renderer.render(makeInput({ nodes, cmsCollections: { schemas: {}, data: { blog: items } } }));
    renderer.render(makeInput({ nodes, cmsCollections: { schemas: {}, data: { blog: items } } }));
    expect(bridgeRender).toHaveBeenCalledTimes(1);
    renderer.render(makeInput({ nodes, cmsCollections: { schemas: {}, data: { blog: [{ id: '1' }, { id: '2' }] } } }));
    expect(bridgeRender).toHaveBeenCalledTimes(2);
  });

  it('forceRender always forwards and refreshes the dedupe baseline', () => {
    const input = makeInput();
    renderer.render(input);
    renderer.forceRender(input);
    expect(bridgeRender).toHaveBeenCalledTimes(2);
    renderer.render(input);
    expect(bridgeRender).toHaveBeenCalledTimes(2);
  });
});
