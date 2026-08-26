import { describe, test, expect } from 'vitest';
import { resolveOverlaySize, resolveOverlayInsets } from './overlay-size';
import type { CanvasNode } from '@/code/parsing/parser';

// Minimal node shape — resolveOverlaySize only touches styles/conditionalStyles/
// responsive maps/hugDims.
const node = (over: Partial<CanvasNode>): CanvasNode => ({
  id: 'inst-1', type: 'div', parentId: null, children: [],
  styles: {}, attrs: {}, textContent: null, componentFile: 'components/FeGaXi.tsx',
  ...over,
} as unknown as CanvasNode);

const VPS = [
  { id: 'desktop', width: 1440, isPrimary: true },
  { id: 'variant-1', width: 1440, isPrimary: false },
];

describe('resolveOverlaySize — instance hug', () => {
  test('a hugged variant reports auto even though the bake made it definite', () => {
    const n = node({
      styles: { width: '719px', height: '419px' },
      conditionalStyles: { height: { 'variant-1': '219px' } },   // baked master value
      hugDims: { height: ['variant-1'] },
    });
    // replica tile: height must read as auto (hug), width stays definite
    expect(resolveOverlaySize(n, 'variant-1', VPS, true)).toEqual({ width: '719px', height: 'auto' });
    // primary tile: untouched
    expect(resolveOverlaySize(n, 'desktop', VPS, true)).toEqual({ width: '719px', height: '419px' });
  });

  test('a hugged base reports auto on the primary tile', () => {
    const n = node({
      styles: { width: '719px' },
      conditionalStyles: { height: { 'variant-1': '219px' } },
      hugDims: { height: ['default'] },
    });
    expect(resolveOverlaySize(n, 'desktop', VPS, true).height).toBe('auto');
    expect(resolveOverlaySize(n, 'variant-1', VPS, true).height).toBe('219px');
  });

  test('no hugDims → unchanged behaviour', () => {
    const n = node({ styles: { width: '100px', height: '50px' } });
    expect(resolveOverlaySize(n, 'desktop', VPS, true)).toEqual({ width: '100px', height: '50px' });
  });
});

describe('resolveOverlayInsets — resize-handle gate', () => {
  // The user's repro (2026-08-27): frame-mtani3vl-2 full-inset ONLY on the
  // tablet band (left/top/right/bottom + width/height auto), base carries
  // left/top + fixed size. Base-read inset checks saw no right/bottom while
  // resolveOverlaySize reported auto — every resize circle vanished.
  const PAGE_VPS = [
    { id: 'desktop', width: 1440, isPrimary: true },
    { id: 'tablet', width: 768, isPrimary: false },
  ];
  const bandOverrides = new Map([[
    'inst-1',
    new Map([[768, new Map(Object.entries({
      left: '230px', top: '64px', right: '246px', bottom: '56px',
      width: 'auto', height: 'auto',
    }))]]),
  ]]);
  const base = node({ styles: { position: 'absolute', left: '92px', top: '64px', width: '124px', height: '91px' } });

  test('full inset authored only on a replica band is detected on that tile', () => {
    expect(resolveOverlayInsets(base, 'tablet', PAGE_VPS, false, bandOverrides))
      .toEqual({ hasHInset: true, hasVInset: true });
  });

  test('primary tile ignores the band — no insets from base left/top alone', () => {
    expect(resolveOverlayInsets(base, 'desktop', PAGE_VPS, false, bandOverrides))
      .toEqual({ hasHInset: false, hasVInset: false });
  });

  test('band auto values do not count as set', () => {
    const ov = new Map([[
      'inst-1',
      new Map([[768, new Map(Object.entries({ right: 'auto', bottom: 'auto' }))]]),
    ]]);
    const n = node({ styles: { position: 'absolute', left: '10px', top: '10px', right: '40px', bottom: '40px' } });
    expect(resolveOverlayInsets(n, 'tablet', PAGE_VPS, false, ov))
      .toEqual({ hasHInset: false, hasVInset: false });
  });

  test('component variant entry insets are detected on the variant tile', () => {
    const n = node({
      styles: { position: 'absolute', left: '10px', top: '10px', width: '64px', height: '64px' },
      motionVariants: {
        default: {},
        'variant-1': { left: '5px', right: '9px', top: '5px', bottom: '9px' },
      },
    });
    expect(resolveOverlayInsets(n, 'variant-1', VPS, true))
      .toEqual({ hasHInset: true, hasVInset: true });
    expect(resolveOverlayInsets(n, 'desktop', VPS, true))
      .toEqual({ hasHInset: false, hasVInset: false });
  });

  test('variant entry auto masks a base inset on that tile', () => {
    const n = node({
      styles: { position: 'absolute', left: '10px', right: '40px', top: '10px', bottom: '40px' },
      motionVariants: { default: {}, 'variant-1': { right: 'auto', bottom: 'auto' } },
    });
    expect(resolveOverlayInsets(n, 'variant-1', VPS, true))
      .toEqual({ hasHInset: false, hasVInset: false });
    expect(resolveOverlayInsets(n, 'desktop', VPS, true))
      .toEqual({ hasHInset: true, hasVInset: true });
  });
});
