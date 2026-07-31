// generator-motion.characterization.test.ts — golden-master characterization
// tests for the Phase 7.4 god-file split (oss-release-plan/phase-7-god-file-splits.md).
//
// These lock the CURRENT exact output strings of generator-motion's most-imported
// exports (inline snapshots captured from the pre-split implementation). The split
// moves code verbatim, so every snapshot must pass IDENTICALLY after the split.
import { describe, it, expect } from 'vitest';
import {
  formatTransitionObj,
  updateMotionConfigTransition,
  updateVariantEntryTransition,
  readTransitionVarRef,
  updateKeyframesInCode,
  removeKeyframesFromCode,
  updateMotionPropInCode,
  removeMotionPropFromCode,
  setMotionPropScopedValue,
  removeMotionPropScopeBranch,
  updateScrollAnimInCode,
  removeScrollAnimFromCode,
  updateScrollDirectionAnimInCode,
  removeScrollDirectionFromCode,
  updateScrollSpeedInCode,
  removeScrollSpeedFromCode,
  getSpeedResponsive,
  ensureMotionTag,
  getOpeningTag,
  hasAppearTransformConflict,
  dedupeAppearHooks,
  composeAllScrollAppearConflicts,
  decomposeAllScrollConflicts,
  setLoopInCode,
  hasLoopConflict,
  composeLoopInCode,
  decomposeLoopInCode,
  buildScrollFxSpec,
  getScrollFx,
  setScrollFxInCode,
  clearNodeScrollFx,
  dormantizeScrollFx,
  rehydrateScrollFx,
  type ScrollAnimConfig,
} from './generator-motion';

// ─── fixtures (modeled on the builder's emitted-code shapes) ─────────────────

const PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} />
      <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
    </div>
  );
}`;

const COMPONENT = `/** @name "Card" */
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const cardRootVariants = {
  default: { backgroundColor: '#111111' },
  'variant-1': { backgroundColor: '#222222', transition: { duration: 0.4 } },
};

