import { describe, test, expect } from 'vitest';
import { fieldDropTargets } from './cms-field-reorder';

describe('fieldDropTargets', () => {
  const ids = ['quote', 'name', 'company', 'avatar']; // name = title (first text field)
  test('a text field may only land after the title', () => {
    expect([...fieldDropTargets(ids, 'name', true)]).toEqual(['company', 'avatar']);
  });
  test('a non-text field may land anywhere, including above the title', () => {
    expect([...fieldDropTargets(ids, 'name', false)]).toEqual(ids);
  });
  test('no title field → every row', () => {
    expect([...fieldDropTargets(ids, null, true)]).toEqual(ids);
    expect([...fieldDropTargets(ids, 'ghost', true)]).toEqual(ids);
  });
});
