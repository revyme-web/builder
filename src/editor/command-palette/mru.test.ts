// mru.test.ts — The MRU list is a convenience, so the contract that
// matters most is that it never throws: a full or unavailable
// localStorage must degrade to "no recents", not break cmd+K.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { getRecentIds, recordRecent, __resetMru } from './mru';

beforeEach(() => __resetMru());
afterEach(() => vi.restoreAllMocks());

describe('mru', () => {
  it('starts empty', () => {
    expect(getRecentIds()).toEqual([]);
  });

  it('returns most-recent first', () => {
    recordRecent('a');
    recordRecent('b');
    expect(getRecentIds()).toEqual(['b', 'a']);
  });

  it('promotes an existing id instead of duplicating it', () => {
    recordRecent('a');
    recordRecent('b');
    recordRecent('a');
    expect(getRecentIds()).toEqual(['a', 'b']);
  });

  it('bounds the list', () => {
    for (let i = 0; i < 50; i++) recordRecent(`id-${i}`);
    expect(getRecentIds().length).toBeLessThanOrEqual(20);
    // Newest survives, oldest is evicted.
    expect(getRecentIds()[0]).toBe('id-49');
    expect(getRecentIds()).not.toContain('id-0');
  });

  it('survives localStorage.setItem throwing (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => recordRecent('a')).not.toThrow();
    // Still served from the in-memory cache for this session.
    expect(getRecentIds()).toEqual(['a']);
  });

  it('treats corrupt persisted JSON as empty', () => {
    localStorage.setItem('revyme:palette:mru', '{not json');
    __resetMru.call(null);
    // Re-read after clearing the cache but leaving the bad value.
    localStorage.setItem('revyme:palette:mru', '{not json');
    expect(() => getRecentIds()).not.toThrow();
  });

  it('ignores non-string entries in persisted data', () => {
    localStorage.setItem('revyme:palette:mru', JSON.stringify(['ok', 42, null]));
    expect(getRecentIds()).toEqual(['ok']);
  });
});
