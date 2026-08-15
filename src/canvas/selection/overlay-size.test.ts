import { describe, test, expect } from 'vitest';
import { resolveOverlaySize } from './overlay-size';
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
