import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  fitFrameBox,
  getImageDimensions,
  getBlobImageDimensions,
  MAX_DROP_SIZE,
  DEFAULT_DROP_W,
  DEFAULT_DROP_H,
} from './image-dims';

/** Swap in a stub `Image` whose load behaviour the test controls. Returns a
 *  restore fn. jsdom's real Image never fires load for a blob: URL. */
function stubImage(behaviour: (img: Record<string, unknown>) => void) {
  const original = globalThis.Image;
  class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_v: string) {
      // Fire asynchronously like a real decode so the promise wiring is exercised.
      setTimeout(() => behaviour(this as unknown as Record<string, unknown>), 0);
    }
  }
  (globalThis as { Image: unknown }).Image = StubImage;
  return () => { (globalThis as { Image: unknown }).Image = original; };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('fitFrameBox', () => {
  test('scales the longest side down to the cap, preserving aspect', () => {
    expect(fitFrameBox({ w: 1600, h: 800 })).toEqual({ width: 400, height: 200 });
    expect(fitFrameBox({ w: 800, h: 1600 })).toEqual({ width: 200, height: 400 });
  });

  test('never upscales an image smaller than the cap', () => {
    expect(fitFrameBox({ w: 120, h: 90 })).toEqual({ width: 120, height: 90 });
  });

  test('falls back to the default box for null/degenerate dims', () => {
    expect(fitFrameBox(null)).toEqual({ width: DEFAULT_DROP_W, height: DEFAULT_DROP_H });
    expect(fitFrameBox({ w: 0, h: 0 })).toEqual({ width: DEFAULT_DROP_W, height: DEFAULT_DROP_H });
    expect(fitFrameBox({ w: -10, h: 10 })).toEqual({ width: DEFAULT_DROP_W, height: DEFAULT_DROP_H });
  });

  // The paste-transparency bug: a square cutout in a fixed 200x150 box got
  // cropped by `object-fit: cover`. A square source must stay square.
  test('a square source produces a square box (no crop under object-fit: cover)', () => {
    expect(fitFrameBox({ w: 350, h: 350 })).toEqual({ width: 350, height: 350 });
    const big = fitFrameBox({ w: 2000, h: 2000 });
    expect(big.width).toBe(big.height);
    expect(big.width).toBe(MAX_DROP_SIZE);
  });

  test('rounds to whole pixels and never returns a zero side', () => {
    const box = fitFrameBox({ w: 1000, h: 3 });
    expect(box).toEqual({ width: 400, height: 1 });
    expect(Number.isInteger(box.width)).toBe(true);
    expect(Number.isInteger(box.height)).toBe(true);
  });
});

describe('getImageDimensions', () => {
  test('resolves the natural size once the image decodes', async () => {
    const restore = stubImage((img) => {
      img.naturalWidth = 640;
      img.naturalHeight = 480;
      (img.onload as () => void)();
    });
    try {
      await expect(getImageDimensions('https://x.test/a.png')).resolves.toEqual({ w: 640, h: 480 });
    } finally { restore(); }
  });

  test('resolves null when the image fails to load', async () => {
    const restore = stubImage((img) => { (img.onerror as () => void)(); });
    try {
      await expect(getImageDimensions('https://x.test/missing.png')).resolves.toBeNull();
    } finally { restore(); }
  });

  test('resolves null when a decode reports a zero natural width', async () => {
    const restore = stubImage((img) => {
      img.naturalWidth = 0;
      img.naturalHeight = 0;
      (img.onload as () => void)();
    });
    try {
      await expect(getImageDimensions('https://x.test/broken.png')).resolves.toBeNull();
    } finally { restore(); }
  });

  test('a late load after an error cannot re-settle the promise', async () => {
    const restore = stubImage((img) => {
      (img.onerror as () => void)();
      img.naturalWidth = 100;
      img.naturalHeight = 100;
      (img.onload as () => void)();
    });
    try {
      await expect(getImageDimensions('https://x.test/flaky.png')).resolves.toBeNull();
    } finally { restore(); }
  });
});

describe('getBlobImageDimensions', () => {
  test('reads dims from an object URL and always revokes it', async () => {
    const createSpy = vi.fn(() => 'blob:stub-url');
    const revokeSpy = vi.fn();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createSpy as never);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeSpy as never);

    const restore = stubImage((img) => {
      img.naturalWidth = 350;
      img.naturalHeight = 350;
      (img.onload as () => void)();
    });
    try {
      const blob = new Blob(['x'], { type: 'image/png' });
      await expect(getBlobImageDimensions(blob)).resolves.toEqual({ w: 350, h: 350 });
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(revokeSpy).toHaveBeenCalledWith('blob:stub-url');
    } finally { restore(); }
  });

  test('revokes the object URL even when the decode fails', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((() => 'blob:stub-url') as never);
    const revokeSpy = vi.fn();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeSpy as never);

    const restore = stubImage((img) => { (img.onerror as () => void)(); });
    try {
      const blob = new Blob(['x'], { type: 'image/png' });
      await expect(getBlobImageDimensions(blob)).resolves.toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith('blob:stub-url');
    } finally { restore(); }
  });
});
