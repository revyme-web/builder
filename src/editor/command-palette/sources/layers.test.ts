// layers.test.ts — Locks in the guarantees that keep the layers source
// usable on a real page: it stays silent while the query is too short,
// never offers the page root, caps its output, and produces an ancestor
// trail that actually disambiguates same-named nodes.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';

// The source reads the node map through jotai's default store. Swapping
// the store is simpler than faking the derived `nodesAtom`, which is
// read-only and computed from parsed source.
const mockNodes = new Map<string, CanvasNode>();

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    getDefaultStore: () => ({ get: () => mockNodes, set: vi.fn() }),
  };
});

const { layersSource } = await import('./layers');

function node(partial: Partial<CanvasNode> & { id: string; name: string }): CanvasNode {
  return {
    type: 'div',
    parentId: 'root',
    children: [],
    styles: {},
    // A page's own node: not inside any component expansion.
    componentInstanceId: null,
    componentFile: null,
    ...partial,
  } as CanvasNode;
}

function seed(nodes: CanvasNode[]) {
  mockNodes.clear();
  mockNodes.set('root', node({ id: 'root', name: 'Page', parentId: null }));
  for (const n of nodes) mockNodes.set(n.id, n);
}

beforeEach(() => mockNodes.clear());

describe('layersSource', () => {
  it('emits nothing below the minimum query length', () => {
    seed([node({ id: 'a', name: 'Header' })]);
    expect(layersSource({ query: '' })).toEqual([]);
    expect(layersSource({ query: 'h' })).toEqual([]);
  });

  it('matches nodes by name once the query is long enough', () => {
    seed([
      node({ id: 'a', name: 'Header' }),
      node({ id: 'b', name: 'Footer' }),
    ]);
    const r = layersSource({ query: 'hea' });
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('Header');
    expect(r[0].action).toEqual({ type: 'select-node', nodeId: 'a' });
  });

  it('never offers the page root as a result', () => {
    // The root matches "page" but selecting it is meaningless, and it
    // would match nearly every broad query.
    seed([]);
    expect(layersSource({ query: 'page' })).toEqual([]);
  });

  it('builds an outermost-first ancestor trail, excluding the node itself', () => {
    seed([
      node({ id: 'sec', name: 'Section', parentId: 'root' }),
      node({ id: 'wrap', name: 'Wrapper', parentId: 'sec' }),
      node({ id: 'h', name: 'Header', parentId: 'wrap' }),
    ]);
    const r = layersSource({ query: 'header' });
    expect(r[0].breadcrumb).toEqual(['Page', 'Section', 'Wrapper']);
  });

  it('distinguishes same-named nodes by their trail', () => {
    seed([
      node({ id: 'sA', name: 'Hero', parentId: 'root' }),
      node({ id: 'sB', name: 'Footer', parentId: 'root' }),
      node({ id: 'c1', name: 'Container', parentId: 'sA' }),
      node({ id: 'c2', name: 'Container', parentId: 'sB' }),
    ]);
    const r = layersSource({ query: 'container' });
    expect(r).toHaveLength(2);
    const innermost = r.map((x) => x.breadcrumb![x.breadcrumb!.length - 1]);
    expect(innermost.sort()).toEqual(['Footer', 'Hero']);
  });

  it('caps output so one repetitive page cannot flood the palette', () => {
    seed(Array.from({ length: 100 }, (_, i) => node({ id: `n${i}`, name: `Container ${i}` })));
    expect(layersSource({ query: 'container' }).length).toBeLessThanOrEqual(30);
  });

  it('survives a parentId cycle instead of hanging', () => {
    // Should not be reachable via the parser, but this runs on every
    // keystroke — an infinite walk here would lock the editor.
    mockNodes.clear();
    mockNodes.set('a', node({ id: 'a', name: 'Loop A', parentId: 'b' }));
    mockNodes.set('b', node({ id: 'b', name: 'Loop B', parentId: 'a' }));
    const r = layersSource({ query: 'loop' });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].breadcrumb!.length).toBeLessThanOrEqual(12);
  });

  it('falls back to the tag name when a node has no name', () => {
    seed([node({ id: 'a', name: '', type: 'section' })]);
    const r = layersSource({ query: 'section' });
    expect(r[0].name).toBe('section');
  });
});

// `nodesAtom` holds every component instance EXPANDED — expandComponent
// inlines each master's subtree so the Renderer can paint it. Those inlined
// nodes are not editable from the page they appear on, and surfacing them
// made a search on the home page return three "Tools" rows from inside the
// Header's mobile-menu variant (user report). They belong to the master.
describe('layersSource — component instance boundaries', () => {
  it('offers the instance but not its inlined internals', () => {
    seed([
      node({ id: 'hdr', name: 'Header', componentFile: 'components/Header.tsx' }),
      // expandComponent output: carries the instance id it lives inside.
      node({ id: 'inner-1', name: 'Header Tools', parentId: 'hdr', componentInstanceId: 'hdr' }),
      node({ id: 'inner-2', name: 'Header Nav', parentId: 'hdr', componentInstanceId: 'hdr' }),
    ]);
    const r = layersSource({ query: 'header' });
    expect(r.map((x) => x.name)).toEqual(['Header']);
  });

  it('hides variant subtrees of an instance', () => {
    // The exact reported shape: several same-named nodes from different
    // variants of one component, none reachable from this page.
    seed([
      node({ id: 'hdr', name: 'Header', componentFile: 'components/Header.tsx' }),
      node({ id: 'v1', name: 'Tools', parentId: 'hdr', componentInstanceId: 'hdr' }),
      node({ id: 'v2', name: 'Tools', parentId: 'hdr', componentInstanceId: 'hdr' }),
      node({ id: 'v3', name: 'Tools', parentId: 'hdr', componentInstanceId: 'hdr' }),
    ]);
    expect(layersSource({ query: 'tools' })).toEqual([]);
  });

  it('DOES surface those nodes when the master file is open', () => {
    // Editing Header.tsx: its own nodes have no componentInstanceId, so they
    // are the page's own content and must be findable — that is the one
    // place they can actually be edited.
    seed([
      node({ id: 'bar', name: 'Bar' }),
      node({ id: 'tools', name: 'Tools', parentId: 'bar' }),
    ]);
    expect(layersSource({ query: 'tools' }).map((x) => x.name)).toEqual(['Tools']);
  });

  it('labels a top-level instance as a Component', () => {
    seed([node({ id: 'hdr', name: 'Header', componentFile: 'components/Header.tsx' })]);
    expect(layersSource({ query: 'header' })[0].subcategory).toBe('Component');
  });

  it('skips svg geometry and sketch strokes', () => {
    // Paint, not structure — LayersPanel forces these to be leaves too.
    seed([
      node({ id: 'tri', name: 'Triangle', type: 'svg' }),
      node({ id: 'poly', name: 'Triangle path', type: 'polygon', parentId: 'tri' }),
      node({ id: 'p1', name: 'Triangle stroke', type: 'path', parentId: 'tri' }),
    ]);
    expect(layersSource({ query: 'triangle' }).map((x) => x.name)).toEqual(['Triangle']);
  });
});
