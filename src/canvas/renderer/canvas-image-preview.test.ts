// canvas-image-preview.test.ts — pure seams of the canvas-only image preview.
//
// Context: big raster images made the canvas slow (full re-decode on every
// structural re-render + full-size compositing under pan/zoom). The preview
// system swaps the PAINTED image for a downscaled blob while the SOURCE keeps
// the original URL. The bitmap pipeline (fetch/createImageBitmap/Offscreen-
// Canvas) is browser-only; these tests cover the URL selection, the CSS url()
// rewriting, and the renderer diff guards that stop patch loops from undoing
// the swap.

import { describe, it, expect } from 'vitest';
import {
  shouldPreviewUrl, extractCssUrls, swapCssUrls,
  isPreviewAppliedSrc, isPreviewAppliedBg,
  edgeResizeUrl, MAX_PREVIEW_EDGE,
} from './canvas-image-preview';

describe('shouldPreviewUrl', () => {
  it('accepts http(s), protocol-relative and root/relative raster URLs', () => {
    expect(shouldPreviewUrl('https://assets.revyme.app/u/photo.jpg')).toBe(true);
    expect(shouldPreviewUrl('http://images.unsplash.com/x.png?w=4000')).toBe(true);
    expect(shouldPreviewUrl('//cdn.example.com/a.webp')).toBe(true);
    expect(shouldPreviewUrl('/images/hero.jpg')).toBe(true);
    expect(shouldPreviewUrl('./local.jpeg')).toBe(true);
  });

  it('rejects data:/blob: (already local) and non-URL strings', () => {
    expect(shouldPreviewUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(shouldPreviewUrl('blob:http://localhost:5174/abc')).toBe(false);
    expect(shouldPreviewUrl('')).toBe(false);
    expect(shouldPreviewUrl('none')).toBe(false);
  });

  it('rejects SVG (resolution-free) and GIF (animation would freeze)', () => {
    expect(shouldPreviewUrl('https://x.com/icon.svg')).toBe(false);
    expect(shouldPreviewUrl('https://x.com/loop.gif')).toBe(false);
    expect(shouldPreviewUrl('https://x.com/loop.gif?v=2')).toBe(false);
    expect(shouldPreviewUrl('https://x.com/photo.jpg')).toBe(true);
  });

  it('rejects URLs that are already edge-transform previews', () => {
    expect(shouldPreviewUrl('https://assets.revyme.app/cdn-cgi/image/width=1600/https://assets.revyme.app/u/p.jpg')).toBe(false);
  });
});

describe('edgeResizeUrl', () => {
  it('rewrites zone-hosted images to the /cdn-cgi/image/ preview form', () => {
    const out = edgeResizeUrl('https://assets.revyme.app/u/proj/photo.jpg?v=3');
    expect(out).toBe(
      `https://assets.revyme.app/cdn-cgi/image/width=${MAX_PREVIEW_EDGE},height=${MAX_PREVIEW_EDGE},fit=scale-down,quality=25,format=auto/https://assets.revyme.app/u/proj/photo.jpg?v=3`,
    );
  });

  it('honours a custom edge size (layers-panel thumbnails)', () => {
    const out = edgeResizeUrl('https://assets.revyme.app/u/p.jpg', 64);
    expect(out).toContain('/cdn-cgi/image/width=64,height=64,');
  });

  it('covers any revyme.app subdomain, but no foreign hosts', () => {
    expect(edgeResizeUrl('https://cdn.revyme.app/x.png')).toContain('/cdn-cgi/image/');
    expect(edgeResizeUrl('https://images.unsplash.com/photo-1?w=4000')).toBeNull();
    expect(edgeResizeUrl('https://evil-revyme.app.attacker.com/x.jpg')).toBeNull();
    expect(edgeResizeUrl('https://notrevyme.app/x.jpg')).toBeNull();
  });

  it('never double-transforms and ignores non-http schemes', () => {
    expect(edgeResizeUrl('https://assets.revyme.app/cdn-cgi/image/width=100/https://assets.revyme.app/x.jpg')).toBeNull();
    expect(edgeResizeUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(edgeResizeUrl('blob:https://assets.revyme.app/abc')).toBeNull();
  });
});

describe('extractCssUrls', () => {
  it('parses bare, single- and double-quoted url() tokens', () => {
    expect(extractCssUrls('url(https://a.com/x.jpg)')).toEqual(['https://a.com/x.jpg']);
    expect(extractCssUrls(`url('https://a.com/y.jpg')`)).toEqual(['https://a.com/y.jpg']);
    expect(extractCssUrls('url("https://a.com/z.jpg")')).toEqual(['https://a.com/z.jpg']);
  });

  it('handles multi-layer values with gradients interleaved', () => {
    const v = 'linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4)), url("https://a.com/bg.jpg"), url(/images/tex.png)';
    expect(extractCssUrls(v)).toEqual(['https://a.com/bg.jpg', '/images/tex.png']);
  });

  it('returns empty for gradient-only or none values', () => {
    expect(extractCssUrls('linear-gradient(#fff, #000)')).toEqual([]);
    expect(extractCssUrls('none')).toEqual([]);
  });
});

describe('swapCssUrls', () => {
  const table: Record<string, string> = {
    'https://a.com/big.jpg': 'blob:http://localhost/preview-1',
  };
  const resolve = (u: string) => table[u] ?? null;

  it('swaps only resolvable URLs and reports change', () => {
    const v = 'url("https://a.com/big.jpg")';
    expect(swapCssUrls(v, resolve)).toBe('url("blob:http://localhost/preview-1")');
  });

  it('keeps unresolvable layers verbatim in a multi-layer value', () => {
    const v = 'linear-gradient(#fff, #000), url(https://a.com/big.jpg), url("https://b.com/small.jpg")';
    expect(swapCssUrls(v, resolve)).toBe(
      'linear-gradient(#fff, #000), url("blob:http://localhost/preview-1"), url("https://b.com/small.jpg")',
    );
  });

  it('returns null when nothing changes (no re-write churn)', () => {
    expect(swapCssUrls('url("https://b.com/small.jpg")', resolve)).toBeNull();
    expect(swapCssUrls('linear-gradient(#fff, #000)', resolve)).toBeNull();
  });
});

describe('renderer diff guards', () => {
  it('isPreviewAppliedSrc: true only while the img paints the recorded preview (blob or edge URL)', () => {
    const img = document.createElement('img');
    img.dataset.cipSrc = 'https://a.com/big.jpg';
    img.dataset.cipSrcset = 'blob:http://localhost/p1';
    img.setAttribute('src', 'blob:http://localhost/p1');
    expect(isPreviewAppliedSrc(img, 'https://a.com/big.jpg')).toBe(true);
    // Edge-resize preview form counts the same way.
    img.dataset.cipSrcset = 'https://assets.revyme.app/cdn-cgi/image/width=1600/https://a.com/big.jpg';
    img.setAttribute('src', img.dataset.cipSrcset);
    expect(isPreviewAppliedSrc(img, 'https://a.com/big.jpg')).toBe(true);
    // Node re-pointed to a different image → diff must write the new src.
    expect(isPreviewAppliedSrc(img, 'https://a.com/other.jpg')).toBe(false);
    // Painted src drifted from the recorded preview → diff proceeds normally.
    img.setAttribute('src', 'https://a.com/big.jpg');
    expect(isPreviewAppliedSrc(img, 'https://a.com/big.jpg')).toBe(false);
  });

  it('isPreviewAppliedBg: true only while the element still paints the recorded swap', () => {
    const el = document.createElement('div');
    const orig = 'url("https://a.com/big.jpg")';
    el.style.backgroundImage = 'url("blob:http://localhost/p1")';
    el.dataset.cipBg = orig;
    el.dataset.cipBgset = el.style.backgroundImage;
    expect(isPreviewAppliedBg(el, orig)).toBe(true);
    // A DIFFERENT desired value (user changed the fill) → must write.
    expect(isPreviewAppliedBg(el, 'url("https://a.com/new.jpg")')).toBe(false);
    // Painted value drifted (something overwrote it) → must write.
    el.style.backgroundImage = 'none';
    expect(isPreviewAppliedBg(el, orig)).toBe(false);
  });
});
