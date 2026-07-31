import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const PAGE = (canvas: string) => `'use client';

${canvas}

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
</div>
  );
}`;

const GOOD = `/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1560, "y": 0 },
    "mobile": { "x": 2450, "y": 0 }
  }
} */`;

const cc = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code.startsWith('CANVAS_CONFIG')).map((x) => x.code);

describe('@canvas viewport config dialect', () => {
  it('three-viewport canonical block passes clean', () => {
    expect(cc(PAGE(GOOD))).toEqual([]);
  });
  it('missing block bounces', () => {
    expect(cc(PAGE(''))).toContain('CANVAS_CONFIG_MISSING');
  });
  it('broken JSON bounces', () => {
    expect(cc(PAGE('/** @canvas { viewports: [ } */'))).toContain('CANVAS_CONFIG_INVALID');
  });
  it('two primaries bounce', () => {
    expect(cc(PAGE(GOOD.replace('"isPrimary": false, "order": 1', '"isPrimary": true, "order": 1')))).toContain('CANVAS_CONFIG_INVALID');
  });
  it('missing positions entry bounces', () => {
    expect(cc(PAGE(GOOD.replace('"mobile": { "x": 2450, "y": 0 }', '"mobile2": { "x": 2450, "y": 0 }')))).toContain('CANVAS_CONFIG_INVALID');
  });
});

const vh = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'CANVAS_VIEWPORT_FIXED_HEIGHT').length;

describe('@canvas viewport height — content must not clip', () => {
  it('height "auto" passes (no fixed-height violation)', () => {
    expect(vh(PAGE(GOOD))).toBe(0);
  });
  it('omitted height passes', () => {
    const noHeight = `/** @canvas { "viewports": [ { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 } ], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;
    expect(vh(PAGE(noHeight))).toBe(0);
  });
  it('a fixed pixel height bounces CANVAS_VIEWPORT_FIXED_HEIGHT', () => {
    const fixed = `/** @canvas { "viewports": [ { "id": "desktop", "label": "Desktop", "width": 1440, "height": 900, "isPrimary": true, "order": 0 } ], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;
    expect(vh(PAGE(fixed))).toBe(1);
  });
});

const bm = (code: string) => checkFile(code, { kind: 'page' }).filter((x) => x.code === 'CANVAS_VIEWPORT_BREAKPOINT_MISMATCH').length;

describe('@canvas breakpoint mismatch — styled widths need a viewport tile', () => {
  // EMPIRICAL PIN, live find 2026-07-29: MCP-authored pricing/about pages
  // shipped a desktop-only @canvas next to 768/375 @media overrides —
  // responsive on the live site, but no canvas tiles to see or edit it.
  const DESKTOP_ONLY = `/** @canvas { "viewports": [ { "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 } ], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;

  it('desktop-only @canvas with 768/375 @media rules bounces', () => {
    const code = PAGE(DESKTOP_ONLY).replace(`height: '900px' }}>`, `height: '900px' }}><style>{\`@media (max-width: 768px) { [data-id="x"] { padding: 0 !important; } } @media (max-width: 375px) { [data-id="x"] { padding: 0 !important; } }\`}</style>`);
    expect(bm(code)).toBe(1);
  });

  it('desktop-only @canvas with a data-responsive _bp list bounces', () => {
    const code = PAGE(DESKTOP_ONLY).replace('<div data-id="root"', `<div data-responsive='{"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}' data-id="root"`);
    expect(bm(code)).toBe(1);
  });

  it('three-viewport block with the same breakpoints passes clean', () => {
    const code = PAGE(GOOD).replace(`height: '900px' }}>`, `height: '900px' }}><style>{\`@media (max-width: 768px) { [data-id="x"] { padding: 0 !important; } }\`}</style>`);
    expect(bm(code)).toBe(0);
  });

  it('a page with no responsive code passes with any viewport set', () => {
    expect(bm(PAGE(DESKTOP_ONLY))).toBe(0);
  });

  it('the 375.02px min-width bound of a range query is not counted as a breakpoint', () => {
    const code = PAGE(GOOD).replace(`height: '900px' }}>`, `height: '900px' }}><style>{\`@media (max-width: 768px) and (min-width: 375.02px) { [data-id="x"] { padding: 0 !important; } }\`}</style>`);
    expect(bm(code)).toBe(0);
  });
});
