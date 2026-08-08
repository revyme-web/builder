// replica-bake.test.ts — a clone must carry the TILE's values, not the primary's.
//
// User report 2026-08-08, two shapes of one bug:
//   1. Alt-drag duplicate of a Button on component variant `variant-2`, where
//      the source has `width: variant === 'variant-2' ? '100%' : ''` → the
//      duplicate came out auto-width.
//   2. Alt-drag duplicate of a hero text on the tablet page replica, where the
//      tablet @media band shrinks the font → the duplicate came out at desktop
//      size.
// Both because every per-tile channel is addressed by the SOURCE's data-id and
// the clone gets a fresh one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ContainerOverrideMap } from '@/code/stores/container-query-store';
import {
  bakeStylesForTile, bakeTextForTile, bakeAttrsForTile, bakeNodeForTile,
  tileContextFor, type TileContext,
} from './replica-bake';

function nodeWith(partial: Partial<CanvasNode>): CanvasNode {
  return {
    id: 'n', type: 'div', name: 'n', parentId: null, children: [],
    styles: {}, attrs: {}, textContent: '', hasMixedContent: false,
    ...partial,
  } as unknown as CanvasNode;
}

/** Build the `@media` override map shape the container-query store produces. */
function overridesFor(nodeId: string, width: number, props: Record<string, string>): ContainerOverrideMap {
  return new Map([[nodeId, new Map([[width, new Map(Object.entries(props))]])]]) as ContainerOverrideMap;
}

const viewportTile = (vpWidth: number, overrides: ContainerOverrideMap, allWidths = [375, 768, 1440]): TileContext =>
  ({ kind: 'viewport', vpWidth, overrides, allWidths });

// ─── Styles ─────────────────────────────────────────────────────────────────

describe('bakeStylesForTile — component variant', () => {
  it('bakes an inline variant ternary (the 100%-wide button)', () => {
    // `width: variant === 'variant-2' ? '100%' : ''` parses into conditionalStyles.
    const node = nodeWith({
      styles: { position: 'relative', zIndex: '1', flex: '0 0 auto' },
      conditionalStyles: { width: { 'variant-2': '100%', 'variant-1': '100%', default: '' } } as any,
    });
    expect(bakeStylesForTile(node, { kind: 'variant', variant: 'variant-2' }).width).toBe('100%');
    // The default tile keeps the primary's (empty) value — nothing invented.
    expect(bakeStylesForTile(node, { kind: 'variant', variant: 'default' }).width).toBe('');
  });

  it('bakes the variants object: own entry over always-on default over base', () => {
    const node = nodeWith({
      styles: { paddingTop: '0px', backgroundColor: 'red' },
      motionVariants: {
        default: { paddingTop: '12px' },
        'variant-2': { paddingTop: '24px', backgroundColor: 'blue' },
      } as any,
    });
    const v2 = bakeStylesForTile(node, { kind: 'variant', variant: 'variant-2' });
    expect(v2.paddingTop).toBe('24px');
    expect(v2.backgroundColor).toBe('blue');
    // `animate={['default', variant]}` makes the default entry always-on, so it
    // is a real paint layer even on the primary tile.
    expect(bakeStylesForTile(node, { kind: 'variant', variant: 'default' }).paddingTop).toBe('12px');
  });

  it('a child hidden on this variant bakes display:none (stays invisible in the copy)', () => {
    const node = nodeWith({
      styles: { display: 'flex' },
      hiddenOnVariants: new Set(['variant-2']) as any,
    });
    expect(bakeStylesForTile(node, { kind: 'variant', variant: 'variant-2' }).display).toBe('none');
    expect(bakeStylesForTile(node, { kind: 'variant', variant: 'variant-1' }).display).toBe('flex');
  });

  it('never mutates the node (the Renderer memoizes its result)', () => {
    const node = nodeWith({ styles: { width: '10px' } });
    const baked = bakeStylesForTile(node, { kind: 'variant', variant: 'default' });
    baked.width = '999px';
    expect(node.styles.width).toBe('10px');
  });
});

describe('bakeStylesForTile — page replica', () => {
  it('overlays the tile @media band (the tablet font-size override)', () => {
    const node = nodeWith({
      id: 'hero-text',
      styles: { fontSize: '64px', color: 'white' },
    });
    const baked = bakeStylesForTile(node, viewportTile(768, overridesFor('hero-text', 768, { fontSize: '28px' })));
    expect(baked.fontSize).toBe('28px');
    expect(baked.color).toBe('white');
  });

  it('a band belonging to another viewport is not applied', () => {
    const node = nodeWith({ id: 'hero-text', styles: { fontSize: '64px' } });
    const baked = bakeStylesForTile(node, viewportTile(768, overridesFor('hero-text', 375, { fontSize: '20px' })));
    expect(baked.fontSize).toBe('64px');
  });

  it('a solo-on-this-replica child resolves its unhide, not its display:none baseline', () => {
    const node = nodeWith({ id: 'only-tablet', styles: { display: 'none' } });
    const baked = bakeStylesForTile(node, viewportTile(768, overridesFor('only-tablet', 768, { display: 'flex' })));
    expect(baked.display).toBe('flex');
  });

  it('primary tile is a pass-through', () => {
    const node = nodeWith({ styles: { fontSize: '64px' } });
    expect(bakeStylesForTile(node, { kind: 'primary' })).toEqual({ fontSize: '64px' });
  });
});

