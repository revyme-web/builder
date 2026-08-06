// hiddenOnVariants must be the FINAL style layer in resolveVariantStyles.
// The hide used to merge into baseStyles BEFORE the motionVariants merge —
// a node whose DEFAULT variant entry carries its own `display: 'flex'`
// (Layout writes park display there) then overrode the hide, and a "Hide
// Yes" on a variant tile hid on live (real React unmount) but the canvas
// tile still showed the node (user report 2026-08-06, Nav Button container
// hidden on Mobile-open).

import { describe, it, expect } from 'vitest';
import { resolveVariantStyles } from './Renderer';
import type { CanvasNode } from '@/code/parsing/parser';

function makeNode(partial: Partial<CanvasNode>): CanvasNode {
  return {
    id: 'n1', type: 'div', name: 'n1', parentId: null, children: [],
    styles: {}, attrs: {}, textContent: '', hasMixedContent: false,
    ...partial,
  } as unknown as CanvasNode;
}

describe('resolveVariantStyles — hiddenOnVariants is the final word', () => {
  it('hides even when the DEFAULT variant entry carries display:flex', () => {
    const node = makeNode({
      styles: { position: 'relative' },
      motionVariants: {
        default: { display: 'flex', maxWidth: '1280px' },
        'variant-5': { paddingTop: '16px' },
      } as any,
      hiddenOnVariants: new Set(['variant-4', 'variant-5']),
    });
    const resolved = resolveVariantStyles(node, 'variant-5');
    expect(resolved.display).toBe('none');
  });

  it('hides even when the ACTIVE variant entry carries its own display', () => {
    const node = makeNode({
      motionVariants: {
        default: {},
        'variant-1': { display: 'grid' },
      } as any,
      hiddenOnVariants: new Set(['variant-1']),
    });
    expect(resolveVariantStyles(node, 'variant-1').display).toBe('none');
  });

  it('non-hidden variants keep the merged display', () => {
    const node = makeNode({
      styles: { position: 'relative' },
      motionVariants: {
        default: { display: 'flex' },
        'variant-5': {},
      } as any,
      hiddenOnVariants: new Set(['variant-5']),
    });
    expect(resolveVariantStyles(node, 'variant-1').display).toBe('flex');
    expect(resolveVariantStyles(node, 'default').display).toBe('flex');
  });

  it('nodes without motionVariants still hide (plain conditional render)', () => {
    const node = makeNode({
      styles: { display: 'flex' },
      hiddenOnVariants: new Set(['variant-2']),
    });
    expect(resolveVariantStyles(node, 'variant-2').display).toBe('none');
  });
});
