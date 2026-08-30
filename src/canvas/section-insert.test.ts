// section-insert.test.ts — blueprint → ClipboardNode conversion contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/canvas/insertion-bridge', () => ({
  insertNodes: vi.fn(() => ['new-root-id']),
}));
vi.mock('@/shared/font-loader', () => ({
  loadGoogleFont: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/code/project/preset-ops', () => ({
  ensureGoogleFontImport: vi.fn(),
}));

import { blueprintToClipboardNodes, blueprintToToolbarItem, insertSectionBlueprint } from './section-insert';
import { insertNodes } from '@/canvas/insertion-bridge';
import { loadGoogleFont } from '@/shared/font-loader';
import { ensureGoogleFontImport } from '@/code/project/preset-ops';
import { SECTION_BLUEPRINTS, getSectionBlueprint } from '@/shared/sections-library';

describe('blueprintToClipboardNodes', () => {
  for (const blueprint of SECTION_BLUEPRINTS) {
    it(`${blueprint.id}: flat list with a detached root and resolvable children`, () => {
      const nodes = blueprintToClipboardNodes(blueprint);
      expect(nodes.length).toBeGreaterThan(3);

      const [root, ...rest] = nodes;
      expect(root.parentId).toBeNull();
      expect(root.id.startsWith('section-')).toBe(true);
      // Only the root gets the free-canvas size snapshot.
      expect(root.computedDimensions).toEqual(blueprint.canvasSize);
      for (const n of rest) expect(n.computedDimensions).toBeUndefined();

      // Every child reference resolves within the flat list, and every
      // non-root node's parent is in the list too — insertNodes requires a
      // self-contained payload.
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const n of nodes) {
        for (const childId of n.children) expect(byId.has(childId)).toBe(true);
        if (n !== root) expect(byId.has(n.parentId as string)).toBe(true);
      }
    });
  }

  it('carries svg shape geometry through attrs (logo marks survive)', () => {
    const nodes = blueprintToClipboardNodes(getSectionBlueprint('header-editorial')!);
    const path = nodes.find((n) => n.id === 'hed-logo-spark-g0');
    expect(path).toBeTruthy();
    expect(path!.attrs?.d).toContain('M10 0');
    const shape = nodes.find((n) => n.id === 'hed-logo-spark');
    expect(shape!.attrs?.viewBox).toBe('0 0 20 20');
  });
});

describe('blueprintToToolbarItem', () => {
  for (const blueprint of SECTION_BLUEPRINTS) {
    it(`${blueprint.id}: drag item with the blueprint's root shape and px ghost`, () => {
      const item = blueprintToToolbarItem(blueprint.id)!;
      expect(item).toBeTruthy();
      expect(item.elementType).toBe('div');
      expect(item.name).toBeTruthy();
      // Flow order belongs to the drop context, never the catalogue item.
      expect(item.defaultStyles.order).toBeUndefined();
      expect(item.ghostSize).toEqual({
        width: parseInt(blueprint.canvasSize.width, 10),
        height: parseInt(blueprint.canvasSize.height, 10),
      });
    });
  }

  it('children factory mints fresh ids on every call (repeat drops cannot collide)', () => {
    const item = blueprintToToolbarItem('header-editorial')!;
    const collectIds = (): string[] => {
      const ids: string[] = [];
      const walk = (list: ReturnType<NonNullable<typeof item.children>>) => {
        for (const d of list) {
          ids.push(d.id!);
          if (d.children) walk(d.children);
        }
      };
      walk(item.children!());
      return ids;
    };
    const first = collectIds();
    const second = collectIds();
    expect(new Set(first).size).toBe(first.length);
    expect(first.some((id) => second.includes(id))).toBe(false);
  });

  it('svg logo geometry survives into the descriptor tree', () => {
    const item = blueprintToToolbarItem('header-glass')!;
    let d: string | undefined;
    const walk = (list: ReturnType<NonNullable<typeof item.children>>) => {
      for (const desc of list) {
        if (desc.tag === 'path') d = desc.attrs?.d;
        if (desc.children) walk(desc.children);
      }
    };
    walk(item.children!());
    expect(d).toContain('M11 0');
  });

  it('loads the declared fonts at drag start', () => {
    vi.clearAllMocks();
    blueprintToToolbarItem('header-glass');
    expect(vi.mocked(loadGoogleFont).mock.calls.map((c) => c[0])).toEqual(['Plus Jakarta Sans', 'Inter']);
    expect(ensureGoogleFontImport).toHaveBeenCalledWith('Plus Jakarta Sans');
  });

  it('unknown blueprint id returns null', () => {
    expect(blueprintToToolbarItem('nope')).toBeNull();
  });
});

describe('insertSectionBlueprint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts through the paste pipe and loads the declared fonts', () => {
    const created = insertSectionBlueprint('hero-editorial');
    expect(created).toEqual(['new-root-id']);
    expect(insertNodes).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(insertNodes).mock.calls[0][0];
    expect(payload[0].id).toBe('section-hero-editorial');
    expect(vi.mocked(loadGoogleFont).mock.calls.map((c) => c[0])).toEqual(['Bricolage Grotesque', 'Inter']);
    expect(ensureGoogleFontImport).toHaveBeenCalledWith('Bricolage Grotesque');
  });

  it('unknown blueprint id is a traced no-op', () => {
    expect(insertSectionBlueprint('nope')).toEqual([]);
    expect(insertNodes).not.toHaveBeenCalled();
  });
});
