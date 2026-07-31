import { describe, it, expect } from 'vitest';
import { resolveMultiSelectLayoutType } from './multi-select-layout';

const disp = (map: Record<string, string>) => (id: string) => map[id] ?? '';
/** Default: everything in the selection is a frame that could hold a layout. */
const allFrames = () => true;
const noFrames = () => false;

describe('resolveMultiSelectLayoutType', () => {
  it('all flex → "flex"', () => {
    expect(resolveMultiSelectLayoutType(['a', 'b', 'c'], disp({ a: 'flex', b: 'flex', c: 'inline-flex' }), allFrames)).toBe('flex');
  });

  it('all grid → "grid"', () => {
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'grid', b: 'inline-grid' }), allFrames)).toBe('grid');
  });

  it('mixed flex + grid → null (hidden)', () => {
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'flex', b: 'grid' }), allFrames)).toBeNull();
  });

  it('some have layout, some do not → null (hidden)', () => {
    expect(resolveMultiSelectLayoutType(['a', 'b', 'c'], disp({ a: 'flex', b: 'flex', c: 'block' }), allFrames)).toBeNull();
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'grid', b: '' }), allFrames)).toBeNull();
  });

  // 2026-07-25: this used to be null (tool hidden). Plain frames with NO layout
  // are exactly when bulk-adding one is most useful, so it now reports the ADD
  // state and PropertiesPanel shows the tool with its `+`.
  it('none have layout but all are frames → "none" (ADD state)', () => {
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'block', b: 'inline' }), allFrames)).toBe('none');
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: '', b: '' }), allFrames)).toBe('none');
  });

  it('none have layout but something cannot HOLD one → null (hidden)', () => {
    // A text / svg / image in the selection: "add layout to all" would skip it.
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'block', b: 'block' }), noFrames)).toBeNull();
    const onlyAIsFrame = (id: string) => id === 'a';
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'block', b: 'block' }), onlyAIsFrame)).toBeNull();
  });

  it('a laid-out node mixed with plain frames stays hidden', () => {
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'block', b: 'flex' }), allFrames)).toBeNull();
    expect(resolveMultiSelectLayoutType(['a', 'b'], disp({ a: 'flex', b: 'block' }), allFrames)).toBeNull();
  });

  it('empty selection → null', () => {
    expect(resolveMultiSelectLayoutType([], disp({}), allFrames)).toBeNull();
  });

  it('single flex still resolves (caller gates on isMultiSelect separately)', () => {
    expect(resolveMultiSelectLayoutType(['a'], disp({ a: 'flex' }), allFrames)).toBe('flex');
  });
});
