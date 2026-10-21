// Size + aspect lock — regression for the 2026-10-12 report (Bug #17,
// "multiple resizing issues with .svg files"): keeping one side in px and the
// other on auto took lock/unlock gymnastics, and the units flipped on their own.
//
// VECTORS now size like a reference shape: one Size row, W×H in px, plus the
// lock — no unit choice at all. Locked, typing one side derives the other in
// px, and the canvas handles keep the ratio from any edge.
//
// FRAMES keep their units; their lock pins:
//   • the free side is the Fit spelling (`min-content`) — a literal `auto` is
//     STRETCHED by a flex row on its cross axis,
//   • typing into the locked free side makes it the driver (it used to leave
//     both sides definite, so the browser dropped the ratio).
import { test, expect, type Page } from '@playwright/test';
import { EditorPage } from '../../../canvas/drag/e2e/helpers/editor-page';

// A 300px flex ROW with align-items at its default `stretch` — a navbar whose
// taller siblings set the row height. (Not the page root: the viewport makes
// the root auto-height, so a lone child would set the row height itself.)
const page = (child: string) => `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '500px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', padding: '40px' }}>
      <div data-id="row" data-name="Row" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '1000px', height: '300px', display: 'flex', flexDirection: 'row', backgroundColor: '#eeeeee' }}>
        ${child}
      </div>
    </div>
  );
}`;

// A native vector: viewBox 1:1 with its px box, art 3.75:1.
const vector = (height = '64px') => `<svg data-id="t" data-name="Logo" viewBox="0 0 240 64" preserveAspectRatio="none" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '240px', height: '${height}', overflow: 'visible' }}><path data-id="t-g0" d="M0 0L240 0L240 64L0 64Z" fill="#111111" /></svg>`;
const frame = `<div data-id="t" data-name="Box" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '240px', height: '64px', backgroundColor: '#111111' }} />`;

async function boot(p: Page, child: string): Promise<EditorPage> {
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': page(child),
  }};
  await p.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await p.goto('/');
  const editor = new EditorPage(p);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('t').waitFor({ state: 'attached', timeout: 60_000 });
  await p.waitForTimeout(1500);
  await editor.select(['t']);
  await p.waitForTimeout(800);
  return editor;
}

/** The target's rendered CSS box (zoom-independent). */
async function cssSize(editor: EditorPage): Promise<{ w: number; h: number }> {
  return editor.node('t').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { w: Math.round(parseFloat(cs.width)), h: Math.round(parseFloat(cs.height)) };
  });
}

async function tag(editor: EditorPage): Promise<string> {
  const code = await editor.readFile('app/page.client.tsx');
  const at = code.indexOf('data-id="t"');
  return code.slice(at, code.indexOf('>', at));
}

const styleOf = (t: string, prop: string): string | null =>
  new RegExp(`(?:^|[{,\\s])${prop}:\\s*'([^']*)'`).exec(t)?.[1] ?? null;

async function typeInto(p: Page, input: ReturnType<Page['locator']>, value: string): Promise<void> {
  await input.click();
  // ToolInput selects its text on the NEXT animation frame after focus —
  // typing before it lands lets that selection eat the first keystroke.
  await p.waitForTimeout(200);
  await p.keyboard.press('ControlOrMeta+a');
  await p.keyboard.type(value);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1200);
}

const lockBtn = (p: Page) => p.locator('button[title="Lock aspect ratio"]');
const unlockBtn = (p: Page) => p.locator('button[title="Unlock aspect ratio"]');

test.use({ viewport: { width: 1720, height: 1000 } });

