import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const PAGE = (body: string, imports = '') => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';
${imports}
export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
${body}
</div>
  );
}`;

const codes = (code: string) => checkFile(code, { kind: 'page' }).map((x) => x.code);

describe('page links must be the next/link <Link>', () => {
  it('a plain <a href> on a page bounces PAGE_LINK_NOT_NEXTLINK', () => {
    expect(codes(PAGE(`  <a data-id="lnk" data-name="a" href="/pricing" style={{ position: 'relative' }}>Pricing</a>`)))
      .toContain('PAGE_LINK_NOT_NEXTLINK');
  });

  it('a <Link href> WITH the import passes clean', () => {
    const out = codes(PAGE(`  <Link data-id="lnk" data-name="a" href="/pricing" style={{ position: 'relative' }}>Pricing</Link>`, "import Link from 'next/link';\n"));
    expect(out).not.toContain('PAGE_LINK_NOT_NEXTLINK');
    expect(out).not.toContain('NEXTLINK_IMPORT_MISSING');
  });

  it('a <Link> WITHOUT the import bounces NEXTLINK_IMPORT_MISSING', () => {
    expect(codes(PAGE(`  <Link data-id="lnk" data-name="a" href="/pricing" style={{ position: 'relative' }}>Pricing</Link>`)))
      .toContain('NEXTLINK_IMPORT_MISSING');
  });

  it('a CMS field-bound <a> (data-cms-bind-target) is EXEMPT — tool-owned', () => {
    expect(codes(PAGE(`  <a data-id="lnk" data-name="a" data-cms-bind-target="href" href="#" style={{ position: 'relative' }}>Link</a>`)))
      .not.toContain('PAGE_LINK_NOT_NEXTLINK');
  });

  it('the page rule does NOT fire on a component (components use MotionLink)', () => {
    const comp = `'use client';\n/** @name "X" */\nimport React from 'react';\nimport { motion } from 'framer-motion';\nfunction X() { return <a data-id="l" data-name="a" href="/x">x</a>; }\nexport default X;`;
    expect(checkFile(comp, { kind: 'component' }).map((x) => x.code)).not.toContain('PAGE_LINK_NOT_NEXTLINK');
  });

  // A page <Link> can be animated by converting it to <MotionLink>
  // (motion.create(Link)) — same client-side routing, so it's allowed on pages.
  it('a <MotionLink href> WITH the import + const passes clean (animatable page link)', () => {
    const out = codes(PAGE(
      `  <MotionLink data-id="lnk" data-name="a" href="/pricing" whileHover={{ opacity: 0.6 }} style={{ position: 'relative' }}>Pricing</MotionLink>`,
      "import Link from 'next/link';\nimport { motion } from 'framer-motion';\nconst MotionLink = motion.create(Link);\n",
    ));
    expect(out).not.toContain('PAGE_LINK_NOT_NEXTLINK');
    expect(out).not.toContain('NEXTLINK_IMPORT_MISSING');
    expect(out).not.toContain('MOTIONLINK_SETUP_MISSING');
  });

  it('a page <MotionLink> WITHOUT `const MotionLink = motion.create(Link)` bounces MOTIONLINK_SETUP_MISSING', () => {
    const out = codes(PAGE(
      `  <MotionLink data-id="lnk" data-name="a" href="/pricing" style={{ position: 'relative' }}>Pricing</MotionLink>`,
      "import Link from 'next/link';\nimport { motion } from 'framer-motion';\n",
    ));
    expect(out).toContain('MOTIONLINK_SETUP_MISSING');
  });

  it('a <motion.a href> on a page STILL bounces — only <Link>/<MotionLink> are allowed', () => {
    expect(codes(PAGE(`  <motion.a data-id="lnk" data-name="a" href="/pricing" style={{ position: 'relative' }}>Pricing</motion.a>`, "import { motion } from 'framer-motion';\n")))
      .toContain('PAGE_LINK_NOT_NEXTLINK');
  });
});