function KoRaMe({ style, initialVariant = 'default', ...rest }) {
  const variant = initialVariant;
  return (
    <LayoutGroup>
      <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
        <motion.p data-id="card-title" data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(KoRaMe);`;

const KF_PAGE = `'use client';
import React from 'react';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <style>{\`
        @keyframes fadeUp {
          0% { opacity: 0; transform: translateY(20px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      \`}</style>
      <div data-id="hero" style={{ animationName: 'fadeUp', animationDuration: '1s' }} />
    </div>
  );
}`;

// the reference "Appear" (initial + whileInView + viewport once) on frame-x.
const appearOn = (code: string): string => {
  let c = updateMotionPropInCode(code, 'frame-x', 'initial', { opacity: '0', y: '40' });
  c = updateMotionPropInCode(c, 'frame-x', 'whileInView', { opacity: '1', y: '0' });
  c = updateMotionPropInCode(c, 'frame-x', 'viewport', { once: 'true' });
  return c;
};

const SCROLL_CFG: ScrollAnimConfig = {
  nodeId: 'frame-x',
  trigger: 'onScroll',
  stops: [
    { progress: 0, props: { y: '0px', opacity: '1' } },
    { progress: 1, props: { y: '-120px', opacity: '0.2' } },
  ],
} as ScrollAnimConfig;

// The compose wrapper the mutation queue uses around every scroll-fx write.
const A = (c: string, fn: (x: string) => string) =>
  composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(c)));

// A node carrying hover + tap + direction + transform + speed (the
// scroll-fx-spec shape the editor produces).
function rich(): string {
  let code = A(PAGE, (c) => updateMotionPropInCode(c, 'frame-x', 'whileHover', { scale: '1.05' }));
  code = A(code, (c) => updateMotionPropInCode(c, 'frame-x', 'whileTap', { scale: '0.95' }));
  code = A(code, (c) => updateScrollDirectionAnimInCode(c, { nodeId: 'frame-x', toProps: { opacity: '0' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5' } }));
  code = A(code, (c) => updateScrollAnimInCode(c, SCROLL_CFG));
  code = A(code, (c) => updateScrollSpeedInCode(c, { nodeId: 'frame-x', speed: 110 }));
  return code;
}

// ─── transition writers ───────────────────────────────────────────────────────

describe('characterization: transition writers', () => {
  it('formatTransitionObj — spring physics config', () => {
    expect(formatTransitionObj({ type: 'spring', stiffness: '170', damping: '26', mass: '1' }))
      .toMatchInlineSnapshot(`"{ type: 'spring', stiffness: 170, damping: 26, mass: 1 }"`);
  });

  it('formatTransitionObj — tween with duration/ease', () => {
    expect(formatTransitionObj({ type: 'tween', duration: '0.5', ease: 'easeOut' }))
      .toMatchInlineSnapshot(`"{ type: 'tween', duration: 0.5, ease: 'easeOut' }"`);
  });

  it('updateMotionConfigTransition — wraps the LayoutGroup contents in MotionConfig', () => {
    expect(updateMotionConfigTransition(COMPONENT, { type: 'spring', stiffness: '170', damping: '26' }))
      .toMatchInlineSnapshot(`
        "/** @name "Card" */
        import { motion, MotionConfig, LayoutGroup } from 'framer-motion';
        import { withResponsiveProps } from '@revyme/runtime';

        const cardRootVariants = {
          default: { backgroundColor: '#111111' },
          'variant-1': { backgroundColor: '#222222', transition: { duration: 0.4 } },
        };

        function KoRaMe({ style, initialVariant = 'default', ...rest }) {
          const variant = initialVariant;
          return (
            <LayoutGroup>
              <MotionConfig transition={{ type: 'spring', stiffness: 170, damping: 26 }}>
              <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
                <motion.p data-id="card-title" data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
              </motion.div>
            </MotionConfig>
            </LayoutGroup>
          );
        }

        export default withResponsiveProps(KoRaMe);"
      `);
  });

  it('updateMotionConfigTransition — updates an existing wrapper, then removes it', () => {
    const wrapped = updateMotionConfigTransition(COMPONENT, { type: 'spring', stiffness: '170', damping: '26' });
    const updated = updateMotionConfigTransition(wrapped, { type: 'tween', duration: '0.8' });
    expect(updated).toMatchInlineSnapshot(`
      "/** @name "Card" */
      import { motion, MotionConfig, LayoutGroup } from 'framer-motion';
      import { withResponsiveProps } from '@revyme/runtime';

      const cardRootVariants = {
        default: { backgroundColor: '#111111' },
        'variant-1': { backgroundColor: '#222222', transition: { duration: 0.4 } },
      };

      function KoRaMe({ style, initialVariant = 'default', ...rest }) {
        const variant = initialVariant;
        return (
          <LayoutGroup>
            <MotionConfig transition={{ type: 'tween', duration: 0.8 }}>
            <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
              <motion.p data-id="card-title" data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
            </motion.div>
          </MotionConfig>
          </LayoutGroup>
        );
      }

      export default withResponsiveProps(KoRaMe);"
    `);
    expect(updateMotionConfigTransition(updated, null)).toMatchInlineSnapshot(`
      "/** @name "Card" */
      import { motion, MotionConfig, LayoutGroup } from 'framer-motion';
      import { withResponsiveProps } from '@revyme/runtime';

      const cardRootVariants = {
        default: { backgroundColor: '#111111' },
        'variant-1': { backgroundColor: '#222222', transition: { duration: 0.4 } },
      };

      function KoRaMe({ style, initialVariant = 'default', ...rest }) {
        const variant = initialVariant;
        return (
          <LayoutGroup>

            <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
              <motion.p data-id="card-title" data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
            </motion.div>

          </LayoutGroup>
        );
      }

      export default withResponsiveProps(KoRaMe);"
    `);
  });

  it('updateVariantEntryTransition — replaces the transition inside an existing variant entry', () => {
    expect(updateVariantEntryTransition(COMPONENT, 'card-root', 'variant-1', { type: 'spring', duration: '0.6', bounce: '0.3' }))
      .toMatchInlineSnapshot(`
        "/** @name "Card" */
        import { motion, LayoutGroup } from 'framer-motion';
        import { withResponsiveProps } from '@revyme/runtime';

        const cardRootVariants = {
          default: { backgroundColor: '#111111' },
          'variant-1': { backgroundColor: '#222222', transition: { type: 'spring', duration: 0.6, bounce: 0.3 },},
        };

        function KoRaMe({ style, initialVariant = 'default', ...rest }) {
          const variant = initialVariant;
          return (
            <LayoutGroup>
              <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
                <motion.p data-id="card-title" data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
              </motion.div>
            </LayoutGroup>
          );
        }

        export default withResponsiveProps(KoRaMe);"
      `);
  });

  it('updateVariantEntryTransition — auto-creates the variants const when the node has none', () => {
    expect(updateVariantEntryTransition(COMPONENT, 'card-title', 'variant-1', { type: 'tween', duration: '0.25' }))
      .toMatchInlineSnapshot(`
        "/** @name "Card" */
        import { motion, LayoutGroup } from 'framer-motion';
        import { withResponsiveProps } from '@revyme/runtime';

        const cardRootVariants = {
          default: { backgroundColor: '#111111' },
          'variant-1': { backgroundColor: '#222222', transition: { duration: 0.4 } },
        };

        const cardTitleVariants = {
          default: {},
          'variant-1': { transition: { type: 'tween', duration: 0.25 },},
        };

        function KoRaMe({ style, initialVariant = 'default', ...rest }) {
          const variant = initialVariant;
          return (
            <LayoutGroup>
              <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
                <motion.p data-id="card-title" variants={cardTitleVariants} data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
              </motion.div>
            </LayoutGroup>
          );
        }

        export default withResponsiveProps(KoRaMe);"
      `);
  });

  it('updateVariantEntryTransition — null strips the entry transition', () => {
    expect(updateVariantEntryTransition(COMPONENT, 'card-root', 'variant-1', null))
      .toMatchInlineSnapshot(`
        "/** @name "Card" */
        import { motion, LayoutGroup } from 'framer-motion';
        import { withResponsiveProps } from '@revyme/runtime';

        const cardRootVariants = {
          default: { backgroundColor: '#111111' },
          'variant-1': { backgroundColor: '#222222'},
        };

        function KoRaMe({ style, initialVariant = 'default', ...rest }) {
          const variant = initialVariant;
          return (
            <LayoutGroup>
              <motion.div data-id="card-root" data-name="Card" variants={cardRootVariants} animate={variant} initial={initialVariant} layout={true} style={{ position: 'relative', width: '320px', height: '180px', ...style }}>
                <motion.p data-id="card-title" data-name="Title" layout={true} style={{ fontSize: '18px' }}>Title</motion.p>
              </motion.div>
            </LayoutGroup>
          );
        }

        export default withResponsiveProps(KoRaMe);"
      `);
  });

  it('readTransitionVarRef — reads a variable-bound MotionConfig transition', () => {
    const varBound = updateMotionConfigTransition(COMPONENT, null, 'brandSpring');
    expect(readTransitionVarRef(varBound, 'card-root', 'motionConfig')).toMatchInlineSnapshot(`"brandSpring"`);
  });
});

// ─── keyframes ────────────────────────────────────────────────────────────────

describe('characterization: keyframes manipulation', () => {
  it('updateKeyframesInCode — rewrites an existing @keyframes block', () => {
    expect(updateKeyframesInCode(KF_PAGE, 'fadeUp', `@keyframes fadeUp {
  0% { opacity: 0; transform: translateY(60px); }
  100% { opacity: 1; transform: translateY(0); }
}`)).toMatchInlineSnapshot(`
  "'use client';
  import React from 'react';

  export default function Page() {
    return (
      <div data-id="root" style={{ position: 'relative', width: '100%' }}>
        <style>{\`
          @keyframes fadeUp {
    0% { opacity: 0; transform: translateY(60px); }
    100% { opacity: 1; transform: translateY(0); }
  }
        \`}</style>
        <div data-id="hero" style={{ animationName: 'fadeUp', animationDuration: '1s' }} />
      </div>
    );
  }"
`);
  });

  it('updateKeyframesInCode — appends a new @keyframes block', () => {
    expect(updateKeyframesInCode(KF_PAGE, 'spinPulse', `@keyframes spinPulse {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}`)).toMatchInlineSnapshot(`
  "'use client';
  import React from 'react';

  export default function Page() {
    return (
      <div data-id="root" style={{ position: 'relative', width: '100%' }}>
        <style>{\`
          @keyframes fadeUp {
            0% { opacity: 0; transform: translateY(20px); }
            100% { opacity: 1; transform: translateY(0); }
          }
  @keyframes spinPulse {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
        \`}</style>
        <div data-id="hero" style={{ animationName: 'fadeUp', animationDuration: '1s' }} />
      </div>
    );
  }"
`);
  });

  it('removeKeyframesFromCode — deletes the named block', () => {
    expect(removeKeyframesFromCode(KF_PAGE, 'fadeUp')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';

      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <style>{\`
            \`}</style>
            <div data-id="hero" style={{ animationName: 'fadeUp', animationDuration: '1s' }} />
          </div>
        );
      }"
    `);
  });
});

// ─── motion motion props ─────────────────────────────────────────────────────

describe('characterization: motion prop writes', () => {
  it('updateMotionPropInCode — adds whileHover to a motion.div', () => {
    expect(updateMotionPropInCode(PAGE, 'frame-x', 'whileHover', { scale: '1.1', rotate: '3' }))
      .toMatchInlineSnapshot(`
        "'use client';
        import React from 'react';
        import { motion } from 'framer-motion';

        export default function Page() {
          return (
            <div data-id="root" style={{ position: 'relative', width: '100%' }}>
              <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                  whileHover={{ scale: 1.1, rotate: 3 }}
                  />
              <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
            </div>
          );
        }"
      `);
  });

  it('updateMotionPropInCode — converts a plain div to motion.div first', () => {
    expect(updateMotionPropInCode(PAGE, 'plain-y', 'whileTap', { scale: '0.9' }))
      .toMatchInlineSnapshot(`
        "'use client';
        import React from 'react';
        import { motion } from 'framer-motion';

        export default function Page() {
          return (
            <div data-id="root" style={{ position: 'relative', width: '100%' }}>
              <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} />
              <motion.div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} 
                  whileTap={{ scale: 0.9 }}
                  />
            </div>
          );
        }"
      `);
  });

  it('updateMotionPropInCode — updates props inside an existing prop object', () => {
    const withHover = updateMotionPropInCode(PAGE, 'frame-x', 'whileHover', { scale: '1.1' });
    expect(updateMotionPropInCode(withHover, 'frame-x', 'whileHover', { scale: '1.25', opacity: '0.8' }))
      .toMatchInlineSnapshot(`
        "'use client';
        import React from 'react';
        import { motion } from 'framer-motion';

        export default function Page() {
          return (
            <div data-id="root" style={{ position: 'relative', width: '100%' }}>
              <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                  whileHover={{ scale: 1.25, opacity: 0.8 }}
                  />
              <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
            </div>
          );
        }"
      `);
  });

  it('removeMotionPropFromCode — strips the attribute', () => {
    const withHover = updateMotionPropInCode(PAGE, 'frame-x', 'whileHover', { scale: '1.1' });
    expect(removeMotionPropFromCode(withHover, 'frame-x', 'whileHover')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('setMotionPropScopedValue — base write (scope null), then a viewport branch', () => {
    const base = setMotionPropScopedValue(PAGE, 'frame-x', 'whileHover', { scale: '1.1' }, null);
    expect(base).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                whileHover={{ scale: 1.1 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
    const scoped = setMotionPropScopedValue(base, 'frame-x', 'whileHover', { scale: '1.3' }, { query: '(max-width: 768px)' });
    expect(scoped).toMatchInlineSnapshot(`
      "'use client';
      import React, { useState, useEffect } from 'react';
      import { motion } from 'framer-motion';
      function useMediaQuery(query: string): boolean {
        // Lazy initializer reads the REAL match on the first client render (not just
        // after a post-mount effect). Critical for framer-motion's \`initial\` (Appear),
        // which is captured ONCE at mount — a useState(false) start would make the
        // responsive branch lose to the base on every page load. (On the server there's
        // no window → false; the client corrects on mount.)
        const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
        useEffect(() => {
          const mql = window.matchMedia(query);
          setMatches(mql.matches);
          const on = () => setMatches(mql.matches);
          mql.addEventListener('change', on);
          return () => mql.removeEventListener('change', on);
        }, [query]);
        return matches;
      }


      export default function Page() {
        const __mq0 = useMediaQuery('(max-width: 768px)');
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                whileHover={__mq0 ? { scale: 1.3 } : { scale: 1.1 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('removeMotionPropScopeBranch — deletes only the scoped branch, keeping the base', () => {
    const base = setMotionPropScopedValue(PAGE, 'frame-x', 'whileHover', { scale: '1.1' }, null);
    const scoped = setMotionPropScopedValue(base, 'frame-x', 'whileHover', { scale: '1.3' }, { query: '(max-width: 768px)' });
    expect(removeMotionPropScopeBranch(scoped, 'frame-x', 'whileHover', { query: '(max-width: 768px)' }))
      .toMatchInlineSnapshot(`
        "'use client';
        import React, { useState, useEffect } from 'react';
        import { motion } from 'framer-motion';
        function useMediaQuery(query: string): boolean {
          // Lazy initializer reads the REAL match on the first client render (not just
          // after a post-mount effect). Critical for framer-motion's \`initial\` (Appear),
          // which is captured ONCE at mount — a useState(false) start would make the
          // responsive branch lose to the base on every page load. (On the server there's
          // no window → false; the client corrects on mount.)
          const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
          useEffect(() => {
            const mql = window.matchMedia(query);
            setMatches(mql.matches);
            const on = () => setMatches(mql.matches);
            mql.addEventListener('change', on);
            return () => mql.removeEventListener('change', on);
          }, [query]);
          return matches;
        }


        export default function Page() {
          const __mq0 = useMediaQuery('(max-width: 768px)');
            return (
            <div data-id="root" style={{ position: 'relative', width: '100%' }}>
              <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                  whileHover={{ scale: 1.1 }}
                  />
              <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
            </div>
          );
        }"
      `);
  });
});

// ─── scroll-linked animation ─────────────────────────────────────────────────

describe('characterization: scroll-linked animation', () => {
  it('updateScrollAnimInCode — onScroll trigger writes hooks + style bindings', () => {
    expect(updateScrollAnimInCode(PAGE, SCROLL_CFG)).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion, useScroll, useTransform } from 'framer-motion';

      export default function Page() {
        const { scrollYProgress: frameXProgress } = useScroll();
        const frameXY = useTransform(frameXProgress, [0, 1], ["0px", "-120px"]);
        const frameXOpacity = useTransform(frameXProgress, [0, 1], [1, 0.2]);
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', y: frameXY, opacity: frameXOpacity}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('updateScrollAnimInCode — layerInView trigger (element-target ref)', () => {
    const cfg: ScrollAnimConfig = {
      nodeId: 'frame-x',
      trigger: 'layerInView',
      stops: [
        { progress: 0, props: { scale: '0.8' } },
        { progress: 1, props: { scale: '1' } },
      ],
    } as ScrollAnimConfig;
    expect(updateScrollAnimInCode(PAGE, cfg)).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion, useScroll, useTransform } from 'framer-motion';

      export default function Page() {
        const frameXRef = useRef(null);
        const { scrollYProgress: frameXProgress } = useScroll({ target: frameXRef, offset: ["start end", "end end"] });
        const frameXScale = useTransform(frameXProgress, [0, 1], [0.8, 1]);
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div ref={frameXRef} data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', scale: frameXScale}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('removeScrollAnimFromCode — removes the hooks and bindings again', () => {
    const withAnim = updateScrollAnimInCode(PAGE, SCROLL_CFG);
    expect(removeScrollAnimFromCode(withAnim, 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion, useScroll, useTransform } from 'framer-motion';

      export default function Page() {
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000'}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('updateScrollDirectionAnimInCode — direction-triggered (the reference "On Scroll")', () => {
    expect(updateScrollDirectionAnimInCode(PAGE, { nodeId: 'frame-x', toProps: { opacity: '0', y: '-30' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5' } }))
      .toMatchInlineSnapshot(`
        "'use client';
        import React from 'react';
        import { motion } from 'framer-motion';

        export default function Page() {
          const [frameXScrolled, setFrameXScrolled] = useState(false);
          const { scrollY: frameXScrollY } = useScroll();
          useMotionValueEvent(frameXScrollY, "change", (y) => {
            const prev = frameXScrollY.getPrevious() ?? 0;
            if (y > prev) setFrameXScrolled(true); else if (y < prev) setFrameXScrolled(false);
          });
            return (
            <div data-id="root" style={{ position: 'relative', width: '100%' }}>
              <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                  animate={frameXScrolled ? { opacity: 0, y: -30 } : { opacity: 1, y: 0 }}
                  transition={{ type: 'spring', duration: 0.5 }}
                  />
              <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
            </div>
          );
        }"
      `);
  });

  it('removeScrollDirectionFromCode — strips the direction wiring', () => {
    const withDir = updateScrollDirectionAnimInCode(PAGE, { nodeId: 'frame-x', toProps: { opacity: '0' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5' } });
    expect(removeScrollDirectionFromCode(withDir, 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }}
                transition={{ type: 'spring', duration: 0.5 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('updateScrollSpeedInCode + getSpeedResponsive + removeScrollSpeedFromCode', () => {
    const withSpeed = updateScrollSpeedInCode(PAGE, { nodeId: 'frame-x', speed: 110 });
    expect(withSpeed).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        const { scrollY: frameXSpeedScroll } = useScroll();
        const frameXSpeedY = useTransform(frameXSpeedScroll, (v) => v * (1 - 110 / 100));
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', y: frameXSpeedY}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
    expect(JSON.stringify(getSpeedResponsive(withSpeed, 'frame-x'))).toMatchInlineSnapshot(`"{"base":110,"responsive":[]}"`);
    expect(removeScrollSpeedFromCode(withSpeed, 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000'}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });
});

// ─── compose (appear × scroll × gestures) ────────────────────────────────────

describe('characterization: conflict compose/decompose', () => {
  it('hasAppearTransformConflict — appear y + scroll transform y on the same node', () => {
    const conflicted = updateScrollAnimInCode(appearOn(PAGE), SCROLL_CFG);
    expect(hasAppearTransformConflict(conflicted, 'frame-x')).toBe(true);
  });

  it('composeAllScrollAppearConflicts — folds the appear into effect-form hooks', () => {
    const conflicted = updateScrollAnimInCode(appearOn(PAGE), SCROLL_CFG);
    expect(composeAllScrollAppearConflicts(conflicted)).toMatchInlineSnapshot(`
      "'use client';
      import React, { useRef , useEffect} from 'react';
      import { motion, useScroll, useTransform , useInView, useMotionValue, animate} from 'framer-motion';

      export default function Page() {
        const { scrollYProgress: frameXProgress } = useScroll();
        const frameXY = useTransform(frameXProgress, [0, 1], ["0px", "-120px"]);
        const frameXOpacity = useTransform(frameXProgress, [0, 1], [1, 0.2]);
        const frameXRef = useRef(null);
        const frameXInView = useInView(frameXRef, { once: true });
        const frameXAppear = useMotionValue(0);
        useEffect(() => { if (frameXInView) { const _c = animate(frameXAppear, 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); } }, [frameXInView]);
        const frameXOpacityC = useTransform([frameXAppear, frameXOpacity], ([a, t]) => a * t);
        const frameXYC = useTransform([frameXAppear, frameXY], ([a, t]) => a * t);
            return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"40"},"once":true},"transform":{"trigger":"onScroll","from":{"y":"0px","opacity":"1"},"to":{"y":"-120px","opacity":"0.2"}}}' ref={frameXRef} data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', opacity: frameXOpacityC, y: frameXYC}}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('decomposeAllScrollConflicts — restores the declarative form (round-trip)', () => {
    const conflicted = updateScrollAnimInCode(appearOn(PAGE), SCROLL_CFG);
    const composed = composeAllScrollAppearConflicts(conflicted);
    expect(decomposeAllScrollConflicts(composed)).toMatchInlineSnapshot(`
      "'use client';
      import React, { useRef , useEffect} from 'react';
      import { motion, useScroll, useTransform , useInView, useMotionValue, animate} from 'framer-motion';

      export default function Page() {
        const { scrollYProgress: frameXProgress } = useScroll();
        const frameXY = useTransform(frameXProgress, [0, 1], ["0px", "-120px"]);
        const frameXOpacity = useTransform(frameXProgress, [0, 1], [1, 0.2]);
            return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', opacity: frameXOpacity, y: frameXY}}
                
                initial={{ opacity: 0, y: 0 }}
                whileInView={{ opacity: 1, y: 1 }}
                viewport={{ once: true }}
                transition={{ type: 'spring', duration: 0.5, bounce: 0.25 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('dedupeAppearHooks — collapses doubled appear effect hooks', () => {
    const conflicted = updateScrollAnimInCode(appearOn(PAGE), SCROLL_CFG);
    const composed = composeAllScrollAppearConflicts(conflicted);
    expect(dedupeAppearHooks(composed)).toMatchInlineSnapshot(`
      "'use client';
      import React, { useRef , useEffect} from 'react';
      import { motion, useScroll, useTransform , useInView, useMotionValue, animate} from 'framer-motion';

      export default function Page() {
        const { scrollYProgress: frameXProgress } = useScroll();
        const frameXY = useTransform(frameXProgress, [0, 1], ["0px", "-120px"]);
        const frameXOpacity = useTransform(frameXProgress, [0, 1], [1, 0.2]);
        const frameXRef = useRef(null);
        const frameXInView = useInView(frameXRef, { once: true });
        const frameXAppear = useMotionValue(0);
        useEffect(() => { if (frameXInView) { const _c = animate(frameXAppear, 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); } }, [frameXInView]);
        const frameXOpacityC = useTransform([frameXAppear, frameXOpacity], ([a, t]) => a * t);
        const frameXYC = useTransform([frameXAppear, frameXY], ([a, t]) => a * t);
            return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"40"},"once":true},"transform":{"trigger":"onScroll","from":{"y":"0px","opacity":"1"},"to":{"y":"-120px","opacity":"0.2"}}}' ref={frameXRef} data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', opacity: frameXOpacityC, y: frameXYC}}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });
});

// ─── loop ─────────────────────────────────────────────────────────────────────

describe('characterization: loop compose', () => {
  const LOOP_SPEC = { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' } };

  it('setLoopInCode — writes the data-loop carrier attribute', () => {
    expect(setLoopInCode(PAGE, 'frame-x', LOOP_SPEC)).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-loop='{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity","ease":"linear"}}' data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('hasLoopConflict + composeLoopInCode — folds the loop into motion values', () => {
    const withLoop = setLoopInCode(PAGE, 'frame-x', LOOP_SPEC);
    expect(hasLoopConflict(withLoop, 'frame-x')).toMatchInlineSnapshot(`true`);
    expect(composeLoopInCode(withLoop, 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        const frameXRef = useRef(null);
        const frameXLoopInView = useInView(frameXRef);
        const frameXLoopRotate = useMotionValue(0);
        useEffect(() => { if (frameXLoopInView) { const _c = animate(frameXLoopRotate, 360, { duration: 2, repeat: Infinity, ease: 'linear' }); return () => _c.stop(); } }, [frameXLoopInView]);
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div ref={frameXRef} data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', rotate: frameXLoopRotate}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('decomposeLoopInCode — restores the carrier-only form (round-trip)', () => {
    const withLoop = setLoopInCode(PAGE, 'frame-x', LOOP_SPEC);
    const composed = composeLoopInCode(withLoop, 'frame-x');
    expect(decomposeLoopInCode(composed, 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        const frameXRef = useRef(null);
          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-loop='{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity","ease":"linear"}}' ref={frameXRef} data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000'}} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('setLoopInCode — null removes the carrier', () => {
    const withLoop = setLoopInCode(PAGE, 'frame-x', LOOP_SPEC);
    expect(setLoopInCode(withLoop, 'frame-x', null)).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });
});

// ─── spec-driven scroll-fx ───────────────────────────────────────────────────

describe('characterization: spec-driven scroll-fx', () => {
  it('buildScrollFxSpec — captures every effect on the node as a spec', () => {
    expect(JSON.stringify(buildScrollFxSpec(rich(), 'frame-x'), null, 2)).toMatchInlineSnapshot(`
      "{
        "speed": 110,
        "animation": {
          "direction": "down",
          "replay": true,
          "toProps": {},
          "transition": {}
        },
        "hover": {
          "props": {
            "scale": "1.05"
          }
        },
        "tap": {
          "props": {
            "scale": "0.95"
          }
        }
      }"
    `);
  });

  it('getScrollFx — reads the stamped data-scroll-fx spec back', () => {
    expect(JSON.stringify(getScrollFx(rich(), 'frame-x'), null, 2)).toMatchInlineSnapshot(`
      "{
        "transform": {
          "trigger": "onScroll",
          "from": {
            "opacity": "1"
          },
          "to": {
            "opacity": "0.2"
          }
        },
        "speed": 110,
        "animation": {
          "direction": "down",
          "replay": true,
          "toProps": {
            "opacity": "0"
          },
          "transition": {
            "type": "spring",
            "duration": "0.5"
          }
        },
        "hover": {
          "props": {
            "scale": "1.05"
          }
        },
        "tap": {
          "props": {
            "scale": "0.95"
          }
        }
      }"
    `);
  });

  it('clearNodeScrollFx — removes every effect + hook for the node', () => {
    expect(clearNodeScrollFx(rich(), 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React, { useEffect } from 'react';
      import { motion, useScroll, useTransform , useMotionValue, animate} from 'framer-motion';

      export default function Page() {
                  return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-scroll-fx='{"transform":{"trigger":"onScroll","from":{"opacity":"1"},"to":{"opacity":"0.2"}},"speed":110,"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"},"transition":{"type":"spring","duration":"0.5"}},"hover":{"props":{"scale":"1.05"}},"tap":{"props":{"scale":"0.95"}}}' data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} 
                whileHover={{ scale: 1.05 }}
                
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', duration: 0.5 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('setScrollFxInCode — regenerates all effects from the spec onto a clean node', () => {
    const code = rich();
    const spec = getScrollFx(code, 'frame-x');
    const cleared = clearNodeScrollFx(code, 'frame-x');
    expect(setScrollFxInCode(cleared, 'frame-x', spec)).toMatchInlineSnapshot(`
      "'use client';
      import React, { useEffect } from 'react';
      import { motion, useScroll, useTransform, useMotionValue, animate } from 'framer-motion';

      export default function Page() {
        const [frameXScrolled, setFrameXScrolled] = useState(false);
        const { scrollY: frameXScrollY } = useScroll();
        useMotionValueEvent(frameXScrollY, "change", (y) => {
          const prev = frameXScrollY.getPrevious() ?? 0;
          if (y > prev) setFrameXScrolled(true); else if (y < prev) setFrameXScrolled(false);
        });
        const { scrollYProgress: frameXProgress } = useScroll();
        const frameXOpacity = useTransform(frameXProgress, [0, 1], [1, 0.2]);
        const { scrollY: frameXSpeedScroll } = useScroll();
        const frameXSpeedY = useTransform(frameXSpeedScroll, (v) => v * (1 - 110 / 100));
        const frameXAnimOpacity = useMotionValue(1);
        useEffect(() => { const _c = animate(frameXAnimOpacity, frameXScrolled ? 0 : 1, { type: 'spring', duration: 0.5 }); return () => _c.stop(); }, [frameXScrolled]);
        const frameXOpacityDC = useTransform([frameXAnimOpacity, frameXOpacity], ([a, t]) => a * t);
                          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-scroll-fx='{"transform":{"trigger":"onScroll","from":{"opacity":"1"},"to":{"opacity":"0.2"}},"speed":110,"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"},"transition":{"type":"spring","duration":"0.5"}},"hover":{"props":{"scale":"1.05"}},"tap":{"props":{"scale":"0.95"}}}' data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', y: frameXSpeedY, opacity: frameXOpacityDC}}
                
                whileHover={{ scale: 1.05 }}
                
                whileTap={{ scale: 0.95 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('dormantizeScrollFx + rehydrateScrollFx — park and restore', () => {
    const code = rich();
    const dormant = dormantizeScrollFx(code, 'frame-x');
    expect(dormant).toMatchInlineSnapshot(`
      "'use client';
      import React, { useEffect } from 'react';
      import { motion, useScroll, useTransform , useMotionValue, animate} from 'framer-motion';

      export default function Page() {
                  return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-scroll-fx='{"transform":{"trigger":"onScroll","from":{"opacity":"1"},"to":{"opacity":"0.2"}},"speed":110,"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"},"transition":{"type":"spring","duration":"0.5"}},"hover":{"props":{"scale":"1.05"}},"tap":{"props":{"scale":"0.95"}}}' data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
    expect(rehydrateScrollFx(dormant, 'frame-x')).toMatchInlineSnapshot(`
      "'use client';
      import React, { useEffect } from 'react';
      import { motion, useScroll, useTransform, useMotionValue, animate } from 'framer-motion';

      export default function Page() {
        const [frameXScrolled, setFrameXScrolled] = useState(false);
        const { scrollY: frameXScrollY } = useScroll();
        useMotionValueEvent(frameXScrollY, "change", (y) => {
          const prev = frameXScrollY.getPrevious() ?? 0;
          if (y > prev) setFrameXScrolled(true); else if (y < prev) setFrameXScrolled(false);
        });
        const { scrollYProgress: frameXProgress } = useScroll();
        const frameXOpacity = useTransform(frameXProgress, [0, 1], [1, 0.2]);
        const { scrollY: frameXSpeedScroll } = useScroll();
        const frameXSpeedY = useTransform(frameXSpeedScroll, (v) => v * (1 - 110 / 100));
        const frameXAnimOpacity = useMotionValue(1);
        useEffect(() => { const _c = animate(frameXAnimOpacity, frameXScrolled ? 0 : 1, { type: 'spring', duration: 0.5 }); return () => _c.stop(); }, [frameXScrolled]);
        const frameXOpacityDC = useTransform([frameXAnimOpacity, frameXOpacity], ([a, t]) => a * t);
                          return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-scroll-fx='{"transform":{"trigger":"onScroll","from":{"opacity":"1"},"to":{"opacity":"0.2"}},"speed":110,"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"},"transition":{"type":"spring","duration":"0.5"}},"hover":{"props":{"scale":"1.05"}},"tap":{"props":{"scale":"0.95"}}}' data-id="frame-x" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000', y: frameXSpeedY, opacity: frameXOpacityDC}}
                
                whileHover={{ scale: 1.05 }}
                
                whileTap={{ scale: 0.95 }}
                />
            <div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });
});

// ─── small utilities ─────────────────────────────────────────────────────────

describe('characterization: tag utilities', () => {
  it('ensureMotionTag — converts a plain div to motion.div', () => {
    expect(ensureMotionTag(PAGE, 'plain-y')).toMatchInlineSnapshot(`
      "'use client';
      import React from 'react';
      import { motion } from 'framer-motion';

      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%' }}>
            <motion.div data-id="frame-x" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} />
            <motion.div data-id="plain-y" style={{ position: 'relative', width: '100px', height: '50px' }} />
          </div>
        );
      }"
    `);
  });

  it('getOpeningTag — returns the opening tag text + offsets', () => {
    expect(JSON.stringify(getOpeningTag(PAGE, 'frame-x'))).toMatchInlineSnapshot(`"{"tag":"<motion.div data-id=\\"frame-x\\" style={{ position: 'absolute', width: '200px', height: '100px', backgroundColor: '#ff0000' }} /","tagStart":205,"gt":330}"`);
  });
});
