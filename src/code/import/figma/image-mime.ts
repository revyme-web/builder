// image-mime.ts — magic-byte sniffing for imported image bytes.
//
// Figma's getBytesAsync returns a photo's ORIGINAL bytes (JPEG for photos,
// PNG for screenshots, sometimes WebP/GIF) while the plugin historically
// labeled everything `image/png`. The backend's /api/upload runs an
// anti-spoofing magic-byte check and rejects any file whose content doesn't
// match its declared MIME — so every mislabeled JPEG bounced with
// "File content does not match its declared type" (the grey-boxes find).
// The declared MIME in a data URL is therefore only a HINT; the bytes are
// the truth.

const SNIFFS: Array<{ mime: string; match: (b: Uint8Array) => boolean }> = [
  { mime: 'image/jpeg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/gif', match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: 'image/webp',
    match: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50, // WEBP
  },
];

/** Identify raster image bytes by magic number. null = unrecognized. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  for (const s of SNIFFS) if (s.match(bytes)) return s.mime;
  return null;
}

export const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
};

/** File extension for a MIME type ('bin' when unknown). */
export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}
