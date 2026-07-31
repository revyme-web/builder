// component-ops.test.ts — Tests for makeComponent and detachComponent.
import { parse } from '@babel/parser';
// Mocks projectFS, mutation-queue, and debug-trace to test the pure transformation logic.

import { describe, test, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('../project/project-fs', () => ({
  projectFS: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    listFiles: vi.fn(() => []),
    exists: vi.fn(() => false),
  },
}));

vi.mock('../mutation/mutation-queue', () => ({
  syncQueueCode: vi.fn(),
  flushNow: vi.fn(),
  queueMutation: vi.fn(),
  // Passthrough — import sync has its own tests; here we only assert the hooks
  // the rehydrate step injects, not the import lines.
  syncImports: vi.fn((c: string) => c),
}));

import { bakeNestedInstanceVariantTernaries, makeComponent, detachComponent, detachInstance, parseComponentName, setComponentName, getComponentDisplayName, cleanComponentRootJSX, ensureLayoutRootOnComponentRoot, detectCmsNavLink, rewriteVariantStateRefsToInitialVariant, stripParentVariantToggleHandlers, extractRootVariantToggleHandler } from './component-ops';
import { parseJSX } from '../parsing/ast-utils';
import { projectFS } from '../project/project-fs';
import { queueMutation } from '../mutation/mutation-queue';

const mockFS = vi.mocked(projectFS);
const mockQueueMutation = vi.mocked(queueMutation);

// ─── Test Data ────────────────────────────────────────────────────────────────

const PAGE_CODE = `import React from 'react';

export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <div data-id="hero" style={{ padding: '40px', background: '#111' }}>
        <h1 data-id="title">Hello World</h1>
      </div>
      <div data-id="footer" style={{ padding: '20px' }}>Footer</div>
    </div>
  );
}`;

// Helper: get the written component code from queueMutation calls
function getWrittenComponentCode(): string {
  const writeCall = mockQueueMutation.mock.calls.find(c => c[0].type === 'writeFile');
  return writeCall ? (writeCall[0] as any).content : '';
}

function getWrittenFilePath(): string {
  const writeCall = mockQueueMutation.mock.calls.find(c => c[0].type === 'writeFile');
  return writeCall ? (writeCall[0] as any).filePath : '';
}

// ─── makeComponent ──────────────────────────────────────────────────────────

describe('makeComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('converts inline transform: rotate() → motion rotate prop on componentized elements', () => {
    const ROT_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <div data-id="hero" style={{ padding: '40px', transform: 'rotate(30deg)' }}>
        <h1 data-id="title">Hi</h1>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(ROT_PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'hero', 'Rot');
    const code = getWrittenComponentCode();
    // Becomes a motion prop (composes with layout FLIP); no raw transform string.
    expect(code).toContain('rotate: 30');
    expect(code).not.toContain("transform: 'rotate(30deg)'");
    // Plain styles preserved.
    expect(code).toContain("padding: '40px'");
  });

  test('a next/link <Link> becomes MotionLink + motion.create declaration (master stays animatable)', () => {
    // EMPIRICAL PIN, live find 2026-07-14: Make Component on the "Explore CTA"
    // pill kept the root as a plain <Link> — motion props are silently ignored
    // on a plain React component, so the new design component was inert (no
    // variants, no connections, no FLIP). Links must become MotionLink.
    const PAGE = `import React from 'react';
import Link from 'next/link';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <Link href="/works" data-id="works-cta" data-name="Explore CTA" style={{ position: 'relative', display: 'inline-flex', borderRadius: '999px' }}>Explore all works</Link>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'works-cta', 'ExploreCta');
    const code = getWrittenComponentCode();
    expect(code).toContain('const MotionLink = motion.create(Link);');
    expect(code).toMatch(/<MotionLink layout=\{true\}[^>]*href="\/works"/);
    expect(code).toContain('</MotionLink>');
    // No plain <Link> tag survives…
    expect(code).not.toMatch(/<Link[\s>]/);
  });

  test('a pre-existing <MotionLink> carries its Link import + motion.create declaration into the master', () => {
    // EMPIRICAL PIN, live find 2026-07-28: componentizing a Sign Up button
    // that was ALREADY a <MotionLink> (its `const MotionLink =
    // motion.create(Link)` lives at the SOURCE file's module scope) produced a
    // master with NEITHER the next/link import NOR the const —
    // `convertLinksToMotionLink` had nothing to convert, and the decl block
    // only fired on conversion. The live site crashed with
    // `MotionLink is not defined`.
    const PAGE = `import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';

const MotionLink = motion.create(Link);

export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <MotionLink layout={true} key="signup" data-id="link-signup" data-name="Sign Up Button" href="/" style={{ display: 'flex', position: 'relative', backgroundColor: '#111111' }}>
        <motion.p layout={true} data-id="text-signup" style={{ color: '#ffffff' }}>Sign Up</motion.p>
      </MotionLink>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'link-signup', 'Sign Up Button');
    const code = getWrittenComponentCode();
    expect(code).toContain("import Link from 'next/link';");
    // Declared exactly once (no duplicate if a carry path ever adds it too).
    expect(code.match(/const MotionLink\s*=\s*motion\.create\(Link\);/g)?.length).toBe(1);
    expect(code).toMatch(/<MotionLink layout=\{true\}[^>]*data-id="link-signup"/);
    // …and the next/link import exists exactly once (carried import deduped).
    expect(code.match(/from 'next\/link'/g)!.length).toBe(1);
  });

  test('transfers a variant-toggle CONNECTION + AnimatePresence key to the INSTANCE, strips them from the component', () => {
    // A node conditionally rendered inside <AnimatePresence>, carrying a parent variant-toggle onTap + a key.
    // After Make Component: the connection + key must live on the INSTANCE (variant/setVariant are in the page's
    // scope; AnimatePresence tracks the instance), and the new component must be clean (no setVariant, no key).
    const PAGE = `import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'mobile' }, { name: 'mobile-open' }];
