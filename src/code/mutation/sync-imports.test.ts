import { MOTION_LINK_DECL } from '@/code/generation/generator-attrs';
import { describe, test, expect } from 'vitest';
import { syncImports } from './mutation-queue';

// Helper: wrap body in a page-like structure so syncImports processes it
function makePage(imports: string, body: string): string {
  return `${imports}\nexport default function Page() {\n  return (\n${body}\n  );\n}\n`;
}

describe('syncImports', () => {
  // ─── Basic Detection ──────────────────────────────────────────────

  test('adds React import even without hooks', () => {
    const code = makePage("'use client';", '<div>Hello</div>');
    const result = syncImports(code);
    expect(result).toContain("import React from 'react';");
  });

  test('detects useState hook', () => {
    const code = makePage("'use client';\nimport React from 'react';",
      '<div>{useState(0)}</div>');
    const result = syncImports(code);
    expect(result).toContain("import React, { useState } from 'react';");
  });

  test('detects multiple React hooks', () => {
    const code = makePage("'use client';\nimport React from 'react';",
      '<div>{useState(0)} {useEffect(() => {})} {useRef(null)}</div>');
    const result = syncImports(code);
    expect(result).toContain('useState');
    expect(result).toContain('useEffect');
    expect(result).toContain('useRef');
  });

  test('detects framer-motion motion.div', () => {
    const code = makePage("'use client';\nimport React from 'react';",
      '<motion.div>hi</motion.div>');
    const result = syncImports(code);
    expect(result).toContain("import { motion } from 'framer-motion';");
  });

  // ─── Next.js Link ─────────────────────────────────────────────────

  test('detects <Link> tag', () => {
    const code = makePage("'use client';\nimport React from 'react';",
      '<Link href="/about">About</Link>');
    const result = syncImports(code);
    expect(result).toContain("import Link from 'next/link';");
  });

  test('removes Link import when not used', () => {
    const code = makePage("'use client';\nimport React from 'react';\nimport Link from 'next/link';",
      '<div>No links here</div>');
    const result = syncImports(code);
    expect(result).not.toContain("import Link from 'next/link'");
  });

  // ─── Next.js Image ────────────────────────────────────────────────

  test('detects <Image> tag and adds next/image import', () => {
    const code = makePage("'use client';\nimport React from 'react';",
      '<Image src="/photo.jpg" alt="Photo" width={800} height={600} />');
    const result = syncImports(code);
    expect(result).toContain("import Image from 'next/image';");
  });

  test('removes Image import when not used', () => {
    const code = makePage("'use client';\nimport React from 'react';\nimport Image from 'next/image';",
      '<div>No images here</div>');
    const result = syncImports(code);
    expect(result).not.toContain("import Image from 'next/image'");
  });

  test('preserves Image import when <Image> is used alongside other components', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport Image from 'next/image';\nimport Link from 'next/link';\nimport Header from '@/components/Header';",
      '<div>\n  <Header />\n  <Link href="/">Home</Link>\n  <Image src="/pic.jpg" alt="" width={400} height={300} />\n</div>');
    const result = syncImports(code);
    expect(result).toContain("import Image from 'next/image';");
    expect(result).toContain("import Link from 'next/link';");
    expect(result).toContain("import Header from '@/components/Header';");
  });

  test('does not duplicate Image import if already present', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport Image from 'next/image';",
      '<Image src="/pic.jpg" alt="" width={400} height={300} />');
    const result = syncImports(code);
    const imageImportCount = (result.match(/import Image from 'next\/image'/g) || []).length;
    expect(imageImportCount).toBe(1);
  });

  // ─── The actual bug scenario: delete a Code component, Image survives ─────

  test('keeps Image import when deleting unrelated component (GrainyOverlay)', () => {
    // Before: page has Image + GrainyOverlay
    // After delete: GrainyOverlay is removed from body, but Image is still used
    const body = `<div>
      <Image src="/photo.jpg" alt="Hero" width={1200} height={800} />
      <h1>Title</h1>
    </div>`;
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport Image from 'next/image';\nimport GrainyOverlay from '@/components/GrainyOverlay';",
      body);
    const result = syncImports(code);
    expect(result).toContain("import Image from 'next/image';");
    // GrainyOverlay (a @/components import) is NOT in the body → pruned as dead
    // code. (Deleting every <Foo/> instance must drop its import.)
    expect(result).not.toContain("import GrainyOverlay from '@/components/GrainyOverlay';");
  });

  test('prunes a component import whose instance was deleted, keeps still-used ones', () => {
    // Mirrors "select-all + delete" on a page: the deleted <Gone/> import goes,
    // the surviving <Kept/> stays — including instances in the canvasNodes
    // fragment after `export default`.
    const code = `'use client';
import React from 'react';
import Gone from '@/components/Gone';
import Kept from '@/components/Kept';
import OnCanvas from '@/components/OnCanvas';
export default function Page() {
  return <div data-id="root"><Kept data-id="k" /></div>;
}
const canvasNodes = <><OnCanvas data-id="oc" data-canvas-node="true" /></>;`;
    const result = syncImports(code);
    expect(result).not.toContain("@/components/Gone");
    expect(result).toContain("import Kept from '@/components/Kept';");
    expect(result).toContain("import OnCanvas from '@/components/OnCanvas';"); // used in canvasNodes
  });

  // ─── Custom Import Preservation ───────────────────────────────────

  test('preserves component imports', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport Header from '@/components/Header';\nimport Footer from '@/components/Footer';",
      '<div><Header /><Footer /></div>');
    const result = syncImports(code);
    expect(result).toContain("import Header from '@/components/Header';");
    expect(result).toContain("import Footer from '@/components/Footer';");
  });

  test('preserves component imports', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport GrainyOverlay from '@/components/GrainyOverlay';",
      '<GrainyOverlay opacity={0.3} />');
    const result = syncImports(code);
    expect(result).toContain("import GrainyOverlay from '@/components/GrainyOverlay';");
  });

  test('preserves non-managed package imports', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport Lottie from 'lottie-react';",
      '<Lottie animationData={data} />');
    const result = syncImports(code);
    expect(result).toContain("import Lottie from 'lottie-react';");
  });

  // ─── Unused Managed Import Removal ────────────────────────────────

  test('removes unused React hooks', () => {
    const code = makePage(
      "'use client';\nimport React, { useState, useEffect, useRef } from 'react';",
      '<div>Static content</div>');
    const result = syncImports(code);
    expect(result).toContain("import React from 'react';");
    expect(result).not.toContain('useState');
    expect(result).not.toContain('useEffect');
    expect(result).not.toContain('useRef');
  });

  test('removes unused framer-motion import', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport { motion } from 'framer-motion';",
      '<div>No motion here</div>');
    const result = syncImports(code);
    expect(result).not.toContain("from 'framer-motion'");
  });

  // ─── Skip Non-Page Files ──────────────────────────────────────────

  test('skips files without export default', () => {
    const code = "export const helper = () => 'test';";
    expect(syncImports(code)).toBe(code);
  });

  test('skips server layout files', () => {
    const code = "'use client';\nexport const metadata = {};\nexport default function RootLayout() { return <html></html>; }";
    expect(syncImports(code)).toBe(code);
  });

  // ─── No-Op When Unchanged ─────────────────────────────────────────

  test('returns same code if imports are already correct', () => {
    const code = makePage(
      "'use client';\n\nimport React, { useState } from 'react';",
      '<div>{useState(0)}</div>');
    const result = syncImports(code);
    // Run twice — second should be identical
    const result2 = syncImports(result);
    expect(result2).toBe(result);
  });

  // ─── motion.<UpperCase> self-heal ─────────────────────────────────
  //
  // Earlier generator versions wrapped EVERY new node inside a component
  // file with `motion.*` for FLIP. Component-instance tags
  // (`<MyCard/>`, `<LiBaVi/>`) ended up as `<motion.MyCard/>` which
  // evaluates to `undefined` at runtime (framer-motion's `motion`
  // proxy only knows HTML tag names). The generator now skips
  // component-instance tags, but existing source files can still have
  // the broken pattern. syncImports strips it on the next flush so
  // the file self-heals.

  test('strips motion. prefix from component-instance opening tags', () => {
    const code = makePage(
      "'use client';\nimport LiBaVi from '@/components/LiBaVi';",
      '<div><motion.LiBaVi data-id="x" style={{ left: \'0\' }} /></div>',
    );
    const result = syncImports(code);
    expect(result).not.toContain('<motion.LiBaVi');
    expect(result).toContain('<LiBaVi data-id="x"');
  });

  test('strips motion. prefix from component-instance closing tags', () => {
    const code = makePage(
      "'use client';\nimport Card from '@/components/Card';",
      '<div><motion.Card data-id="x">child</motion.Card></div>',
    );
    const result = syncImports(code);
    expect(result).not.toContain('motion.Card');
    expect(result).toContain('<Card data-id="x"');
    expect(result).toContain('</Card>');
  });

  test('does NOT touch motion.<lowercase> (legitimate framer-motion tags)', () => {
    const code = makePage(
      "'use client';",
      '<motion.div data-id="x"><motion.span>hi</motion.span></motion.div>',
    );
    const result = syncImports(code);
    expect(result).toContain('<motion.div');
    expect(result).toContain('<motion.span');
    expect(result).toContain('</motion.div>');
  });

  // Legacy lowercase-component bug: an older `updateMotionPropInCode`
  // converted a PascalCase instance tag via `tagName.toLowerCase()`, so
  // `<MoJiBa>` became `<motion.mojiba>`. The simple uppercase-only self-
  // heal can't recognize it. Recover by cross-referencing the imports.

  test('strips motion. prefix from lowercased component instance using import lookup', () => {
    const code = makePage(
      "'use client';\nimport MoJiBa from '@/components/MoJiBa';",
      '<div><motion.mojiba data-id="x" style={{ left: \'0\' }} /></div>',
    );
    const result = syncImports(code);
    expect(result).not.toContain('motion.mojiba');
    expect(result).toContain('<MoJiBa data-id="x"');
  });

  test('lowercased self-heal also fixes closing tags', () => {
    const code = makePage(
      "'use client';\nimport MoJiBa from '@/components/MoJiBa';",
      '<motion.mojiba data-id="x">child</motion.mojiba>',
    );
    const result = syncImports(code);
    expect(result).not.toContain('motion.mojiba');
    expect(result).toContain('<MoJiBa data-id="x"');
    expect(result).toContain('</MoJiBa>');
  });

  // ─── MotionLink (motion.create(Link)) ─────────────────────────────

  test('adds next/link import when MotionLink is used', () => {
    const code = makePage(
      "'use client';\nimport { motion } from 'framer-motion';\nconst MotionLink = motion.create(Link);",
      '<MotionLink data-id="x" href="/a" />',
    );
    const result = syncImports(code);
    expect(result).toContain("import Link from 'next/link';");
  });

  test('recovers a statement squished after an import semicolon (does not drop it)', () => {
    // Mirrors the retainLines output of convertToMotionLink: the const ended up
    // on the same line as the @revyme/runtime import. syncImports must keep the
    // const in the body, not drop it with the framework import.
    const code = makePage(
      "'use client';\nimport { motion } from 'framer-motion';\nimport { withResponsiveProps } from '@revyme/runtime';const MotionLink = motion.create(Link);",
      '<MotionLink data-id="x" href="/a" />',
    );
    const result = syncImports(code);
    // Legacy `motion.create(Link)` is UPGRADED to the href-aware wrapper —
    // syncImports owns the declaration and keeps it canonical.
    expect(result).toContain(MOTION_LINK_DECL);
    expect(result).toContain("import Link from 'next/link';");
    // The const must be on its own line now, not glued to an import.
    const declLine = result.split('\n').find((l) => l.includes('const MotionLink'))!;
    expect(declLine).not.toMatch(/\bimport\b/);
  });

  // ─── MotionLink self-heal — pasted/edited markup with NO setup ─────
  // A raw paste of `<MotionLink>` (e.g. copying a footer link into another
  // page) has neither the const nor the imports. syncImports must add ALL of
  // it, or MotionLink is undefined at runtime.

  test('injects the const + BOTH imports when MotionLink is pasted with no setup', () => {
    const code = makePage(
      "'use client';\nimport React from 'react';",
      '<div data-id="footer"><MotionLink data-id="l0" href="#">Advisors</MotionLink></div>',
    );
    const result = syncImports(code);
    expect(result).toContain(MOTION_LINK_DECL);
    expect(result).toContain("import Link from 'next/link';");
    expect(result).toContain("import { motion } from 'framer-motion';");
    // const declared exactly once, on its own line, after the imports.
    expect((result.match(/const MotionLink = motion\.create\(/g) || []).length).toBe(1);
    const declIdx = result.indexOf('const MotionLink');
    const lastImportIdx = result.lastIndexOf('import ');
    expect(declIdx).toBeGreaterThan(lastImportIdx);
  });

  test('injects the const even when Link + motion are ALREADY imported (imports unchanged)', () => {
    // The early "imports unchanged" return must not swallow the body injection.
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport Link from 'next/link';\nimport { motion } from 'framer-motion';",
      '<div><Link href="/a">A</Link><MotionLink data-id="l0" href="#">B</MotionLink></div>',
    );
    const result = syncImports(code);
    expect(result).toContain(MOTION_LINK_DECL);
  });

  test('does NOT duplicate the const when it already exists', () => {
    const code = makePage(
      "'use client';\nimport { motion } from 'framer-motion';\nimport Link from 'next/link';\nconst MotionLink = motion.create(Link);",
      '<MotionLink data-id="x" href="/a" />',
    );
    const result = syncImports(code);
    // The legacy line upgrades to the wrapper — still exactly ONE declaration.
    expect((result.match(/const MotionLink = motion\.create\(/g) || []).length).toBe(1);
    expect(result).toContain(MOTION_LINK_DECL);
  });

  // ─── CDN URL imports (cross-project linked components) ────────────

  test('a CDN URL default import satisfies the tag — NO duplicate @/components auto-inject', async () => {
    // The cross-project paste path imports linked components from the CDN:
    //   import Marquee from "https://assets.revyme.app/components/Marquee@hash.js"
    // The auto-inject pass must treat that name as satisfied. Before the fix
    // it didn't — it lazy-installed the same-named built-in and emitted a
    // SECOND `import Marquee from '@/components/Marquee'`, a duplicate-
    // identifier SyntaxError that blanked the whole canvas.
    const { projectFS } = await import('@/code/project/project-fs');
    projectFS.writeFile('components/UrlSatisfied.tsx', 'export default function UrlSatisfied() { return null; }');
    const code = makePage(
      "'use client';\nimport React from 'react';\nimport UrlSatisfied from \"https://assets.revyme.app/components/UrlSatisfied@abc123.js\";",
      '<UrlSatisfied data-id="m1" />',
    );
    const result = syncImports(code);
    expect((result.match(/import UrlSatisfied from/g) || []).length).toBe(1);
    expect(result).not.toContain("from '@/components/UrlSatisfied'");
    // The URL import itself survives untouched.
    expect(result).toContain('https://assets.revyme.app/components/UrlSatisfied@abc123.js');
  });
});
