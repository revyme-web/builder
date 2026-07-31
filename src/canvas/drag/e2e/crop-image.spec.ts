// crop-image.spec.ts — verifies the browser-only canvas crop (cropImageToBlob)
// against a real <canvas> by importing the module through the Vite dev graph.
// The pure geometry (crop-utils) is covered by unit tests; this proves the
// actual pixel-cut + blob output works in a browser.

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

// 80×50 PNG: left half pink (249,168,168), right half blue (102,204,255).
const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAyCAIAAABET8urAAAAcklEQVR4nOXOMQHAMBCAQIqWeoqK+orFbHWRHzgD8Jy9mfC9a6QrMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRIjMRLj9MBtPy+eA5U8gxfjAAAAAElFTkSuQmCC';

test('cropImageToBlob cuts the requested region and returns a sized PNG blob', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('FLEX_COL_TALL'); // any seed — we only need the Vite module graph

  const result = await page.evaluate(async ({ img }) => {
    // @ts-expect-error runtime Vite dev-server URL (resolved in the browser, not by tsc)
    const mod = await import('/src/editor/ui/crop-image.ts');
    // Crop the RIGHT half (the blue region): natural x=40,y=0,w=40,h=50.
    const { blob, width, height, mime } = await mod.cropImageToBlob(img, { x: 40, y: 0, width: 40, height: 50 });

    // Read the cropped blob back and sample its centre pixel — must be blue.
    const url = URL.createObjectURL(blob);
    const el = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = el.naturalWidth; c.height = el.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const px = ctx.getImageData(Math.floor(el.naturalWidth / 2), Math.floor(el.naturalHeight / 2), 1, 1).data;
    URL.revokeObjectURL(url);

    return { width, height, mime, bytes: blob.size, r: px[0], g: px[1], b: px[2] };
  }, { img: IMG });

  expect(result.width).toBe(40);
  expect(result.height).toBe(50);
  expect(result.mime).toBe('image/png');
  expect(result.bytes).toBeGreaterThan(0);
  // Centre of the cropped right-half is the BLUE region (102, 204, 255).
  expect(result.b).toBeGreaterThan(200);
  expect(result.r).toBeLessThan(160);
});

test('cropImageToBlob of the LEFT half samples pink', async ({ page }) => {
  const editor = new EditorPage(page);
  await editor.gotoWithSeed('FLEX_COL_TALL');

  const px = await page.evaluate(async ({ img }) => {
    // @ts-expect-error runtime Vite dev-server URL (resolved in the browser, not by tsc)
    const mod = await import('/src/editor/ui/crop-image.ts');
    const { blob } = await mod.cropImageToBlob(img, { x: 0, y: 0, width: 40, height: 50 });
    const url = URL.createObjectURL(blob);
    const el = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = el.naturalWidth; c.height = el.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0);
    const p = ctx.getImageData(Math.floor(el.naturalWidth / 2), Math.floor(el.naturalHeight / 2), 1, 1).data;
    URL.revokeObjectURL(url);
    return { r: p[0], g: p[1], b: p[2] };
  }, { img: IMG });

  // PINK region (249, 168, 168): high red, mid green/blue.
  expect(px.r).toBeGreaterThan(220);
  expect(px.b).toBeLessThan(210);
});