export default function Page() {
  const [variant, setVariant] = useState('default');
  return (
    <motion.div data-id="root" animate={['default', variant]}>
      <AnimatePresence mode="popLayout">{variant !== "default" && <motion.div onTap={() => setVariant(variant === 'mobile' ? 'mobile-open' : variant === 'mobile-open' ? 'mobile' : variant)} data-id="hamburger" data-name="Menu" key="hamburger" style={{ position: 'relative', width: '28px', height: '28px' }}><motion.div data-id="line" data-name="Line" style={{ position: 'absolute', width: '20px' }} /></motion.div>}</AnimatePresence>
    </motion.div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'hamburger', 'MenuBtn') as { updatedPageCode: string } | null;
    const instancePage = result!.updatedPageCode;
    // The instance tag uses a generated INTERNAL name (random PascalCase), so find it by its data-id.
    const idIdx = instancePage.indexOf('data-id="hamburger"');
    const instanceTag = instancePage.slice(instancePage.lastIndexOf('<', idIdx), instancePage.indexOf('/>', idIdx) + 2);
    // INSTANCE: keeps the connection + the AnimatePresence key.
    expect(instanceTag).toContain('onTap={() => setVariant(');
    expect(instanceTag).toContain('key="hamburger"');
    // COMPONENT: clean — no parent variant state, no leftover root key.
    const component = getWrittenComponentCode();
    expect(component).not.toContain('setVariant');
    expect(component).not.toContain('key="hamburger"');
  });

  test('child instance with scroll/fx: animation hooks are PORTED into the component (not left undefined)', () => {
    // A frame whose child is a component instance with data-instance-fx +
    // data-scroll-variant. Those effects' page-level hooks (useMotionValue/
    // useScroll/useEffect + Sv state) stay in the PAGE; the extracted JSX binds
    // `scale: kidFxCScale` / `ref={kidRef}` / `initialVariant={kidSv}`. Without
    // porting, the new component references undefined identifiers and crashes.
    const ANIM_PAGE = `import React, { useState, useEffect, useRef } from 'react';
import { useScroll, useMotionValueEvent, useMotionValue, useTransform, animate, hover } from 'framer-motion';
import Card from '@/components/Card';
export default function Page() {
  const [kidSv, setKidSv] = useState('default');
  const { scrollY: kidSvScroll } = useScroll();
  useMotionValueEvent(kidSvScroll, "change", (y) => { const prev = kidSvScroll.getPrevious() ?? 0; if (y > prev) setKidSv('variant-1'); else if (y < prev) setKidSv('default'); });
  const kidRef = useRef(null);
  const kidFxHovScale = useMotionValue(1);
  const kidFxCScale = useTransform([kidFxHovScale], (vals) => vals.reduce((a, v) => a * v, 1));
  useEffect(() => { const el = kidRef.current; if (!el) return; return hover(el, () => { animate(kidFxHovScale, 1.05, { type: 'spring', stiffness: 300, damping: 30 }); return () => { animate(kidFxHovScale, 1, { type: 'spring', stiffness: 300, damping: 30 }); }; }); }, []);
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="frame" style={{ position: 'absolute', width: '400px', height: '300px' }}>
        <Card data-instance-fx='{"hover":{"to":{"scale":1.05}}}' ref={kidRef} data-scroll-variant='{"trigger":"onScroll","from":"default","to":"variant-1","direction":"down","replay":true}' initialVariant={kidSv} data-id="kid" data-name="Card" style={{ scale: kidFxCScale, position: 'absolute', left: '10px', top: '10px', width: '100px', height: '80px' }}></Card>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(ANIM_PAGE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'frame', 'Anim');
    expect(result).not.toBeNull();
    const code = getWrittenComponentCode();
    // The component file PARSES (was a crash) and DECLARES the hooks the child binds.
    expect(parseJSX(code)).not.toBeNull();
    expect(code).toMatch(/const kidFxHovScale = useMotionValue\(/);   // fx motion value regenerated
    expect(code).toMatch(/const kidRef = useRef\(null\)/);            // gesture ref regenerated
    expect(code).toMatch(/setKidSv\(/);                              // scroll-variant state regenerated
    expect(code).toContain('data-instance-fx=');                     // spec preserved
    expect(code).toContain('data-scroll-variant=');
    // The page's now-orphaned hooks are stripped (their JSX moved to the component).
    expect(result!.updatedPageCode).not.toMatch(/kidFxHovScale/);
    expect(result!.updatedPageCode).not.toMatch(/setKidSv/);
    expect(result!.updatedPageCode).toContain('data-name="Anim"');  // instance (random tag) swapped in
    expect(result!.updatedPageCode).not.toContain('data-id="kid"'); // child JSX moved to the component
  });

  test('MULTI-VARIANT make-component also converts inline transform (double quotes) → rotate prop', () => {
    // A frame with a rotated child, componentized into a 3-variant component
    // (one variant per viewport) — goes through buildMultiVariantComponentFile.
    const ROT_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="frame" style={{ position: 'absolute', width: '699px', height: '464px' }}>
        <div data-id="kid" style={{ position: 'absolute', left: '231px', top: '136px', transform: "rotate(28.2deg)" }}></div>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(ROT_PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'frame', 'Multi', true, [
      { vpId: 'desktop', vpLabel: 'Desktop', width: 699, height: 464, vpWidth: 1440 },
      { vpId: 'tablet', vpLabel: 'Tablet', width: 699, height: 464, vpWidth: 768 },
      { vpId: 'mobile', vpLabel: 'Mobile', width: 699, height: 464, vpWidth: 375 },
    ]);
    const code = getWrittenComponentCode();
    expect(code).toContain('rotate: 28.2');
    expect(code).not.toContain('rotate(28.2deg)');     // CSS string gone
    // Variant gap is 20% of the variant width (699 → 140), not a flat 40:
    // variant-1.x = 699 + 140 = 839 (was 739 with the old flat gap).
    expect(code).toMatch(/name: 'variant-1'[^}]*x: 839/);
  });

  test('MULTI-VARIANT make-component normalizes a position:fixed root → absolute', () => {
    const FIXED_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="frame" style={{ position: 'fixed', width: '375px', height: '264px', backgroundColor: '#97cffc' }}></div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(FIXED_PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'frame', 'Fix', true, [
      { vpId: 'desktop', vpLabel: 'Desktop', width: 375, height: 264, vpWidth: 1470 },
      { vpId: 'tablet', vpLabel: 'Tablet', width: 375, height: 264, vpWidth: 768 },
      { vpId: 'mobile', vpLabel: 'Mobile', width: 375, height: 264, vpWidth: 375 },
    ]);
    const code = getWrittenComponentCode();
    // Root must be absolute (canvas tiles via variantConfig); fixed would pin it.
    // Read the root's STYLE OBJECT specifically (makeComponent no longer injects
    // the fixed-header layoutRoot props — that's deferred to the reactive hook).
    const sIdx = code.indexOf('style={{', code.indexOf('data-id="frame"'));
    const rootStyle = code.slice(sIdx, code.indexOf('}}', sIdx) + 2);
    expect(rootStyle).toContain("position: 'absolute'");
    expect(rootStyle).not.toContain("position: 'fixed'");
  });

  test('multi-variant make-component carries @media responsive overrides into VARIANTS', () => {
    // A child rotated ONLY on tablet (via @media) must become a variant-1
    // override on the component (variant-1 = tablet, vpWidth 768).
    const RESP_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <style>{\`
        @media (max-width: 768px) and (min-width: 376px) {
          [data-id="kid"] { transform: rotate(42deg) !important; }
        }
      \`}</style>
      <div data-id="frame" style={{ position: 'absolute', width: '316px', height: '354px' }}>
        <div data-id="kid" style={{ position: 'absolute', left: '73px', top: '105px' }}></div>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(RESP_PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'frame', 'Resp', true, [
      { vpId: 'desktop', vpLabel: 'Desktop', width: 316, height: 354, vpWidth: 1470 },
      { vpId: 'tablet', vpLabel: 'Tablet', width: 316, height: 354, vpWidth: 768 },
      { vpId: 'mobile', vpLabel: 'Mobile', width: 316, height: 354, vpWidth: 375 },
    ]);
    const code = getWrittenComponentCode();
    // The kid gets a variants object with variant-1 (tablet) rotation as a motion prop.
    expect(code).toMatch(/'variant-1':\s*\{[^}]*rotate:\s*42/);
    expect(code).not.toContain('rotate(42deg)');         // converted, not a CSS string
  });

  test('MULTI-VARIANT root per-variant SIZE is an inline ternary, NOT a variant-object value', () => {
    // Sizes that differ per viewport (like a responsive nav: 1440×125 → 375×462).
    // Size must ride the layout FLIP, so it lands in a `style` ternary keyed on
    // initialVariant (no connections yet) and is stripped from the variants object.
    const SIZE_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="frame" style={{ position: 'absolute', width: '1440px', height: '125px', backgroundColor: '#000' }}></div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(SIZE_PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'frame', 'Nav', true, [
      { vpId: 'desktop', vpLabel: 'Desktop', width: 1440, height: 125, vpWidth: 1440 },
      { vpId: 'tablet', vpLabel: 'Tablet', width: 768, height: 125, vpWidth: 768 },
      { vpId: 'mobile', vpLabel: 'Mobile', width: 375, height: 462, vpWidth: 375 },
    ]);
    const code = getWrittenComponentCode();
    // width: 3-way ternary (default 1440 from inline; variant-1 768; variant-2 375).
    expect(code).toContain("width: initialVariant === 'variant-1' ? '768px' : initialVariant === 'variant-2' ? '375px' : '1440px'");
    // height: the authored 125px is PX → every variant inherits it (the page
    // renders 125px on mobile too) — collapsed to the plain value, no ternary.
    // (Pre-2026-07-28 this froze the measured 462px into variant-2.)
    expect(code).toContain("height: '125px'");
    expect(code).not.toContain("height: initialVariant === 'variant-2' ? '462px'");
    // The root variants object must NOT carry width/height (they'd value-tween).
    const variantsConst = code.slice(code.indexOf('Variants = {'), code.indexOf('Variants = {') + 200);
    expect(variantsConst).not.toContain('width');
    expect(variantsConst).not.toContain('height');
  });

  test('multi-variant @media LAYOUT override → ternary; PAINT override → variant object', () => {
    // A child whose flexDirection changes on tablet (layout → ternary) and whose
    // backgroundColor changes on tablet (paint → variants object).
    const RESP_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <style>{\`
        @media (max-width: 768px) and (min-width: 376px) {
          [data-id="kid"] { flex-direction: column !important; background-color: #ff0000 !important; }
        }
      \`}</style>
      <div data-id="frame" style={{ position: 'absolute', width: '316px', height: '354px' }}>
        <div data-id="kid" style={{ position: 'relative', display: 'flex', flexDirection: 'row', backgroundColor: '#00ff00' }}></div>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(RESP_PAGE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'frame', 'Resp2', true, [
      { vpId: 'desktop', vpLabel: 'Desktop', width: 316, height: 354, vpWidth: 1470 },
      { vpId: 'tablet', vpLabel: 'Tablet', width: 316, height: 354, vpWidth: 768 },
      { vpId: 'mobile', vpLabel: 'Mobile', width: 316, height: 354, vpWidth: 375 },
    ]);
    const code = getWrittenComponentCode();
    // flexDirection (layout) → inline ternary on the kid.
    expect(code).toContain("flexDirection: initialVariant === 'variant-1' ? 'column' : 'row'");
    // backgroundColor (paint) → variant object (still value-tweened, correctly).
    expect(code).toMatch(/'variant-1':\s*\{[^}]*backgroundColor:\s*'#ff0000'/);
  });

  test('extracts node subtree into a component file with @name annotation', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'Hero Section');
    expect(result).not.toBeNull();

    // Component file should be written with a random name
    const filePath = getWrittenFilePath();
    expect(filePath).toMatch(/^components\/[A-Z][a-zA-Z0-9]+\.tsx$/);

    const componentCode = getWrittenComponentCode();
    // Should have @name annotation with the display name
    expect(componentCode).toContain('/** @name "Hero Section" */');
    // Should contain the extracted JSX wrapped in motion.*
    expect(componentCode).toContain('motion.div');
    expect(componentCode).toContain('data-id="hero"');
    expect(componentCode).toContain('data-id="title"');
    expect(componentCode).toContain("import { motion, LayoutGroup } from 'framer-motion'");
    expect(componentCode).toContain('variantConfig');

    // The updated page code should have the instance tag with display name
    expect(result!.updatedPageCode).toContain('data-id="hero"');
    expect(result!.updatedPageCode).toContain('data-name="Hero Section"');
    // Other nodes should be untouched
    expect(result!.updatedPageCode).toContain('data-id="footer"');
  });

  test('injects wrapper-only style props (position/left/top/etc) onto the instance tag so placement is preserved', () => {
    // Without this, after Make Component the instance falls back to its
    // parent's natural flow with no positioning info, and the canvas jumps.
    const positionedPage = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="card" style={{
        position: 'absolute',
        left: '64px',
        top: '38px',
        width: '320px',
        backgroundColor: '#fff',
        padding: '32px',
        borderRadius: '16px',
      }}>
        <h2 data-id="t">Card</h2>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(positionedPage);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'card', 'Card');
    expect(result).not.toBeNull();

    // The instance tag should carry a style={{}} with the positioning props.
    expect(result!.updatedPageCode).toMatch(/style=\{\{\s*position:\s*['"]absolute['"]/);
    expect(result!.updatedPageCode).toContain("left: '64px'");
    expect(result!.updatedPageCode).toContain("top: '38px'");
    // Visual props (width / backgroundColor / padding / borderRadius) belong
    // on the master root, NOT the instance tag — they live in the new
    // component file and reach the inner via the {...style} spread.
    const tagStart = result!.updatedPageCode.indexOf('<', result!.updatedPageCode.indexOf('data-id="card"') - 50);
    const tagEnd = result!.updatedPageCode.indexOf('/>', tagStart) + 2;
    const instanceTag = result!.updatedPageCode.slice(tagStart, tagEnd);
    expect(instanceTag).not.toMatch(/backgroundColor/);
    expect(instanceTag).not.toMatch(/borderRadius/);
    expect(instanceTag).not.toMatch(/\bpadding\b/);
    expect(instanceTag).not.toMatch(/\bwidth\b/);
  });

  test('parent-relative width/height (100%) ride the instance tag so a grid child keeps filling its cell', () => {
    // EMPIRICAL PIN, live find 2026-07-29: a grid child with width/height
    // 100% made into a component came back as an auto×auto instance —
    // the master froze 100% to measured px, and width/height never rode
    // the instance (WRAPPER_ONLY_STYLE_PROPS has neither), so the node
    // stopped filling its grid cell. Parent-relative sizes are PLACEMENT:
    // they must transfer to the instance tag; px/auto sizes must not.
    const gridPage = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div data-id="tile" style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#fff',
      }}>
        <p data-id="t">IMDb</p>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(gridPage);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'tile', 'Tile');
    expect(result).not.toBeNull();

    const tagStart = result!.updatedPageCode.indexOf('<', result!.updatedPageCode.indexOf('data-id="tile"') - 50);
    const tagEnd = result!.updatedPageCode.indexOf('/>', tagStart) + 2;
    const instanceTag = result!.updatedPageCode.slice(tagStart, tagEnd);
    expect(instanceTag).toContain("width: '100%'");
    expect(instanceTag).toContain("height: '100%'");
    // Visual props still stay off the instance.
    expect(instanceTag).not.toMatch(/backgroundColor/);
  });

  test('normalizes a position:fixed root to absolute + strips fixed-bar centering', () => {
    // A fixed nav made into a component must NOT stay fixed in the master —
    // it would pin to the editor viewport and break the variant tiles.
    const fixedPage = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="nav" style={{
        position: 'fixed',
        left: "50%",
        transform: "translateX(-50%)",
        width: '1440px',
        height: '105px',
        backgroundColor: '#000',
      }}>
        <p data-id="t">Logo</p>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(fixedPage);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'nav', 'Nav');
    expect(result).not.toBeNull();

    const componentCode = getWrittenComponentCode();
    // Root style object (first style={{) must be absolute, not fixed.
    const rootStyle = componentCode.slice(componentCode.indexOf('style={{'), componentCode.indexOf('}}', componentCode.indexOf('style={{')) + 2);
    expect(rootStyle).toMatch(/position:\s*['"]absolute['"]/);
    expect(rootStyle).not.toMatch(/position:\s*['"]fixed['"]/);
    // The fixed-bar centering artifacts are stripped from the root.
    expect(rootStyle).not.toMatch(/left:\s*['"]50%['"]/);
    expect(rootStyle).not.toMatch(/translateX/);
  });

  test('emits no `style={{}}` on the instance when the original had no wrapper-only props', () => {
    // Visual-only styles → instance stays clean, the master holds them.
    const cleanPage = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root">
      <div data-id="card" style={{ backgroundColor: '#fff', padding: '20px' }}>
        <h2 data-id="t">Hi</h2>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(cleanPage);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'card', 'Card');
    expect(result).not.toBeNull();
    // The instance tag should NOT carry a style={{}} attribute at all
    const cardLine = result!.updatedPageCode.split('\n').find(l => /<\w+\s+data-id="card"/.test(l)) || '';
    expect(cardLine).not.toMatch(/style=\{\{/);
  });

  test('generates random PascalCase internal name for React component', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'My Component');
    expect(result).not.toBeNull();

    const componentCode = getWrittenComponentCode();
    // Internal function name should be PascalCase (starts with uppercase)
    // Now wrapped: function Name(...) + export default withResponsiveProps(Name)
    const funcMatch = componentCode.match(/function (\w+)\s*\(/);
    expect(funcMatch).not.toBeNull();
    expect(funcMatch![1]).toMatch(/^[A-Z]/);
    // Should NOT be the display name
    expect(funcMatch![1]).not.toBe('My Component');
    // Should be wrapped with withResponsiveProps
    expect(componentCode).toContain(`export default withResponsiveProps(${funcMatch![1]})`);
  });

  test('display name allows spaces, lowercase, special characters', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'header component v2');
    expect(result).not.toBeNull();
    expect(result!.updatedPageCode).toContain('data-name="header component v2"');
    expect(getWrittenComponentCode()).toContain('/** @name "header component v2" */');
  });

  test('returns null when node not found in code', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'nonexistent-id', 'MyComp');
    expect(result).toBeNull();
  });

  test('returns null when page file does not exist', () => {
    mockFS.readFile.mockReturnValue(null);

    const result = makeComponent('missing.tsx', 'hero', 'Hero');
    expect(result).toBeNull();
  });

  test('generated component has { style } prop and ...style spread at end', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'Hero');
    expect(result).not.toBeNull();

    const componentCode = getWrittenComponentCode();

    // Component function must accept { style, initialVariant } props
    expect(componentCode).toContain('style, initialVariant');
    expect(componentCode).toContain('style?: React.CSSProperties');
    expect(componentCode).toContain("initialVariant?: string");
    // Must be wrapped with withResponsiveProps
    expect(componentCode).toContain('withResponsiveProps');
    expect(componentCode).toMatch(/export default withResponsiveProps\(\w+\)/);

    // Root style object must end with ...style spread (after all other props)
    expect(componentCode).toContain('...style');
    const spreadMatch = componentCode.match(/\.\.\.style\s*\}/);
    expect(spreadMatch).not.toBeNull();
  });

  test('instance tag preserves data-id and gets data-name with display name', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'Feature Card');
    expect(result).not.toBeNull();

    // Instance tag must have data-id matching the original node
    expect(result!.updatedPageCode).toContain('data-id="hero"');
    // Instance tag must have data-name matching the DISPLAY name
    expect(result!.updatedPageCode).toContain('data-name="Feature Card"');
    // Must be self-closing
    expect(result!.updatedPageCode).toMatch(/<\w+ data-id="hero"[^>]*\/>/);
  });

  test('variantConfig label uses display name', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'hero', 'Hero Section');
    const componentCode = getWrittenComponentCode();
    expect(componentCode).toContain("label: 'Hero Section'");
  });

  // ─── Variant const carryover ──────────────────────────────────────────────
  // When the extracted JSX references a `const xxxVariants` defined at the
  // parent scope, that const must be carried into the new component file —
  // otherwise the new module references an undefined identifier and the
  // live preview crashes with `ReferenceError: xxxVariants is not defined`.

  test('carries variant consts referenced by the extracted JSX into the new component file', () => {
    const PAGE_WITH_VARIANT_CONSTS = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';

const frameMolxVariants = {
  default: { left: '74px', top: '35px' },
  'variant-1': { left: '251px', top: '85px' },
};

export default function Page() {
  return (
    <motion.div data-id="root" style={{ position: 'relative' }}>
      <motion.div data-id="hero" variants={frameMolxVariants} style={{ padding: '40px' }}>
        <h1 data-id="title">Hello</h1>
      </motion.div>
    </motion.div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE_WITH_VARIANT_CONSTS);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'Hero');
    const componentCode = getWrittenComponentCode();

    // The variant const declaration is carried over verbatim
    expect(componentCode).toContain('const frameMolxVariants =');
    expect(componentCode).toContain("'variant-1': { left: '251px', top: '85px' }");
    // And it lives BEFORE the function declaration so the reference resolves
    const constIdx = componentCode.indexOf('const frameMolxVariants');
    const fnIdx = componentCode.search(/function\s+\w+\(/);
    expect(constIdx).toBeGreaterThanOrEqual(0);
    expect(constIdx).toBeLessThan(fnIdx);

    // The page no longer carries the now-orphan const
    expect(result!.updatedPageCode).not.toContain('const frameMolxVariants');
  });

  test('leaves variant consts in the page if they are still referenced by other elements', () => {
    const PAGE_WITH_SHARED_CONST = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';

const sharedVariants = {
  default: { opacity: '1' },
};

export default function Page() {
  return (
    <motion.div data-id="root" style={{ position: 'relative' }}>
      <motion.div data-id="hero" variants={sharedVariants} style={{ padding: '40px' }}>Hero</motion.div>
      <motion.div data-id="other" variants={sharedVariants} style={{ padding: '20px' }}>Other</motion.div>
    </motion.div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE_WITH_SHARED_CONST);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'hero', 'Hero');
    // Const stays in page because `<motion.div data-id="other">` still uses it
    expect(result!.updatedPageCode).toContain('const sharedVariants');
    // But it's also copied into the new component for hero's reference
    expect(getWrittenComponentCode()).toContain('const sharedVariants');
  });

  test('skips carryover when extracted JSX has no variants={...} references', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'hero', 'Hero');
    const componentCode = getWrittenComponentCode();
    // No carriedConstsBlock when nothing to carry
    expect(componentCode).not.toMatch(/const \w+Variants\s*=/);
  });

  test('CMS collection-list instance gets position:relative (flows, not absolute overlap)', () => {
    // A collection-list item made into a component: the master root is forced
    // position:absolute (tile view), so the INSTANCE must be position:relative
    // or every row stacks at the same spot on the live site.
    const CMS_PAGE = `import React from 'react';
import items from '@/cms/team.json';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((item, idx) => <div data-id="card" data-name="Card" style={{ display: 'flex', gap: '8px' }}><h3 data-id="t">{item.name}</h3></div>)}
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(CMS_PAGE);
    mockFS.exists.mockReturnValue(false);

    // (the instance tag is a random internal name; assert by attributes, not tag)
    const result = makeComponent('app/page.tsx', 'card', 'TeamCard', false, undefined, 'item');
    expect(result).not.toBeNull();
    // The instance flows (position:relative) and is NOT the master's forced absolute.
    expect(result!.updatedPageCode).toContain("position: 'relative'");
    expect(result!.updatedPageCode).not.toContain("position: 'absolute'");
    // Still binds the CMS field.
    expect(result!.updatedPageCode).toMatch(/name=\{item\.name\}/);
  });
});

