import { describe, it, expect } from 'vitest';
import {
  audienceIsEmpty,
  normalizeAudience,
  matchesAudience,
  type AbAudience,
} from './audience-match';

describe('audienceIsEmpty', () => {
  it('treats null/undefined/empty as empty', () => {
    expect(audienceIsEmpty(null)).toBe(true);
    expect(audienceIsEmpty(undefined)).toBe(true);
    expect(audienceIsEmpty({})).toBe(true);
    expect(audienceIsEmpty({ country: [], device: [], source: [], cookie: '' })).toBe(true);
    expect(audienceIsEmpty({ cookie: '   ' })).toBe(true);
  });

  it('returns false when any dimension has a value', () => {
    expect(audienceIsEmpty({ country: ['US'] })).toBe(false);
    expect(audienceIsEmpty({ device: ['mobile'] })).toBe(false);
    expect(audienceIsEmpty({ source: ['google.com'] })).toBe(false);
    expect(audienceIsEmpty({ cookie: 'utm=x' })).toBe(false);
  });
});

describe('normalizeAudience', () => {
  it('returns null for empty input', () => {
    expect(normalizeAudience(null)).toBeNull();
    expect(normalizeAudience({})).toBeNull();
    expect(normalizeAudience({ country: [], cookie: '' })).toBeNull();
  });

  it('uppercases country codes and dedupes', () => {
    const r = normalizeAudience({ country: ['us', 'US', ' ca '] });
    expect(r?.country).toEqual(['US', 'CA']);
  });

  it('lowercases sources and strips www.', () => {
    const r = normalizeAudience({ source: ['Google.com', 'www.google.com', 'BING.COM'] });
    expect(r?.source).toEqual(['google.com', 'bing.com']);
  });

  it('drops unknown device literals', () => {
    const r = normalizeAudience({ device: ['mobile', 'desktop', 'pager' as 'desktop'] });
    expect(r?.device).toEqual(['mobile', 'desktop']);
  });

  it('trims cookie whitespace', () => {
    const r = normalizeAudience({ cookie: '  utm=x  ' });
    expect(r?.cookie).toBe('utm=x');
  });
});

describe('matchesAudience', () => {
  it('matches everyone when audience is empty', () => {
    expect(matchesAudience(null, {})).toBe(true);
    expect(matchesAudience({}, { country: 'US' })).toBe(true);
  });

  it('country dimension', () => {
    const aud: AbAudience = { country: ['US', 'CA'] };
    expect(matchesAudience(aud, { country: 'US' })).toBe(true);
    expect(matchesAudience(aud, { country: 'ca' })).toBe(true); // case-insensitive
    expect(matchesAudience(aud, { country: 'GB' })).toBe(false);
    expect(matchesAudience(aud, {})).toBe(false); // missing
  });

  it('device dimension', () => {
    const aud: AbAudience = { device: ['mobile', 'tablet'] };
    expect(matchesAudience(aud, { device: 'mobile' })).toBe(true);
    expect(matchesAudience(aud, { device: 'desktop' })).toBe(false);
    expect(matchesAudience(aud, { device: 'bot' })).toBe(false);
    expect(matchesAudience(aud, {})).toBe(false);
  });

  it('source dimension normalizes www.', () => {
    const aud: AbAudience = { source: ['google.com'] };
    expect(matchesAudience(aud, { source: 'google.com' })).toBe(true);
    expect(matchesAudience(aud, { source: 'www.google.com' })).toBe(true);
    expect(matchesAudience(aud, { source: 'bing.com' })).toBe(false);
  });

  it('cookie dimension requires exact name=value pair', () => {
    const aud: AbAudience = { cookie: 'utm_source=email' };
    expect(matchesAudience(aud, { cookieHeader: 'utm_source=email' })).toBe(true);
    expect(matchesAudience(aud, { cookieHeader: 'a=1; utm_source=email; b=2' })).toBe(true);
    expect(matchesAudience(aud, { cookieHeader: 'utm_source=organic' })).toBe(false);
    // No false-positive substring matches
    expect(matchesAudience(aud, { cookieHeader: 'xutm_source=emailx' })).toBe(false);
    expect(matchesAudience(aud, {})).toBe(false);
  });

  it('every populated dimension must match (AND)', () => {
    const aud: AbAudience = { country: ['US'], device: ['mobile'] };
    expect(matchesAudience(aud, { country: 'US', device: 'mobile' })).toBe(true);
    expect(matchesAudience(aud, { country: 'US', device: 'desktop' })).toBe(false);
    expect(matchesAudience(aud, { country: 'GB', device: 'mobile' })).toBe(false);
  });
});
