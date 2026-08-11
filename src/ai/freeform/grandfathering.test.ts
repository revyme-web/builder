// grandfathering.test.ts — the gate blocks what an edit ADDS, never what the
// file already carried.
//
// The oracle grows rules (2026-08-11 added ~15); legacy pages carry violations
// they were built with. Without grandfathering, ANY AI edit to such a page
// would bounce on pre-existing content — "fix all history before touching
// anything" — bricking AI editing on real customer sites. gateTurnFiles now
// re-checks the previous on-disk version and lets identical violations
// (same rule + same element, or up to the same count for element-less rules)
// pass through, while anything NEW still blocks.

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { gateTurnFiles } from './freeform-client';

const PAGE_PATH = 'app/gf-probe/page.client.tsx';

const pageWith = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0, "height": "auto" }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
${body}
  </div>;
}
`;

// A legacy page carrying a violation the new rules flag: typography inherited
// from a wrapper (TEXT_STYLE_ON_FRAME on data-id="legacy-wrap").
const LEGACY_BODY = `    <div data-id="legacy-wrap" style={{ position: 'relative', width: '100%', height: 'auto', fontSize: '18px', color: '#B5B2B1' }}>
      <p data-id="legacy-text" style={{ position: 'relative', width: '100%', height: 'auto' }}>Old copy</p>
    </div>`;

beforeEach(() => {
  projectFS.writeFile(PAGE_PATH, pageWith(LEGACY_BODY));
});

describe('gateTurnFiles grandfathering', () => {
  it('an edit that KEEPS the legacy violation passes', () => {
    const edited = pageWith(`${LEGACY_BODY}
    <p data-id="new-clean" data-name="New" style={{ position: 'relative', width: '100%', height: 'auto' }}>Fresh copy</p>`);
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: edited }], PAGE_PATH);
    expect(violations.map((v) => v.code)).not.toContain('TEXT_STYLE_ON_FRAME');
  });

  it('an edit that ADDS the same violation on a NEW element bounces', () => {
    const edited = pageWith(`${LEGACY_BODY}
    <div data-id="new-wrap" style={{ position: 'relative', width: '100%', height: 'auto', fontSize: '22px', color: '#fff' }}>
      <p data-id="new-text" style={{ position: 'relative', width: '100%', height: 'auto' }}>New copy</p>
    </div>`);
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: edited }], PAGE_PATH);
    const hits = violations.filter((v) => v.code === 'TEXT_STYLE_ON_FRAME');
    expect(hits.length).toBe(1);
    expect(hits[0].message).toContain('new-wrap');
  });

  it('a BRAND-NEW file is judged in full (no previous version to inherit from)', () => {
    projectFS.deleteFile(PAGE_PATH);
    projectFS.writeFile(PAGE_PATH, pageWith('    '));
    const fresh = pageWith(LEGACY_BODY);
    const { violations } = gateTurnFiles([{ path: PAGE_PATH, kind: 'page', code: fresh }], PAGE_PATH);
    expect(violations.map((v) => v.code)).toContain('TEXT_STYLE_ON_FRAME');
  });
});
