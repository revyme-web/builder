// Component-master root selection must NEVER unmount the Properties panel.
//
// EMPIRICAL PIN, live find 2026-07-29: on a MotionLink-root master (Sign Up
// button with a hover variant), selecting the root variant hid the ENTIRE
// right sidebar. Mechanism: masters have no `root` node, but two selection
// paths fall back to `'root'` (the canvas viewport-header click via
// ViewportHeaderManager when the tile container has no data-id, and the
// Layers page-header branch) — and PropertiesPanelInner returned `null` for
// an unresolvable id, unmounting the whole 260px sidebar instead of
// degrading to the empty shell.
//
// Guards under test:
//   1. Layers variant-header click selects the MASTER ROOT (children[0]).
//   2. An unresolvable selection ('root' on a master) keeps the panel shell
//      mounted (PropertiesPanel renders the empty shell, not null).
//   3. The master root itself renders the full panel (MotionLink root
//      included — its type must not blank the tools).

import { test, expect } from '@playwright/test';
import { EditorPage } from './helpers/editor-page';

const COMPONENT = `'use client';

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(Link);

/** @name "Sign Up Button" */

const variantConfig = [
  { name: 'default', label: 'Sign Up Button', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Sign Up Button - Hover', x: 0, y: 71, interactionType: 'hover', parentVariant: 'default' },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function SignUp({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
    <MotionLink
      onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} layout={true} key="signup" data-id="link-signup" {...rest} data-name="Sign Up Button" href="/" style={{ display: 'flex', flexDirection: 'row', gap: '10px', position: 'absolute', backgroundColor: '#111111', width: 'max-content', height: 'min-content', overflow: 'hidden', ...style}} initial={['default', initialVariant]} animate={['default', variant]}>
      <motion.p layout={true} data-id="text-signup" data-name="Sign Up Label" style={{ position: 'relative', fontSize: '16px', color: '#ffffff' }}>Sign Up</motion.p>
    </MotionLink>
    </LayoutGroup>
  );
}

export default withResponsiveProps(SignUp);
`;

test('master root selection paths keep the Properties panel alive', async ({ page }) => {
  const project = {
    format: 'revyme-v1',
    files: {
      'app/page.tsx': `import PageClient from './page.client';\n\nexport const metadata = {};\n\nexport default function Page() {\n  return <PageClient />;\n}\n`,
      'app/page.client.tsx': `/** @canvas { "viewports": [{"id":"desktop","width":1440}] } */\n'use client';\nexport default function Page() {\n  return (\n    <div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', width: '1440px', minHeight: '900px' }}></div>\n  );\n}`,
      'components/SignUp.tsx': COMPONENT,
    },
  };
  await page.addInitScript((data) => {
    window.localStorage.setItem('revyme-project-local', JSON.stringify(data));
    window.localStorage.setItem('revyme-onboarding-completed', 'true');
  }, project);
  await page.goto('/');
  const editor = new EditorPage(page);
  await editor.sandbox().locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 30_000 });

  await page.evaluate(() => (window as any).__e2e.openFile('components/SignUp.tsx'));
  await page.waitForTimeout(2000);

  // 3. The MotionLink master root renders the full panel.
  await page.evaluate(() => (window as any).__e2e.select(['link-signup']));
  await page.waitForTimeout(700);
  let panel = page.locator('[data-properties-panel]');
  await expect(panel, 'panel for MotionLink master root').toBeVisible();
  await expect(panel, 'root panel has content (Navigation section)').toContainText('Navigation');

  // 2. An unresolvable id (the 'root' fallback on a master) keeps the shell.
  await page.evaluate(() => (window as any).__e2e.select(['root']));
  await page.waitForTimeout(700);
  panel = page.locator('[data-properties-panel]');
  await expect(panel, 'panel shell survives unresolvable selection').toBeVisible();

  // 1. Layers variant-header click selects the master root and shows the panel.
  await page.evaluate(() => (window as any).__e2e.select([]));
  await page.locator('[data-tutorial="layers-button"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-layer-id="__vp_desktop"]').click({ timeout: 10_000 });
  await page.waitForTimeout(700);
  const selection: string[] = await page.evaluate(() => (window as any).__e2e.selection?.() ?? []);
  expect(selection, 'variant header selects the master root').toEqual(['link-signup']);
  await expect(page.locator('[data-properties-panel]'), 'panel after variant-header click').toContainText('Navigation');
});
