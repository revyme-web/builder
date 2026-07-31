import { describe, it, expect } from 'vitest';
import { isCmsDetailLink, cmsDetailLinkTarget } from './LinkUrlControl';

// Note: getCmsDetailRoutePrefixes reads projectFS (empty here), so only the
// dynamic-`[param]` branch is exercised — which is the primary signal.
describe('isCmsDetailLink', () => {
  it('true for a dynamic [param] detail route', () => {
    expect(isCmsDetailLink('/blog/[slug]')).toBe(true);
    expect(isCmsDetailLink('/advisors/[id]')).toBe(true);
  });
  it('false for a plain page, external URL, or empty', () => {
    expect(isCmsDetailLink('/about')).toBe(false);
    expect(isCmsDetailLink('/')).toBe(false);
    expect(isCmsDetailLink('')).toBe(false);
    expect(isCmsDetailLink('https://example.com')).toBe(false);
  });
});

// cmsDetailLinkTarget: the `[param]` branch needs no projectFS, so it's the one
// exercised here (the literal-prefix branch reads listPageFiles(), empty in tests).
describe('cmsDetailLinkTarget', () => {
  it('extracts the TARGET collection + prefix from a dynamic route', () => {
    expect(cmsDetailLinkTarget('/blog/[slug]')).toEqual({ collection: 'blog', prefix: '/blog/' });
    expect(cmsDetailLinkTarget('/our-services/[id]')).toEqual({ collection: 'our-services', prefix: '/our-services/' });
  });
  it('returns null for plain pages, empty, or non-detail links', () => {
    expect(cmsDetailLinkTarget('/about')).toBeNull();
    expect(cmsDetailLinkTarget('')).toBeNull();
    expect(cmsDetailLinkTarget('https://example.com')).toBeNull();
  });
});
