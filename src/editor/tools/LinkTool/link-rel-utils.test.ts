import { describe, test, expect } from 'vitest';
import { REL_OPTIONS, parseRelTokens, formatRelTokens, relLabel, nonUserRelTokens, isUserRelToken } from './link-rel-utils';

describe('link-rel-utils', () => {
  test('REL_OPTIONS exposes the 5 user tokens', () => {
    expect(REL_OPTIONS.map((o) => o.token)).toEqual(['nofollow', 'noreferrer', 'me', 'ugc', 'sponsored']);
  });

  test('parseRelTokens splits + de-dupes preserving order', () => {
    expect(parseRelTokens('nofollow  noreferrer nofollow')).toEqual(['nofollow', 'noreferrer']);
    expect(parseRelTokens('')).toEqual([]);
    expect(parseRelTokens('   ')).toEqual([]);
  });

  test('formatRelTokens joins + de-dupes', () => {
    expect(formatRelTokens(['ugc', 'me', 'ugc'])).toBe('ugc me');
  });

  test('relLabel maps tokens to labels, falls back to raw', () => {
    expect(relLabel('nofollow')).toBe('No Follow');
    expect(relLabel('noopener')).toBe('noopener');
  });

  test('nonUserRelTokens preserves non-user tokens (e.g. noopener)', () => {
    expect(nonUserRelTokens('noopener noreferrer ugc')).toEqual(['noopener']);
  });

  test('isUserRelToken', () => {
    expect(isUserRelToken('ugc')).toBe(true);
    expect(isUserRelToken('noopener')).toBe(false);
  });
});
