import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// A canonical CMS detail page: useParams + the `const item = <col>.find(...)`
// resolver + the cms import — the context prev/next/self navigation needs.
const DETAIL = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

/** @cmsPage { "collection": "products", "kind": "detail" } */

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import products from '@/cms/products.json';

export default function Page() {
  const params = useParams();
  const item = products.find((i) => i._slug === params?.slug) ?? products[0];
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
${body}
    </div>
  );
}`;

// Hrefs exactly as the Link tool's generator (cmsNavHrefExpr) emits them.
// Double-quoted so the backticks / ${...} are literal, not interpolated.
const HREF_NEXT = "href={`/products/${products[products.findIndex((i) => i._slug === params?.slug) + 1]?._slug ?? ''}`}";
const HREF_PREV = "href={`/products/${products[products.findIndex((i) => i._slug === params?.slug) - 1]?._slug ?? ''}`}";
const HREF_SELF = "href={`/products/${params?.slug ?? ''}`}";
const HREF_ROW  = "href={`/products/${item?._slug ?? ''}`}";

const nav = (code: string, kind: 'page' | 'component' = 'page') =>
  checkFile(code, { kind }).filter((x) => x.code.startsWith('CMS_NAV_'));

describe('CMS slug navigation dialect', () => {
  it('canonical Next link passes clean', () => {
    expect(nav(DETAIL(`      <Link data-id="next" data-name="a" data-cms-nav="next" ${HREF_NEXT} style={{ position: 'relative' }}>Next →</Link>`))).toEqual([]);
  });

  it('canonical Previous link passes clean', () => {
    expect(nav(DETAIL(`      <Link data-id="prev" data-name="a" data-cms-nav="prev" ${HREF_PREV} style={{ position: 'relative' }}>← Previous</Link>`))).toEqual([]);
  });

  it('canonical Current (self) link passes clean', () => {
    expect(nav(DETAIL(`      <Link data-id="cur" data-name="a" data-cms-nav="self" ${HREF_SELF} style={{ position: 'relative' }}>Current</Link>`))).toEqual([]);
  });

  it('row link inside a .map passes clean', () => {
    const code = DETAIL(`      <div data-id="list" data-name="List" style={{ position: 'relative' }}>
        {products.map((item, idx) => (
          <Link data-id="row" data-name="a" key={idx} data-cms-nav="row" ${HREF_ROW} style={{ position: 'relative' }}>{item.title}</Link>
        ))}
      </div>`);
    expect(nav(code)).toEqual([]);
  });

  // ── Make Component output: a collection-row card MASTER ──────────────────
  // The row link became `<MotionLink data-cms-nav="row" href={linkHref}>` with
  // `const MotionLink = motion.create(Link)` and linkHref = a link-variable PROP;
  // the `.map()` + canonical per-row href live on the PAGE at the instance.
  const ROW_CARD_MASTER = `'use client';
/** @propMeta {"coverImage":{"type":"image"}} */
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
const MotionLink = motion.create(Link);
function CoKaGo({ style, linkHref = "/works/neon-dusk", coverImage = "url(https://x/1.jpg)", ...rest }: { style?: React.CSSProperties; [key: string]: any }) {
  return <LayoutGroup>
    <MotionLink data-cms-nav="row" data-id="col-a-card" {...rest} href={linkHref} style={{ position: 'relative', width: '373px', ...style }}>
      <motion.div layout={true} data-id="img" style={{ position: 'relative', backgroundImage: coverImage }} />
    </MotionLink>
  </LayoutGroup>;
}
export default CoKaGo;`;

  it('component master: MotionLink row link with a linkHref PROP passes clean', () => {
    expect(nav(ROW_CARD_MASTER, 'component')).toEqual([]);
  });

  it('component master: a NON-Link tag still fails NOT_LINK', () => {
    const bad = ROW_CARD_MASTER.replace('<MotionLink data-cms-nav', '<motion.a data-cms-nav').replace('</MotionLink>', '</motion.a>');
    expect(nav(bad, 'component').map((x) => x.code)).toContain('CMS_NAV_NOT_LINK');
  });

  it('PAGE row link as bare-identifier href does NOT get the master carve-out', () => {
    const code = DETAIL(`      <div data-id="list" data-name="List" style={{ position: 'relative' }}>
        {products.map((item, idx) => (
          <Link data-id="row" data-name="a" key={idx} data-cms-nav="row" href={somewhere} style={{ position: 'relative' }}>{item.title}</Link>
        ))}
      </div>`);
    // Still flagged (CONTEXT_MISSING / HREF_MISMATCH) — the carve-out is component-only.
    expect(nav(code).length).toBeGreaterThan(0);
  });

  it('next marker with a STATIC href → HREF_MISMATCH', () => {
    const out = nav(DETAIL(`      <Link data-id="next" data-name="a" data-cms-nav="next" href="/products/next" style={{ position: 'relative' }}>Next</Link>`));
    expect(out.map((x) => x.code)).toContain('CMS_NAV_HREF_MISMATCH');
  });

  it('next marker but href uses the prev (- 1) offset → HREF_MISMATCH', () => {
    expect(nav(DETAIL(`      <Link data-id="next" data-name="a" data-cms-nav="next" ${HREF_PREV} style={{ position: 'relative' }}>Next</Link>`)).map((x) => x.code)).toContain('CMS_NAV_HREF_MISMATCH');
  });

  it('findIndex nav href WITHOUT the marker → MARKER_MISSING', () => {
    expect(nav(DETAIL(`      <Link data-id="next" data-name="a" ${HREF_NEXT} style={{ position: 'relative' }}>Next</Link>`)).map((x) => x.code)).toContain('CMS_NAV_MARKER_MISSING');
  });

  it('invalid mode value → INVALID_MODE', () => {
    expect(nav(DETAIL(`      <Link data-id="x" data-name="a" data-cms-nav="forward" href="#" style={{ position: 'relative' }}>Next</Link>`)).map((x) => x.code)).toContain('CMS_NAV_INVALID_MODE');
  });

  it('marker on a native <a> instead of <Link> → NOT_LINK', () => {
    expect(nav(DETAIL(`      <a data-id="next" data-name="a" data-cms-nav="next" ${HREF_NEXT} style={{ position: 'relative' }}>Next</a>`)).map((x) => x.code)).toContain('CMS_NAV_NOT_LINK');
  });

  it('prev/next without the detail resolver line → CONTEXT_MISSING', () => {
    const code = `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import products from '@/cms/products.json';

export default function Page() {
  const params = useParams();
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
      <Link data-id="next" data-name="a" data-cms-nav="next" ${HREF_NEXT} style={{ position: 'relative' }}>Next</Link>
    </div>
  );
}`;
    expect(nav(code).map((x) => x.code)).toContain('CMS_NAV_CONTEXT_MISSING');
  });

  it('does not fire on an ordinary internal Link (no cms-nav, no findIndex)', () => {
    expect(nav(DETAIL(`      <Link data-id="home" data-name="a" href="/" style={{ position: 'relative' }}>Home</Link>`))).toEqual([]);
  });
});
