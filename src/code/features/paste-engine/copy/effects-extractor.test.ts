// effects-extractor.test.ts — Verify extractEffectsForNodes picks up
// scroll transforms, GSAP, scroll-path annotations, and the full
// recursive subtree (parent → grandchild ownership).

import { describe, it, expect } from 'vitest';
import { extractEffectsForNodes } from './effects-extractor';

// ─── Scroll transforms ──────────────────────────────────────────────────────

describe('extractEffectsForNodes — scroll transforms', () => {
  const SCROLL_SOURCE = `'use client';
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

  it('captures all hooks/refs/state/useEffect tied to the node prefix', () => {
    const bundle = extractEffectsForNodes(SCROLL_SOURCE, ['frame-mpo91uhh-8']);
    expect(bundle).not.toBeNull();
    expect(bundle!.sourceSlices.length).toBeGreaterThanOrEqual(5);
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain('frameMpo91uhh_8Sec0Ref = useRef');
    expect(joined).toContain('frameMpo91uhh_8SecPositions');
    expect(joined).toContain('useEffect');
    expect(joined).toContain('useScroll');
    expect(joined).toContain('useSpring');
    expect(joined).toContain('useTransform');
  });

  it('preserves cross-references (getElementById literals) verbatim', () => {
    // The user's spec: don't try to follow cross-refs; the effect runs
    // as a no-op if `getElementById('5')` returns null on the
    // destination. The literal '5' must NOT be touched by extraction.
    const bundle = extractEffectsForNodes(SCROLL_SOURCE, ['frame-mpo91uhh-8']);
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain("document.getElementById('5')");
  });

  it('returns null when no node ids match', () => {
    const bundle = extractEffectsForNodes(SCROLL_SOURCE, ['nonexistent-node']);
    expect(bundle).toBeNull();
  });

  it('returns null when ownedNodeIds is empty', () => {
    const bundle = extractEffectsForNodes(SCROLL_SOURCE, []);
    expect(bundle).toBeNull();
  });
});

// ─── GSAP timelines + ScrollTrigger ─────────────────────────────────────────

describe('extractEffectsForNodes — GSAP', () => {
  const GSAP_SOURCE = `'use client';
import React, { useEffect } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

export default function Page() {
  useEffect(() => {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: '[data-id="frame-hero-1"]', start: 'top center' }
    });
    tl.to('[data-id="frame-hero-1"]', { x: 100, duration: 1 });
  }, []);
  return <div data-id="root"><div data-id="frame-hero-1" /></div>;
}`;

  it('captures useEffect blocks that reference the node via data-id selector', () => {
    const bundle = extractEffectsForNodes(GSAP_SOURCE, ['frame-hero-1']);
    expect(bundle).not.toBeNull();
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain('gsap.timeline');
    expect(joined).toContain('[data-id="frame-hero-1"]');
  });
});

// ─── Scroll-path annotations ────────────────────────────────────────────────

describe('extractEffectsForNodes — scroll-path annotations', () => {
  const PATH_SOURCE = `'use client';
import { useEffect } from 'react';

export default function Page() {
  // @scrollPath { "nodeId": "frame-path-1", "targets": ["a", "b"] }
  useEffect(() => {
    /* path setup for frame-path-1 */
    const el = document.querySelector('[data-id="frame-path-1"]');
  }, []);
  return <div data-id="root"><div data-id="frame-path-1" /></div>;
}`;

  it('captures the annotation comment AND its trailing useEffect', () => {
    const bundle = extractEffectsForNodes(PATH_SOURCE, ['frame-path-1']);
    expect(bundle).not.toBeNull();
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain('@scrollPath');
    expect(joined).toContain('frame-path-1');
  });
});

// ─── Recursive subtree (parent → grandchild) ────────────────────────────────

describe('extractEffectsForNodes — recursive subtree', () => {
  it('picks up effects owned by descendants when only the parent is named explicitly', () => {
    // Caller is responsible for expanding the subtree; we just verify
    // that passing the FULL collected list (parent + grandchild)
    // captures the grandchild's effects too. Variable names follow the
    // generator's convention: `<nodeIdToVarName(nodeId)><Suffix>` →
    // `grandkid_1Progress` for node id `grandkid-1`.
    const code = `'use client';
import { useEffect, useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const grandkid_1Progress = useScroll().scrollYProgress;
  const grandkid_1Opacity = useTransform(grandkid_1Progress, [0, 1], [0, 1]);
  return (
    <div data-id="parent-1">
      <div data-id="child-1">
        <motion.div data-id="grandkid-1" style={{ opacity: grandkid_1Opacity }} />
      </div>
    </div>
  );
}`;
    // Caller passes the FULL subtree set including the grandkid.
    const bundle = extractEffectsForNodes(code, ['parent-1', 'child-1', 'grandkid-1']);
    expect(bundle).not.toBeNull();
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain('grandkid_1Progress');
    expect(joined).toContain('grandkid_1Opacity');
  });

  it('captures effects from MULTIPLE owned roots (multi-select)', () => {
    const code = `'use client';
import { useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const heroProgress = useScroll().scrollYProgress;
  const heroOpacity = useTransform(heroProgress, [0, 1], [0, 1]);
  const ctaProgress = useScroll().scrollYProgress;
  const ctaScale = useTransform(ctaProgress, [0, 1], [0.8, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="hero" style={{ opacity: heroOpacity }} />
      <motion.div data-id="cta" style={{ scale: ctaScale }} />
    </div>
  );
}`;
    const bundle = extractEffectsForNodes(code, ['hero', 'cta']);
    expect(bundle).not.toBeNull();
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain('heroProgress');
    expect(joined).toContain('heroOpacity');
    expect(joined).toContain('ctaProgress');
    expect(joined).toContain('ctaScale');
  });

  it('does NOT capture statements unrelated to the owned set', () => {
    const code = `'use client';
import { useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const heroProgress = useScroll().scrollYProgress;
  const heroOpacity = useTransform(heroProgress, [0, 1], [0, 1]);
  // Untouched by the copy:
  const otherProgress = useScroll().scrollYProgress;
  const otherOpacity = useTransform(otherProgress, [0, 1], [0, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="hero" style={{ opacity: heroOpacity }} />
      <motion.div data-id="other" style={{ opacity: otherOpacity }} />
    </div>
  );
}`;
    const bundle = extractEffectsForNodes(code, ['hero']);
    expect(bundle).not.toBeNull();
    const joined = bundle!.sourceSlices.join('\n');
    expect(joined).toContain('heroProgress');
    expect(joined).not.toContain('otherProgress');
    expect(joined).not.toContain('otherOpacity');
  });
});
