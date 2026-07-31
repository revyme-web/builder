import { describe, test, expect } from 'vitest';
import { setVideoFillInCode, removeVideoFillInCode } from './generator-video';

const URL_A = 'https://cdn.example.com/a.mp4';
const URL_B = 'https://cdn.example.com/b.mp4';

const HOST_OPEN_CLOSE = `function App() {
  return (
    <div data-id="hero" style={{ padding: '40px', gap: '24px' }}>
      <p data-id="title">Hi</p>
    </div>
  );
}`;

const HOST_SELF_CLOSING = `function App() {
  return (
    <div data-id="empty" style={{ padding: '40px' }} />
  );
}`;

const HOST_NO_STYLE = `function App() {
  return (
    <div data-id="bare">
      <p data-id="t">x</p>
    </div>
  );
}`;

describe('setVideoFillInCode (insert)', () => {
  test('inserts <video data-bg-video> as first child with all defaults', () => {
    const out = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    expect(out).toContain('data-bg-video');
    expect(out).toContain(`src="${URL_A}"`);
    // Default boolean attrs are present.
    expect(out).toContain('autoPlay');
    expect(out).toContain('muted');
    expect(out).toContain('loop');
    expect(out).toContain('playsInline');
    // controls is off by default → not present.
    expect(out).not.toMatch(/\scontrols(\s|\/|>)/);
    // Default objectFit = cover, and pointerEvents: none (because controls off).
    expect(out).toContain('objectFit:');
    expect(out).toMatch(/pointerEvents:\s*['"]none['"]/);
    // Existing child preserved + ordered after the video.
    expect(out).toContain('data-id="title"');
    const videoIdx = out.indexOf('data-bg-video');
    const titleIdx = out.indexOf('data-id="title"');
    expect(videoIdx).toBeLessThan(titleIdx);
    // Host got the position/overflow/isolation triplet.
    expect(out).toContain('isolation:');
  });

  test('inserts respect explicit option overrides at create time', () => {
    const out = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', {
      src: URL_A, muted: false, controls: true, objectFit: 'contain',
    });
    expect(out).not.toContain(' muted');
    expect(out).toMatch(/\scontrols(\s|\/|>)/);
    expect(out).toMatch(/objectFit:\s*['"]contain['"]/);
    // Controls on → pointerEvents NOT set to 'none' (so user can interact).
    expect(out).not.toMatch(/pointerEvents:\s*['"]none['"]/);
  });

  test('expands a self-closing host to open/close form before inserting', () => {
    const out = setVideoFillInCode(HOST_SELF_CLOSING, 'empty', { src: URL_A });
    expect(out).toContain('data-bg-video');
    expect(out).toContain('</div>');
    expect(out).not.toMatch(/data-id="empty"[^>]*\/>/);
  });

  test('creates a fresh style attribute on a host that has none', () => {
    const out = setVideoFillInCode(HOST_NO_STYLE, 'bare', { src: URL_A });
    expect(out).toContain('data-bg-video');
    expect(out).toMatch(/position:\s*['"]relative['"]/);
    expect(out).toContain('isolation:');
  });

  test('returns code unchanged when nodeId is not found', () => {
    const out = setVideoFillInCode(HOST_OPEN_CLOSE, 'does-not-exist', { src: URL_A });
    expect(out).toBe(HOST_OPEN_CLOSE);
  });

  test('no-op when bg-video missing AND no src provided', () => {
    const out = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { muted: false });
    expect(out).toBe(HOST_OPEN_CLOSE);
  });
});

describe('setVideoFillInCode (patch)', () => {
  test('updates src in place without duplicating element', () => {
    const first = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    const second = setVideoFillInCode(first, 'hero', { src: URL_B });
    expect(second).toContain(`src="${URL_B}"`);
    expect(second).not.toContain(URL_A);
    expect(second.match(/data-bg-video/g)?.length).toBe(1);
  });

  test('toggles a boolean attribute off when explicitly set false', () => {
    const inserted = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    expect(inserted).toContain('muted');
    const patched = setVideoFillInCode(inserted, 'hero', { muted: false });
    expect(patched).not.toMatch(/\smuted(\s|\/|>)/);
    // Other defaults still present.
    expect(patched).toContain('autoPlay');
    expect(patched).toContain('loop');
  });

  test('toggling controls on clears pointerEvents:none, off restores it', () => {
    const inserted = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    expect(inserted).toMatch(/pointerEvents:\s*['"]none['"]/);
    const withControls = setVideoFillInCode(inserted, 'hero', { controls: true });
    expect(withControls).toMatch(/\scontrols(\s|\/|>)/);
    expect(withControls).not.toMatch(/pointerEvents:\s*['"]none['"]/);
    const withoutControls = setVideoFillInCode(withControls, 'hero', { controls: false });
    expect(withoutControls).not.toMatch(/\scontrols(\s|\/|>)/);
    expect(withoutControls).toMatch(/pointerEvents:\s*['"]none['"]/);
  });

  test('changes objectFit in the inline style', () => {
    const inserted = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    expect(inserted).toMatch(/objectFit:\s*['"]cover['"]/);
    const patched = setVideoFillInCode(inserted, 'hero', { objectFit: 'contain' });
    expect(patched).toMatch(/objectFit:\s*['"]contain['"]/);
  });

  test('sets and clears poster', () => {
    const POSTER = 'https://cdn.example.com/poster.jpg';
    const inserted = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    expect(inserted).not.toContain('poster=');
    const withPoster = setVideoFillInCode(inserted, 'hero', { poster: POSTER });
    expect(withPoster).toContain(`poster="${POSTER}"`);
    const cleared = setVideoFillInCode(withPoster, 'hero', { poster: '' });
    expect(cleared).not.toContain('poster=');
  });
});

describe('removeVideoFillInCode', () => {
  test('removes the bg-video child but leaves siblings intact', () => {
    const inserted = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    const out = removeVideoFillInCode(inserted, 'hero');
    expect(out).not.toContain('data-bg-video');
    expect(out).not.toContain(URL_A);
    expect(out).toContain('data-id="title"');
  });

  test('leaves host position/overflow/isolation alone (cleanup is opt-in)', () => {
    const inserted = setVideoFillInCode(HOST_OPEN_CLOSE, 'hero', { src: URL_A });
    const out = removeVideoFillInCode(inserted, 'hero');
    expect(out).toMatch(/position:\s*['"]relative['"]/);
    expect(out).toContain('isolation:');
  });

  test('no-op when there is no bg-video child', () => {
    const out = removeVideoFillInCode(HOST_OPEN_CLOSE, 'hero');
    expect(out).toBe(HOST_OPEN_CLOSE);
  });
});
