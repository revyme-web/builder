import { describe, it, expect } from 'vitest';
import { setScrollVariantInCode, ensureComponentAcceptsRef } from './scroll-variant-gen';
import { parseJSX } from '@/code/parsing/ast-utils';

const PAGE = `'use client';
import React, { useRef } from 'react';
import { useInView } from 'framer-motion';
import Hero from '@/components/Hero';
export default function Page() {
  return (<div data-id="root"><Hero data-id="hero" initialVariant="default" /></div>);
}`;

const COMPONENT = `'use client';
import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const heroVariants = { default: { opacity: 1 }, 'variant-1': { opacity: 0.5 } };
function Hero({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (<LayoutGroup><MotionConfig><motion.div data-id="hero-root" variants={heroVariants} initial={initialVariant} animate={initialVariant} style={{...style}}></motion.div></MotionConfig></LayoutGroup>);
}
export default withResponsiveProps(Hero);`;

describe('Scroll Variant — layerInView ref (React 19 ref-as-prop)', () => {
  it('page layerInView uses a real ref on the instance (no querySelector)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'layerInView', from: 'default', to: 'variant-1', start: 'top', replay: true });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).not.toContain('querySelector');
    expect(out).toMatch(/const heroSvRef = useRef\(null\)/);
    expect(out).toMatch(/useMotionValueEvent\(heroSvScrollY, "change"/);
    expect(out).toMatch(/<Hero[^>]*ref=\{heroSvRef\}/);
    expect(out).toMatch(/initialVariant=\{heroSv\}/);
  });

  it('ensureComponentAcceptsRef adds ref prop + ref on the variants root (idempotent)', () => {
    const out = ensureComponentAcceptsRef(COMPONENT);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/initialVariant = 'default'\s*,\s*ref\s*\}/);          // ref in destructure
    expect(out).toMatch(/initialVariant\?: string\s*;\s*ref\?: React\.Ref<any>\s*\}\)/); // ref in type
    expect(out).toMatch(/<motion\.div ref=\{ref\} data-id="hero-root"[^>]*variants=\{heroVariants\}/);
    expect(ensureComponentAcceptsRef(out)).toBe(out); // idempotent
  });

  it('attaches ref on a connection-wired root (animate={variant}, not initialVariant)', () => {
    const connected = `function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
      const [variant, setVariant] = useState(initialVariant);
      useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
      return (<motion.div data-id="card-root" variants={cardVariants} initial={variant} animate={variant} style={{...style}}></motion.div>);
    }`;
    const out = ensureComponentAcceptsRef(connected);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/initialVariant = 'default'\s*,\s*ref\s*\}/);
    expect(out).toMatch(/<motion\.div ref=\{ref\} data-id="card-root"/);
  });

  it('handles the real generated shape: layout={true} before data-id, multiline sig, trailing `;` type', () => {
    const real = `function TiFiPa({
  style,
  initialVariant = 'default'
}: {
  style?: React.CSSProperties;
  initialVariant?: string;
}) {
  return <LayoutGroup><MotionConfig>
    <motion.div layout={true} data-id="frame-root" variants={rootVariants} initial={initialVariant} animate={initialVariant} style={{ ...style }}>
    <motion.div layout={true} data-id="frame-child" variants={childVariants} initial={initialVariant} animate={initialVariant}></motion.div>
  </motion.div></MotionConfig></LayoutGroup>;
}`;
    const out = ensureComponentAcceptsRef(real);
    expect(parseJSX(out)).not.toBeNull();                 // valid (no `string;;`)
    expect(out).toMatch(/initialVariant = 'default'\s*,\s*ref\s*\}/);
    expect(out).toMatch(/initialVariant\?: string\s*;\s*ref\?: React\.Ref<any>\s*\}/);
    expect(out).toMatch(/<motion\.div ref=\{ref\} layout=\{true\} data-id="frame-root"/); // ref on ROOT
    expect(out).not.toMatch(/data-id="frame-child"[^>]*ref=\{ref\}|ref=\{ref\}[^>]*data-id="frame-child"/); // NOT on child
    expect(out.match(/ref=\{ref\}/g)).toHaveLength(1);    // exactly one root attr
  });

  it('attaches ref on the ROOT when only a CONDITIONAL CHILD has variants={ (header shape)', () => {
    // The root has animate={variant} + ...style but NO variants object; the only
    // variants={ is on a child that renders in some variants only (a hamburger line
    // shown in mobile, absent in default). Ref MUST land on the root (always
    // rendered) — putting it on the conditional child means ref.current is null in
    // the default variant → motion's "Target ref is defined but not hydrated" crash
    // the moment a Scroll Transform / Hover instance-FX targets the instance.
    const header = `function Header({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
      const [variant, setVariant] = useState(initialVariant);
      return <LayoutGroup><MotionConfig>
        <motion.div data-id="header-root" animate={variant} style={{ position: 'absolute', ...style }}>
          <motion.div data-id="bar">
            <AnimatePresence>{variant !== 'default' && <motion.div data-id="ham-top" variants={lineTopVariants} initial={initialVariant} animate={variant} style={{ position: 'absolute' }} />}</AnimatePresence>
          </motion.div>
        </motion.div>
      </MotionConfig></LayoutGroup>;
    }`;
    const out = ensureComponentAcceptsRef(header);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/initialVariant = 'default'\s*,\s*ref\s*\}/);             // ref in destructure
    expect(out).toMatch(/<motion\.div ref=\{ref\} data-id="header-root"/);        // ref on the ROOT
    expect(out).not.toMatch(/data-id="ham-top"[^>]*ref=\{ref\}/);                 // NOT on the conditional child
    expect(out.match(/ref=\{ref\}/g)).toHaveLength(1);                            // exactly one attr
    expect(ensureComponentAcceptsRef(out)).toBe(out);                             // idempotent
  });

  it('non-variant component is untouched', () => {
    const plain = `function X({ style }: { style?: any }) { return (<motion.div data-id="x" style={style}></motion.div>); }`;
    expect(ensureComponentAcceptsRef(plain)).toBe(plain);
  });

  it('layerInView strips clean on remove (ref + binding + spec gone)', () => {
    const set = setScrollVariantInCode(PAGE, 'hero', { trigger: 'layerInView', from: 'default', to: 'variant-1', start: 'top', replay: true });
    const cleared = setScrollVariantInCode(set, 'hero', null);
    expect(parseJSX(cleared)).not.toBeNull();
    expect(cleared).not.toMatch(/heroSvRef/);
    expect(cleared).not.toMatch(/data-scroll-variant/);
    expect(cleared).not.toMatch(/ref=\{heroSvRef\}/);
  });
});
