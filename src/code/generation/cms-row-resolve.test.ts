import { describe, test, it, expect, vi } from 'vitest';

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
// Detail-page context: plain atoms so the test can drive "which item is the
// slug page previewing" without a project/parse round trip.
vi.mock('@/code/stores/cms-page-store', async () => {
  const { atom } = await import('jotai');
  return {
    cmsPageMetaAtom: atom<{ kind: string; collection: string } | null>(null),
    activePreviewItemAtom: atom<Record<string, unknown> | null>(null),
  };
});

import { getDefaultStore, type PrimitiveAtom } from 'jotai';
import { cmsPageMetaAtom as metaAtomRO, activePreviewItemAtom as itemAtomRO } from '@/code/stores/cms-page-store';
import { resolveCmsRowValues, resolveCmsRowForNodeInCode } from './cms-row-resolve';
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


// ─── Detail ([slug]) pages have no `.map()` ancestor ───────────────────────
// The resolver used to require one, so on a slug page it returned {} and every
// caller got nothing: pressing × on a bound Content field injected an EMPTY
// string and the text disappeared from the canvas (user report 2026-09-09).
// The row a detail page shows is the PREVIEWED item — the same one the canvas
// paints from — so unbind now leaves exactly the words that were on screen.
// The real atoms are derived (read-only); the mock above replaces them with
// primitives, so cast to the writable shape for the setup writes.
const cmsPageMetaAtom = metaAtomRO as unknown as PrimitiveAtom<{ kind: string; collection: string } | null>;
const activePreviewItemAtom = itemAtomRO as unknown as PrimitiveAtom<Record<string, unknown> | null>;

describe('resolveCmsRowValues — detail ([slug]) page', () => {
  const store = getDefaultStore();
  const boundNode = {
    id: 'tag-4', parentId: 'section', children: [], type: 'p', styles: {},
    binding: { field: 'untitled', property: 'text' },
  } as any;
  // No ancestor carries `collectionList` — that is the whole point.
  const nodes = new Map<string, any>([
    ['root', { id: 'root', parentId: null, children: ['section'], type: 'div', styles: {} }],
    ['section', { id: 'section', parentId: 'root', children: ['tag-4'], type: 'div', styles: {} }],
    ['tag-4', boundNode],
  ]);

  test('resolves the bound text from the previewed item', () => {
    store.set(cmsPageMetaAtom, { kind: 'detail', collection: 'collection-1' });
    store.set(activePreviewItemAtom, { title: 'Second post', untitled: 'Second body', _slug: 'second' });

    expect(resolveCmsRowValues(boundNode, nodes)).toEqual({ __text: 'Second body' });
  });

  test('style + attr bindings resolve from the same item', () => {
    store.set(cmsPageMetaAtom, { kind: 'detail', collection: 'collection-1' });
    store.set(activePreviewItemAtom, { untitled: 'Body', cover: 'https://cdn/x.png' });
    const node = {
      ...boundNode,
      attrBindings: [{ field: 'cover', property: 'src' }],
      styleBindings: [{ styleProp: 'backgroundImage', field: 'cover' }],
    };
    expect(resolveCmsRowValues(node, nodes)).toEqual({
      __text: 'Body', src: 'https://cdn/x.png', '__style.backgroundImage': 'https://cdn/x.png',
    });
  });

  test('a page that is NOT a detail page still resolves nothing', () => {
    store.set(cmsPageMetaAtom, null);
    store.set(activePreviewItemAtom, { untitled: 'Body' });
    expect(resolveCmsRowValues(boundNode, nodes)).toEqual({});
  });

  test('a detail page with no previewed item (empty collection) resolves nothing', () => {
    store.set(cmsPageMetaAtom, { kind: 'detail', collection: 'collection-1' });
    store.set(activePreviewItemAtom, null);
    expect(resolveCmsRowValues(boundNode, nodes)).toEqual({});
  });

  test('an unbound node is untouched (no bindings → no work)', () => {
    store.set(cmsPageMetaAtom, { kind: 'detail', collection: 'collection-1' });
    store.set(activePreviewItemAtom, { untitled: 'Body' });
    expect(resolveCmsRowValues({ ...boundNode, binding: undefined }, nodes)).toEqual({});
  });
});


// ─── Which surface is this node on? `isCollectionTemplate`, not a bare walk ──
// The parser marks every node inside a `.map()` callback. A node that merely
// sits inside the list CONTAINER (a sibling of the `.map()` expression) is NOT
// a row — resolving it against the list would hand it another collection's
// values, which on a detail page holding a related-items list is the page's
// own item's field read from the wrong row.
describe('resolveCmsRowValues — row vs container descendant', () => {
  const store = getDefaultStore();
  const nodes = new Map<string, any>([
    ['list', { id: 'list', parentId: null, children: ['row', 'heading'], type: 'div', styles: {}, collectionList: { source: 'collection-1', itemVar: 'item' } }],
    ['row', { id: 'row', parentId: 'list', children: ['name'], type: 'div', styles: {}, isCollectionTemplate: true }],
    ['name', { id: 'name', parentId: 'row', children: [], type: 'p', styles: {}, isCollectionTemplate: true, binding: { field: 'title', property: 'text' } }],
    // Inside the container, OUTSIDE the map callback — bound to the page item.
    ['heading', { id: 'heading', parentId: 'list', children: [], type: 'p', styles: {}, binding: { field: 'title', property: 'text' } }],
  ]);

  it('a real `.map()` row resolves from the collection', () => {
    store.set(cmsPageMetaAtom, null);
    store.set(activePreviewItemAtom, null);
    expect(resolveCmsRowValues(nodes.get('name'), nodes)).toEqual({ __text: 'First post' });
  });

  it('a container DESCENDANT on a detail page resolves from the previewed item, not the list', () => {
    store.set(cmsPageMetaAtom, { kind: 'detail', collection: 'case-study' });
    store.set(activePreviewItemAtom, { title: 'The page item' });
    expect(resolveCmsRowValues(nodes.get('heading'), nodes)).toEqual({ __text: 'The page item' });
  });
});
