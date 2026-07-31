// W/H → auto on a DESIGN-COMPONENT INSTANCE — regression for 2026-07-31: the
// auto→'' removal was applied imperatively by clearing the expanded root's
// inline width/height. But that inline style is the FLATTENED
// master+instance merge, so the clear dropped the master's base size too and
// the instance collapsed to text size; only a page switch (full re-expand)
// resolved it. The fix queues the removal + forces the flush render and skips
// the lossy imperative clear.
import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const MASTER = `'use client';

/** @name "TeCard" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function TeCard({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="tec-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{
      position: 'absolute',
      width: '300px',
      height: '200px',
      backgroundColor: '#97cffc',
      borderRadius: '12px',
      left: '0px',
      top: '0px',
      ...style
    }}>
      <motion.p layout={true} data-id="tec-text" data-name="Text" style={{ fontSize: '24px', color: '#000000', position: 'relative' }}>Card</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(TeCard);
`;

const PAGE = `/** @canvas { "viewports": [{"id":"desktop","width":1440,"label":"Desktop","isPrimary":true,"order":0,"height":"auto"}], "positions": {"desktop":{"x":0,"y":0}} } */
'use client';
import TeCard from '@/components/TeCard';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '700px', backgroundColor: '#ffffff', display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', padding: '40px' }}>
      <TeCard data-id="card-1" data-name="Card" style={{ position: 'relative', width: '546px', height: '354px', flex: '0 0 auto' }} />
    </div>
  );
}`;

test('W/H → auto on an instance resolves to the MASTER base size, no collapse', async ({ page }) => {
  test.setTimeout(120_000);
  const project = { format: 'revyme-v1', files: {
    'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
    'app/page.client.tsx': PAGE,
    'components/TeCard.tsx': MASTER,
  }};
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
  await editor.node('card-1').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => (window as any).__e2e.select(['card-1']));
  await page.waitForTimeout(800);

  const before = (await editor.node('card-1').boundingBox())!;
  const scale = before.width / 546; // instance rendered at its px override

  // The Dimensions section's W and H unit selects are the first two selects
  // offering an `auto` option.
  const autoSelects = page.locator('select:has(option[value="auto"])');
  await autoSelects.first().waitFor({ state: 'visible', timeout: 10_000 });
  await autoSelects.nth(0).selectOption('auto'); // Width → auto
  await page.waitForTimeout(900);
  await autoSelects.nth(1).selectOption('auto'); // Height → auto
  await page.waitForTimeout(1800);

  const syncTr: string[] = await page.evaluate(() =>
    ((window as any).__e2e.traceEntries('renderer:instance-wrapper-size-sync') ?? []).slice(-4).map((e: any) => JSON.stringify(e.data ?? e).slice(0, 220)));
  for (const t of syncTr) console.log('SYNC', t);
  const inlineStyle = await editor.node('card-1').evaluate((el) => (el as HTMLElement).getAttribute('style') ?? '');
  console.log('expanded inline:', inlineStyle.slice(0, 400));
  const codeMid: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  console.log('committed tag:', JSON.stringify(codeMid.slice(codeMid.indexOf('card-1'), codeMid.indexOf('card-1') + 300)));
  const after = (await editor.node('card-1').boundingBox())!;
  const cssW = after.width / scale;
  const cssH = after.height / scale;
  console.log('instance after auto:', cssW.toFixed(1), 'x', cssH.toFixed(1), 'css px');

  // Master base is 300×200 — the instance must resolve there, NOT collapse
  // to the text's size (pre-fix: ~60×30) and NOT keep the 546×354 override.
  expect(Math.abs(cssW - 300)).toBeLessThan(8);
  expect(Math.abs(cssH - 200)).toBeLessThan(8);

  // Committed code: the instance tag carries no width/height anymore.
  const code: string = await page.evaluate(() => (window as any).__e2e.readFile('app/page.client.tsx'));
  const tag = code.slice(code.indexOf('card-1'), code.indexOf('card-1') + 400);
  expect(tag).not.toMatch(/width:\s*'546px'/);
  expect(tag).not.toMatch(/height:\s*'354px'/);
});