// ─── rewriteVariantStateRefsToInitialVariant (nested-component variant rebind) ─
describe('rewriteVariantStateRefsToInitialVariant', () => {
  test('rebinds the variant-list wiring carried from a variant-driven parent', () => {
    // The Header's logo dots: Make Component carried `animate={['default', variant]}`
    // but the new component has no `variant` state → undefined identifier.
    const jsx = `<motion.div data-id="ld0" variants={ld0Variants} initial={['default', initialVariant]} animate={['default', variant]} />`;
    const out = rewriteVariantStateRefsToInitialVariant(jsx);
    expect(out).toContain("animate={['default', initialVariant]}");
    // No bare `variant` reference survives (initial was already initialVariant).
    expect(out).not.toMatch(/\[\s*'default'\s*,\s*variant\s*\]/);
  });

  test('rebinds comparison ternaries to initialVariant', () => {
    const jsx = `{variant === "mobile-open" ? "Blog" : variant !== "x" ? "a" : "b"}`;
    const out = rewriteVariantStateRefsToInitialVariant(jsx);
    expect(out).toContain('initialVariant === "mobile-open"');
    expect(out).toContain('initialVariant !== "x"');
  });

  test('leaves variants / setVariant / initialVariant / variantConfig untouched', () => {
    const jsx = `variants={ld0Variants} initialVariant={initialVariant} onTap={() => setVariant('x')}`;
    expect(rewriteVariantStateRefsToInitialVariant(jsx)).toBe(jsx);
  });
});

// ─── stripParentVariantToggleHandlers (Make Component drops the parent's variant toggle) ─
describe('stripParentVariantToggleHandlers', () => {
  test('removes the hamburger onTap that toggles the parent variant (the undefined-setVariant crash)', () => {
    // Make Component from the Header's hamburger carried `onTap={() => setVariant(…)}` — the new component has
    // no variant/setVariant state, so it crashes with "References undefined identifiers: setVariant, variant".
    const jsx = `<motion.div layout={true} onTap={() => setVariant(variant === 'mobile' ? 'mobile-open' : variant === 'variant-7' ? 'variant-8' : variant)} data-id="hamburger" {...rest} data-name="Menu Button" key="hamburger" style={{ position: 'absolute' }}>`;
    const out = stripParentVariantToggleHandlers(jsx);
    expect(out).not.toContain('setVariant');
    expect(out).not.toMatch(/\bvariant\b/);           // the trailing `: variant` went with the whole handler
    expect(out).toContain('data-id="hamburger"');     // the element itself survives
    expect(out).toContain('{...rest}');
  });
  test('leaves event handlers that do NOT toggle variant alone', () => {
    const jsx = `<button onClick={handleClick} onMouseEnter={() => track(1)} data-id="x">`;
    expect(stripParentVariantToggleHandlers(jsx)).toBe(jsx);
  });
  test('extractRootVariantToggleHandler lifts the handler (with leading space) for the instance tag', () => {
    // The connection must MOVE to the instance — extract returns it verbatim (variant/setVariant un-rewritten,
    // since the instance lives in the parent's scope), so makeComponent can splice it onto `<Inst …/>`.
    const jsx = `<motion.div layout={true} onTap={() => setVariant(variant === 'mobile' ? 'mobile-open' : variant)} data-id="hamburger" {...rest}>`;
    const h = extractRootVariantToggleHandler(jsx);
    expect(h).toBe(` onTap={() => setVariant(variant === 'mobile' ? 'mobile-open' : variant)}`);
    expect(h.startsWith(' ')).toBe(true);                  // leading space → safe to splice into the tag
    expect(`<Inst${h} data-id="hamburger" />`).toContain('setVariant'); // survives onto the instance
  });
  test('extractRootVariantToggleHandler returns empty when there is no variant toggle', () => {
    expect(extractRootVariantToggleHandler(`<button onClick={handleClick} data-id="x">`)).toBe('');
  });
});

// ─── detectCmsNavLink (CMS row link → linkHref variable) ────────────────────

describe('detectCmsNavLink', () => {
  test('detects a <Link> detail href + resolves the first-item default', () => {
    const code = `export default function C() {
  return (
    <Link data-id="row-1" href={\`/advisors/\${item?._slug ?? ''}\`}>
      <span>{item.name}</span>
    </Link>
  );
}`;
    const nav = detectCmsNavLink(code, 'item', { _slug: 'sarah-johnson', name: 'Sarah' });
    expect(nav).not.toBeNull();
    expect(nav!.nodeId).toBe('row-1');
    expect(nav!.tag).toBe('Link');
    // Verbatim href expression (item still in scope — bound per-row on the instance).
    expect(nav!.hrefExprCode).toContain('item');
    expect(nav!.hrefExprCode).toContain('_slug');
    // Concrete default resolved from the first item.
    expect(nav!.defaultValue).toBe('/advisors/sarah-johnson');
  });

  test('detects a plain <a href={item.link}> (stays an <a>, tag captured)', () => {
    const code = `export default function C() { return <a data-id="a-1" href={item.link}>x</a>; }`;
    const nav = detectCmsNavLink(code, 'item', { link: 'https://example.com' });
    expect(nav).not.toBeNull();
    expect(nav!.tag).toBe('a');
    expect(nav!.hrefExprCode).toBe('item.link');
    expect(nav!.defaultValue).toBe('https://example.com');
  });

  test('detects a <MotionLink> template href', () => {
    const code = `export default function C() { return <MotionLink data-id="row-1" href={\`/blog/\${item.slug}\`}>x</MotionLink>; }`;
    const nav = detectCmsNavLink(code, 'item', { slug: 'post-1' });
    expect(nav!.tag).toBe('MotionLink');
    expect(nav!.defaultValue).toBe('/blog/post-1');
  });

  test('returns null for a static (non-item) href', () => {
    const code = `export default function C() { return <Link data-id="row-1" href="/static">x</Link>; }`;
    expect(detectCmsNavLink(code, 'item', {})).toBeNull();
  });

  test('returns null when the row has no link element', () => {
    const code = `export default function C() { return <div data-id="row-1">{item.name}</div>; }`;
    expect(detectCmsNavLink(code, 'item', { name: 'x' })).toBeNull();
  });

  test('unresolved field (no first item) → static prefix only, still detects', () => {
    const code = `export default function C() { return <Link data-id="row-1" href={\`/advisors/\${item._slug}\`}>x</Link>; }`;
    const nav = detectCmsNavLink(code, 'item', undefined);
    expect(nav).not.toBeNull();
    expect(nav!.defaultValue).toBe('/advisors/');
  });
});

// ─── parseComponentName ─────────────────────────────────────────────────────

