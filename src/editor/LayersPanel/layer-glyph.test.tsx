// layer-glyph.test.tsx — a frame's layers icon reflects its LAYOUT.
//
// Plain frame → the crop-mark outline (unchanged). Flex frame → three columns.
// Grid frame → a 2x2 cell field. The display is resolved for the row's OWN
// viewport/variant (shared with the eye state), so a frame that's flex only on
// `variant-1` carries the flex glyph there and the plain one elsewhere.

import { describe, it, expect } from 'vitest';
import { resolveDisplayForLayer, getEffectiveLayerStyle } from './rows';
import type { CanvasNode } from '@/code/parsing/parser';

const node = (styles: Record<string, string>, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id: 'n', type: 'div', name: 'n', parentId: 'root', children: [], styles, attrs: {}, ...extra }) as unknown as CanvasNode;

const vpConfigs = [
  { id: 'desktop', width: 1440, isPrimary: true },
  { id: 'tablet', width: 768, isPrimary: false },
];
const noOverrides = new Map<string, Map<number, Map<string, string>>>();

describe('resolveDisplayForLayer surfaces the resolved display', () => {
  it('returns the base display for a plain frame', () => {
    const r = resolveDisplayForLayer(node({ display: 'block' }), 'desktop', vpConfigs, noOverrides, false);
    expect(r.display).toBe('block');
    expect(r.isHidden).toBe(false);
  });

  it('returns flex / grid so the glyph can branch', () => {
    expect(resolveDisplayForLayer(node({ display: 'flex' }), 'desktop', vpConfigs, noOverrides, false).display).toBe('flex');
    expect(resolveDisplayForLayer(node({ display: 'grid' }), 'desktop', vpConfigs, noOverrides, false).display).toBe('grid');
  });

  it('resolves the ROW\'s viewport, not the primary', () => {
    // Tablet flips the frame to grid via an @media override.
    const overrides = new Map([['n', new Map([[768, new Map([['display', 'grid']])]])]]);
    const n = node({ display: 'flex' });
    expect(resolveDisplayForLayer(n, 'desktop', vpConfigs, overrides, false).display).toBe('flex');
    expect(resolveDisplayForLayer(n, 'tablet', vpConfigs, overrides, false).display).toBe('grid');
  });

  it('resolves a component VARIANT entry', () => {
    const n = node({ display: 'flex' }, {
      motionVariants: { default: {}, 'variant-1': { display: 'grid' } } as any,
    });
    expect(resolveDisplayForLayer(n, 'variant-1', [], noOverrides, true).display).toBe('grid');
  });

  it('a hidden row still reports display and stays hidden', () => {
    const n = node({ display: 'flex' }, { hiddenOnVariants: new Set(['variant-1']) as any });
    const r = resolveDisplayForLayer(n, 'variant-1', [], noOverrides, true);
    expect(r.isHidden).toBe(true);
    expect(r.display).toBe('none');
  });
});

// The glyph rule itself — kept as a pure predicate so it reads as a spec.
const glyphFor = (display?: string, flexDirection?: string): 'flex-row' | 'flex-column' | 'grid' | 'frame' => {
  const d = (display ?? '').trim();
  if (d === 'flex' || d === 'inline-flex') {
    return (flexDirection ?? '').trim().startsWith('column') ? 'flex-column' : 'flex-row';
  }
  if (d === 'grid' || d === 'inline-grid') return 'grid';
  return 'frame';
};

describe('frame glyph by layout', () => {
  it('splits flex by direction', () => {
    expect(glyphFor('flex', 'row')).toBe('flex-row');
    expect(glyphFor('flex', 'column')).toBe('flex-column');
  });

  it('defaults to row — the CSS initial value', () => {
    expect(glyphFor('flex')).toBe('flex-row');
    expect(glyphFor('flex', '')).toBe('flex-row');
  });

  it('handles the reverse directions', () => {
    expect(glyphFor('flex', 'column-reverse')).toBe('flex-column');
    expect(glyphFor('flex', 'row-reverse')).toBe('flex-row');
  });

  it('grid ignores direction', () => {
    expect(glyphFor('grid', 'column')).toBe('grid');
  });

  it('the inline variants count — they place children the same way', () => {
    expect(glyphFor('inline-flex', 'column')).toBe('flex-column');
    expect(glyphFor('inline-grid')).toBe('grid');
  });

  it('everything else keeps the plain frame icon', () => {
    for (const d of ['block', 'none', 'inline-block', '', undefined]) {
      expect(glyphFor(d)).toBe('frame');
    }
  });
});

// The direction has to be resolved for the row's OWN tile, exactly like display
// — a frame that's a row on desktop and a column on tablet must show both.
describe('getEffectiveLayerStyle — flexDirection per tile', () => {
  it('reads the @media override for a replica row', () => {
    const overrides = new Map([['n', new Map([[768, new Map([['flexDirection', 'column']])]])]]);
    const n = node({ display: 'flex', flexDirection: 'row' });
    expect(getEffectiveLayerStyle(n, 'flexDirection', 'desktop', vpConfigs, overrides, false)).toBe('row');
    expect(getEffectiveLayerStyle(n, 'flexDirection', 'tablet', vpConfigs, overrides, false)).toBe('column');
  });

  it('reads a per-variant conditional ternary on a master', () => {
    const n = node({ display: 'flex', flexDirection: 'row' }, {
      conditionalStyles: { flexDirection: { 'variant-1': 'column', default: 'row' } } as any,
    });
    expect(getEffectiveLayerStyle(n, 'flexDirection', 'variant-1', [], noOverrides, true)).toBe('column');
    expect(getEffectiveLayerStyle(n, 'flexDirection', 'desktop', [], noOverrides, true)).toBe('row');
  });

  it('falls back to the inline base when nothing overrides it', () => {
    const n = node({ display: 'flex', flexDirection: 'column' });
    expect(getEffectiveLayerStyle(n, 'flexDirection', 'desktop', vpConfigs, noOverrides, false)).toBe('column');
  });
});
