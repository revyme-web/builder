import { describe, test, expect } from 'vitest';
import {
  isExternalImageDrag,
  extractImageUrlFromDataTransfer,
  filenameFromUrl,
} from './CanvasFileDrop';
// `fitFrameBox` moved to the shared image-dims module (also used by the
// clipboard-paste path); the cases below still pin the drop behaviour.
import { fitFrameBox } from './image-dims';

/** Minimal DataTransfer stand-in: only `getData` is read by the helper. */
function mockDT(data: Record<string, string>): DataTransfer {
  return { getData: (type: string) => data[type] ?? '' } as unknown as DataTransfer;
}

describe('isExternalImageDrag', () => {
  test('accepts OS file drags', () => {
    expect(isExternalImageDrag(['Files'])).toBe(true);
  });
  test('accepts browser image-URL drags (uri-list / DownloadURL)', () => {
    expect(isExternalImageDrag(['text/uri-list', 'text/html', 'text/plain'])).toBe(true);
    expect(isExternalImageDrag(['DownloadURL'])).toBe(true);
  });
  test('ignores internal / plain-text-only drags', () => {
    expect(isExternalImageDrag(['text/plain'])).toBe(false);
    expect(isExternalImageDrag(['application/x-revyme-node'])).toBe(false);
    expect(isExternalImageDrag([])).toBe(false);
  });
});

describe('extractImageUrlFromDataTransfer', () => {
  test('parses a Chrome DownloadURL (mime:name:url), keeping colons in the URL', () => {
    const dt = mockDT({ DownloadURL: 'image/png:Dashboard@2x.png:https://cdn.example.com/a/b.png?v=1' });
    expect(extractImageUrlFromDataTransfer(dt)).toEqual({
      url: 'https://cdn.example.com/a/b.png?v=1',
      name: 'Dashboard@2x.png',
    });
  });

  test('rejects a non-image DownloadURL', () => {
    const dt = mockDT({ DownloadURL: 'application/pdf:Invoice.pdf:https://x.com/i.pdf' });
    expect(extractImageUrlFromDataTransfer(dt)).toBeNull();
  });

  test('extracts the first <img src> from text/html', () => {
    const dt = mockDT({ 'text/html': '<meta><img alt="" src="https://x.com/pic.jpg" width="40">' });
    expect(extractImageUrlFromDataTransfer(dt)).toEqual({ url: 'https://x.com/pic.jpg' });
  });

  test('takes the first non-comment line of text/uri-list', () => {
    const dt = mockDT({ 'text/uri-list': '# a comment\r\nhttps://x.com/p.webp\r\nhttps://x.com/other' });
    expect(extractImageUrlFromDataTransfer(dt)).toEqual({ url: 'https://x.com/p.webp' });
  });

  test('falls back to a bare image/data/blob URL in text/plain', () => {
    expect(extractImageUrlFromDataTransfer(mockDT({ 'text/plain': 'https://x.com/p.png' })))
      .toEqual({ url: 'https://x.com/p.png' });
    expect(extractImageUrlFromDataTransfer(mockDT({ 'text/plain': 'data:image/png;base64,AAA' })))
      .toEqual({ url: 'data:image/png;base64,AAA' });
  });

  test('ignores non-URL plain text (a dragged text selection)', () => {
    expect(extractImageUrlFromDataTransfer(mockDT({ 'text/plain': 'just some words' }))).toBeNull();
  });

  test('precedence: DownloadURL beats html beats uri-list', () => {
    const dt = mockDT({
      DownloadURL: 'image/png:a.png:https://dl/a.png',
      'text/html': '<img src="https://html/b.png">',
      'text/uri-list': 'https://uri/c.png',
    });
    expect(extractImageUrlFromDataTransfer(dt)?.url).toBe('https://dl/a.png');
  });
});

describe('fitFrameBox', () => {
  test('caps the longest side at 400 while preserving aspect ratio', () => {
    expect(fitFrameBox({ w: 1600, h: 800 })).toEqual({ width: 400, height: 200 });
    expect(fitFrameBox({ w: 800, h: 1600 })).toEqual({ width: 200, height: 400 });
  });
  test('never upscales a small image', () => {
    expect(fitFrameBox({ w: 120, h: 90 })).toEqual({ width: 120, height: 90 });
  });
  test('uses the default box for missing / degenerate dims', () => {
    expect(fitFrameBox(null)).toEqual({ width: 320, height: 200 });
    expect(fitFrameBox({ w: 0, h: 0 })).toEqual({ width: 320, height: 200 });
  });
});

describe('filenameFromUrl', () => {
  test('pulls the decoded basename when it has an extension', () => {
    expect(filenameFromUrl('https://x.com/a/My%20Pic.png?q=1')).toBe('My Pic.png');
  });
  test('returns null for extensionless paths and data URLs', () => {
    expect(filenameFromUrl('https://x.com/a/b')).toBeNull();
    expect(filenameFromUrl('data:image/png;base64,AAA')).toBeNull();
  });
});