describe('parseComponentName', () => {
  test('parses @name annotation from component code', () => {
    const code = `import React from 'react';\n/** @name "My Header" */\nconst variantConfig = [];`;
    expect(parseComponentName(code)).toBe('My Header');
  });

  test('returns null when no @name annotation', () => {
    const code = `import React from 'react';\nexport default function Foo() {}`;
    expect(parseComponentName(code)).toBeNull();
  });

  test('handles @name with spaces and special characters', () => {
    const code = `/** @name "My Button (v2)" */`;
    expect(parseComponentName(code)).toBe('My Button (v2)');
  });

  test('handles single-star comment format', () => {
    const code = `/* @name "Short Comment" */`;
    expect(parseComponentName(code)).toBe('Short Comment');
  });

  test('does not match single-line comment format', () => {
    const code = `// @name "Not Valid"`;
    expect(parseComponentName(code)).toBeNull();
  });

  test('returns first @name if multiple exist', () => {
    const code = `/** @name "First" */\n/** @name "Second" */`;
    expect(parseComponentName(code)).toBe('First');
  });
});

// ─── setComponentName ──────────────────────────────────────────────────────

describe('setComponentName', () => {
  test('replaces existing @name annotation', () => {
    const code = `import React from 'react';\n/** @name "Old Name" */\nconst variantConfig = [];`;
    const updated = setComponentName(code, 'New Name');
    expect(updated).toContain('/** @name "New Name" */');
    expect(updated).not.toContain('Old Name');
    expect(parseComponentName(updated)).toBe('New Name');
  });

  test('inserts annotation when none exists, after imports', () => {
    const code = `'use client';\nimport React from 'react';\nimport { motion } from 'framer-motion';\nfunction Foo() { return <div />; }\nexport default Foo;`;
    const updated = setComponentName(code, 'Hero Section');
    expect(parseComponentName(updated)).toBe('Hero Section');
    // The annotation is inserted after the imports block, before the function
    const nameIdx = updated.indexOf('/** @name');
    const funcIdx = updated.indexOf('function Foo');
    expect(nameIdx).toBeGreaterThan(0);
    expect(nameIdx).toBeLessThan(funcIdx);
  });

  test('escapes embedded double quotes', () => {
    const code = `/** @name "Old" */`;
    const updated = setComponentName(code, 'My "Quoted" Name');
    expect(updated).toContain('/** @name "My \\"Quoted\\" Name" */');
  });

  test('inserts @name AFTER a multi-line @controls block — never inside it (code component)', () => {
    // Renaming CompanyMarquee used to inject @name right after `/** @controls {`,
    // whose `*/` closed the controls comment early and corrupted the whole file.
    const code = `'use client';

/** @label "Company Marquee" */
/** @comment "Infinite marquee" */
/** @controls {
  "children": { "type": "slot", "label": "Names", "slotMax": "infinite" },
  "speed": { "type": "slider", "label": "Speed", "default": 40 }
} */
import React, { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function CompanyMarquee({ speed = 40, children, ...props }) {
  const isStatic = useStaticCanvas();
  return <div ref={props.ref} />;
}
export default withResponsiveProps(CompanyMarquee);
`;
    const out = setComponentName(code, 'Marquee');
    expect(parseComponentName(out)).toBe('Marquee');
    // The @controls block is intact and closes exactly once.
    expect(out.match(/\} \*\//g)?.length).toBe(1);
    expect(out).toMatch(/@controls \{[\s\S]*"speed"[\s\S]*\} \*\//);
    // The annotation sits AFTER the controls comment closes — never inside it.
    expect(out.indexOf('@name "Marquee"')).toBeGreaterThan(out.indexOf('} */'));
    // Imports + function survive (no spill-out corruption).
    expect(out).toContain("from '@revyme/runtime'");
    expect(out).toContain('function CompanyMarquee');
    // And it parses cleanly.
    expect(() => parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
  });

  test('returns code unchanged for empty / whitespace-only names', () => {
    const code = `/** @name "Existing" */\nfunction Foo() {}`;
    expect(setComponentName(code, '')).toBe(code);
    expect(setComponentName(code, '   ')).toBe(code);
  });

  test('preserves other file content when replacing', () => {
    const code = `'use client';\nimport React from 'react';\n/** @name "X" */\nconst variantConfig = [{ name: 'default' }];\nfunction Foo() { return <div />; }`;
    const updated = setComponentName(code, 'Y');
    expect(updated).toContain("'use client'");
    expect(updated).toContain("import React from 'react'");
    expect(updated).toContain("const variantConfig = [{ name: 'default' }]");
    expect(updated).toContain('function Foo()');
    expect(parseComponentName(updated)).toBe('Y');
  });
});

// ─── getComponentDisplayName ───────────────────────────────────────────────

describe('getComponentDisplayName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns display name from component file', () => {
    mockFS.readFile.mockReturnValue(`/** @name "Feature Card" */\nexport default function Abc() {}`);
    const result = getComponentDisplayName('components/Abc.tsx');
    expect(result).toBe('Feature Card');
  });

  test('returns null when file has no @name annotation', () => {
    mockFS.readFile.mockReturnValue(`export default function Abc() {}`);
    const result = getComponentDisplayName('components/Abc.tsx');
    expect(result).toBeNull();
  });

  test('returns null when file does not exist', () => {
    mockFS.readFile.mockReturnValue(null);
    const result = getComponentDisplayName('components/Missing.tsx');
    expect(result).toBeNull();
  });
});

// ─── generateInternalName (tested indirectly via makeComponent) ────────────

describe('generateInternalName (indirect)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('generates different names on consecutive calls', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result1 = makeComponent('app/page.tsx', 'hero', 'First');
    vi.clearAllMocks();
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    const result2 = makeComponent('app/page.tsx', 'hero', 'Second');

    // Both should succeed
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();

    // The generated file paths should be different (random names)
    const calls1 = vi.mocked(queueMutation).mock.calls;
    // We only have calls from result2 since we cleared mocks
    const path2 = (calls1.find(c => c[0].type === 'writeFile')?.[0] as any)?.filePath;
    expect(path2).toMatch(/^components\/[A-Z]/);
  });

  test('generated name is PascalCase (starts with uppercase)', () => {
    mockFS.readFile.mockReturnValue(PAGE_CODE);
    mockFS.exists.mockReturnValue(false);

    makeComponent('app/page.tsx', 'hero', 'Test');
    const filePath = getWrittenFilePath();
    const name = filePath.replace('components/', '').replace('.tsx', '');
    // PascalCase: starts with uppercase, no spaces
    expect(name).toMatch(/^[A-Z][a-zA-Z]+$/);
  });

  // ─── Slot connection carryover ───────────────────────────────────────────
  // When the extracted subtree contains code-component instances with slot
  // refs (e.g. `<Marquee>{cn_frame_a_1}</Marquee>`), the connected canvas-
  // node `const cn_*` declarations are COPIED into the new component file as
  // its CONNECTED slot nodes (fresh suffixed data-ids; the moved JSX is
  // rewritten to point at them). The page originals STAY as normal,
  // now-disconnected canvas nodes on the page workspace (confirmed
  // 2026-07-28). Without the carry the moved code component renders blank —
  // undefined identifier.

  test('duplicates slot-connected canvas-node consts into the new component file', () => {
    const PAGE_WITH_SLOTS = `import React from 'react';
import Marquee from '@/components/Marquee';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="container">
        <Marquee data-id="m1">{cn_frame_a_1}{cn_frame_b_2}</Marquee>
      </div>
    </div>
  );
}
const cn_frame_a_1 = <div data-id="frame-a-1" data-canvas-node="true" style={{ position: 'absolute', width: '200px', height: '100px', left: '500px', top: '200px', backgroundColor: '#f00' }}></div>;
const cn_frame_b_2 = <div data-id="frame-b-2" data-canvas-node="true" style={{ position: 'absolute', width: '150px', height: '80px', left: '600px', top: '300px', backgroundColor: '#00f' }}></div>;
const canvasNodes = <></>;
`;
    mockFS.readFile.mockReturnValue(PAGE_WITH_SLOTS);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'container', 'Container');
    expect(result).not.toBeNull();
    const componentCode = getWrittenComponentCode();

    // Both slot-connected canvas nodes were duplicated into the new file.
    expect(componentCode).toMatch(/const cn_frame_a_1_[a-z0-9]{6}\s*=/);
    expect(componentCode).toMatch(/const cn_frame_b_2_[a-z0-9]{6}\s*=/);

    // The moved Marquee's slot refs were rewritten to the new const names.
    const aMatch = componentCode.match(/const (cn_frame_a_1_[a-z0-9]{6})\s*=/);
    const bMatch = componentCode.match(/const (cn_frame_b_2_[a-z0-9]{6})\s*=/);
    expect(aMatch).not.toBeNull();
    expect(bMatch).not.toBeNull();
    expect(componentCode).toContain('{' + aMatch![1] + '}');
    expect(componentCode).toContain('{' + bMatch![1] + '}');

    // The duplicated cn-decls carry the suffix on their data-id.
    expect(componentCode).toMatch(/data-id="frame-a-1-[a-z0-9]{6}"/);
    expect(componentCode).toMatch(/data-id="frame-b-2-[a-z0-9]{6}"/);

    // Each duplicate sits to the left of the master viewport (negative left,
    // stacked vertically).
    const declA = componentCode.match(/const cn_frame_a_1_[a-z0-9]{6}\s*=\s*[\s\S]*?;/)![0];
    expect(declA).toMatch(/left:\s*'-\d+px'/);

    // The page originals STAY — as normal, now-disconnected canvas nodes
    // (the referencing slot moved into the master; confirmed 2026-07-28).
    expect(result!.updatedPageCode).toContain('const cn_frame_a_1 =');
    expect(result!.updatedPageCode).toContain('const cn_frame_b_2 =');

    // The carried cn_ decls sit BELOW the export (page-dialect spot) so the
    // entry-fit scanner's "first data-id = root" assumption holds — declared
    // above the function they made component entry fit a card-sized box.
    expect(componentCode.indexOf('const cn_frame_a_1_')).toBeGreaterThan(componentCode.indexOf('export default'));
  });


  test('MULTI-VARIANT build carries slot consts too (blank-master regression)', () => {
    // The multi-variant builder (direct viewport child + 3 viewports) never
    // received carriedConsts — the CTA section with a Marquee compiled against
    // undefined cn_ identifiers and the whole master rendered blank with empty
    // layers (2026-07-28).
    const PAGE = `import React from 'react';
import Marquee from '@/components/Marquee';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="container">
        <Marquee data-id="m1">{cn_frame_a_1}</Marquee>
      </div>
    </div>
  );
}
const cn_frame_a_1 = <div data-id="frame-a-1" data-canvas-node="true" style={{ position: 'absolute', width: '200px', height: '100px', left: '500px', top: '200px' }}></div>;
const canvasNodes = <></>;
`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'container', 'Container', true, [
      { vpWidth: 1440, width: 1440, height: 600 },
      { vpWidth: 768, width: 768, height: 500 },
      { vpWidth: 375, width: 375, height: 400 },
    ] as never);
    expect(result).not.toBeNull();
    const code = getWrittenComponentCode();
    const m = code.match(/const (cn_frame_a_1_[a-z0-9]{6})\s*=/);
    expect(m).not.toBeNull();                       // decl carried into the MV file
    expect(code).toContain('{' + m![1] + '}');      // slot ref points at it
    expect(result!.updatedPageCode).toContain('const cn_frame_a_1 ='); // page keeps its (disconnected) node
    expect(code.indexOf('const cn_frame_a_1_')).toBeGreaterThan(code.indexOf('export default')); // below the export
  });

  test('bare rich-text <span> converts consistently — no mismatched motion pairs', () => {
    const PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root">
      <div data-id="container">
        <p data-id="t1"><span>Get early access</span></p>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'container', 'Container');
    expect(result).not.toBeNull();
    const code = getWrittenComponentCode();
    // Opening and closing both converted — the old opening regex required an
    // attribute after the tag name, so `<span>` stayed while `</span>` became
    // `</motion.span>`: mismatched JSX, unparsable file, blank master.
    expect(code).not.toMatch(/<span>/);
    expect((code.match(/<motion\.span[\s>]/g) ?? []).length)
      .toBe((code.match(/<\/motion\.span>/g) ?? []).length);
  });

  test('carries imports for user-component instances inside duplicated slot consts', () => {
    // A slot containing a user-component instance (<CeDuFe />, <PaLiCe />)
    // — these refs live inside the cn_* consts, not the main extracted
    // JSX. Without scanning the slot consts for tag references too, the
    // new component file would compile but reference undefined identifiers.
    const PAGE = `import React from 'react';
import Marquee from '@/components/Marquee';
import CeDuFe from '@/components/CeDuFe';
import PaLiCe from '@/components/PaLiCe';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="container">
        <Marquee data-id="m1">{cn_a}{cn_b}</Marquee>
      </div>
    </div>
  );
}
const cn_a = <CeDuFe data-id="ce-1" data-canvas-node="true" style={{ position: 'absolute', width: '200px', height: '100px', left: '50px', top: '50px' }} />;
const cn_b = <PaLiCe data-id="pa-1" data-canvas-node="true" style={{ position: 'absolute', width: '150px', height: '80px', left: '300px', top: '100px' }} />;
const canvasNodes = <></>;
`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);

    const result = makeComponent('app/page.tsx', 'container', 'Container');
    expect(result).not.toBeNull();
    const componentCode = getWrittenComponentCode();

    // Both user-component imports the slot consts depend on are carried
    // into the new component file.
    expect(componentCode).toContain("import CeDuFe from '@/components/CeDuFe'");
    expect(componentCode).toContain("import PaLiCe from '@/components/PaLiCe'");
    // The Marquee import (referenced in the main JSX) too.
    expect(componentCode).toContain("import Marquee from '@/components/Marquee'");
  });
});

