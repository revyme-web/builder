// DND · Component instances and code components dragged from the canvas into
// a replica tile: the per-viewport visibility recipe (E2E_TEST_PLAN.md §2, batch D6).

import { test, expect, TILES_VIEWPORT } from '../../fixtures/test';
import {
  seed, pageWithCanvas, TILES, gesture, prime, displayIn, traces, stableCode, quickBox,
} from '../../helpers/d6';

test.use({ viewport: TILES_VIEWPORT });
test.describe.configure({ timeout: 150_000 });

// ─── Seeds ───────────────────────────────────────────────────────────

const ROOT_WITH_HERO = `
<div data-id="root" data-name="Page" style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%', minHeight: '900px', position: 'relative', backgroundColor: '#0d0d1a', padding: '40px' }}>
  <div data-id="hero" data-name="Hero" style={{ width: '100%', height: '200px', backgroundColor: '#1a1a3a', position: 'relative', flex: '0 0 auto' }}></div>
</div>`;

const CARD_MASTER = `'use client';

/** @name "Card" */

import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true }];

function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="card-root" initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} data-name="Card" style={{
      position: 'absolute',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      width: '300px',
      height: '200px',
      padding: '24px',
      backgroundColor: '#97cffc',
      borderRadius: '12px',
      left: '0px',
      top: '0px',
      ...style
    }}>
      <motion.p layout={true} data-id="card-text" data-name="Text" style={{ fontSize: '24px', color: '#000000', position: 'relative' }}>Card</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Card);
`;

/** INSTANCE_CANVAS_3VP: a design-component instance free on the canvas above the Desktop tile. */
const INSTANCE_CANVAS_3VP = seed(pageWithCanvas({
  tiles: TILES.three, imports: [`import Card from '@/components/Card';`], root: ROOT_WITH_HERO, canvas: `
  <Card data-id="card-inst" data-name="Card" data-canvas-node="true" style={{ position: 'absolute', left: '600px', top: '-320px', width: '300px', height: '200px' }} />
` }), { 'components/Card.tsx': CARD_MASTER });

/** A local code component whose root is a `<span>` with its own display. */
const BADGE_CODE_COMPONENT = `'use client';

/** @label "Badge" */
/** @comment "A pill with a label" */
/** @controls {
  "label": { "type": "text", "label": "Label", "default": "New" }
} */

import { withResponsiveProps } from '@revyme/runtime';

function Badge({ label = 'New', ...props }: { label?: string; [key: string]: any }) {
  return (
    <span {...props} style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 12px', borderRadius: '999px', backgroundColor: '#ffcc33', color: '#000000', ...(props.style || {}) }}>
      {label}
    </span>
  );
}

export default withResponsiveProps(Badge);
`;

const CDN_URL = 'https://assets.revyme.app/components/StubPill@0123456789abcdef.js';

const CODE_COMPONENTS_3VP = seed(pageWithCanvas({
  tiles: TILES.three,
  imports: [`import Badge from '@/components/Badge';`, `import StubPill from '${CDN_URL}';`],
  root: ROOT_WITH_HERO, canvas: `
  <Badge data-id="badge-inst" data-name="Badge" data-canvas-node="true" style={{ position: 'absolute', left: '300px', top: '-260px', width: '160px', height: '60px' }} />
  <StubPill data-id="cdn-inst" data-name="StubPill" data-canvas-node="true" style={{ position: 'absolute', left: '900px', top: '-260px', width: '160px', height: '60px' }} />
` }), { 'components/Badge.tsx': BADGE_CODE_COMPONENT });

// ─── Helpers ─────────────────────────────────────────────────────────

/** Drag a canvas node (by its box centre, a hair off) into the Tablet root below the hero. */
async function dropIntoTablet(editor: Parameters<typeof prime>[0], id: string): Promise<void> {
  await prime(editor, id);
  const box = await editor.nodeBox(id);
  const root = await editor.nodeBoxIn('tablet', 'root');
  const hero = await editor.nodeBoxIn('tablet', 'hero');
  const from = { x: box.x + box.width / 2 + 6, y: box.y + box.height / 2 + 4 };
  const to = { x: root.x + root.width / 2, y: hero.y + hero.height + (root.y + root.height - hero.y - hero.height) * 0.4 };
  // Come in from the gap left of the tile at the target height, so the path never
  // crosses the hero frame (a no-layout frame would capture the node on the way).
  const gap = { x: root.x - 16, y: to.y };
  await gesture(editor, from, [{ x: gap.x, y: from.y }, gap, to], { steps: 14 });
  await expect.poll(() => editor.parentOf(id)).toBe('root');
  await stableCode(editor);
}

// ─── Tests ───────────────────────────────────────────────────────────

