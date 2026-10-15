// An SVG in the Media panel dropped as a frame with the file as a background
// picture — not editable (user report 2026-10-15). It now drops through the
// full vector pass: nested groups + editable paths, the svg editor's own tree.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/backend', () => ({ backend: { fetchMediaBytes: vi.fn(async () => { throw new Error('no proxy'); }) } }));

import {
  isSvgMediaUrl, buildSvgMediaDragItem, prefetchSvgMarkup, getPrefetchedSvgMarkup, seedSvgMarkup, resetSvgMarkupCacheForTest,
} from './media-svg-drop';
import { convertSvgToDropVector, convertSvgToEditableShapes, SVG_DROP_MAX_SIDE, SVG_DROP_MIN_SIDE } from '@/code/svg/svg-import';
import { normalizeLayoutDescriptor } from '@/canvas/drag/layout-normalize';
import { addNodeInCode, type AddNodeDef } from '@/code/generation/generator-crud';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { checkFile } from '@/code/oracle/check-file';
import type { NewNodeDescriptor } from '@/shared/types';

// A logo: a translated group holding a rotated rect + a circle, and a second
// group nested inside the first — the structure that must survive as groups.
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <g id="mark" transform="translate(10 10)">
    <rect x="0" y="0" width="40" height="40" fill="#e43225" transform="rotate(45 20 20)"/>
    <circle cx="80" cy="20" r="15" fill="#111111"/>
    <g id="dots"><circle cx="120" cy="20" r="5" fill="#111111"/><circle cx="140" cy="20" r="5" fill="#111111"/></g>
  </g>
  <path d="M10 80 H190" stroke="#111111" stroke-width="4" fill="none"/>
</svg>`;

const ghost = { width: 112, height: 112 };

/** Walk a descriptor tree. */
function walk(d: NewNodeDescriptor, visit: (n: NewNodeDescriptor, depth: number) => void, depth = 0): void {
  visit(d, depth);
  for (const c of d.children ?? []) walk(c, visit, depth + 1);
}

describe('isSvgMediaUrl', () => {
  it('matches .svg paths (query ignored) and svg data URLs only', () => {
    expect(isSvgMediaUrl('https://assets.revyme.app/u/w/images/uploaded/abc.svg')).toBe(true);
    expect(isSvgMediaUrl('https://assets.revyme.app/u/w/images/uploaded/abc.SVG?v=2')).toBe(true);
    expect(isSvgMediaUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(true);
    expect(isSvgMediaUrl('https://assets.revyme.app/u/w/images/uploaded/abc.webp')).toBe(false);
    expect(isSvgMediaUrl('https://x.com/a.svg.png')).toBe(false);
  });
});

describe('convertSvgToDropVector — the full vector pass, as drop descriptors', () => {
  it('keeps the source <g> structure as NESTED groups, ids derived from the root', () => {
    const v = convertSvgToDropVector(LOGO, 'Logo')!;
    expect(v).not.toBeNull();
    expect(v.groupCount).toBeGreaterThanOrEqual(2);
    const kids = v.children('svg-root-1');
    const root: NewNodeDescriptor = { tag: 'svg', id: 'svg-root-1', styles: {}, children: kids };
    let maxDepth = 0, paths = 0;
    walk(root, (n, depth) => {
      if (n.tag === 'path') { paths++; expect(n.id).toMatch(/^svg-root-1(-s\d+)*-g0$/); }
      if (n.tag === 'svg' && depth > 0) {
        expect(n.id).toMatch(/^svg-root-1(-s\d+)+$/);
        // the nested-group markup the shape editor drills into
        expect(n.attrs).toMatchObject({ preserveAspectRatio: 'none', overflow: 'visible' });
        expect(n.attrs!.viewBox).toBe(`0 0 ${n.attrs!.width} ${n.attrs!.height}`);
      }
      maxDepth = Math.max(maxDepth, depth);
    });
    expect(paths).toBe(v.shapeCount);
    expect(maxDepth).toBeGreaterThanOrEqual(3);   // root → mark → dots → path
  });

  it('bakes transforms into geometry — no transform attribute survives', () => {
    const kids = convertSvgToDropVector(LOGO, 'Logo')!.children('r');
    walk({ tag: 'svg', styles: {}, children: kids }, (n) => expect(n.attrs?.transform).toBeUndefined());
  });

  it('is the SAME geometry the icon-card import emits (one pass, two outputs)', () => {
    const v = convertSvgToDropVector(LOGO, 'Logo')!;
    const jsx = convertSvgToEditableShapes(LOGO, { iconId: 'x', displayName: 'Logo', cardW: 200, cardH: 100 })!.jsx;
    const ds: string[] = [];
    walk({ tag: 'svg', styles: {}, children: v.children('r') }, (n) => { if (n.tag === 'path') ds.push(n.attrs!.d); });
    expect(ds).toEqual([...jsx.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]));
  });

  it('shrink-wraps the root: viewBox 1:1 with its px box', () => {
    const v = convertSvgToDropVector(LOGO, 'Logo')!;
    expect(v.attrs).toEqual({ viewBox: `0 0 ${v.box.w} ${v.box.h}`, preserveAspectRatio: 'none' });
    expect(v.box.w).toBeLessThanOrEqual(200);
  });

  it('lands at its own size, the longest side clamped into the drop range', () => {
    const tiny = convertSvgToDropVector('<svg viewBox="0 0 24 24"><rect width="24" height="24"/></svg>', 'i')!;
    expect(Math.max(tiny.box.w, tiny.box.h)).toBe(SVG_DROP_MIN_SIDE);
    const huge = convertSvgToDropVector('<svg viewBox="0 0 3000 1500"><rect width="3000" height="1500"/></svg>', 'i')!;
    expect(huge.box).toEqual({ w: SVG_DROP_MAX_SIDE, h: SVG_DROP_MAX_SIDE / 2 });
  });

  it('returns null for what the shape model cannot express (gradient fill)', () => {
    const grad = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(convertSvgToDropVector(grad, 'G')).toBeNull();
  });
});

describe('buildSvgMediaDragItem', () => {
  it('drops an <svg> with the vector pass\'s children — not a background picture', () => {
    const item = buildSvgMediaDragItem('https://a/x.svg', LOGO, ghost)!;
    expect(item.elementType).toBe('svg');
    expect(item.defaultStyles.backgroundImage).toBeUndefined();
    expect(item.defaultAttrs?.preserveAspectRatio).toBe('none');
    expect(item.textContent).toBeUndefined();
    const kids = item.children!('svg-abc-1');
    expect(kids.length).toBeGreaterThan(0);
    expect(kids[0].id!.startsWith('svg-abc-1-')).toBe(true);
  });

  it('END TO END: drop normalizer → JSX writer → parser → oracle', () => {
    const item = buildSvgMediaDragItem('https://a/x.svg', LOGO, ghost)!;
    const rootId = 'svg-drop-1';
    const desc = normalizeLayoutDescriptor({
      tag: item.elementType, id: rootId, name: item.name,
      styles: { ...item.defaultStyles, position: 'absolute', left: '40px', top: '40px' },
      attrs: item.defaultAttrs, children: item.children!(rootId),
    });
    const toDef = (d: NewNodeDescriptor): AddNodeDef => ({
      id: d.id!, type: d.tag, styles: d.styles, attrs: d.attrs, name: d.name, children: d.children?.map(toDef),
    });
    const page = `'use client';