// ─── detachComponent ───────────────────────────────────────────────────────

describe('detachComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('replaces component instance with original JSX from component file', () => {
    const pageWithComponent = `import React from 'react';
import XyzAbc from '@/components/XyzAbc';

export default function Page() {
  return (
    <div data-id="root">
      <XyzAbc data-id="hero" data-name="Hero" />
    </div>
  );
}`;

    const componentFileCode = `import React from 'react';
import { motion } from 'framer-motion';

/** @name "Hero" */

const variantConfig = [
  { name: 'default', label: 'Hero', x: 0, y: 0, isPrimary: true },
];

export default function XyzAbc({ style }: { style?: React.CSSProperties }) {
  return (
    <motion.div data-id="hero" style={{padding: '40px', background: '#111', ...style}}>
      <h1 data-id="title">Hello World</h1>
    </motion.div>
  );
}`;

    mockFS.readFile.mockImplementation((path: string) => {
      if (path === 'app/page.tsx') return pageWithComponent;
      if (path === 'components/XyzAbc.tsx') return componentFileCode;
      return null;
    });
    mockFS.exists.mockReturnValue(true);

    const result = detachComponent('app/page.tsx', 'hero', 'components/XyzAbc.tsx');
    expect(result).not.toBeNull();
    expect(result).toContain('data-id="hero"');
    expect(result).toContain('data-id="title"');
  });
});

describe('cleanComponentRootJSX', () => {
  test('strips data-canvas-node and page-canvas left/top from a canvas-node root', () => {
    // left/top last in the object — removing them must NOT leave a dangling
    // comma (it would collide with the injected `...style` spread).
    const jsx = `<div data-id="frame-1" data-name="Frame" data-canvas-node="true" style={{position: 'absolute', width: '481px', height: '185px', backgroundColor: '#97cffc', overflow: 'hidden', left: '323px', top: '983px'}}></div>`;
    const out = cleanComponentRootJSX(jsx);
    expect(out).not.toContain('data-canvas-node');
    expect(out).not.toContain('left:');
    expect(out).not.toContain('top:');
    // No dangling / doubled comma left behind.
    expect(out).not.toMatch(/,\s*,/);
    expect(out).not.toMatch(/,\s*\}\}/);
    // Real styles + identity survive.
    expect(out).toContain("position: 'absolute'");
    expect(out).toContain("width: '481px'");
    expect(out).toContain("overflow: 'hidden'");
    expect(out).toContain('data-id="frame-1"');
  });

  test('is a no-op for a viewport-child root (no canvas residue)', () => {
    const jsx = `<div data-id="hero" style={{display: 'flex', width: '600px'}}></div>`;
    expect(cleanComponentRootJSX(jsx)).toBe(jsx);
  });

  test('leaves camelCase props containing left/top untouched', () => {
    const jsx = `<div data-id="x" style={{marginLeft: '10px', paddingTop: '4px'}}></div>`;
    const out = cleanComponentRootJSX(jsx);
    expect(out).toContain("marginLeft: '10px'");
    expect(out).toContain("paddingTop: '4px'");
  });

  test('strips DOUBLE-quoted left/top too (leaked into nested instances as a relative offset)', () => {
    const jsx = `<div data-id="frame-x" style={{position: "absolute", width: "66px", height: "63px", left: "952px", top: "289px"}}></div>`;
    const out = cleanComponentRootJSX(jsx);
    expect(out).not.toContain('left:');
    expect(out).not.toContain('top:');
    expect(out).toContain('width: "66px"');
    expect(out).not.toMatch(/,\s*\}\}/);
  });
});

describe('detachInstance', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const COMPONENT = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';
const cardVariants = { default: { backgroundColor: 'green' }, 'variant-1': { backgroundColor: 'red' } };
function Card({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
    <motion.div data-id="card-root" variants={cardVariants} initial={initialVariant} animate={initialVariant} layout={true} data-name="Frame" style={{ position: 'relative', width: '300px', height: '200px', ...style }}>
      <motion.div data-id="card-child" layout={true} data-name="Frame" style={{ position: 'absolute', left: '10px', top: '10px', width: '50px', height: '50px', backgroundColor: 'blue' }}></motion.div>
      <Inner data-id="card-nested" data-name="Inner" style={{ position: 'absolute', left: '5px', top: '5px' }} />
    </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(Card);`;

  const PAGE = `import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="page-root"><Card data-id="inst" data-name="Card" style={{ width: '393px', height: '526px', position: 'relative', order: '1' }} /></div>);
}`;

  function setupFS() {
    mockFS.readFile.mockImplementation((p: string) =>
      p === 'app/page.tsx' ? PAGE : p === 'components/Card.tsx' ? COMPONENT : null);
  }

  test('inlines the master as normal nodes: strips motion/variant props, bakes variant + wrapper styles', () => {
    setupFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'default')!;
    expect(out).not.toBeNull();
    expect(parseJSX(out)).not.toBeNull();
    // The <Card/> instance is gone; the inlined region replaces it.
    expect(out).not.toContain('<Card ');
    // motion.* → plain tags; motion variant props dropped on inlined nodes.
    expect(out).not.toContain('motion.div');
    expect(out).not.toContain('variants={');
    expect(out).not.toMatch(/\b(initial|animate|layout)=/);
    // Default variant baked onto the root; instance wrapper width won over the master's 300px.
    expect(out).toContain("backgroundColor: 'green'");
    expect(out).toContain("width: '393px'");
    expect(out).not.toContain("width: '300px'");
    // The `...style` spread is resolved away.
    expect(out).not.toContain('...style');
  });

  test('keeps a NESTED component instance as an instance (not inlined/expanded)', () => {
    setupFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'default')!;
    expect(out).toContain('<Inner');           // nested instance preserved as a tag
    expect(out).toContain('data-name="Inner"');
    // The page didn't import Inner (only the master did) — detach must carry the import in, else
    // the inlined <Inner/> is undefined and won't render.
    expect(out).toMatch(/import Inner from ['"]@\/components\/Inner['"]/);
  });

  test('remaps every inlined data-id to a fresh id (no master-id collisions)', () => {
    setupFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'default')!;
    expect(out).not.toContain('data-id="card-root"');
    expect(out).not.toContain('data-id="card-child"');
    expect(out).not.toContain('data-id="card-nested"');
    expect(out).toMatch(/data-id="det-/);      // fresh det-* ids
  });

  test('bakes the requested variant (variant-1 → red)', () => {
    setupFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'variant-1')!;
    expect(out).toContain("backgroundColor: 'red'");
    expect(out).not.toContain("backgroundColor: 'green'");
  });

  test('drops the master {...rest} spread when inlining (no orphan "rest is not defined")', () => {
    const REST_COMP = `'use client';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (<LayoutGroup>
    <motion.div data-id="card-root" {...rest} variants={{ default: {} }} initial={initialVariant} animate={initialVariant} layout={true} data-name="Frame" style={{ position: 'relative', width: '300px', ...style }}></motion.div>
    </LayoutGroup>);
}
export default withResponsiveProps(Card);`;
    mockFS.readFile.mockImplementation((p: string) =>
      p === 'app/page.tsx' ? PAGE : p === 'components/Card.tsx' ? REST_COMP : null);
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'default')!;
    expect(out).not.toBeNull();
    expect(parseJSX(out)).not.toBeNull();
    // The inlined page div must NOT carry the master's `{...rest}` spread.
    expect(out).not.toContain('...rest');
    expect(out).not.toContain('{...rest}');
  });

  test('resolves component PROP variables: instance override wins, else the param default', () => {
    // The user's case: the master root uses prop variables in its style; the instance overrides some.
    // Detach must inline the value the prop resolves to (override ⊳ default), not leave the identifier.
    const COMP = `'use client';
import { motion, LayoutGroup } from 'framer-motion';
import JiPaVu from '@/components/JiPaVu';
function QiBiPa({ style, initialVariant = 'default', azefazef = "#97cffc", zefzeef = "0px", ergerg = "" }) {
  return (
    <LayoutGroup>
    <motion.div data-id="q-root" data-name="Frame" style={{ position: 'absolute', width: '1167px', backgroundColor: azefazef, borderRadius: zefzeef, overflow: 'hidden', ...style, border: ergerg }}>
      <JiPaVu data-id="q-nested" data-name="Frame" style={{ position: 'absolute', left: '15%', top: '27%' }} />
    </motion.div>
    </LayoutGroup>
  );
}
export default QiBiPa;`;
    const PG = `import QiBiPa from '@/components/QiBiPa';
export default function Page() {
  return (<div data-id="root"><QiBiPa ergerg="73px solid #000000" zefzeef="171px" azefazef="#244e70" data-id="inst" data-name="Frame" style={{ position: 'absolute', left: '9%', top: '121px' }} /></div>);
}`;
    mockFS.readFile.mockImplementation((p: string) => p === 'app/page.tsx' ? PG : p === 'components/QiBiPa.tsx' ? COMP : null);
    const out = detachInstance('app/page.tsx', 'inst', 'components/QiBiPa.tsx', 'default')!;
    expect(parseJSX(out)).not.toBeNull();
    // Instance overrides inlined (no leftover prop identifiers).
    expect(out).toMatch(/backgroundColor: ['"]#244e70['"]/);
    expect(out).toMatch(/borderRadius: ['"]171px['"]/);
    expect(out).toMatch(/border: ['"]73px solid #000000['"]/);
    expect(out).not.toMatch(/\bazefazef\b/);
    expect(out).not.toMatch(/\bzefzeef\b/);
    expect(out).not.toMatch(/\bergerg\b/);
    // The nested instance survives + its import is carried.
    expect(out).toContain('<JiPaVu');
    expect(out).toMatch(/import JiPaVu from/);
  });

  test('a prop with no override falls back to the param default', () => {
    const COMP = `'use client';
import { motion, LayoutGroup } from 'framer-motion';
function P({ style, bg = "rebeccapurple" }) {
  return (<LayoutGroup><motion.div data-id="r" data-name="Frame" style={{ position: 'absolute', backgroundColor: bg, ...style }}></motion.div></LayoutGroup>);
}
export default P;`;
    const PG = `import P from '@/components/P';
export default function Page() { return (<div data-id="root"><P data-id="inst" data-name="Frame" style={{ position: 'absolute' }} /></div>); }`;
    mockFS.readFile.mockImplementation((p: string) => p === 'app/page.tsx' ? PG : p === 'components/P.tsx' ? COMP : null);
    const out = detachInstance('app/page.tsx', 'inst', 'components/P.tsx', 'default')!;
    expect(out).toMatch(/backgroundColor: ['"]rebeccapurple['"]/);   // param default used (no override)
    expect(out).not.toMatch(/backgroundColor: bg\b/);
  });

  test('neutralizes component-scope refs/handlers/hooks so nested instances still render', () => {
    // The user's bug: a component with variant connections + scroll-fx + a nested instance whose
    // initialVariant/ref are driven by PARENT hooks. Naive inlining left those undefined identifiers
    // on the page → crash → nested instances "disappeared". Detach must strip/resolve them all.
    const COMP = `'use client';
