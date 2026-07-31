import { describe, it, expect } from 'vitest';
import { shouldCaptureThumbnail } from './usePreviewThumbnail';

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
