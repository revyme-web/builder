// media-gallery-utils.test.ts — pure logic behind the Media panel's delete +
// shift-sweep multi-select: key derivation, marquee hit-testing, edge
// auto-scroll velocity, and the confirm copy.

import { describe, it, expect } from 'vitest';
import { deriveUploadKey, keysInSweep, sweepAutoScrollStep, deleteConfirmMessage, type TileRect } from './media-gallery-utils';

describe('deriveUploadKey', () => {
  it('prefers the explicit R2 key when present', () => {
    expect(deriveUploadKey({ url: 'https://cdn.example.com/u1/site/images/uploaded/a.webp', key: 'u1/site/images/uploaded/a.webp' }))
      .toBe('u1/site/images/uploaded/a.webp');
  });

  it('falls back to the URL pathname (fresh uploads carry only the url)', () => {
    expect(deriveUploadKey({ url: 'https://cdn.example.com/u1/site/images/uploaded/b.webp' }))
      .toBe('u1/site/images/uploaded/b.webp');
  });

  it('returns null for standalone data:/blob: rows (nothing to delete)', () => {
    expect(deriveUploadKey({ url: 'data:image/png;base64,AAAA' })).toBeNull();
    expect(deriveUploadKey({ url: 'blob:http://localhost/xyz' })).toBeNull();
    expect(deriveUploadKey({ url: 'not a url' })).toBeNull();
  });
});

describe('keysInSweep', () => {
  // 2-column grid, 100×100 tiles with a 10px gap (content coords).
  const tiles: TileRect[] = [
    { key: 'a', left: 0,   top: 0,   right: 100, bottom: 100 },
    { key: 'b', left: 110, top: 0,   right: 210, bottom: 100 },
    { key: 'c', left: 0,   top: 110, right: 100, bottom: 210 },
    { key: 'd', left: 110, top: 110, right: 210, bottom: 210 },
  ];

  it('selects only tiles intersecting the marquee rect', () => {
    // Sweep down the LEFT column only.
    expect(keysInSweep(tiles, { x: 10, y: 10 }, { x: 60, y: 200 })).toEqual(['a', 'c']);
  });

  it('handles any drag direction (b above/left of a)', () => {
    expect(keysInSweep(tiles, { x: 200, y: 200 }, { x: 10, y: 10 }).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a sweep past the visible rows still hits tiles by content coords (auto-scroll case)', () => {
    // Anchor at the top, pointer effectively at y=1000 after scrolling.
    expect(keysInSweep(tiles, { x: 10, y: 0 }, { x: 20, y: 1000 })).toEqual(['a', 'c']);
  });

  it('empty when the rect touches nothing', () => {
    expect(keysInSweep(tiles, { x: 300, y: 300 }, { x: 400, y: 400 })).toEqual([]);
  });
});

describe('sweepAutoScrollStep', () => {
  const TOP = 100, BOTTOM = 500;

  it('zero in the middle of the container', () => {
    expect(sweepAutoScrollStep(300, TOP, BOTTOM)).toBe(0);
  });

  it('scrolls up near the top edge, faster the closer/past it', () => {
    const near = sweepAutoScrollStep(TOP + 20, TOP, BOTTOM);
    const at = sweepAutoScrollStep(TOP, TOP, BOTTOM);
    const past = sweepAutoScrollStep(TOP - 50, TOP, BOTTOM);
    expect(near).toBeLessThan(0);
    expect(at).toBeLessThanOrEqual(near);
    expect(past).toBe(-18); // capped at maxStep
  });

  it('scrolls down near the bottom edge, capped', () => {
    expect(sweepAutoScrollStep(BOTTOM - 10, TOP, BOTTOM)).toBeGreaterThan(0);
    expect(sweepAutoScrollStep(BOTTOM + 100, TOP, BOTTOM)).toBe(18);
  });
});

describe('deleteConfirmMessage', () => {
  it('single asset copy', () => {
    expect(deleteConfirmMessage(1, 'image')).toBe('This will delete this asset from the website. Continue?');
  });
  it('bulk copy with count + noun', () => {
    expect(deleteConfirmMessage(7, 'image')).toBe('This will delete 7 images from the website. Continue?');
    expect(deleteConfirmMessage(2, 'video')).toBe('This will delete 2 videos from the website. Continue?');
  });
});
