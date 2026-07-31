// Selection-overlay edge resize on a CENTER-POSITIONED axis — regression for
// 2026-07-29: an absolute frame with only TOP pinned (top: px) stores its
// horizontal position as `left: N%` + `translateX(-50%)` (center form). That
// left is neither pinned nor fixed-px, so the resize loop/commit never wrote
// it — dragging the left/right edge changed only width while the center %
// stayed put, growing BOTH sides symmetrically instead of holding the
// opposite edge. Fix: isCenteredX/isCenteredY re-aim the center % each frame
// and commit it.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const PAGE = `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#ffffff' }}>
      <div data-id="host-1" data-name="Host" style={{ position: 'relative', width: '561px', height: '500px', backgroundColor: '#ffffba', margin: '40px auto' }}>
        <div data-id="pink-1" data-name="Pink" style={{ position: 'absolute', top: '96px', left: '50.0138%', width: '298px', height: '155px', backgroundColor: '#ffb3ba', transform: 'translateX(-50%)' }} data-pinned="true"></div>
      </div>
    </div>
  );
}`;

test('left-edge resize on a top-only-pinned (centered-x) frame keeps the RIGHT edge fixed', async ({ page }) => {
  test.setTimeout(120_000);
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('pink-1').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => (window as any).__e2e.select(['pink-1']));
  await page.waitForTimeout(600);

  const before = await editor.node('pink-1').boundingBox();
  expect(before).toBeTruthy();
  const rightEdgeBefore = before!.x + before!.width;

  // Drag the LEFT edge 60px further left → width grows by 60 (screen px),
  // right edge must not move.
  const edge = page.locator('[data-resize-edge="left"]');
  await edge.waitFor({ state: 'visible', timeout: 10_000 });
  const eb = (await edge.boundingBox())!;
  const sx = eb.x + eb.width / 2;
  const sy = eb.y + eb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sx - (60 * i) / 8, sy);
    await page.waitForTimeout(50);
  }
  // LIVE check (before mouseup): right edge already stable during the drag.
  const during = await editor.node('pink-1').boundingBox();
  const rightEdgeDuring = during!.x + during!.width;
  console.log('right edge before/during', rightEdgeBefore, rightEdgeDuring);
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const after = await editor.node('pink-1').boundingBox();
  const rightEdgeAfter = after!.x + after!.width;
  console.log('right edge after', rightEdgeAfter, 'width', before!.width, '→', after!.width);

  // Width grew (left edge followed the cursor)…
  expect(after!.width).toBeGreaterThan(before!.width + 30);
  // …and the OPPOSITE (right) edge stayed put, live AND committed (2px slack
  // for rounding across canvas scale).
  expect(Math.abs(rightEdgeDuring - rightEdgeBefore)).toBeLessThan(2.5);
  expect(Math.abs(rightEdgeAfter - rightEdgeBefore)).toBeLessThan(2.5);

  // Committed code: left is a re-aimed center % (< the original 50.0138 since
  // the center moved left), translate untouched, width in px.
  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  expect(code).toContain('translateX(-50%)');
  const leftMatch = code.match(/data-id="pink-1"[\s\S]*?left:\s*'([\d.]+)%'/);
  expect(leftMatch).toBeTruthy();
  expect(parseFloat(leftMatch![1])).toBeLessThan(50.0138);
  expect(parseFloat(leftMatch![1])).toBeGreaterThan(30);
});

test('right-edge resize on the same centered-x frame keeps the LEFT edge fixed', async ({ page }) => {
  test.setTimeout(120_000);
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('pink-1').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).__e2e.select(['pink-1']));
  await page.waitForTimeout(600);

  const before = await editor.node('pink-1').boundingBox();
  const leftEdgeBefore = before!.x;

  const edge = page.locator('[data-resize-edge="right"]');
  await edge.waitFor({ state: 'visible', timeout: 10_000 });
  const eb = (await edge.boundingBox())!;
  const sx = eb.x + eb.width / 2;
  const sy = eb.y + eb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sx + (60 * i) / 8, sy);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const after = await editor.node('pink-1').boundingBox();
  console.log('left edge', leftEdgeBefore, '→', after!.x, 'width', before!.width, '→', after!.width);
  expect(after!.width).toBeGreaterThan(before!.width + 30);
  expect(Math.abs(after!.x - leftEdgeBefore)).toBeLessThan(2.5);
});

// PLAIN-% form (round 2): a drag-commit leaves `left: N%` with NO translate —
// the % anchors the LEFT EDGE. Left-edge drag must move that edge (update the
// %), not spill the growth out the right side.
const PAGE_PLAIN = PAGE.replace(
  `left: '50.0138%', width: '298px', height: '155px', backgroundColor: '#ffb3ba', transform: 'translateX(-50%)' }} data-pinned="true"`,
  `left: '26.2531%', width: '298px', height: '155px', backgroundColor: '#ffffba' }}`,
);

test('left-edge resize on a PLAIN-% left (no translate) frame keeps the RIGHT edge fixed', async ({ page }) => {
  test.setTimeout(120_000);
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE_PLAIN,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('pink-1').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).__e2e.select(['pink-1']));
  await page.waitForTimeout(600);

  const before = await editor.node('pink-1').boundingBox();
  const rightEdgeBefore = before!.x + before!.width;

  const edge = page.locator('[data-resize-edge="left"]');
  await edge.waitFor({ state: 'visible', timeout: 10_000 });
  const eb = (await edge.boundingBox())!;
  const sx = eb.x + eb.width / 2;
  const sy = eb.y + eb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sx - (60 * i) / 8, sy);
    await page.waitForTimeout(50);
  }
  const during = await editor.node('pink-1').boundingBox();
  const rightEdgeDuring = during!.x + during!.width;
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const after = await editor.node('pink-1').boundingBox();
  const rightEdgeAfter = after!.x + after!.width;
  console.log('plain-% right edge', rightEdgeBefore, '/', rightEdgeDuring, '/', rightEdgeAfter, 'width', before!.width, '→', after!.width);

  expect(after!.width).toBeGreaterThan(before!.width + 30);
  expect(Math.abs(rightEdgeDuring - rightEdgeBefore)).toBeLessThan(2.5);
  expect(Math.abs(rightEdgeAfter - rightEdgeBefore)).toBeLessThan(2.5);

  // Committed: left stays a % and DECREASED (left edge moved left); no
  // translate appeared.
  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const leftMatch = code.match(/data-id="pink-1"[\s\S]*?left:\s*'(-?[\d.]+)%'/);
  expect(leftMatch).toBeTruthy();
  expect(parseFloat(leftMatch![1])).toBeLessThan(26.2531);
  expect(code).not.toMatch(/data-id="pink-1"[\s\S]{0,400}translateX/);
});

// ROTATED centered-x (round 3): `translateX(-50%) rotate(22.5deg)`, top-only
// pinned (the trace's exact shape). The compensated newLeft/newTop carry the
// full matrix coupling; the centered write adds the translate-size correction.
// Invariant asserted in PARENT-CSS space from the committed code: the local
// edge OPPOSITE the drag stays fixed (leftMid for a right drag, bottomMid for
// a top drag), where visualCenter = (left%·pW, top + h/2) and
// edgeMid = center ± R(θ)·(w/2, 0) / R(θ)·(0, h/2).
const PAGE_ROT = PAGE.replace(
  `left: '50.0138%', width: '298px', height: '155px', backgroundColor: '#ffb3ba', transform: 'translateX(-50%)' }} data-pinned="true"`,
  `left: '43.0565%', width: '402.797px', height: '224.135px', backgroundColor: '#ffb3ba', transform: 'translateX(-50%) rotate(22.5deg)' }} data-pinned="true"`,
);
const TH = (22.5 * Math.PI) / 180;
const PW = 561;

function committedBox(code: string): { cx: number; cy: number; w: number; h: number } {
  const seg = code.slice(code.indexOf('pink-1'), code.indexOf('pink-1') + 400);
  const num = (re: RegExp) => parseFloat(seg.match(re)![1]);
  const leftPct = num(/left:\s*'(-?[\d.]+)%'/);
  const top = num(/top:\s*'(-?[\d.]+)px'/);
  const w = num(/width:\s*'(-?[\d.]+)px'/);
  const h = num(/height:\s*'(-?[\d.]+)px'/);
  return { cx: (leftPct / 100) * PW, cy: top + h / 2, w, h };
}
const rot = (x: number, y: number) => ({
  x: x * Math.cos(TH) - y * Math.sin(TH),
  y: x * Math.sin(TH) + y * Math.cos(TH),
});

async function seedRotated(page: import('@playwright/test').Page): Promise<EditorPage> {
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE_ROT,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('pink-1').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).__e2e.select(['pink-1']));
  await page.waitForTimeout(600);
  return editor;
}

async function dragEdge(page: import('@playwright/test').Page, dir: string, dx: number, dy: number): Promise<void> {
  const edge = page.locator(`[data-resize-edge="${dir}"]`);
  await edge.waitFor({ state: 'visible', timeout: 10_000 });
  const eb = (await edge.boundingBox())!;
  const sx = eb.x + eb.width / 2, sy = eb.y + eb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sx + (dx * i) / 8, sy + (dy * i) / 8);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);
}

test('rotated 22.5° centered-x: RIGHT-edge drag keeps the local LEFT edge fixed', async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await seedRotated(page);
  const code0: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const b0 = committedBox(code0);
  await dragEdge(page, 'right', 50, 0);
  const code1: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const b1 = committedBox(code1);
  expect(b1.w).toBeGreaterThan(b0.w + 20);
  const m0 = rot(-b0.w / 2, 0), m1 = rot(-b1.w / 2, 0);
  const leftMid0 = { x: b0.cx + m0.x, y: b0.cy + m0.y };
  const leftMid1 = { x: b1.cx + m1.x, y: b1.cy + m1.y };
  console.log('leftMid drift', Math.hypot(leftMid1.x - leftMid0.x, leftMid1.y - leftMid0.y).toFixed(2), 'css px');
  expect(Math.hypot(leftMid1.x - leftMid0.x, leftMid1.y - leftMid0.y)).toBeLessThan(1.5);
});

test('rotated 22.5° centered-x: TOP-edge drag keeps the local BOTTOM edge fixed (x moves too)', async ({ page }) => {
  test.setTimeout(120_000);
  const editor = await seedRotated(page);
  const code0: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const b0 = committedBox(code0);
  await dragEdge(page, 'top', 0, -50);
  const code1: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const b1 = committedBox(code1);
  expect(b1.h).toBeGreaterThan(b0.h + 20);
  // The centered-x % MUST have moved: rotation couples height→x.
  expect(Math.abs(b1.cx - b0.cx)).toBeGreaterThan(2);
  const m0 = rot(0, b0.h / 2), m1 = rot(0, b1.h / 2);
  const botMid0 = { x: b0.cx + m0.x, y: b0.cy + m0.y };
  const botMid1 = { x: b1.cx + m1.x, y: b1.cy + m1.y };
  console.log('bottomMid drift', Math.hypot(botMid1.x - botMid0.x, botMid1.y - botMid0.y).toFixed(2), 'css px');
  expect(Math.hypot(botMid1.x - botMid0.x, botMid1.y - botMid0.y)).toBeLessThan(1.5);
});

// 180°-ROTATED canvas node (round 4): rotate(180deg) = matrix(-1,0,0,-1) has
// ZERO b/c shear terms, so the rotation detector classified it UN-rotated →
// corners came back axis-aligned with the LOCAL top edge labeled at the
// visual top (the painted local top actually sits at the visual BOTTOM).
// Grabbing the visual top thus resized the local top: the box grew DOWNWARD
// away from the cursor. With flip-aware detection the handle at the visual
// top carries the correct local direction and resize follows the mouse.
const PAGE_ROT180 = `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#ffffff' }}></div>
  );
}
const canvasNodes = <>
  <div data-id="cn-flip" data-name="Flip" data-canvas-node="true" style={{ position: 'absolute', width: '187px', height: '374px', backgroundColor: '#97cffc', left: '-460px', top: '120px', transform: 'rotate(-180deg)' }}></div>
