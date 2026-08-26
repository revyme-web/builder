import { describe, test, expect } from 'vitest';
import { convertToMotionLinkInCode, MOTION_LINK_DECL } from './generator-attrs';

describe('convertToMotionLinkInCode', () => {
  const base = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';

function Card() {
  return <motion.div data-id="frame-1" style={{ width: '100px' }}></motion.div>;
}
export default Card;`;

  test('renames the tag to MotionLink and injects the href-aware const', () => {
    const r = convertToMotionLinkInCode(base, 'frame-1');
    expect(r).toMatch(/<MotionLink\b/);
    expect(r).toMatch(/<\/MotionLink>/);
    expect(r).not.toMatch(/<motion\.div data-id="frame-1"/);
    // The declaration is the href-aware wrapper: falsy href → no anchor at
    // all (an unset link VARIABLE must not render a link, 2026-08-26).
    expect(r).toContain(MOTION_LINK_DECL);
  });

  test('the const is inserted after the imports', () => {
    const r = convertToMotionLinkInCode(base, 'frame-1');
    const importIdx = r.lastIndexOf('import ');
    const declIdx = r.indexOf('const MotionLink');
    expect(declIdx).toBeGreaterThan(importIdx);
  });

  test('the const lands on its OWN line (not squished onto an import)', () => {
    const r = convertToMotionLinkInCode(base, 'frame-1');
    const declLine = r.split('\n').find((l) => l.includes('const MotionLink'))!;
    expect(declLine.trim()).toBe(MOTION_LINK_DECL);
    // The line must NOT also contain an import statement.
    expect(declLine).not.toMatch(/\bimport\b/);
  });

  test('idempotent — does not duplicate the const on a second pass', () => {
    const once = convertToMotionLinkInCode(base, 'frame-1');
    const twice = convertToMotionLinkInCode(once, 'frame-1');
    const matches = twice.match(/const MotionLink = motion\.create\(/g) || [];
    expect(matches.length).toBe(1);
  });

  test('no-op when the data-id is not found', () => {
    expect(convertToMotionLinkInCode(base, 'missing')).toBe(base);
  });

  test('preserves children of the converted element', () => {
    const withChild = `import { motion } from 'framer-motion';
function Card() {
  return <motion.div data-id="frame-1"><motion.span data-id="t">hi</motion.span></motion.div>;
}
export default Card;`;
    const r = convertToMotionLinkInCode(withChild, 'frame-1');
    expect(r).toMatch(/<MotionLink[^>]*>\s*<motion\.span data-id="t">hi<\/motion\.span>\s*<\/MotionLink>/);
  });
});

describe('href-aware MotionLink declaration — dialect safety', () => {
  // The wrapper contains JSX at module scope (<Link>/<div> inside
  // motion.create(React.forwardRef(...))). Neither the parser nor the oracle
  // may treat that scaffolding as authored content.
  const componentWithDecl = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
${MOTION_LINK_DECL}
function Card() {
  return (<LayoutGroup><motion.div data-id="root" style={{ width: '100px' }}>
    <MotionLink data-id="lnk" href={linkHref} style={{ display: 'block' }}>Go</MotionLink>
  </motion.div></LayoutGroup>);
}
export default Card;`;

  test('the parser yields ONLY the authored nodes — nothing from the declaration', async () => {
    const { parseJSXToNodes } = await import('../parsing/parser');
    const nodes = parseJSXToNodes(componentWithDecl);
    expect([...nodes.keys()].sort()).toEqual(['lnk', 'root']);
  });

  test('the oracle accepts the wrapper (no link-rule violations from its internals)', async () => {
    const { checkComponentLinks } = await import('../oracle/checks/link-rules');
    const { parseJSX } = await import('../parsing/ast-utils');
    const v: any[] = [];
    checkComponentLinks(componentWithDecl, parseJSX(componentWithDecl)!, v);
    expect(v).toEqual([]);
  });

  test('the LEGACY declaration still satisfies the oracle setup check', async () => {
    const { checkComponentLinks } = await import('../oracle/checks/link-rules');
    const { parseJSX } = await import('../parsing/ast-utils');
    const legacy = componentWithDecl.replace(MOTION_LINK_DECL, 'const MotionLink = motion.create(Link);');
    const v: any[] = [];
    checkComponentLinks(legacy, parseJSX(legacy)!, v);
    expect(v).toEqual([]);
  });
});