import { motion, LayoutGroup, useMotionValue, useRef } from 'framer-motion';
import Inner from '@/components/Inner';
const cVariants = { default: { backgroundColor: 'green' }, 'variant-1': { backgroundColor: 'red' } };
function Card({ style, initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  const innerRef = useRef(null);
  const innerSv = useMotionValue('default');
  const hovScale = useMotionValue(1);
  return (
    <LayoutGroup>
    <motion.div onTap={() => setVariant(variant === 'default' ? 'variant-1' : 'default')} data-id="c-root" variants={cVariants} initial={initialVariant} animate={initialVariant} data-name="Frame" style={{ position: 'relative', scale: hovScale, width: '300px', ...style }}>
      <Inner ref={innerRef} initialVariant={variant === 'variant-1' ? innerSv : 'default'} data-scroll-variant='{"trigger":"onScroll"}' data-id="c-nested" data-name="Inner" style={{ position: 'absolute', left: '5px', top: '5px' }} />
    </motion.div>
    </LayoutGroup>
  );
}
export default Card;`;
    const PG = `import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="page-root"><Card data-id="inst" data-name="Card" style={{ width: '400px', position: 'relative' }} /></div>);
}`;
    mockFS.readFile.mockImplementation((p: string) => p === 'app/page.tsx' ? PG : p === 'components/Card.tsx' ? COMP : null);
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'default')!;
    expect(parseJSX(out)).not.toBeNull();
    // No component-scope leftovers (these crashed the page).
    expect(out).not.toMatch(/\bsetVariant\b/);
    expect(out).not.toMatch(/\bvariant ===/);
    expect(out).not.toMatch(/\bref=\{/);          // refs dropped
    expect(out).not.toMatch(/\binnerSv\b/);        // hook-bound initialVariant resolved away
    expect(out).not.toMatch(/\bhovScale\b/);       // motion-value style binding dropped
    expect(out).not.toMatch(/onTap=/);             // variant-connection handler dropped
    // The nested instance survives, with a STATIC resolved initialVariant.
    expect(out).toContain('<Inner');
    expect(out).toContain('initialVariant="default"');
    expect(out).toContain('data-name="Inner"');
    // Inlined root still has its non-dynamic styles + baked variant.
    expect(out).toContain("backgroundColor: 'green'");
    expect(out).toContain("width: '400px'");       // instance wrapper width
  });

  // A CMS-row component: root is `MotionLink = motion.create(Link)`, props (image/title)
  // are bound to `item.field` on the instance inside a `.map()`. Detaching it must turn
  // it into NORMAL nodes that keep the CMS bindings — not leave `image`/`title`/`variant`/
  // `...style` dangling (the user-reported "breaks completely").
  const CMS_COMPONENT = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Link from 'next/link';
const MotionLink = motion.create(Link);
const headingVariants = { default: { color: '#111' } };
function MoCeUx({ image, title, linkHref = '/', style, initialVariant = 'default' }) {
  const [variant, setVariant] = React.useState(initialVariant);
  return (
    <LayoutGroup>
    <MotionLink data-cms-nav="row" href={linkHref} data-id="row-root" data-name="Blog" style={{ display: 'flex', flexDirection: 'row', width: '296px', ...style }}>
      <motion.div onHoverStart={() => setVariant('default-hover')} layout={true} data-id="row-img" style={{ width: '60px', height: '60px', backgroundImage: \`url(\${image})\` }} initial={['default', initialVariant]} animate={['default', variant]}></motion.div>
      <motion.h3 layout={true} data-id="row-title" variants={headingVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{ fontSize: '18px' }}>{title}</motion.h3>
    </MotionLink>
    </LayoutGroup>
  );
}
export default withResponsiveProps(MoCeUx);`;

  const CMS_PAGE = `import React from 'react';
import blog from '@/cms/blog.json';
import MoCeUx from '@/components/MoCeUx';
export default function Page() {
  return (<div data-id="page-root">{blog.map((item, idx) => <MoCeUx data-id="inst" key={idx} data-name="Blog" image={item.image} title={item.title} linkHref={\`/blog/\${item?._slug ?? ''}\`} style={{ position: 'relative' }} />)}</div>);
}`;

  function setupCmsFS() {
    mockFS.readFile.mockImplementation((p: string) =>
      p === 'app/page.tsx' ? CMS_PAGE : p === 'components/MoCeUx.tsx' ? CMS_COMPONENT : null);
  }

  test('CMS-row MotionLink instance detaches to a normal <Link> row with bindings intact', () => {
    setupCmsFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/MoCeUx.tsx', 'default')!;
    expect(out).not.toBeNull();
    expect(parseJSX(out)).not.toBeNull();
    // The .map() wrapper survives; the instance is gone, replaced by a plain Link row.
    expect(out).toContain('blog.map(');
    expect(out).not.toContain('<MoCeUx');
    expect(out).toContain('<Link');                 // MotionLink → Link (not a black-box instance)
    expect(out).not.toContain('MotionLink');
    expect(out).not.toContain('motion.');
    // Props resolve back to the per-row CMS bindings (deep, inside template literal + text child).
    expect(out).toContain('url(${item.image})');
    expect(out).toContain('{item.title}');
    // No dangling component-scope references.
    expect(out).not.toMatch(/\$\{image\}/);
    expect(out).not.toMatch(/>\{title\}</);
    expect(out).not.toContain('...style');
    expect(out).not.toMatch(/\bvariant\b(?!s)/);    // no `variant`/`setVariant`/initial=… leftovers
    expect(out).not.toMatch(/\bsetVariant\b/);
    expect(out).not.toContain('headingVariants');
    expect(out).not.toMatch(/\b(initial|animate|layout|variants)=/);
  });

  test('reports the detached root data-id via the out-param (for re-selection)', () => {
    setupFS();
    const detachOut: { rootId?: string } = {};
    const out = detachInstance('app/page.tsx', 'inst', 'components/Card.tsx', 'default', detachOut)!;
    expect(detachOut.rootId).toMatch(/^det-/);
    // The reported id is the one actually present on the inlined root.
    expect(out).toContain(`data-id="${detachOut.rootId}"`);
  });
});

// ─── ensureLayoutRootOnComponentRoot ────────────────────────────────────────
// Per-instance fixed/sticky layout config on a component ROOT. The live-verified
// fix is `layoutScroll={(CHECK)}` — it marks the fixed root as a scroll boundary so
// Motion stops folding the window scroll offset into its projection, killing the
// nav "slide" for the root AND its `layout` children. `layout={(CHECK) ? "size" :
// true}` rides alongside (size-only animation = mobile-menu expand, position snaps).
// Both conditional on CHECK → relative masters keep layoutScroll={false}/layout={true}.
// Heals every dead-end (layoutRoot / layoutDependency / bare layoutScroll stripped)
// AND un-wraps the abandoned two-element data-fixed-shell, restoring root height.
const CHECK = `(style as any)?.position === 'fixed' || (style as any)?.position === 'sticky'`;
const TARGET = `layout={(${CHECK}) ? "size" : true}`;
const SCROLL = `layoutScroll={(${CHECK})}`;
describe('ensureLayoutRootOnComponentRoot', () => {
  test('adds layoutScroll + layout="size" (conditional), strips layoutRoot/Dependency', () => {
    const code = `function C({ style }) { return <motion.div data-id="root" data-name="C" layout={true} style={{ position: 'absolute', height: '72px', ...style }} />; }`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).toContain(SCROLL);               // the actual fix
    expect(out).toContain(TARGET);
    expect(out).not.toContain('layout={true}'); // the literal is gone (now conditional)
    expect(out).not.toContain('layoutRoot=');
    expect(out).not.toContain('layoutDependency=');
  });

  test('heals the layoutRoot+layout={true}+layoutDependency state', () => {
    const code = `<motion.div data-id="root" data-name="C" layout={true} layoutDependency={((style as any)?.position === 'fixed' || (style as any)?.position === 'sticky') ? ('72px') : undefined} style={{ position: 'absolute', height: '72px', ...style }} />`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).toContain(SCROLL);
    expect(out).toContain(TARGET);
    expect(out).not.toContain('layoutDependency='); // stripped
  });

  test('heals the layoutRoot-anchor state (layout={!(…)} + layoutRoot)', () => {
    const code = `<motion.div data-id="root" data-name="C" layout={!(${CHECK})} layoutRoot={${CHECK}} style={{ position: 'absolute', height: '72px', ...style }} />`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).toContain(SCROLL);
    expect(out).toContain(TARGET);
    expect(out).not.toMatch(/layout=\{!\(/);
    expect(out).not.toContain('layoutRoot=');
  });

  test('strips a hand-added bare layoutScroll and replaces with the conditional form', () => {
    const code = `<motion.div data-id="root" data-name="C" layoutScroll layout={true} style={{ position: 'absolute', height: '72px', ...style }} />`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).toContain(SCROLL);
    expect(out).toContain(TARGET);
    expect(out).not.toMatch(/layoutScroll(?!=)\s/); // no leftover bare token
    expect(out.match(/layoutScroll/g)?.length).toBe(1); // exactly one
  });

  test('handles instance-size roots that spread ...__instStyle (responsive Header)', () => {
    const code = `function H({ style }) { const { width: w, height: h, ...__instStyle } = style ?? {}; return <motion.div data-id="header-root" data-name="Header" layout={true} style={{ position: 'absolute', height: '72px', ...__instStyle }} />; }`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).toContain(SCROLL);
    expect(out).toContain(TARGET);
    expect(out).toContain('...__instStyle');
  });

  test('UN-WRAPS an abandoned data-fixed-shell, restores root height + sets layout="size"', () => {
    // The two-element shell broke the expand. Re-running must remove the inner
    // wrapper, leave its children attached to the root, restore the root height
    // (un-wrap the `(CHECK) ? 'auto' : (X)`) and put layout="size" on the root.
    const shell = `<motion.div data-fixed-shell layout={${CHECK}} style={(${CHECK}) ? { display: 'flex', flexDirection: 'inherit', width: '100%', height: variant === 'mobile-open' ? 'auto' : '72px', overflow: 'hidden' } : { display: 'contents' }}>`;
    const code = `function H({ style }) { return (
    <motion.div data-id="header-root" layout={!(${CHECK})} layoutRoot={${CHECK}} style={{ position: 'absolute', height: (${CHECK}) ? 'auto' : (variant === 'mobile-open' ? 'auto' : '72px'), ...style }}>
      ${shell}
      <motion.div data-id="bar" layout={true} style={{ height: '72px' }}></motion.div>
      </motion.div>
    </motion.div>
  ); }`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).not.toContain('data-fixed-shell');           // shell removed
    expect(out).not.toContain('layoutRoot=');                // anchor props gone
    expect(out).toContain(SCROLL);                            // scroll-boundary fix added
    expect(out).toContain(TARGET);                            // root is layout="size"
    expect(out).toContain(`height: variant === 'mobile-open' ? 'auto' : '72px'`); // root height restored (un-wrapped)
    expect(out).not.toMatch(/\? 'auto' : \(variant/);        // no longer wrapped
    expect(out).toContain('data-id="bar"');                  // children preserved
    expect(() => parseJSX(out)).not.toThrow();               // still valid JSX
  });

  test('un-wraps a shell through deep, realistic Header nesting (bar + AnimatePresence panel)', () => {
    // Mirrors the live Header: the shell wraps a bar (nested motion.divs) AND an
    // AnimatePresence mobile panel. The shell-close matcher must skip every nested
    // </motion.div> and pick the shell's own — leaving all children attached.
    const shell = `<motion.div data-fixed-shell layout={${CHECK}} style={(${CHECK}) ? { display: 'flex', flexDirection: 'inherit', width: '100%', height: variant === 'mobile-open' ? 'auto' : '72px', overflow: 'hidden' } : { display: 'contents' }}>`;
    const code = `function Header({ style }) {
  return (
    <LayoutGroup>
      <MotionConfig transition={{ duration: 0.3 }}>
        <motion.div data-id="header-root" layout={!(${CHECK})} layoutRoot={${CHECK}} style={{ position: 'absolute', display: 'flex', flexDirection: 'column', height: (${CHECK}) ? 'auto' : (variant === 'mobile-open' ? 'auto' : '72px'), ...style }}>
${shell}
          <motion.div data-id="bar" layout={true} style={{ display: 'flex' }}>
            <motion.div data-id="logo" layout={true}><MotionLink href="/">Logo</MotionLink></motion.div>
            <AnimatePresence mode="popLayout">{open && <motion.div data-id="nav" key="nav" layout={true}></motion.div>}</AnimatePresence>
          </motion.div>
          <AnimatePresence mode="popLayout">{open && <motion.div data-id="panel" key="panel" layout={true}></motion.div>}</AnimatePresence>
        </motion.div>
      </MotionConfig>
    </LayoutGroup>
  );
}`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).not.toContain('data-fixed-shell');     // shell gone
    expect(out).not.toContain('layoutRoot=');          // anchor props gone
    expect(out).toContain(SCROLL);                      // scroll-boundary fix added
    expect(out).toContain(TARGET);                      // root layout="size"
    expect(out).toContain(`height: variant === 'mobile-open' ? 'auto' : '72px'`); // root height restored
    // All children survived in place.
    expect(out).toContain('data-id="bar"');
    expect(out).toContain('data-id="logo"');
    expect(out).toContain('data-id="nav"');
    expect(out).toContain('data-id="panel"');
    expect(out).toContain('<LayoutGroup>');
    expect(() => parseJSX(out)).not.toThrow();          // still valid JSX
  });

  test('idempotent — a root already carrying layoutScroll + layout="size" is unchanged', () => {
    const code = `<motion.div ${SCROLL} ${TARGET} data-id="root" data-name="C" style={{ position: 'absolute', height: '72px', ...style }} />`;
    expect(ensureLayoutRootOnComponentRoot(code)).toBe(code);
  });

  test('handles a bare `layout` motion root (AI form) without leaving a duplicate layout attr', () => {
    const code = `<motion.div data-id="root" data-name="C" layout style={{ position: 'absolute', height: '72px', ...style }} />`;
    const out = ensureLayoutRootOnComponentRoot(code);
    expect(out).toContain(SCROLL);
    expect(out).toContain(TARGET);
    expect(out.match(/\blayout=/g)?.length).toBe(1); // only the conditional — bare `layout` stripped
    expect(() => parseJSX(out)).not.toThrow();
  });

  test('skips a NON-motion component root (no framer-motion props on a plain element)', () => {
    const code = `<div data-id="root" data-name="C" layout style={{ position: 'absolute', ...style }} />`;
    expect(ensureLayoutRootOnComponentRoot(code)).toBe(code);
  });

  test('no-op when there is no instance style spread', () => {
    const code = `<motion.div data-id="root" style={{ position: 'absolute' }} />`;
    expect(ensureLayoutRootOnComponentRoot(code)).toBe(code);
  });
});

