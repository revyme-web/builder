import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const upload = vi.fn(async () => 'https://assets.test/thumb.jpg');
vi.mock('@/shared/cloud-flag', () => ({ CLOUD_ENABLED: true }));
vi.mock('@/backend/project-id', () => ({ getProjectId: () => 'site-1' }));
vi.mock('@/backend/revyme-backend', () => ({ uploadPreviewThumbnail: (...a: unknown[]) => upload(...(a as [])) }));

import { shouldCaptureThumbnail, usePreviewThumbnail } from './usePreviewThumbnail';

describe('shouldCaptureThumbnail', () => {
  it('captures the home page when nothing was captured before', () => {
    expect(shouldCaptureThumbnail({ isHomePage: true, lastCapturedVersion: null, currentVersion: 1 })).toBe(true);
  });

  it('captures the home page when the project version moved forward', () => {
    expect(shouldCaptureThumbnail({ isHomePage: true, lastCapturedVersion: 3, currentVersion: 4 })).toBe(true);
  });

  it('captures the home page when the version moved backward (undo)', () => {
    expect(shouldCaptureThumbnail({ isHomePage: true, lastCapturedVersion: 5, currentVersion: 4 })).toBe(true);
  });

  it('skips when the home page version is unchanged', () => {
    expect(shouldCaptureThumbnail({ isHomePage: true, lastCapturedVersion: 4, currentVersion: 4 })).toBe(false);
  });

  it('never captures a non-home page, even if the version changed', () => {
    expect(shouldCaptureThumbnail({ isHomePage: false, lastCapturedVersion: null, currentVersion: 1 })).toBe(false);
    expect(shouldCaptureThumbnail({ isHomePage: false, lastCapturedVersion: 3, currentVersion: 9 })).toBe(false);
  });
});

// Security report 2026-11-06: the thumbnail listener accepted a
// `preview:thumbnail` from ANY window, so another page could replace the
// site's dashboard thumbnail with any image.
describe('usePreviewThumbnail — only the preview iframe sets the thumbnail', () => {
  const PREVIEW = 'https://revyme.com:5175';
  const frames: HTMLIFrameElement[] = [];
  const frame = () => { const f = document.createElement('iframe'); document.body.appendChild(f); frames.push(f); return f; };
  afterEach(() => { frames.splice(0).forEach((f) => f.remove()); upload.mockClear(); });

  function mount(preview: HTMLIFrameElement) {
    renderHook(() => usePreviewThumbnail({
      open: true, iframeReady: false, isHomePage: true, projectVersion: 1,
      iframeRef: { current: preview }, previewOrigin: PREVIEW,
    }));
  }
  const thumbnail = (source: Window | null, origin: string) => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'preview:thumbnail', dataUrl: 'data:image/jpeg;base64,AAAA' }, source, origin,
  }));

  it('ignores a thumbnail from another window', () => {
    const preview = frame();
    mount(preview);
    thumbnail(frame().contentWindow, PREVIEW);
    thumbnail(preview.contentWindow, 'https://evil.example');
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads the preview iframe\'s own thumbnail', () => {
    const preview = frame();
    mount(preview);
    thumbnail(preview.contentWindow, PREVIEW);
    expect(upload).toHaveBeenCalledWith('site-1', 'data:image/jpeg;base64,AAAA');
  });
});
