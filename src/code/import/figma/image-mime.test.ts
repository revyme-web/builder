import { describe, it, expect } from 'vitest';
import { sniffImageMime, extForMime } from './image-mime';

// Figma ships a photo's ORIGINAL bytes (JPEG) while the plugin labeled all
// of them image/png — the backend's magic-byte guard then 400'd every
// upload ("File content does not match its declared type") and the canvas
// showed grey boxes. The sniffer makes the BYTES authoritative.

const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const gif = () => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
const webp = () => Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

describe('sniffImageMime', () => {
  it('identifies JPEG (the mislabeled-photo class from the grey-boxes find)', () => {
    expect(sniffImageMime(jpeg())).toBe('image/jpeg');
  });

  it('identifies PNG', () => {
    expect(sniffImageMime(png())).toBe('image/png');
  });

  it('identifies GIF', () => {
    expect(sniffImageMime(gif())).toBe('image/gif');
  });

  it('identifies WebP (needs both RIFF and WEBP markers)', () => {
    expect(sniffImageMime(webp())).toBe('image/webp');
    const riffOnly = webp();
    riffOnly[8] = 0x00; // RIFF but not WEBP (e.g. WAV) — must NOT match
    expect(sniffImageMime(riffOnly)).toBeNull();
  });

  it('returns null for unknown or too-short content', () => {
    expect(sniffImageMime(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull(); // < 12 bytes
  });
});

describe('extForMime', () => {
  it('maps known mimes and falls back to bin', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/svg+xml')).toBe('svg');
    expect(extForMime('application/x-thing')).toBe('bin');
  });
});
