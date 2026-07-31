import { describe, test, expect, vi } from 'vitest';

vi.mock('@/code/project/cms-ops', () => ({
  getCollectionData: vi.fn((slug: string) => slug === 'collection-1'
    ? [
        { title: 'First post', untitled: 'First body', _slug: 'first' },
        { title: 'Second post', untitled: 'Second body', _slug: 'second' },
        { title: 'Third post', untitled: 'Third body', _slug: 'third' },
      ]
    : []),
}));
vi.mock('@/code/stores/store', async () => {
  const { atom } = await import('jotai');
  return { mapItemIndexAtom: atom<number | null>(null) };
});

import { resolveCmsRowForNodeInCode } from './cms-row-resolve';
import { getEnclosingMapSourceForNode } from './map-gen';

const PAGE = (mapExpr: string) => `
import collection1 from '@/cms/collection-1.json';
export default function Page() {
  return (
    <div data-id="root">
      {${mapExpr}.map((item, idx) => (
        <article key={idx} data-id="row-1">
          <motion.h3 data-id="h3-1">{item.untitled}</motion.h3>
        </article>
      ))}
    </div>
  );
}`;

describe('getEnclosingMapSourceForNode', () => {
  test('captures a sliced collection chain', () => {
    expect(getEnclosingMapSourceForNode(PAGE('collection1.slice(1)'), 'h3-1'))
      .toEqual({ iterVar: 'item', sourceExpr: 'collection1.slice(1)' });
  });
  test('captures a call-wrapped source (__applyListConfig)', () => {
    expect(getEnclosingMapSourceForNode(PAGE('__applyListConfig(collection1, cfg)'), 'h3-1'))
      .toEqual({ iterVar: 'item', sourceExpr: '__applyListConfig(collection1, cfg)' });
  });
  test('captures a bare identifier source', () => {
    expect(getEnclosingMapSourceForNode(PAGE('cardData'), 'h3-1'))
      .toEqual({ iterVar: 'item', sourceExpr: 'cardData' });
  });
  test('null outside any .map()', () => {
    const code = `const canvasNodes = (<><motion.h3 data-id="h3-1">x</motion.h3></>);`;
    expect(getEnclosingMapSourceForNode(code, 'h3-1')).toBeNull();
  });
});

describe('resolveCmsRowForNodeInCode', () => {
  test('plain map resolves the first item', () => {
    expect(resolveCmsRowForNodeInCode(PAGE('collection1'), 'h3-1')?.title).toBe('First post');
  });
  test('slice(1) resolves the first item the slice lets THROUGH — not items[0]', () => {
    // The primary template row of `collection1.slice(1).map(...)` displays the
    // SECOND collection item; the drag-out bake must use what the user saw.
    expect(resolveCmsRowForNodeInCode(PAGE('collection1.slice(1)'), 'h3-1')?.title).toBe('Second post');
  });
  test('a call-wrapped source still resolves via the referenced collection import', () => {
    expect(resolveCmsRowForNodeInCode(PAGE('__applyListConfig(collection1, cfg)'), 'h3-1')?.title).toBe('First post');
  });
  test('inline map data (no CMS import referenced) → null, placeholder behavior stands', () => {
    expect(resolveCmsRowForNodeInCode(PAGE('cardData'), 'h3-1')).toBeNull();
  });
  test('unknown collection file → null', () => {
    const code = PAGE('collection9.slice(0, 3)').replace("collection1 from '@/cms/collection-1.json'", "collection9 from '@/cms/collection-9.json'");
    expect(resolveCmsRowForNodeInCode(code, 'h3-1')).toBeNull();
  });
});
