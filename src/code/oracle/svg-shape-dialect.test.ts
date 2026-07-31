import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));

import { checkFile } from './check-file';

const codes = (vs: { code: string }[]) => vs.map((x) => x.code);

// The CANONICAL icon — a group of two path shapes, exactly what the editor's
// own creators emit. Must pass with ZERO svg-dialect violations.
const CANONICAL_ICON = `'use client';

/** @name "StarIcon" */

import React from 'react';

function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
    <svg data-id="vector-icon-1" data-name="Group" viewBox="0 0 48 48" preserveAspectRatio="none" style={{
      position: 'absolute', left: '40px', top: '40px', width: '48px', height: '48px', overflow: 'visible'
    }}><svg data-id="shape-icon-2" data-name="Star" x="4" y="4" width="40" height="40" viewBox="0 0 40 40" preserveAspectRatio="none" overflow="visible">
      <path data-id="shape-icon-2-g0" fill="#3b82f6" stroke="#000000" stroke-width="0" d="M20 0 L25 14 L40 14 L28 23 L33 38 L20 29 L7 38 L12 23 L0 14 L15 14 Z" />
    </svg><svg data-id="shape-icon-3" data-name="Dot" x="20" y="20" width="8" height="8" viewBox="0 0 8 8" preserveAspectRatio="none" overflow="visible">
      <path data-id="shape-icon-3-g0" fill="#8726d2" stroke="none" d="M4 0 A4 4 0 1 1 3.99 0 Z" />
    </svg></svg>
  </div>;
}
export default Page;
`;

describe('SVG shape dialect', () => {
  it('canonical icon passes clean', () => {
    const out = checkFile(CANONICAL_ICON, { kind: 'page' });
    expect(out.filter((x) => x.code.startsWith('SHAPE_') || x.code.startsWith('NESTED_SVG') || x.code === 'WRAPPER_PAINT_PROPS')).toEqual([]);
  });

  it('polygon geometry bounces with the exact path conversion', () => {
    const bad = CANONICAL_ICON.replace(
      '<path data-id="shape-icon-2-g0" fill="#3b82f6" stroke="#000000" stroke-width="0" d="M20 0 L25 14 L40 14 L28 23 L33 38 L20 29 L7 38 L12 23 L0 14 L15 14 Z" />',
      '<polygon points="20,0 40,40 0,40" fill="#3b82f6" />',
    );
    const out = checkFile(bad, { kind: 'page' });
    const hit = out.find((x) => x.code === 'SHAPE_GEOMETRY_NOT_PATH');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('M20,0 L40,40 L0,40 z');
  });

  it('missing geometry id bounces with the exact id to add', () => {
    const bad = CANONICAL_ICON.replace(' data-id="shape-icon-2-g0"', '');
    const out = checkFile(bad, { kind: 'page' });
    const hit = out.find((x) => x.code === 'SHAPE_GEOMETRY_ID_REQUIRED');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('shape-icon-2-g0');
  });

  it('CSS box on a nested svg bounces toward attrs', () => {
    const bad = CANONICAL_ICON.replace(
      '<svg data-id="shape-icon-2" data-name="Star" x="4" y="4" width="40" height="40" viewBox="0 0 40 40" preserveAspectRatio="none" overflow="visible">',
      `<svg data-id="shape-icon-2" data-name="Star" viewBox="0 0 40 40" preserveAspectRatio="none" overflow="visible" style={{ left: '4px', top: '4px', width: '40px', height: '40px' }}>`,
    );
    const out = checkFile(bad, { kind: 'page' });
    expect(codes(out)).toContain('NESTED_SVG_BOX_IN_STYLE');
  });

  it('missing overflow on a nested shape wrapper bounces', () => {
    const bad = CANONICAL_ICON.replace(
      'x="20" y="20" width="8" height="8" viewBox="0 0 8 8" preserveAspectRatio="none" overflow="visible">',
      'x="20" y="20" width="8" height="8" viewBox="0 0 8 8" preserveAspectRatio="none">',
    );
    const out = checkFile(bad, { kind: 'page' });
    expect(codes(out)).toContain('NESTED_SVG_OVERFLOW_REQUIRED');
  });

  it('paint on the wrapper bounces toward the inner path', () => {
    const bad = CANONICAL_ICON.replace(
      '<svg data-id="vector-icon-1" data-name="Group" viewBox="0 0 48 48"',
      '<svg data-id="vector-icon-1" data-name="Group" fill="#ff0000" viewBox="0 0 48 48"',
    );
    const out = checkFile(bad, { kind: 'page' });
    expect(codes(out)).toContain('WRAPPER_PAINT_PROPS');
  });

  it('non-1:1 top-level wrapper bounces with the corrected viewBox', () => {
    const bad = CANONICAL_ICON.replace("width: '48px', height: '48px'", "width: '96px', height: '96px'");
    const out = checkFile(bad, { kind: 'page' });
    const hit = out.find((x) => x.code === 'SHAPE_WRAPPER_NOT_1TO1');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('viewBox="0 0 96 96"');
  });
});

describe('SVG path multiple-subpaths', () => {
  it('stroke-only path with 3 subpaths bounces toward a group of 3 svgs', () => {
    const bad = CANONICAL_ICON.replace(
      '<path data-id="shape-icon-2-g0" fill="#3b82f6" stroke="#000000" stroke-width="0" d="M20 0 L25 14 L40 14 L28 23 L33 38 L20 29 L7 38 L12 23 L0 14 L15 14 Z" />',
      '<path data-id="shape-icon-2-g0" fill="none" stroke="#f97316" stroke-width="5" d="M 54 66 C 93 42 16 98 0 124 M 62 84 C 46 96 32 110 22 126 M 33 0 C 21 12 12 98 2 110" />',
    );
    const out = checkFile(bad, { kind: 'page' });
    const hit = out.find((x) => x.code === 'SHAPE_PATH_MULTIPLE_SUBPATHS');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('3 separate subpaths');
    expect(hit!.message).toContain('GROUP');
  });

  it('stroke-only SINGLE-subpath path passes', () => {
    const ok = CANONICAL_ICON.replace(
      '<path data-id="shape-icon-2-g0" fill="#3b82f6" stroke="#000000" stroke-width="0" d="M20 0 L25 14 L40 14 L28 23 L33 38 L20 29 L7 38 L12 23 L0 14 L15 14 Z" />',
      '<path data-id="shape-icon-2-g0" fill="none" stroke="#f97316" stroke-width="5" d="M 0 0 C 20 20 40 40 60 60" />',
    );
    expect(checkFile(ok, { kind: 'page' }).filter((x) => x.code === 'SHAPE_PATH_MULTIPLE_SUBPATHS')).toEqual([]);
  });

  it('FILLED multi-subpath path (holed donut) is NOT flagged', () => {
    const donut = CANONICAL_ICON.replace(
      '<path data-id="shape-icon-2-g0" fill="#3b82f6" stroke="#000000" stroke-width="0" d="M20 0 L25 14 L40 14 L28 23 L33 38 L20 29 L7 38 L12 23 L0 14 L15 14 Z" />',
      '<path data-id="shape-icon-2-g0" fill="#3b82f6" fill-rule="evenodd" d="M24 4 A20 20 0 1 1 23.9 4 Z M24 14 A10 10 0 1 0 23.9 14 Z" />',
    );
    expect(checkFile(donut, { kind: 'page' }).filter((x) => x.code === 'SHAPE_PATH_MULTIPLE_SUBPATHS')).toEqual([]);
  });
});
