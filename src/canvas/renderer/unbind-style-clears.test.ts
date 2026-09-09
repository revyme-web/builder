// unbind-style-clears.test.ts — the collection TEMPLATE row (item 0, patched via
// patchElement) must drop a CMS-bound inline style the moment the binding is
// gone. × on the Fill pill removes `backgroundImage` from the source; the
// ghosts rebuild from the binding signature, but the template kept painting
// the row-0 image until a page switch (user report 2026-09-09).
import { describe, test, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn(), state: vi.fn() } }));
import { patchElement } from '../Renderer';
import type { CanvasNode } from '@/code/parsing/parser';

const mk = (over: Partial<CanvasNode>): CanvasNode => ({
  id: 'avatar', type: 'div', parentId: 'row', children: [], attrs: {}, styles: { width: '40px', height: '40px' }, ...over,
} as unknown as CanvasNode);

function patch(el: HTMLElement, node: CanvasNode, item: Record<string, unknown> | null) {
  const all = new Map<string, CanvasNode>([[node.id, node]]);
  patchElement(el, node, all, () => {}, '', null, item as any, undefined, 1440);
}

describe('template row: unbound style is cleared on the next patch', () => {
  test('bound backgroundImage → unbind → inline image gone', () => {
    const el = document.createElement('div');
    el.setAttribute('data-id', 'avatar');
    el.setAttribute('data-node-id', 'avatar');
    document.body.appendChild(el);
    const bound = mk({ styleBindings: [{ styleProp: 'backgroundImage', field: 'photo' }], styles: { width: '40px', height: '40px', backgroundSize: 'cover' } } as any);
    patch(el, bound, { _id: 'i1', photo: 'https://x/a.jpg' });
    expect(el.style.backgroundImage).toContain('a.jpg');

    // The unbind: source loses backgroundImage/backgroundSize; still a collection row (item 0).
    const unbound = mk({ styles: { width: '40px', height: '40px' } });
    patch(el, unbound, { _id: 'i1', photo: 'https://x/a.jpg' });
    expect(el.style.backgroundImage).toBe('');
    expect(el.style.width).toBe('40px');
  });

  test('a key that is bound AND declared statically survives the binding going away', () => {
    const el = document.createElement('div');
    el.setAttribute('data-id', 'avatar'); el.setAttribute('data-node-id', 'avatar');
    document.body.appendChild(el);
    const bound = mk({ styleBindings: [{ styleProp: 'backgroundColor', field: 'brand' }] } as any);
    patch(el, bound, { _id: 'i1', brand: '#ff0000' });
    expect(el.style.backgroundColor).toBe('rgb(255, 0, 0)');
    // Unbind → static fallback written into the source
    const unbound = mk({ styles: { width: '40px', height: '40px', backgroundColor: '#00ff00' } });
    patch(el, unbound, { _id: 'i1', brand: '#ff0000' });
    expect(el.style.backgroundColor).toBe('rgb(0, 255, 0)');
  });
});