describe('link operations upgrade the legacy declaration in place', () => {
  // The upgrade must land THE MOMENT a link variable is touched — create,
  // Set Variable (same generator), or unbind — not on some unrelated later
  // edit. Reported 2026-08-26: X + re-Set Variable on a master left
  // `motion.create(Link)`, so an empty href still rendered a navigating <a>.
  const legacyMaster = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
const MotionLink = motion.create(Link);
function Card() {
  return (<LayoutGroup><MotionLink data-id="lnk" href="/about" style={{ display: 'block' }}>Go</MotionLink></LayoutGroup>);
}
export default Card;`;

  test('createLinkAttrVariableInCode (create AND Set Variable) upgrades it', async () => {
    const { createLinkAttrVariableInCode } = await import('../features/variable-ops');
    const out = createLinkAttrVariableInCode(legacyMaster, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string', defaultValue: '/about',
    });
    expect(out).toContain(MOTION_LINK_DECL);
    expect(out).not.toMatch(/const MotionLink = motion\.create\(Link\);/);
    expect((out.match(/const MotionLink = motion\.create\(/g) || []).length).toBe(1);
  });

  test('removeLinkAttrVariableInCode (unbind ×) upgrades it', async () => {
    const { createLinkAttrVariableInCode, removeLinkAttrVariableInCode } = await import('../features/variable-ops');
    const bound = createLinkAttrVariableInCode(legacyMaster, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string', defaultValue: '/about',
    });
    // Simulate an OLD bound file that still carries the legacy declaration.
    const legacyBound = bound.replace(MOTION_LINK_DECL, 'const MotionLink = motion.create(Link);');
    const out = removeLinkAttrVariableInCode(legacyBound, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string',
    });
    expect(out).toContain(MOTION_LINK_DECL);
    expect(out).not.toMatch(/const MotionLink = motion\.create\(Link\);/);
  });

  test('a file already on the canonical declaration is untouched', async () => {
    const { ensureCanonicalMotionLinkDecl } = await import('./generator-attrs');
    const canonical = legacyMaster.replace('const MotionLink = motion.create(Link);', MOTION_LINK_DECL);
    expect(ensureCanonicalMotionLinkDecl(canonical)).toBe(canonical);
  });

  test('a file with NO MotionLink is untouched', async () => {
    const { ensureCanonicalMotionLinkDecl } = await import('./generator-attrs');
    const plain = `import React from 'react';\nexport default function P() { return <div data-id="x" />; }`;
    expect(ensureCanonicalMotionLinkDecl(plain)).toBe(plain);
  });
});

describe('re-binding an EXISTING link variable (the ×-then-Set-Variable round trip)', () => {
  // Reported 2026-08-26: × keeps the prop + its old "/" default, and the
  // rebind's prop-add is idempotent — so the leftover default kept navigating
  // to Home. Binding an href IS what makes it a link variable → the existing
  // default is forced empty in the same operation.
  const masterWithOldDefault = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
const MotionLink = motion.create(Link);
function Card({ style, linkHref = "/", ...rest }: any) {
  return (<LayoutGroup><MotionLink data-id="lnk" href="/about" style={{ display: 'block' }}>Go</MotionLink></LayoutGroup>);
}
export default Card;`;

  test('Set Variable forces the pre-existing default to empty + upgrades the declaration', async () => {
    const { createLinkAttrVariableInCode } = await import('../features/variable-ops');
    const out = createLinkAttrVariableInCode(masterWithOldDefault, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string', defaultValue: '/about',
    });
    expect(out).toMatch(/href=\{linkHref\}/);
    expect(out).toMatch(/linkHref = ['"]['"]/);
    expect(out).not.toMatch(/linkHref = ['"]\/['"]/);
    expect(out).toContain(MOTION_LINK_DECL);
  });
});

describe('the data-id healer leaves the MotionLink declaration alone', () => {
  test('no data-id stamped into the wrapper internals; drifted wrappers normalize back', async () => {
    const { healMissingInstanceDataIds } = await import('../parsing/heal-data-ids');
    const withDecl = `'use client';
import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
${MOTION_LINK_DECL}
function Card() {
  return <MotionLink data-id="lnk" href="/a">Go</MotionLink>;
}
export default Card;`;
    const { code: healed, healed: count } = healMissingInstanceDataIds(withDecl);
    expect(healed).toBe(withDecl);
    expect(count).toBe(0);

    // A wrapper ALREADY mutated by the pre-fix stamper (live find: data-id on
    // the internal <Link>) normalizes back to canonical on the next link op.
    const { ensureCanonicalMotionLinkDecl } = await import('./generator-attrs');
    const drifted = withDecl.replace('<Link ref={ref}', '<Link data-id="Link-stray-1" ref={ref}');
    expect(drifted).not.toBe(withDecl);
    expect(ensureCanonicalMotionLinkDecl(drifted)).toContain(MOTION_LINK_DECL);
    expect(ensureCanonicalMotionLinkDecl(drifted)).not.toContain('Link-stray-1');
  });
});
