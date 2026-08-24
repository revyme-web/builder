// @vitest-environment jsdom
// A component master whose ROOT hugs its content, painted as an artboard tile.
//
// Reported 2026-08-24: a pill button that renders on ONE line on the page and on
// the live site wrapped mid-label on its own master artboard — 133px there
// versus 203px on the page. 133 is the label's MIN-content width.
//
// Every tile is stamped `position: absolute` inside #content-root, which is
// itself an absolute box with no width and no insets and therefore computes to
// zero. Shrink-to-fit against zero available space IS min-content, so an
// auto-width tile can only ever wrap at its longest word. Pages never hit it
// (their tile takes the definite `vp.width`); master roots only started to when
// hug roots stopped being frozen to measured px.
//
// jsdom does no layout, so these pin the STAMPED values — which is the whole
// mechanism: `max-content` for the width, and `container-type: normal`, without
// which inline-size containment would resolve that max-content against no
// contents at all and hand back a zero-wide tile.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => '', listFiles: () => [], exists: () => false,
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';

/** A one-variant master whose root carries `rootStyle`. */
const master = (rootStyle: string) => `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Find Advisor', x: 0, y: 0, isPrimary: true }];

function CeWoTi({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="find-btn" data-name="Find Advisor" style={{ ${rootStyle}, ...style }}>gfdgdfhdfhd sdfsdffhf</motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(CeWoTi);
`;

function renderTile(code: string): HTMLElement {
  (globalThis as any).CSS = (globalThis as any).CSS ?? {};
  (globalThis as any).CSS.escape = (globalThis as any).CSS.escape
    ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const viewports = [{ id: 'desktop', width: 0, x: 0, y: 0, isPrimary: true }] as any;
  renderNodes(container, parseJSXToNodes(code), null, () => {}, viewports, code);
  return container.querySelector('[data-node-id="find-btn"]') as HTMLElement;
}

describe('component master tile — a hugging root', () => {
  it('THE BUG: a root with no width key is stamped max-content, not left auto', () => {
    const el = renderTile(master("position: 'absolute', padding: '10px 18px', borderRadius: '999px'"));
    expect(el).toBeTruthy();
    expect(el.style.width).toBe('max-content');
  });

  it('an explicit `auto` width hugs the same way — it is the same declaration', () => {
    const el = renderTile(master("position: 'absolute', width: 'auto', padding: '10px 18px'"));
    expect(el.style.width).toBe('max-content');
  });

  it('and drops inline containment, which would size it against no contents', () => {
    const el = renderTile(master("position: 'absolute', padding: '10px 18px'"));
    expect(el.style.containerType).toBe('normal');
  });

  it('a root with a real width is untouched — it keeps px and its container', () => {
    const el = renderTile(master("position: 'absolute', width: '777px', height: '488px'"));
    expect(el.style.width).toBe('777px');
    expect(el.style.containerType).toBe('inline-size');
  });

  it('a Fit width is not overwritten — the user asked for min-content', () => {
    const el = renderTile(master("position: 'absolute', width: 'min-content'"));
    expect(el.style.width).toBe('min-content');
    expect(el.style.containerType).toBe('normal');
  });

  it('an in-flow hugging root gets the same treatment — the tile is absolute either way', () => {
    // `position: absolute` is stamped on every tile regardless of what the root
    // authored, so the zero-width containing block clamps a relative root too.
    const el = renderTile(master("position: 'relative', padding: '10px 18px'"));
    expect(el.style.width).toBe('max-content');
  });
});