// ─── Text ───────────────────────────────────────────────────────────────────

describe('bakeTextForTile', () => {
  it('resolves per-variant text, falling back to the default branch', () => {
    const node = nodeWith({
      textContent: 'Book a Call',
      conditionalText: { 'variant-2': 'Get Started', default: 'Book a Call' } as any,
    });
    expect(bakeTextForTile(node, { kind: 'variant', variant: 'variant-2' })).toBe('Get Started');
    expect(bakeTextForTile(node, { kind: 'variant', variant: 'variant-9' })).toBe('Book a Call');
  });

  it('resolves the useResponsiveText bucket for the tile width', () => {
    const node = nodeWith({
      textContent: 'Ready to scale your brand with paid ads?',
      textOverrides: { '768': 'Ready to scale?' } as any,
    });
    const overrides = new Map() as ContainerOverrideMap;
    expect(bakeTextForTile(node, viewportTile(768, overrides))).toBe('Ready to scale?');
    // A viewport with no override of its own keeps the primary copy.
    expect(bakeTextForTile(node, viewportTile(1440, overrides))).toBe('Ready to scale your brand with paid ads?');
  });

  it('a resolved-but-empty entry wins — a variant that shows nothing stays empty', () => {
    const node = nodeWith({
      textContent: 'Hello',
      conditionalText: { 'variant-2': '', default: 'Hello' } as any,
    });
    expect(bakeTextForTile(node, { kind: 'variant', variant: 'variant-2' })).toBeUndefined();
  });
});

// ─── Attrs ──────────────────────────────────────────────────────────────────

describe('bakeAttrsForTile', () => {
  it('resolves a per-variant instance prop (the duplicated Button rendered the wrong variant)', () => {
    // `initialVariant={variant === 'variant-2' ? 'variant-3' : 'default'}` — the
    // parser parks the DEFAULT branch in attrs, so an unbaked clone said "default".
    const node = nodeWith({
      attrs: { initialVariant: 'default' },
      attrConditional: { initialVariant: { 'variant-2': 'variant-3', default: 'default' } } as any,
    });
    expect(bakeAttrsForTile(node, { kind: 'variant', variant: 'variant-2' })!.initialVariant).toBe('variant-3');
    expect(bakeAttrsForTile(node, { kind: 'variant', variant: 'default' })!.initialVariant).toBe('default');
  });

  it('resolves a responsive raw-element attr for the tile width', () => {
    const node = nodeWith({
      attrs: { type: 'text' },
      responsiveAttrs: { type: { viewport: { 375: 'date' }, variant: {} } } as any,
    });
    const overrides = new Map() as ContainerOverrideMap;
    expect(bakeAttrsForTile(node, viewportTile(375, overrides))!.type).toBe('date');
    expect(bakeAttrsForTile(node, viewportTile(1440, overrides))!.type).toBe('text');
  });

  it('does not invent a prop the clone never carried', () => {
    // `speed` lives in componentProps (numeric) — writing it as a string attr
    // would hand the component a string where it wants a number.
    const node = nodeWith({
      attrs: { 'data-name': 'Marquee' },
      responsiveAttrPropValues: { speed: { 375: '5' } } as any,
    });
    const baked = bakeAttrsForTile(node, viewportTile(375, new Map() as ContainerOverrideMap))!;
    expect(baked.speed).toBeUndefined();
  });
});

// ─── Tile context ───────────────────────────────────────────────────────────

vi.mock('@/code/project/active-file-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/code/project/active-file-store')>()),
  isComponentFilePath: (p: string) => p.includes('/components/'),
}));

describe('tileContextFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a component master resolves variants — including the always-on default', () => {
    const widths = { desktop: 1440, 'variant-1': 375 };
    expect(tileContextFor('variant-1', '/components/Header.tsx', widths))
      .toEqual({ kind: 'variant', variant: 'variant-1' });
    expect(tileContextFor('desktop', '/components/Header.tsx', widths))
      .toEqual({ kind: 'variant', variant: 'default' });
  });

  it('a page replica resolves a viewport with an ascending width ladder', () => {
    const tile = tileContextFor('tablet', '/app/page.tsx', { desktop: 1440, tablet: 768, mobile: 375 });
    expect(tile.kind).toBe('viewport');
    if (tile.kind !== 'viewport') throw new Error('unreachable');
    expect(tile.vpWidth).toBe(768);
    expect(tile.allWidths).toEqual([375, 768, 1440]);
  });

  it('a page primary needs no resolution', () => {
    expect(tileContextFor('desktop', '/app/page.tsx', { desktop: 1440 })).toEqual({ kind: 'primary' });
  });
});

// ─── The whole node ─────────────────────────────────────────────────────────

describe('bakeNodeForTile', () => {
  it('resolves styles, text and attrs together', () => {
    const node = nodeWith({
      styles: { width: '73px' },
      textContent: 'Book a Call',
      attrs: { initialVariant: 'default' },
      conditionalStyles: { width: { 'variant-2': '100%', default: '73px' } } as any,
      conditionalText: { 'variant-2': 'Get Started', default: 'Book a Call' } as any,
      attrConditional: { initialVariant: { 'variant-2': 'variant-3', default: 'default' } } as any,
    });
    expect(bakeNodeForTile(node, { kind: 'variant', variant: 'variant-2' })).toEqual({
      styles: { width: '100%' },
      textContent: 'Get Started',
      attrs: { initialVariant: 'variant-3' },
    });
  });
});