// ─── replaceNonPxDimensions — FILL (flex-basis 0) nodes ──────────────────────
// A Fill node has NO width/height key (size = grow in the parent's flex); on
// the master artboard there's no flex parent, so basis-0 collapsed the root to
// 0px (live find 2026-07-08). The missing axis gets the computed px injected.
import { replaceNonPxDimensions } from './component-ops';

describe('replaceNonPxDimensions — fill flex', () => {
  test('injects computed WIDTH when a fill node has no width key', () => {
    const jsx = `<div data-id="row" style={{
      position: 'relative', height: '263px',
      flex: '1 0 0px', display: "flex"
    }}></div>`;
    const out = replaceNonPxDimensions(jsx, 437, 263);
    expect(out).toContain("width: '437px'");
    expect(out).toContain("height: '263px'"); // existing explicit height untouched
    // The fill is resolved to FIXED on the master root — the artboard has no flex
    // parent, so basis-0 is meaningless there (panel read the root as "Fill").
    // Page rows still fill: the INSTANCE tag carries flex '1 0 0px', spread last.
    expect(out).toContain("flex: '0 0 auto'");
    expect(out).not.toContain("flex: '1 0 0px'");
  });

  test('injects BOTH axes when fill node has neither (and resolves the fill to fixed)', () => {
    const out = replaceNonPxDimensions(`<div style={{ position: 'relative', flex: '2 1 0%' }}></div>`, 300, 150);
    expect(out).toContain("width: '300px'");
    expect(out).toContain("height: '150px'");
    expect(out).toContain("flex: '0 0 auto'");
  });

  test('non-fill node without width stays untouched (content-sized text etc.)', () => {
    const jsx = `<p style={{ position: 'relative', flex: '0 0 auto', fontSize: '14px' }}>x</p>`;
    expect(replaceNonPxDimensions(jsx, 200, 20)).toBe(jsx);
  });

  test('% and auto replacement unchanged', () => {
    const jsx = `<div style={{ width: '100%', height: 'auto' }}></div>`;
    const out = replaceNonPxDimensions(jsx, 500, 250);
    expect(out).toContain("width: '500px'");
    expect(out).toContain("height: '250px'");
  });
});

describe('detachInstance — AnimatePresence variant render gates (live find 2026-07-13)', () => {
  // The VoRaLu/GaBiTa reveal dialect: a row rendered only on the hover variant via
  // `<AnimatePresence>{variant !== "default" && <motion.div …/>}</AnimatePresence>`.
  // Detach used to keep this block VERBATIM (AnimatePresence read as a nested
  // instance → children never transformed) — `variant` / `wtMetaVariants` were
  // undefined at page scope and the page crashed.
  const HOVER_COMPONENT = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const wtMetaVariants = { default: {}, 'variant-1': { opacity: 1, y: 0 } };
function Tile({ style, initialVariant = 'default', category = "Photography" }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 260, damping: 30 }}>
    <motion.div data-id="wt-root" layout={true} data-name="Tile" onHoverStart={() => setVariant('variant-1')} animate={['default', variant]} initial={['default', initialVariant]} style={{ position: 'absolute', width: '680px', display: 'flex', flexDirection: 'column', ...style }}>
      <motion.div data-id="wt-img" layout={true} data-name="Image" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%', height: '500px' }}></motion.div>
      <AnimatePresence mode="popLayout">{variant !== "default" && <motion.div layout={true} data-id="wt-meta" variants={wtMetaVariants} initial={variant === 'variant-1' ? { opacity: 0, y: 14 } : ['default', initialVariant]} animate={['default', variant]} data-name="Meta Row" key="wt-meta" data-replica-solo="variant-1" style={{ position: 'relative', order: '1', flex: '0 0 auto', width: '100%' }}>
        <motion.p layout={true} data-id="wt-meta-cat" data-name="Category" style={{ position: 'relative', order: '0', flex: '0 0 auto', margin: '0px' }}>{category}</motion.p>
      </motion.div>}</AnimatePresence>
      <motion.div data-id="wt-bar" layout={true} data-name="Caption" style={{ position: 'relative', order: '2', flex: '0 0 auto', width: '100%' }}></motion.div>
    </motion.div>
  </MotionConfig>
    </LayoutGroup>;
}
export default withResponsiveProps(Tile);`;

  const HOVER_PAGE = `import React from 'react';
import Tile from '@/components/Tile';
export default function Page() {
  return (<div data-id="page-root"><Tile data-id="inst" data-name="Tile" category="Motion" style={{ width: '100%', position: 'relative', order: '0' }} /></div>);
}`;

  function setupHoverFS() {
    mockFS.readFile.mockImplementation((p: string) =>
      p === 'app/page.tsx' ? HOVER_PAGE : p === 'components/Tile.tsx' ? HOVER_COMPONENT : null);
  }

  beforeEach(() => { vi.clearAllMocks(); });

  test('default detach: the gated row and ALL variant machinery are gone', () => {
    setupHoverFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/Tile.tsx', 'default')!;
    expect(out).not.toBeNull();
    expect(parseJSX(out)).not.toBeNull();
    expect(out).not.toContain('AnimatePresence');
    expect(out).not.toContain('wtMetaVariants');
    expect(out).not.toMatch(/\bvariant\b\s*[!=]==/);
    expect(out).not.toContain('data-id="wt-meta"');       // row not rendered on default
    expect(out).not.toContain('data-replica-solo');
    expect(out).toContain('data-name="Caption"');          // siblings survive
  });

  test('variant-1 detach: the row inlines as a NORMAL node (fresh id, no machinery)', () => {
    setupHoverFS();
    const out = detachInstance('app/page.tsx', 'inst', 'components/Tile.tsx', 'variant-1')!;
    expect(out).not.toBeNull();
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toContain('data-name="Meta Row"');
    expect(out).not.toContain('data-id="wt-meta"');        // fresh det-* id
    expect(out).not.toContain('AnimatePresence');
    expect(out).not.toContain('wtMetaVariants');
    expect(out).not.toMatch(/animate=\{\[/);
    expect(out).not.toContain('key="wt-meta"');
    expect(out).not.toContain('data-replica-solo');
    // The category prop override resolved into the text child.
    expect(out).toContain('Motion');
  });
});

// ─── @media rule strip on extraction ────────────────────────────────────────
// The extracted subtree's responsive rules migrate into the component (or
// die with it) — leaving them in the PAGE lets them keep matching: internal
// data-ids still exist inside the instance, and the ROOT id now names the
// instance WRAPPER, so a migrated padding rule pads the wrapper and draws a
// page-colored ring around the instance on replica tiles (the Footer report).
describe('makeComponent strips migrated @media rules from the page', () => {
  test('extracted ids cleared, unrelated ids kept', () => {
    const PAGE = `import React from 'react';

