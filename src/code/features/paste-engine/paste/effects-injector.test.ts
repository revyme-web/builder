// effects-injector.test.ts — Verify injectEffectsBundle rewrites
// captured slices with the new IDs and splices them above the
// function's JSX `return` statement.

import { describe, it, expect } from 'vitest';
import { injectEffectsBundle } from './effects-injector';
import type { EffectsBundle } from '../types';

const DEST_PAGE_BASE = `'use client';
import React from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="dest-1" />
    </div>
  );
}`;

// ─── Var-prefix rename (scroll transforms) ──────────────────────────────────

describe('injectEffectsBundle — var-prefix rename', () => {
  // Use a node id that produces a `_<digit>`-suffixed prefix — that's
  // the convention the live generator actually emits (e.g.
  // `frame-mpo91uhh-8` → `frameMpo91uhh_8`). Tests that used `frame-a`
  // → `frameA` (no underscore) hid bugs where the rename regex
  // anchored on `_` boundaries.
  const SRC_ID = 'frame-mpo91uhh-8';
  const DST_ID = 'frame-mpo99new-9';
  const SRC_PREFIX = 'frameMpo91uhh_8';
  const DST_PREFIX = 'frameMpo99new_9';

  it('renames the owned-node var prefix and splices above the return', () => {
    const bundle: EffectsBundle = {
      sourceSlices: [
        `const ${SRC_PREFIX}Progress = useScroll().scrollYProgress;`,
        `const ${SRC_PREFIX}Opacity = useTransform(${SRC_PREFIX}Progress, [0, 1], [0, 1]);`,
      ],
      ownedNodeIds: [SRC_ID],
    };
    const idMap = new Map([[SRC_ID, DST_ID]]);
    const out = injectEffectsBundle(DEST_PAGE_BASE, bundle, idMap);

    expect(out).toContain(`${DST_PREFIX}Progress`);
    expect(out).toContain(`${DST_PREFIX}Opacity`);
    expect(out).not.toContain(`${SRC_PREFIX}Progress`);
    expect(out).not.toContain(`${SRC_PREFIX}Opacity`);

    // Injected ABOVE the return statement (return still present).
    const returnIdx = out.indexOf('return (');
    const injectedIdx = out.indexOf(`${DST_PREFIX}Progress`);
    expect(injectedIdx).toBeGreaterThan(-1);
    expect(injectedIdx).toBeLessThan(returnIdx);
  });

  it('does NOT rename references to nodes that are NOT in idMap (cross-refs)', () => {
    const bundle: EffectsBundle = {
      sourceSlices: [
        `${SRC_PREFIX}Sec0Ref.current = document.getElementById('5');`,
        `${SRC_PREFIX}Sec1Ref.current = document.getElementById('other-target');`,
      ],
      ownedNodeIds: [SRC_ID],
    };
    const idMap = new Map([[SRC_ID, DST_ID]]);
    const out = injectEffectsBundle(DEST_PAGE_BASE, bundle, idMap);

    expect(out).toContain("document.getElementById('5')");
    expect(out).toContain("document.getElementById('other-target')");
    expect(out).toContain(`${DST_PREFIX}Sec0Ref`);
    expect(out).toContain(`${DST_PREFIX}Sec1Ref`);
  });
});

// ─── Data-id literal rename (GSAP, scroll-path) ─────────────────────────────

