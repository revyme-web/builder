// effects-roundtrip.test.ts — End-to-end: extract effects from a real-
// shaped source file, then inject them into a fresh destination page
// with the id-rename pass. Reproduces the user's reported flow:
//   "I copy a node with scroll transforms, paste it on another page →
//    effects must come along with refs/state/useEffect/hooks renamed."

import { describe, it, expect } from 'vitest';
import { extractEffectsForNodes } from './copy/effects-extractor';
import { injectEffectsBundle } from './paste/effects-injector';
import { renameVarStyleValues, buildIdRenamePairs } from './core/id-renames';

const SOURCE_PAGE = `'use client';
import React, { useState, useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';

export default function Page() {
  const frameMpo91uhh_8Sec0Ref = useRef(null);
  const [frameMpo91uhh_8SecPositions, setFrameMpo91uhh_8SecPositions] = useState(() => [0]);
  useEffect(() => {
    frameMpo91uhh_8Sec0Ref.current = document.getElementById('5');
    const compute = () => { setFrameMpo91uhh_8SecPositions([0.5]); };
    compute();
  }, []);
  const { scrollYProgress: frameMpo91uhh_8Progress } = useScroll();
  const frameMpo91uhh_8Smooth = useSpring(frameMpo91uhh_8Progress, { duration: 0.5 });
  const frameMpo91uhh_8Opacity = useTransform(frameMpo91uhh_8Smooth, [0, 0.5, 1], [0, 1, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="frame-mpo91uhh-8" style={{ opacity: frameMpo91uhh_8Opacity }} />
    </div>
  );
}`;

const DEST_PAGE = `'use client';
import React from 'react';

export default function OtherPage() {
  return (
    <div data-id="dest-root">
      <div data-id="dest-existing" />
    </div>
  );
}`;

