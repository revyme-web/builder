// ghost-id.test.ts — pure-function unit tests for the ghost-id helpers.

import { describe, it, expect } from 'vitest';
import { isGhostNodeId, getGhostIndex, stripGhostSuffix, makeGhostId } from './ghost-id';

describe('isGhostNodeId', () => {
  it('returns true for ids with a __N suffix', () => {
    expect(isGhostNodeId('card1__1')).toBe(true);
    expect(isGhostNodeId('card1-title__12')).toBe(true);
    expect(isGhostNodeId('a__0')).toBe(true);
  });

  it('returns false for canonical ids', () => {
    expect(isGhostNodeId('card1')).toBe(false);
    expect(isGhostNodeId('card1-title')).toBe(false);
    expect(isGhostNodeId('root')).toBe(false);
  });

  it('returns false for ids with __ but no trailing digits', () => {
    expect(isGhostNodeId('card__title')).toBe(false);
    expect(isGhostNodeId('foo__bar')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGhostNodeId('')).toBe(false);
  });
});

describe('getGhostIndex', () => {
  it('returns the numeric index from a ghost id', () => {
    expect(getGhostIndex('card1__1')).toBe(1);
    expect(getGhostIndex('card1-title__42')).toBe(42);
    expect(getGhostIndex('a__0')).toBe(0);
  });

  it('returns null for canonical ids', () => {
    expect(getGhostIndex('card1')).toBeNull();
    expect(getGhostIndex('card1-title')).toBeNull();
  });

  it('returns null for non-numeric suffix patterns', () => {
    expect(getGhostIndex('card__abc')).toBeNull();
    expect(getGhostIndex('card__1a')).toBeNull();
  });
});

describe('stripGhostSuffix', () => {
  it('strips the __N suffix from a ghost id', () => {
    expect(stripGhostSuffix('card1__1')).toBe('card1');
    expect(stripGhostSuffix('card1-title__42')).toBe('card1-title');
  });

  it('returns canonical ids unchanged', () => {
    expect(stripGhostSuffix('card1')).toBe('card1');
    expect(stripGhostSuffix('card1-title')).toBe('card1-title');
  });

  it('only strips the trailing match — preserves embedded __ patterns', () => {
    // Hypothetical id with __ inside but a real ghost suffix at the end.
    expect(stripGhostSuffix('foo__bar__3')).toBe('foo__bar');
  });
});

describe('makeGhostId', () => {
  it('appends __N for indices > 0', () => {
    expect(makeGhostId('card1', 1)).toBe('card1__1');
    expect(makeGhostId('card1', 5)).toBe('card1__5');
  });

  it('returns the canonical id for index 0 (the template itself)', () => {
    expect(makeGhostId('card1', 0)).toBe('card1');
  });

  it('round-trips with stripGhostSuffix / getGhostIndex', () => {
    const ghost = makeGhostId('card1-title', 3);
    expect(stripGhostSuffix(ghost)).toBe('card1-title');
    expect(getGhostIndex(ghost)).toBe(3);
  });
});