</>;`;

test('180°-rotated canvas node: dragging the VISUAL top edge up grows the box upward', async ({ page }) => {
  test.setTimeout(120_000);
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE_ROT180,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('cn-flip').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).__e2e.select(['cn-flip']));
  await page.waitForTimeout(800);

  const before = (await editor.node('cn-flip').boundingBox())!;
  const bottomBefore = before.y + before.height;

  // Grab the HORIZONTAL edge handle painted nearest the node's VISUAL top —
  // with rotated corners that's the local 'bottom' edge; the test asserts
  // behavior, not the label.
  const handles = await page.locator('[data-resize-edge]').all();
  let topHandle: { el: (typeof handles)[number]; y: number } | null = null;
  for (const h of handles) {
    const hb = await h.boundingBox();
    if (!hb || hb.width < hb.height) continue; // vertical edges
    if (!topHandle || Math.abs(hb.y - before.y) < Math.abs(topHandle.y - before.y)) {
      topHandle = { el: h, y: hb.y };
    }
  }
  expect(topHandle).toBeTruthy();
  const hb = (await topHandle!.el.boundingBox())!;
  const sx = hb.x + hb.width / 2, sy = hb.y + hb.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sx, sy - (60 * i) / 8);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const after = (await editor.node('cn-flip').boundingBox())!;
  const bottomAfter = after.y + after.height;
  console.log('flip resize: top', before.y.toFixed(1), '→', after.y.toFixed(1), 'bottom', bottomBefore.toFixed(1), '→', bottomAfter.toFixed(1));
  // Height grew, the VISUAL top followed the cursor UP, the bottom held.
  expect(after.height).toBeGreaterThan(before.height + 30);
  expect(after.y).toBeLessThan(before.y - 30);
  expect(Math.abs(bottomAfter - bottomBefore)).toBeLessThan(2.5);
});
