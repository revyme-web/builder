import { describe, it, expect } from 'vitest';
import { isOutOfCreditsError } from './credits-store';

describe('isOutOfCreditsError', () => {
  // The exact sentence the AI service's shared `refuseIfOutOfCredits` helper
  // returns on 402. If this ever stops matching, every chat panel silently
  // falls back to the red error bubble instead of the top-up card.
  it('matches the sentence the AI service actually sends', () => {
    expect(isOutOfCreditsError(
      'Out of credits — top up in Settings → Credits to keep using AI.',
    )).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding text', () => {
    expect(isOutOfCreditsError('Error: out of credits')).toBe(true);
    expect(isOutOfCreditsError('workspace is OUT OF CREDITS, sorry')).toBe(true);
  });

  // Must NOT swallow unrelated failures — those still deserve the red bubble
  // with their real message, which is what the user debugs from.
  it('ignores other errors', () => {
    expect(isOutOfCreditsError('HTTP 404')).toBe(false);
    expect(isOutOfCreditsError('OpenRouter 402: This request requires more credits')).toBe(false);
    expect(isOutOfCreditsError('Missing required field: contents')).toBe(false);
  });

  it('handles null/undefined/empty', () => {
    expect(isOutOfCreditsError(null)).toBe(false);
    expect(isOutOfCreditsError(undefined)).toBe(false);
    expect(isOutOfCreditsError('')).toBe(false);
  });
});