describe('injectEffectsBundle — data-id literal rename', () => {
  it('rewrites data-id selector strings pointing at the copied node', () => {
    const bundle: EffectsBundle = {
      sourceSlices: [
        `useEffect(() => { gsap.to('[data-id="frame-hero-1"]', { x: 100 }); }, []);`,
      ],
      ownedNodeIds: ['frame-hero-1'],
    };
    const idMap = new Map([['frame-hero-1', 'frame-hero-1-pasted']]);
    const out = injectEffectsBundle(DEST_PAGE_BASE, bundle, idMap);

    expect(out).toContain('[data-id="frame-hero-1-pasted"]');
    // The original literal is replaced entirely — no `data-id="frame-hero-1"`
    // (without the `-pasted` suffix) should survive.
    expect(out).not.toMatch(/data-id="frame-hero-1"/);
  });

  it('leaves cross-reference data-id literals untouched', () => {
    const bundle: EffectsBundle = {
      sourceSlices: [
        `gsap.to('[data-id="frame-hero-1"]', { x: 100 });`,
        `gsap.to('[data-id="frame-other-target"]', { y: 200 });`,
      ],
      ownedNodeIds: ['frame-hero-1'], // 'frame-other-target' is NOT owned
    };
    const idMap = new Map([['frame-hero-1', 'frame-hero-2']]);
    const out = injectEffectsBundle(DEST_PAGE_BASE, bundle, idMap);

    expect(out).toContain('[data-id="frame-hero-2"]');
    expect(out).toContain('[data-id="frame-other-target"]'); // unchanged
  });
});

// ─── Splice location ────────────────────────────────────────────────────────

describe('injectEffectsBundle — splice location', () => {
  it('inserts right before the return statement, after any pre-existing decls', () => {
    const dest = `'use client';
import React, { useState } from 'react';

export default function Page() {
  const [count, setCount] = useState(0);
  return <div data-id="root" />;
}`;
    const bundle: EffectsBundle = {
      sourceSlices: [`const heroProgress = useScroll().scrollYProgress;`],
      ownedNodeIds: ['hero'],
    };
    const idMap = new Map([['hero', 'hero-2']]);
    const out = injectEffectsBundle(dest, bundle, idMap);

    // The pre-existing decl should still come first.
    const countIdx = out.indexOf('const [count, setCount]');
    const injectedIdx = out.indexOf('hero_2Progress');
    const returnIdx = out.indexOf('return <div');

    expect(countIdx).toBeGreaterThan(-1);
    expect(injectedIdx).toBeGreaterThan(countIdx);
    expect(injectedIdx).toBeLessThan(returnIdx);
  });

  it('returns destCode unchanged when there is no JSX-returning function', () => {
    const noJSX = `export function helper() { return 42; }`;
    const bundle: EffectsBundle = {
      sourceSlices: [`const x = 1;`],
      ownedNodeIds: ['a'],
    };
    const out = injectEffectsBundle(noJSX, bundle, new Map([['a', 'b']]));
    expect(out).toBe(noJSX);
  });

  it('returns destCode unchanged when the bundle is empty', () => {
    const bundle: EffectsBundle = { sourceSlices: [], ownedNodeIds: [] };
    const out = injectEffectsBundle(DEST_PAGE_BASE, bundle, new Map());
    expect(out).toBe(DEST_PAGE_BASE);
  });
});

// ─── Recursive / multi-id rename ────────────────────────────────────────────

describe('injectEffectsBundle — multi-id rename', () => {
  it('renames every owned-id occurrence with its respective new id', () => {
    const bundle: EffectsBundle = {
      sourceSlices: [
        `const heroOpacity = useTransform(progress, [0, 1], [0, 1]);`,
        `const ctaScale = useTransform(progress, [0, 1], [0.8, 1]);`,
        `gsap.to('[data-id="hero"]', { x: 100 });`,
        `gsap.to('[data-id="cta"]', { y: 200 });`,
      ],
      ownedNodeIds: ['hero', 'cta'],
    };
    const idMap = new Map([
      ['hero', 'hero-2'],
      ['cta', 'cta-2'],
    ]);
    const out = injectEffectsBundle(DEST_PAGE_BASE, bundle, idMap);

    expect(out).toContain('hero_2Opacity');
    expect(out).toContain('cta_2Scale');
    expect(out).toContain('[data-id="hero-2"]');
    expect(out).toContain('[data-id="cta-2"]');
    expect(out).not.toContain('[data-id="hero"]');
    expect(out).not.toContain('[data-id="cta"]');
  });
});
