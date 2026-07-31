import { describe, it, expect } from 'vitest';
import { isComponentUrl, parseCdnComponentUrl } from './component-paste';

// Note: extractComponentName and ensureUrlImport are not exported (internal helpers).
// We test isComponentUrl which is the public API.

describe('isComponentUrl (code + design components — JS bundle URLs)', () => {
  it('matches valid Component CDN JS URLs', () => {
    expect(isComponentUrl('https://assets.revyme.app/components/MeshGradient@f638dd5686e76a12.js')).toBe(true);
    expect(isComponentUrl('https://assets.revyme.app/components/Hero-v2@aabbccddee112233.js')).toBe(true);
  });

  it('matches design-component URLs (same path, same JS shape, multi-file via manifest sibling)', () => {
    // Post-2026-05-06 unification: design components share at the same
    // `/components/<Name>@<hash>.js` path as code components. The
    // distinction is detected from the source's shape, not the URL.
    expect(isComponentUrl('https://assets.revyme.app/components/Hero@123abc456def7890.js')).toBe(true);
  });

  it('trims whitespace', () => {
    expect(isComponentUrl('  https://assets.revyme.app/components/slug@abcdef1234567890.js  ')).toBe(true);
    expect(isComponentUrl('\nhttps://assets.revyme.app/components/slug@abcdef1234567890.js\n')).toBe(true);
  });

  it('rejects non-component URLs', () => {
    expect(isComponentUrl('https://example.com')).toBe(false);
    expect(isComponentUrl('https://assets.revyme.app/images/photo.jpg')).toBe(false);
    expect(isComponentUrl('not a url')).toBe(false);
    expect(isComponentUrl('')).toBe(false);
  });

  it('rejects URLs without version hash', () => {
    expect(isComponentUrl('https://assets.revyme.app/components/slug.js')).toBe(false);
  });

  it('rejects legacy .tsx URLs (the editor expects compiled JS)', () => {
    expect(isComponentUrl('https://assets.revyme.app/components/slug@abcdef1234567890.tsx')).toBe(false);
  });

  it('rejects URLs with wrong domain', () => {
    expect(isComponentUrl('https://other.domain.com/components/slug@abcdef1234567890.js')).toBe(false);
  });

  it('rejects manifest URLs (siblings, not paste-able)', () => {
    expect(isComponentUrl('https://assets.revyme.app/components/Hero@abcdef1234567890.manifest.json')).toBe(false);
  });

  it('matches vector CDN URLs (`/vectors/...`)', () => {
    expect(isComponentUrl('https://assets.revyme.app/vectors/Arrows@1234567890abcdef.js')).toBe(true);
  });
});

describe('parseCdnComponentUrl', () => {
  it('returns kind="component" for components URLs', () => {
    expect(parseCdnComponentUrl('https://assets.revyme.app/components/Hero@abcdef1234567890.js')).toEqual({
      kind: 'component', name: 'Hero', hash: 'abcdef1234567890',
    });
  });

  it('returns kind="vector" for vectors URLs', () => {
    expect(parseCdnComponentUrl('https://assets.revyme.app/vectors/Arrows@1111222233334444.js')).toEqual({
      kind: 'vector', name: 'Arrows', hash: '1111222233334444',
    });
  });

  it('returns null for malformed URLs', () => {
    expect(parseCdnComponentUrl('https://other.domain/vectors/X@abc.js')).toBeNull();
    expect(parseCdnComponentUrl('not a url')).toBeNull();
  });

  it('legacy .tsx URLs return kind="component" (warning path only)', () => {
    expect(parseCdnComponentUrl('https://assets.revyme.app/vectors/Old@1234567890abcdef.tsx')).toEqual({
      kind: 'component', name: 'Old', hash: '1234567890abcdef',
    });
  });
});
