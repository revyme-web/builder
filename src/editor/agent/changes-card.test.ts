import { describe, test, expect } from 'vitest';
import { layerCount, revealTarget, type ChangedFile } from './ChangesCard';

const f = (over: Partial<ChangedFile> = {}): ChangedFile => ({ path: 'app/page.client.tsx', ...over });

describe('layerCount', () => {
  test('sums everything that moved', () => {
    expect(layerCount(f({ addedIds: ['a', 'b'], changedIds: ['c'], removedIds: ['d'] }))).toBe(4);
  });

  // file-diff reports a file it could not parse with empty id sets. It still
  // changed, so the row stays — but a confident "0 Layers" would read as
  // "nothing happened", which is the opposite of true.
  test('an unparseable file counts zero rather than guessing', () => {
    expect(layerCount(f())).toBe(0);
  });
});

describe('revealTarget', () => {
  test('prefers something ADDED — the new thing worth looking at', () => {
    expect(revealTarget(f({ addedIds: ['new'], changedIds: ['old'] }))).toBe('new');
  });

  test('falls back to something changed', () => {
    expect(revealTarget(f({ changedIds: ['old'] }))).toBe('old');
  });

  // Selecting a deleted id silently does nothing, which makes the row feel
  // broken. Better to render it unclickable.
  test('NEVER targets a removed id', () => {
    expect(revealTarget(f({ removedIds: ['gone'] }))).toBeNull();
  });

  test('a file with no ids is not navigable', () => {
    expect(revealTarget(f())).toBeNull();
  });
});