/** @canvas { "viewports": [ { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 } ], "positions": { "desktop": { "x": 0, "y": 0 } } } */
import React from 'react';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%', height: '800px' }}>
  </div>;
}`;
    const code = addNodeInCode(page, 'root', toDef(desc));
    const nodes = parseJSXToNodes(code);
    const root = nodes.get(rootId)!;
    expect(root.type).toBe('svg');
    expect(root.children.length).toBeGreaterThan(0);
    // a nested group is a real node the editor can select and drill into
    const nested = [...nodes.values()].filter((n) => n.type === 'svg' && n.id !== rootId);
    expect(nested.length).toBeGreaterThanOrEqual(2);
    const blocking = checkFile(code, { kind: 'page' }).filter((v) => v.tier === 3);
    expect(blocking).toEqual([]);
    const shapeRules = checkFile(code, { kind: 'page' }).filter((v) => /SHAPE|SVG/.test(v.code));
    expect(shapeRules).toEqual([]);
  });

  it('a gradient SVG still drops INLINE as an svg (decompose/verbatim chain), active content stripped', () => {
    const svg = '<svg viewBox="0 0 10 10"><script>alert(1)</script><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)" onclick="alert(2)"/></svg>';
    const item = buildSvgMediaDragItem('https://a/g.svg', svg, ghost)!;
    expect(item.elementType).toBe('svg');
    expect(item.defaultAttrs?.viewBox).toBe('0 0 10 10');
    expect(item.defaultStyles.width).toBe(`${SVG_DROP_MIN_SIDE}px`);
    expect(item.textContent).toContain('linearGradient');
    expect(item.textContent).not.toMatch(/script|onclick|alert/);
  });

  it('null for markup that is not a usable SVG — the caller drops the picture', () => {
    expect(buildSvgMediaDragItem('https://a/x.svg', '<svg></svg>', ghost)).toBeNull();
  });
});

describe('markup prefetch', () => {
  beforeEach(() => resetSvgMarkupCacheForTest());

  it('fetches once, caches, and is readable synchronously at drag start', async () => {
    const fetchMock = vi.fn(async () => new Response(LOGO));
    vi.stubGlobal('fetch', fetchMock);
    expect(getPrefetchedSvgMarkup('https://a/x.svg')).toBeUndefined();
    await Promise.all([prefetchSvgMarkup('https://a/x.svg'), prefetchSvgMarkup('https://a/x.svg')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getPrefetchedSvgMarkup('https://a/x.svg')).toBe(LOGO);
    vi.unstubAllGlobals();
  });

  it('a non-SVG body caches as null; an upload seeds straight from the file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>nope</html>')));
    expect(await prefetchSvgMarkup('https://a/bad.svg')).toBeNull();
    vi.unstubAllGlobals();
    seedSvgMarkup('https://a/new.svg', LOGO);
    expect(getPrefetchedSvgMarkup('https://a/new.svg')).toBe(LOGO);
  });
});