test.describe('vector: Size = W×H px + lock', () => {
  const vecInput = (p: Page, axis: 'width' | 'height') => p.locator(`[data-vector-size="${axis}"] input`);

  test('no unit choice; locked, one side derives the other in px', async ({ page: p }) => {
    test.setTimeout(120_000);
    const editor = await boot(p, vector());
    await expect(vecInput(p, 'width')).toBeVisible();
    await expect(vecInput(p, 'height')).toBeVisible();
    // The Dimensions W/H unit dropdowns are gone for a vector.
    await expect(p.locator('select:has(option[value="auto"]):has(option[value="%"])')).toHaveCount(0);

    await lockBtn(p).click();
    await p.waitForTimeout(1200);
    let t = await tag(editor);
    console.log('after lock:', t);
    expect(styleOf(t, 'aspectRatio')).toBeTruthy();
    expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['240px', '64px']);
    expect(await cssSize(editor)).toEqual({ w: 240, h: 64 });

    await typeInto(p, vecInput(p, 'width'), '480');
    t = await tag(editor);
    console.log('after W=480:', t);
    expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['480px', '128px']);
    expect(await cssSize(editor)).toEqual({ w: 480, h: 128 });

    await typeInto(p, vecInput(p, 'height'), '100');
    t = await tag(editor);
    console.log('after H=100:', t);
    expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['375px', '100px']);
    expect(await cssSize(editor)).toEqual({ w: 375, h: 100 });

    // Unlock only drops the ratio; then the sides are independent again.
    await unlockBtn(p).click();
    await p.waitForTimeout(1200);
    t = await tag(editor);
    console.log('after unlock:', t);
    expect(styleOf(t, 'aspectRatio')).toBeNull();
    expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['375px', '100px']);
    await typeInto(p, vecInput(p, 'width'), '200');
    expect(await cssSize(editor)).toEqual({ w: 200, h: 100 });
  });

  test('a legacy auto height shows px, and locking pins it to px', async ({ page: p }) => {
    test.setTimeout(120_000);
    const editor = await boot(p, vector('min-content'));
    await expect(vecInput(p, 'height')).toHaveValue('64');
    await lockBtn(p).click();
    await p.waitForTimeout(1200);
    const t = await tag(editor);
    console.log('legacy after lock:', t);
    expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['240px', '64px']);
    expect(styleOf(t, 'aspectRatio')).toBeTruthy();
  });

  test('locked: a canvas edge drag scales both sides', async ({ page: p }) => {
    test.setTimeout(120_000);
    const editor = await boot(p, vector());
    await lockBtn(p).click();
    await p.waitForTimeout(1200);

    const handle = p.locator('[data-resize-edge="right"]').first();
    await handle.waitFor({ state: 'visible', timeout: 10_000 });
    const hb = (await handle.boundingBox())!;
    const before = (await editor.node('t').boundingBox())!;
    const zoom = before.width / 240;
    await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(hb.x + hb.width / 2 + (240 * zoom * i) / 10, hb.y + hb.height / 2);
    await p.mouse.up();
    await p.waitForTimeout(1500);

    const t = await tag(editor);
    console.log('after edge drag:', t);
    const w = parseFloat(styleOf(t, 'width') ?? '0');
    const h = parseFloat(styleOf(t, 'height') ?? '0');
    expect(w).toBeGreaterThan(300); // the drag engaged (240 → ~480)
    expect(Math.abs(w / h - 3.75)).toBeLessThan(0.05);
  });

  // An ABSOLUTE shape on the primary resizes through the geometry-bake loop
  // (startRotatedSvgShapeResize), not the main path — the lock was ignored
  // there while the panel inputs honoured it (user find 2026-10-20).
  test('locked absolute shape: edge and corner drags keep the ratio', async ({ page: p }) => {
    test.setTimeout(120_000);
    const triangle = `<div data-id="frame" data-name="Frame" style={{ position: 'relative', flex: '0 0 auto', order: '0', width: '700px', height: '300px', backgroundColor: '#a3cdf7' }}><svg data-id="t" data-name="Triangle" viewBox="0 0 168 124" preserveAspectRatio="none" style={{ position: 'absolute', left: '200px', top: '60px', width: '168px', height: '124px', overflow: 'visible' }}><path data-id="t-g0" d="M84 0L168 124L0 124Z" fill="#3B82F6" /></svg></div>`;
    const editor = await boot(p, triangle);
    await lockBtn(p).click();
    await p.waitForTimeout(1200);
    const ratio = 168 / 124;

    const drag = async (sel: string, dx: number, dy: number) => {
      const handle = p.locator(sel).first();
      await handle.waitFor({ state: 'visible', timeout: 10_000 });
      const hb = (await handle.boundingBox())!;
      const x0 = hb.x + hb.width / 2, y0 = hb.y + hb.height / 2;
      await p.mouse.move(x0, y0);
      await p.mouse.down();
      for (let i = 1; i <= 10; i++) await p.mouse.move(x0 + (dx * i) / 10, y0 + (dy * i) / 10);
      await p.mouse.up();
      await p.waitForTimeout(1500);
      const t = await tag(editor);
      return { t, w: parseFloat(styleOf(t, 'width') ?? '0'), h: parseFloat(styleOf(t, 'height') ?? '0') };
    };
    const zoom = (await editor.node('t').boundingBox())!.width / 168;

    const edge = await drag('[data-resize-edge="right"]', 100 * zoom, 0);
    console.log('abs after edge drag:', edge.t);
    expect(edge.w).toBeGreaterThan(220); // engaged (168 → ~268)
    expect(Math.abs(edge.w / edge.h - ratio)).toBeLessThan(0.03);

    const corner = await drag('[data-resize-dir="bottomRight"]', 60 * zoom, 5 * zoom);
    console.log('abs after corner drag:', corner.t);
    expect(corner.w).toBeGreaterThan(edge.w + 30);
    expect(Math.abs(corner.w / corner.h - ratio)).toBeLessThan(0.03);
  });
});

test('frame: the lock keeps the ratio in a stretching row; typed side drives', async ({ page: p }) => {
  test.setTimeout(120_000);
  const editor = await boot(p, frame);
  // Dimensions W (0) / H (1): the unit select, and the number input on its row.
  const unit = (row: 0 | 1) => p.locator('select:has(option[value="auto"])').nth(row);
  const input = (row: 0 | 1) => unit(row).locator('xpath=ancestor::div[contains(@class,"justify-between")][1]//input[@type="text"]');

  await lockBtn(p).click();
  await p.waitForTimeout(1200);
  let t = await tag(editor);
  console.log('frame after lock:', t);
  // Not stretched to the row's height (a literal `auto` free side is).
  expect(await cssSize(editor)).toEqual({ w: 240, h: 64 });
  expect(styleOf(t, 'height')).toBe('min-content');

  await typeInto(p, input(0), '480');
  expect(await cssSize(editor)).toEqual({ w: 480, h: 128 });

  // Typing into the Fit height: height takes over, width derives.
  await typeInto(p, input(1), '100');
  t = await tag(editor);
  console.log('frame after H=100:', t);
  expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['min-content', '100px']);
  expect(await cssSize(editor)).toEqual({ w: 375, h: 100 });

  // Unlock freezes the Fit side to px — a frame's Fit would hug its content.
  await unlockBtn(p).click();
  await p.waitForTimeout(1200);
  t = await tag(editor);
  expect(styleOf(t, 'aspectRatio')).toBeNull();
  expect([styleOf(t, 'width'), styleOf(t, 'height')]).toEqual(['375px', '100px']);
});