export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <style>{\`
    @media (max-width: 768px) {
      [data-id="hero"] { padding: 76px 48px 16px 48px !important; }
      [data-id="title"] { font-size: 20px !important; }
      [data-id="other"] { gap: 10px !important; }
    }
  \`}</style>
      <div data-id="hero" style={{ padding: '40px', background: '#111' }}>
        <h1 data-id="title">Hello World</h1>
      </div>
      <div data-id="other" style={{ padding: '20px' }}>Other</div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);

    const res = makeComponent('app/page.tsx', 'hero', 'HeroC');
    const pageOut = (res as any).updatedPageCode as string;
    expect(pageOut).not.toContain('[data-id="hero"] { padding');
    expect(pageOut).not.toContain('[data-id="title"]');
    expect(pageOut).toContain('[data-id="other"]');
  });
});

// ─── useResponsiveText carry ─────────────────────────────────────────────────
// The extracted JSX can CALL the page's file-local `useResponsiveText` hook
// (per-viewport text overrides). The definition used to stay behind on the
// page, so the new component ReferenceError-crashed on the live site
// (componentized "Why ClarityU" section, 2026-07-28).
describe('makeComponent — useResponsiveText hook carry', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const HOOK_PAGE = `import React, { useState, useEffect } from 'react';
// @useResponsiveText-begin
function useResponsiveText(base, overrides, bps) {
  const [t, setT] = useState(base);
  useEffect(() => {}, []);
  return t;
}
// @useResponsiveText-end
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <div data-id="hero" style={{ padding: '40px' }}>
        <p data-id="title">{useResponsiveText("Manage taxes", { 375: "Taxes" }, [375, 768, 1440])}</p>
      </div>
    </div>
  );
}`;

  test('a componentized subtree calling useResponsiveText gets its own hook definition', () => {
    mockFS.readFile.mockReturnValue(HOOK_PAGE);
    mockFS.exists.mockReturnValue(false);
    makeComponent('app/page.tsx', 'hero', 'Sec');
    const code = getWrittenComponentCode();
    expect(code).toContain('useResponsiveText(');
    expect(code).toMatch(/function useResponsiveText\(/);   // definition carried
    expect(code).toMatch(/import React, \{[^}]*useState/);  // react hooks imported
  });

  test('no hook call in the subtree → no definition injected', () => {
    const NO_CALL_PAGE = HOOK_PAGE.replace(
      '<p data-id="title">{useResponsiveText("Manage taxes", { 375: "Taxes" }, [375, 768, 1440])}</p>',
      '<p data-id="title">Manage taxes</p>',
    );
    mockFS.readFile.mockReturnValue(NO_CALL_PAGE);
    mockFS.exists.mockReturnValue(false);
    makeComponent('app/page.tsx', 'hero', 'Sec');
    const code = getWrittenComponentCode();
    expect(code).toBeTruthy();
    expect(code).not.toMatch(/function useResponsiveText\(/);
  });
});

// ─── Per-viewport ROOT placement stays on the page instance ──────────────────
// A root section can carry an INDEPENDENT per-viewport `order` in the page's
// @media block (the user's mobile reorder wrote `order: 10 !important` for the
// CTA). Make Component used to strip it with the rest of the extracted ids'
// rules and migrate it into the master's variant — where it lands on the INNER
// root, layout-inert — so the new INSTANCE fell to order 0 on mobile and
// jumped up under the hero (2026-07-28). Placement props (order/flex/margins/
// align-self/grid placement) must stay on the page for the instance id; visual
// props still migrate.
describe('makeComponent — per-viewport root placement stays with the instance', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const MEDIA_PAGE = `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
      <style>{\`
      @media (max-width: 375px) {
        [data-id="cta"] { order: 10 !important; padding: 13px !important; }
        [data-id="other"] { order: 1 !important; }
      }
      \`}</style>
      <div data-id="other" style={{ position: 'relative', width: '100%', height: 'auto' }}>Other</div>
      <div data-id="cta" style={{ position: 'relative', width: '100%', height: 'auto', padding: '95px' }}>
        <p data-id="cta-title">Get early access</p>
      </div>
    </div>
  );
}`;

  test('multi-variant: order stays in the page @media for the instance; padding migrates to the master', () => {
    mockFS.readFile.mockReturnValue(MEDIA_PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'cta', 'Cta', true, [
      { vpWidth: 1440, width: 1440, height: 600 },
      { vpWidth: 768, width: 768, height: 500 },
      { vpWidth: 375, width: 375, height: 400 },
    ] as never);
    expect(result).not.toBeNull();
    const master = getWrittenComponentCode();
    // The instance keeps its per-viewport ORDER on the page…
    expect(result!.updatedPageCode).toMatch(/\[data-id="cta"\][^}]*order:\s*10/);
    // …while the UNRELATED sibling's rule is untouched…
    expect(result!.updatedPageCode).toMatch(/\[data-id="other"\][^}]*order:\s*1/);
    // …the root's PADDING migrated into the master's mobile variant…
    expect(master).toMatch(/'variant-2':\s*\{[^}]*padding:\s*'13px'/);
    // …and the master did NOT get the placement order.
    expect(master).not.toMatch(/'variant-2':\s*\{[^}]*order/);
    // The page no longer carries the migrated padding for the extracted root.
    expect(result!.updatedPageCode).not.toMatch(/\[data-id="cta"\][^}]*padding:\s*13px/);
  });

  test('single-variant: placement overrides also survive for the instance', () => {
    mockFS.readFile.mockReturnValue(MEDIA_PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'cta', 'Cta');
    expect(result).not.toBeNull();
    expect(result!.updatedPageCode).toMatch(/\[data-id="cta"\][^}]*order:\s*10/);
  });
});

// ─── Root variant sizes mirror the RESOLVED AUTHORED value ───────────────────
// A root variant can only be PX or AUTO: authored px stays px, authored auto
// stays auto ('min-content'), fluid units (%/vh) freeze to the measured px.
// Tablet/mobile inheriting the primary's height:auto used to get the measured
// px frozen into variant-1/-2 while the default correctly kept min-content
// (user report 2026-07-28).
describe('makeComponent — root variant PX-or-AUTO sizing', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const VPS = [
    { vpWidth: 1440, width: 1440, height: 600 },
    { vpWidth: 768, width: 768, height: 537 },
    { vpWidth: 375, width: 375, height: 553 },
  ] as never;

  const pageWith = (rootStyle: string, media = '') => `import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
      ${media}
      <div data-id="cta" style={{ ${rootStyle} }}>
        <p data-id="cta-title">Get early access</p>
      </div>
    </div>
  );
}`;

  test('height AUTO inherited by every viewport → all variants min-content', () => {
    mockFS.readFile.mockReturnValue(pageWith(`position: 'relative', width: '100%', height: 'min-content', padding: '95px'`));
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'cta', 'Cta', true, VPS);
    expect(result).not.toBeNull();
    const master = getWrittenComponentCode();
    // All three resolve auto → the writer collapses the ternary to the plain value.
    expect(master).toMatch(/height: 'min-content'/);
    expect(master).not.toMatch(/height: initialVariant[^,]*537px/);
    expect(master).not.toMatch(/height: initialVariant[^,]*553px/);
    // Width '100%' is fluid → measured px per viewport (unchanged behaviour).
    expect(master).toMatch(/width: initialVariant === 'variant-1' \? '768px' : initialVariant === 'variant-2' \? '375px'/);
  });

  test('authored PX inherits as that px; a @media px override wins for its viewport', () => {
    const media = `<style>{\`
      @media (max-width: 768px) and (min-width: 375.02px) {
        [data-id="cta"] { height: 400px !important; }
      }
      \`}</style>`;
    mockFS.readFile.mockReturnValue(pageWith(`position: 'relative', width: '100%', height: '500px'`, media));
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'cta', 'Cta', true, VPS);
    expect(result).not.toBeNull();
    const master = getWrittenComponentCode();
    // tablet override 400px; mobile inherits the authored 500px (collapsed into
    // the else branch — the writer omits entries equal to the default).
    expect(master).toMatch(/height: initialVariant === 'variant-1' \? '400px' : '500px'/);
  });

  test('a fluid @media override (vh) freezes to the measured px', () => {
    const media = `<style>{\`
      @media (max-width: 375px) {
        [data-id="cta"] { height: 50vh !important; }
      }
      \`}</style>`;
    mockFS.readFile.mockReturnValue(pageWith(`position: 'relative', width: '100%', height: 'min-content', padding: '95px'`, media));
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'cta', 'Cta', true, VPS);
    expect(result).not.toBeNull();
    const master = getWrittenComponentCode();
    // tablet inherits auto (collapsed into the else); mobile's 50vh freezes to
    // the measured 553px.
    expect(master).toMatch(/height: initialVariant === 'variant-2' \? '553px' : 'min-content'/);
  });
});


// ─── Nested instance per-viewport variants → parent-variant ternary ──────────
// data-responsive keys on VIEWPORT WIDTH — inside a master the tiles are
// PARENT VARIANTS, so without the ternary the tablet/mobile tiles rendered
// the nested instance at its PRIMARY variant (user report 2026-07-28).
describe('bakeNestedInstanceVariantTernaries', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const VPS = [{ vpWidth: 1440 }, { vpWidth: 768 }, { vpWidth: 375 }];

  it('maps data-responsive picks into the parent-variant ternary', () => {
    const code = `<LeCeJo data-responsive='{"375":{"initialVariant":"variant-4"},"768":{"initialVariant":"variant-4"},"_bp":[375,768,1440]}' data-id="lc" style={{ order: '1', position: 'relative' }} />`;
    const out = bakeNestedInstanceVariantTernaries(code, VPS);
    expect(out).toContain("initialVariant={initialVariant === 'variant-1' ? 'variant-4' : initialVariant === 'variant-2' ? 'variant-4' : 'default'}");
    expect(out).toContain("data-responsive='"); // kept — the live site still resolves by breakpoint
  });

  it("an authored string initialVariant becomes the ternary's else branch", () => {
    const code = `<LeCeJo initialVariant="variant-2" data-responsive='{"375":{"initialVariant":"variant-4"},"_bp":[375,768,1440]}' data-id="lc" style={{ position: 'relative' }} />`;
    const out = bakeNestedInstanceVariantTernaries(code, VPS);
    expect(out).toContain("initialVariant={initialVariant === 'variant-2' ? 'variant-4' : 'variant-2'}");
    expect(out).not.toMatch(/initialVariant="variant-2"/);
  });

  it('no-ops when every pick equals the default, when already conditional, and for non-component tags', () => {
    const same = `<LeCeJo initialVariant="variant-4" data-responsive='{"375":{"initialVariant":"variant-4"},"768":{"initialVariant":"variant-4"},"_bp":[375,768,1440]}' data-id="lc" style={{ position: 'relative' }} />`;
    expect(bakeNestedInstanceVariantTernaries(same, VPS)).toBe(same);
    const cond = `<LeCeJo initialVariant={x ? 'a' : 'b'} data-responsive='{"375":{"initialVariant":"variant-4"}}' data-id="lc" />`;
    expect(bakeNestedInstanceVariantTernaries(cond, VPS)).toBe(cond);
    const plain = `<motion.div data-responsive='{"375":{"initialVariant":"variant-4"}}' data-id="d" />`;
    expect(bakeNestedInstanceVariantTernaries(plain, VPS)).toBe(plain);
  });

  it('multi-variant makeComponent emits the ternary end-to-end', () => {
    const PAGE = `import React from 'react';
import LeCeJo from '@/components/LeCeJo';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
      <div data-id="cta" style={{ position: 'relative', width: '100%', height: 'min-content' }}>
        <LeCeJo data-responsive='{"375":{"initialVariant":"variant-4"},"768":{"initialVariant":"variant-4"},"_bp":[375,768,1440]}' data-id="lc" data-name="Frame" style={{ order: '1', position: 'relative' }} />
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'cta', 'Cta', true, [
      { vpWidth: 1440, width: 1440, height: 600 },
      { vpWidth: 768, width: 768, height: 500 },
      { vpWidth: 375, width: 375, height: 400 },
    ] as never);
    expect(result).not.toBeNull();
    expect(getWrittenComponentCode()).toContain("initialVariant={initialVariant === 'variant-1' ? 'variant-4' : initialVariant === 'variant-2' ? 'variant-4' : 'default'}");
  });
});

// ─── Collection lists transfer wholesale into the master ─────────────────────
// The extracted section can CONTAIN entire `.map()` collection lists. The JSX
// carried fine, but the page's CMS data import (`import collection1 from
// '@/cms/collection-1.json'`) is referenced in EXPRESSIONS — not as a tag — so
// the import scan never carried it and the master's lists rendered EMPTY
// (undefined `collection1`; user report 2026-07-28).
describe('makeComponent — collection lists keep their CMS data import', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const BLOG_PAGE = `import React from 'react';
import Link from 'next/link';
import collection1 from '@/cms/collection-1.json';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
      <div data-id="blog-section" data-name="Recent Blog Section" style={{ position: 'relative', width: '100%', height: 'min-content', display: 'flex', flexDirection: 'column' }}>
        <div data-id="blogs" data-name="Blogs" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'row' }}>{collection1.slice(1).map((item, idx) => <Link data-cms-nav="row" href={\`/collection-1/\${item?._slug ?? ''}\`} data-id="item-1" key={idx} style={{ position: 'relative', display: 'flex' }} data-name="Blog">
          <h3 data-id="h3-1" data-name="Title" style={{ width: '100%', height: 'auto' }}>{item.title}</h3>
        </Link>)}</div>
      </div>
    </div>
  );
}`;

  test('the CMS import and the .map() survive into the master', () => {
    mockFS.readFile.mockReturnValue(BLOG_PAGE);
    mockFS.exists.mockReturnValue(false);
    const result = makeComponent('app/page.tsx', 'blog-section', 'Blog');
    expect(result).not.toBeNull();
    const master = getWrittenComponentCode();
    expect(master).toContain("import collection1 from '@/cms/collection-1.json'");
    expect(master).toContain('collection1.slice(1).map((item, idx)');
    expect(master).toContain('{item.title}');
  });

  test("a data-name containing an import's name never triggers a false carry", () => {
    const PAGE = `import React from 'react';
import Helper from '@/components/Helper';
export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <div data-id="sec" data-name="Helper Section" style={{ position: 'relative' }}>
        <p data-id="t">plain text</p>
      </div>
    </div>
  );
}`;
    mockFS.readFile.mockReturnValue(PAGE);
    mockFS.exists.mockReturnValue(false);
    makeComponent('app/page.tsx', 'sec', 'Sec');
    expect(getWrittenComponentCode()).not.toContain("import Helper");
  });
});
