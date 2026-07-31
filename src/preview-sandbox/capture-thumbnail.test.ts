import { describe, test, expect } from 'vitest';
import { captureScale } from './capture-thumbnail';

// The full-page thumbnail raster is downscaled to ~900px wide — native-res
// capture (plus cacheBust refetching every image) blocked the preview's main
// thread for seconds and read as "the page freezes when I hover".
describe('captureScale', () => {
  test('downscales wide pages to the thumbnail width', () => {
    expect(captureScale(1440)).toBeCloseTo(900 / 1440);
    expect(captureScale(1800)).toBeCloseTo(0.5);
  });

  test('never upscales narrow pages', () => {
    expect(captureScale(900)).toBe(1);
    expect(captureScale(375)).toBe(1);
  });

  test('degenerate widths fall back to 1', () => {
    expect(captureScale(0)).toBe(1);
    expect(captureScale(-5)).toBe(1);
  });
});
