// bound-style-keys.test.ts — applyNodeCmsBindings reports the inline style
// keys it owns so the template patch can clear a binding that went away
// (× on the Fill pill: the row-0 image lingered until a page switch, 2026-09-09).
import { describe, test, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
import { applyNodeCmsBindings } from './bindings';
import type { CanvasNode } from '@/code/parsing/parser';

const node = (over: Partial<CanvasNode>): CanvasNode => ({ id: 'avatar', type: 'div', children: [], styles: {}, attrs: {}, ...over } as unknown as CanvasNode);

describe('applyNodeCmsBindings → styleKeys', () => {
  test('a bound backgroundImage is written and reported', () => {
    const el = document.createElement('div');
    const r = applyNodeCmsBindings(el, node({ styleBindings: [{ styleProp: 'backgroundImage', field: 'photo' }] } as any), { _id: 'i1', photo: 'https://x/a.jpg' } as any, 1440, null);
    expect(el.style.backgroundImage).toContain('a.jpg');
    expect(r.styleKeys).toEqual(['backgroundImage']);
  });
  test('no bindings → no keys owned', () => {
    const el = document.createElement('div');
    const r = applyNodeCmsBindings(el, node({}), { _id: 'i1' } as any, 1440, null);
    expect(r.styleKeys).toEqual([]);
  });
});