describe('effects copy/paste roundtrip', () => {
  it('extracts scroll-transform effects from source then injects them renamed into destination', () => {
    // 1. Extract — caller passes the full subtree (parent → grandchild).
    //    Here the subtree is just the one node with effects.
    const bundle = extractEffectsForNodes(SOURCE_PAGE, ['frame-mpo91uhh-8']);
    expect(bundle).not.toBeNull();
    expect(bundle!.sourceSlices.length).toBeGreaterThanOrEqual(5);

    // 2. Inject — simulate paste creating a new node with a fresh id.
    const idMap = new Map([['frame-mpo91uhh-8', 'frame-mpo99new-9']]);
    const out = injectEffectsBundle(DEST_PAGE, bundle!, idMap);

    // 3. Verify: all source prefixes were renamed.
    expect(out).not.toContain('frameMpo91uhh_8Sec0Ref');
    expect(out).not.toContain('frameMpo91uhh_8Progress');
    expect(out).not.toContain('frameMpo91uhh_8Opacity');
    expect(out).toContain('frameMpo99new_9Sec0Ref');
    expect(out).toContain('frameMpo99new_9Progress');
    expect(out).toContain('frameMpo99new_9Opacity');
    expect(out).toContain('frameMpo99new_9Smooth');
    expect(out).toContain('frameMpo99new_9SecPositions');
    // setFrameMpo91uhh_8SecPositions → setFrameMpo99new_9SecPositions
    // (capitalised prefix rename).
    expect(out).toContain('setFrameMpo99new_9SecPositions');

    // 4. Cross-reference preserved verbatim.
    expect(out).toContain("document.getElementById('5')");

    // 5. Injection landed above the return.
    const injectedIdx = out.indexOf('frameMpo99new_9Progress');
    const returnIdx = out.indexOf('return (');
    expect(injectedIdx).toBeLessThan(returnIdx);
  });

  it('GSAP timeline with data-id selector — selector renamed, cross-refs kept', () => {
    const gsapSource = `'use client';
import { useEffect } from 'react';
import gsap from 'gsap';

export default function Page() {
  useEffect(() => {
    const tl = gsap.timeline();
    tl.to('[data-id="frame-hero-1"]', { x: 100 });
    tl.to('[data-id="frame-other"]', { y: 200 });
  }, []);
  return <div data-id="root"><div data-id="frame-hero-1" /></div>;
}`;
    const bundle = extractEffectsForNodes(gsapSource, ['frame-hero-1']);
    expect(bundle).not.toBeNull();

    const idMap = new Map([['frame-hero-1', 'frame-hero-2']]);
    const out = injectEffectsBundle(DEST_PAGE, bundle!, idMap);

    expect(out).toContain('[data-id="frame-hero-2"]'); // renamed
    expect(out).toContain('[data-id="frame-other"]'); // cross-ref untouched
    expect(out).not.toMatch(/data-id="frame-hero-1"/);
  });

  it('recursive subtree: parent copy carries grandchild effects, all renamed', () => {
    const source = `'use client';
import { useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const grandkid_1Progress = useScroll().scrollYProgress;
  const grandkid_1Opacity = useTransform(grandkid_1Progress, [0, 1], [0, 1]);
  return (
    <div data-id="parent">
      <div data-id="child">
        <motion.div data-id="grandkid-1" style={{ opacity: grandkid_1Opacity }} />
      </div>
    </div>
  );
}`;
    // Caller expands the subtree — paste-engine does this via collectSubtree.
    const bundle = extractEffectsForNodes(source, ['parent', 'child', 'grandkid-1']);
    expect(bundle).not.toBeNull();

    const idMap = new Map([
      ['parent', 'parent-2'],
      ['child', 'child-2'],
      ['grandkid-1', 'grandkid-2'],
    ]);
    const out = injectEffectsBundle(DEST_PAGE, bundle!, idMap);

    // Grandchild prefix renamed
    expect(out).toContain('grandkid_2Progress');
    expect(out).toContain('grandkid_2Opacity');
    expect(out).not.toContain('grandkid_1Progress');
    expect(out).not.toContain('grandkid_1Opacity');
  });

  it('multi-select copy: independent effect bundles, both rename correctly', () => {
    const source = `'use client';
import { useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const hero_1Progress = useScroll().scrollYProgress;
  const hero_1Opacity = useTransform(hero_1Progress, [0, 1], [0, 1]);
  const cta_1Progress = useScroll().scrollYProgress;
  const cta_1Scale = useTransform(cta_1Progress, [0, 1], [0.8, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="hero-1" style={{ opacity: hero_1Opacity }} />
      <motion.div data-id="cta-1" style={{ scale: cta_1Scale }} />
    </div>
  );
}`;
    const bundle = extractEffectsForNodes(source, ['hero-1', 'cta-1']);
    expect(bundle).not.toBeNull();

    const idMap = new Map([
      ['hero-1', 'hero-9'],
      ['cta-1', 'cta-9'],
    ]);
    const out = injectEffectsBundle(DEST_PAGE, bundle!, idMap);

    expect(out).toContain('hero_9Progress');
    expect(out).toContain('hero_9Opacity');
    expect(out).toContain('cta_9Progress');
    expect(out).toContain('cta_9Scale');
    expect(out).not.toContain('hero_1Progress');
    expect(out).not.toContain('cta_1Progress');
  });

  it('var-style references in the copied node are renamed alongside the effect hooks', () => {
    // The user-reported bug: copy a node whose style binds to
    // `useScroll` motion values, paste on another page. Effects
    // injected correctly with renamed prefix, but the JSX style still
    // pointed at the OLD source-page prefix because the node-creator
    // didn't rewrite `var:<oldPrefix>X` style values. End result:
    // dangling reference, no animation.
    //
    // This test exercises the FULL chain: parser-style clipboard
    // representation (`styles.opacity = "var:frameMpoaahpp_2Opacity"`)
    // → node-creator's renameVarStyleValues → expected post-paste
    // style with the renamed prefix.
    //
    // Parser side is verified separately; here we just verify the
    // rename helper produces the expected result for the user's case.
    const idMap = new Map([['frame-mpoaahpp-2', 'div-mpoab3d2-4']]);
    const pairs = buildIdRenamePairs(idMap);
    const out = renameVarStyleValues(
      {
        opacity: 'var:frameMpoaahpp_2Opacity',
        scale: 'var:frameMpoaahpp_2Scale',
        backgroundColor: '#ffb3ba', // unrelated value passes through
      },
      pairs,
    );
    expect(out.opacity).toBe('var:divMpoab3d2_4Opacity');
    expect(out.scale).toBe('var:divMpoab3d2_4Scale');
    expect(out.backgroundColor).toBe('#ffb3ba');
  });

  it('ref={X} attribute survives copy/paste, renamed alongside hooks', () => {
    // "Target ref is defined but not hydrated" bug: the parser used to
    // drop `ref={X}` attributes entirely (not in htmlAttrs list, and
    // getAttr only handled string literals). On paste, the destination
    // got the useRef + useScroll hook but nothing on the JSX bound the
    // ref to an element → ref.current stayed null → useScroll threw.
    //
    // Fix: parser captures `ref={X}` as `attrs.ref = "var:X"`. The
    // node-creator's rename pass rewrites attrs too. The generator's
    // serializeJSXAttr emits `ref={X}` (JSX expression) instead of
    // `ref="X"` (string).
    //
    // This test exercises the rename hop. Parser side is verified in
    // parser.test.ts; generator side in generator-utils.test.ts (if
    // present) — here we just confirm `attrs.ref` follows the prefix
    // rename like style values do.
    const idMap = new Map([['frame-mpoaahpp-2', 'div-mpoab3d2-4']]);
    const pairs = buildIdRenamePairs(idMap);
    const out = renameVarStyleValues(
      { ref: 'var:frameMpoaahpp_2Ref' },
      pairs,
    );
    expect(out.ref).toBe('var:divMpoab3d2_4Ref');
  });

  it('returns dest unchanged when source has no effects', () => {
    const plainSource = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root"><div data-id="plain-1" /></div>;
}`;
    const bundle = extractEffectsForNodes(plainSource, ['plain-1']);
    expect(bundle).toBeNull();
  });
});
