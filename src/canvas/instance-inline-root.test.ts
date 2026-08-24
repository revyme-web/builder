// @vitest-environment jsdom
// A component whose ROOT is an inline-level tag, rendered as an INSTANCE.
//
// Reported 2026-08-24: a pill button rendered fine on the live site — its
// parent row measured 447 × 36.5 and wrapped it — while on the canvas the same
// parent was one line-height tall and the pill overflowed it. The instance
// itself read 203 × 17 around a box painting 36px tall.
//
// On the live site the component's SINGLE element is the flex item, and a flex
// item is blockified whatever its tag. The canvas expands an instance into two
// divs — wrapper (placement) + root (visuals) — so the wrapper becomes the flex
// item and the root lands as an ordinary child of a block container, where an
// `<a>` stays INLINE: its padding paints outside the line box and the wrapper
// measures a line-height instead of the root's border box.
//
// jsdom does no layout, so these pin the stamped `display` — the whole
// mechanism. The wrapper's collapse was invisible while master roots were
// frozen to measured px, because the wrapper adopted that baked height.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/code/project/project-fs', async (orig) => {
  const actual = await orig<typeof import('@/code/project/project-fs')>();
  return { ...actual, projectFS: { readFile: () => '', listFiles: () => [], exists: () => false, writeFile: () => {}, deleteFile: () => {} } };
});

import { parseProjectFile, clearComponentParseCache } from '@/code/parsing/project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';
import { renderNodes } from '@/canvas/Renderer';
import type { CanvasNode } from '@/code/parsing/parser';

/** A one-element master whose root tag + style are the variables under test. */
const master = (tag: string, style: string) => `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
import { withResponsiveProps } from '@revyme/runtime';

const MotionLink = motion.create(Link);

/** @name "Find Advisor" */

function FindAdvisor({ style }) {
  return (
    <LayoutGroup>
      <${tag} data-id="btn-root" data-name="Find Advisor" style={{ ${style}, ...style }}>gfdgdfhdfhd sdfsdffhf</${tag}>
    </LayoutGroup>
  );
}

export default withResponsiveProps(FindAdvisor);
`;

const PAGE = `
import React from 'react';
import FindAdvisor from '@/components/FindAdvisor';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="nav" data-name="Nav Actions" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <FindAdvisor data-id="find-btn" style={{ position: 'relative', order: '0', flex: '0 0 auto' }} />
      </div>
    </div>
  );
}
`;

const VIEWPORTS = [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true }] as any;

/** Parse the page against a master built from `tag` + `style`. */
function parseFor(tag: string, style: string): { nodes: Map<string, CanvasNode>; rootId: string } {
  clearComponentParseCache();
  (globalThis as any).CSS = (globalThis as any).CSS ?? {};
  (globalThis as any).CSS.escape = (globalThis as any).CSS.escape
    ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
  const fs = new InMemoryProjectFS(new Map([
    ['app/page.tsx', PAGE],
    ['components/FindAdvisor.tsx', master(tag, style)],
  ]));
  const nodes = parseProjectFile('app/page.tsx', fs);
  const root = [...nodes.values()].find((n) => n.isComponentRoot && n.componentInstanceId);
  expect(root, 'the instance should expand to a component root').toBeTruthy();
  return { nodes, rootId: root!.id };
}

function render(container: HTMLElement, nodes: Map<string, CanvasNode>, rootId: string): HTMLElement {
  renderNodes(container, nodes, null, () => {}, VIEWPORTS, PAGE);
  const el = container.querySelector(`[data-node-id="${rootId}"]`) as HTMLElement;
  expect(el, 'the component root should reach the DOM').toBeTruthy();
  return el;
}

/** Render the page and hand back the DOM element for the expanded master root. */
function renderRoot(tag: string, style: string): { el: HTMLElement } {
  const { nodes, rootId } = parseFor(tag, style);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { el: render(container, nodes, rootId) };
}

describe('instance root — inline tags are blockified so the wrapper can measure them', () => {
  it('THE BUG: a MotionLink root reaches the DOM as <a> and is blockified', () => {
    const { el } = renderRoot('MotionLink', "position: 'absolute', padding: '10px 18px', borderRadius: '999px'");
    expect(el.tagName.toLowerCase()).toBe('a');
    expect(el.style.display).toBe('block');
  });

  it('a <button> root too — same inline default, same collapse', () => {
    const { el } = renderRoot('motion.button', "position: 'absolute', padding: '10px 18px'");
    expect(el.style.display).toBe('block');
  });

  it('a div root is left alone — it is already block-level', () => {
    const { el } = renderRoot('motion.div', "position: 'absolute', padding: '10px 18px'");
    expect(el.style.display).toBe('');
  });

  it('an AUTHORED display wins — inline-flex is a deliberate choice', () => {
    const { el } = renderRoot('MotionLink', "position: 'absolute', display: 'inline-flex', padding: '10px 18px'");
    expect(el.style.display).toBe('inline-flex');
  });

  it('REMOVING an authored display re-stamps block on the patch path', () => {
    // The first paint runs buildNodeElement; every render after it patches the
    // element in place, so the stamp has to live on BOTH paths. This is the
    // transition that proves it: patchElement's stale-clear drops a `display`
    // it wrote last render, and without its own stamp the root falls straight
    // back to inline — the collapse returns mid-session with no rebuild to
    // recover it.
    const withDisplay = parseFor('MotionLink', "position: 'absolute', display: 'inline-flex', padding: '10px 18px'");
    const without = parseFor('MotionLink', "position: 'absolute', padding: '10px 18px'");
    expect(without.rootId, 'same data-id → patched in place').toBe(withDisplay.rootId);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const el = render(container, withDisplay.nodes, withDisplay.rootId);
    expect(el.style.display).toBe('inline-flex');

    const el2 = render(container, without.nodes, without.rootId);
    expect(el2, 'patched in place, not rebuilt').toBe(el);
    expect(el2.style.display).toBe('block');
  });
});