test('DND-162 a canvas component instance dropped into the Tablet tile shows on Tablet only', { tag: ['@p1', '@dnd', '@tiles', '@cmp'] }, async ({ editor }) => {
  await editor.load(INSTANCE_CANVAS_3VP, { fit: true });
  const before = await editor.code();
  await dropIntoTablet(editor, 'card-inst');

  // Source: the pair landed in the right channels.
  const src = await editor.source();
  expect(src.byId.get('card-inst')?.tag).toBe('Card');
  expect(src.byId.get('card-inst')?.attrs['data-canvas-node']).toBeUndefined();
  await expect(editor).toHaveStyle('card-inst', 'display', 'none');
  await expect(editor).toHaveBandStyle(768, 'card-inst', 'display', 'flex', { important: true });
  await expect(editor).toHaveBandStyle(375, 'card-inst', 'display', 'none');
  expect(await editor.code(), 'no band keyed at the primary width').not.toContain('max-width: 1440px');

  // Tiles: hidden on Desktop + Mobile; on Tablet the inner root paints a real flex box.
  await expect.poll(() => displayIn(editor, 'tablet', 'card-inst')).toBe('flex');
  expect(await displayIn(editor, 'desktop', 'card-inst')).toBe('none');
  expect(await displayIn(editor, 'mobile', 'card-inst')).toBe('none');
  const innerRoot = editor.sandbox().locator('[data-node-id="tablet-card-inst:card-root"]').first();
  const innerBox = await quickBox(innerRoot);
  expect(innerBox, 'inner root has a box on Tablet').not.toBeNull();
  expect(innerBox!.height).toBeGreaterThan(20);
  expect(await innerRoot.evaluate(el => getComputedStyle(el).display)).toBe('flex');

  await expect(editor).toUndoInOneStep(before);
  // Back to the seed: the inline display:'none' half of the recipe trips the oracle (see DND-155).
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
});

test('DND-169 a local code component restores its parsed root display; a CDN one falls back to a traced block', { tag: ['@p2', '@dnd', '@tiles', '@cmp'] }, async ({ editor, page }) => {
  // The CDN bundle is stubbed: no network, and its root display is unknowable by design.
  await page.context().route(/assets\.revyme\.app\/components\//, route => route.fulfill({
    status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
    body: 'export default function StubPill(props) { return null; }',
  }));
  // LOCAL mode has no backend: `/api/components/metadata` falls through to the SPA's
  // index.html and the metadata hook logs a JSON parse error. Answer it like a
  // backend that has no metadata for this hash.
  await page.context().route(/\/api\/components\/metadata/, route => route.fulfill({ status: 404, body: '' }));
  editor.allowErrors(/api\/components\/metadata.*404|404.*api\/components\/metadata|status of 404/);
  await editor.load(CODE_COMPONENTS_3VP, { fit: true });
  const before = await editor.code();

  // ── Local code component (`<span>` root, display: inline-flex).
  await dropIntoTablet(editor, 'badge-inst');
  await expect(editor).toHaveStyle('badge-inst', 'display', 'none');
  await expect(editor).toHaveBandStyle(768, 'badge-inst', 'display', 'inline-flex', { important: true });
  const unhides = await traces(editor, 'instance-replica-visibility:unhide-display');
  expect(unhides.at(-1)?.data).toMatchObject({ type: 'Badge', display: 'inline-flex', guessed: false });
  await expect.poll(() => displayIn(editor, 'tablet', 'badge-inst')).not.toBe('none');
  expect(await displayIn(editor, 'desktop', 'badge-inst')).toBe('none');
  const afterBadge = await editor.code();

  // ── CDN component: `block`, traced as a guess.
  await dropIntoTablet(editor, 'cdn-inst');
  await expect(editor).toHaveStyle('cdn-inst', 'display', 'none');
  await expect(editor).toHaveBandStyle(768, 'cdn-inst', 'display', 'block', { important: true });
  const cdnUnhide = (await traces(editor, 'instance-replica-visibility:unhide-display')).at(-1)?.data;
  expect(cdnUnhide).toMatchObject({ type: 'StubPill', display: 'block', source: 'block-fallback', guessed: true });
  // Never `unset`, never an invalid ternary remnant, for either.
  const code = await editor.code();
  expect(code).not.toMatch(/\[data-id="(badge|cdn)-inst"\][^}]*display:\s*(unset|[^;}]*\?)/);
  await expect.poll(() => displayIn(editor, 'tablet', 'cdn-inst')).toBe('block');

  await expect(editor).toUndoInOneStep(afterBadge);
  // Back to the seed (inline display:'none' trips the oracle, see DND-155).
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(afterBadge);
  await editor.undo();
  await expect.poll(() => editor.code()).toBe(before);
});
