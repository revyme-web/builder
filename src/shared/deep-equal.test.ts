import { describe, it, expect } from 'vitest';
import { deepEqualPlain } from './deep-equal';

describe('deepEqualPlain', () => {
  it('primitives + Object.is semantics', () => {
    expect(deepEqualPlain('a', 'a')).toBe(true);
    expect(deepEqualPlain('a', 'b')).toBe(false);
    expect(deepEqualPlain(1, 1)).toBe(true);
    expect(deepEqualPlain(0, -0)).toBe(false); // Object.is
    expect(deepEqualPlain(NaN, NaN)).toBe(true); // Object.is
    expect(deepEqualPlain(null, null)).toBe(true);
    expect(deepEqualPlain(undefined, undefined)).toBe(true);
    expect(deepEqualPlain(null, undefined)).toBe(false);
    expect(deepEqualPlain(null, {})).toBe(false);
    expect(deepEqualPlain(1, '1')).toBe(false);
    expect(deepEqualPlain(true, 1)).toBe(false);
  });

  it('arrays: order + length + deep members', () => {
    expect(deepEqualPlain([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqualPlain([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(deepEqualPlain([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqualPlain([], [])).toBe(true);
    expect(deepEqualPlain([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(deepEqualPlain([{ a: 1 }], [{ a: 2 }])).toBe(false);
    expect(deepEqualPlain([1], { 0: 1, length: 1 })).toBe(false); // array vs array-like
  });

  it('plain objects: keys + nested values', () => {
    expect(deepEqualPlain({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(true); // key order irrelevant
    expect(deepEqualPlain({ a: 1 }, { a: 1, b: undefined })).toBe(false); // extra (even undefined) key
    expect(deepEqualPlain({ a: { b: { c: [1] } } }, { a: { b: { c: [1] } } })).toBe(true);
    expect(deepEqualPlain({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(deepEqualPlain({}, {})).toBe(true);
  });

  it('Set support (CanvasNode.hiddenOnVariants)', () => {
    expect(deepEqualPlain(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(deepEqualPlain(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(deepEqualPlain(new Set(), new Set())).toBe(true);
    expect(deepEqualPlain(new Set(['a']), ['a'])).toBe(false);
    expect(deepEqualPlain(new Set(['a']), { a: true })).toBe(false);
  });

  it('rejects exotic objects conservatively (no false positives)', () => {
    expect(deepEqualPlain(new Date(0), new Date(0))).toBe(false); // not plain — bail false
    expect(deepEqualPlain(new Map(), new Map())).toBe(false);
    class Node { a = 1; }
    expect(deepEqualPlain(new Node(), { a: 1 })).toBe(false); // class vs plain
  });

  it('realistic CanvasNode-shaped comparison', () => {
    const mk = () => ({
      id: 'frame-1', type: 'div', name: 'Frame', parentId: 'root',
      children: ['a', 'b'],
      styles: { position: 'relative', width: '100px', backgroundColor: '#fff' },
      attrs: {}, textContent: '', hasMixedContent: false, order: 0,
      isCanvasNode: false, componentFile: null, componentInstanceId: null,
      isComponentRoot: false, motionVariants: { default: { height: '80px' } },
      motionVariantsRef: null, motionProps: null, responsiveVariantMap: null,
      conditionalStyles: null, hiddenOnVariants: new Set(['variant-2']),
      inlineMapData: [{ title: 'One' }, { title: 'Two' }],
    });
    expect(deepEqualPlain(mk(), mk())).toBe(true);
    const changed = mk();
    changed.styles.width = '101px';
    expect(deepEqualPlain(mk(), changed)).toBe(false);
    const moved = mk();
    moved.parentId = 'other';
    expect(deepEqualPlain(mk(), moved)).toBe(false);
    const reordered = mk();
    reordered.children = ['b', 'a'];
    expect(deepEqualPlain(mk(), reordered)).toBe(false);
  });
});
