import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

/** CANONICAL FIXTURE — a real component drawn in the builder (user-provided
 *  2026-06-10): canvas-absolute children, left/top + rotate + fontSize tweens
 *  in CHILD variant objects, width/height as ternaries, per-tag
 *  initial/animate, root with onTap (no sourceNode), solo node in
 *  AnimatePresence with key + data-replica-solo + gated initial appear.
 *  The oracle must accept the builder's own output with ZERO violations. */
const TIFEGO = `'use client';

/** @name "Frame" */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{
  name: 'default',
  label: 'Frame',
  x: 0,
  y: 0,
  isPrimary: true
}, {
  name: 'variant-1',
  label: 'Frame',
  x: 520,
  y: 0
}];
const frameMq7ziqbd3Variants = {
  default: {
    left: '56px',
    top: '63px'
  },
  'variant-1': {
    left: '186px',
    top: '46px'
  }
};
const frameMq7ziv4x4Variants = {
  default: {
    fontSize: '16px'
  },
  'variant-1': {
    fontSize: '39px'
  }
};
const frameMq7zj2vw5Variants = {
  default: {
    left: '173px',
    top: '73px',
    rotate: 0
  },
  'variant-1': {
    left: '55px',
    top: '53px',
    rotate: -208.8
  }
};
const connections = [{
  from: 'default',
  to: 'variant-1',
  trigger: 'click'
}, {
  from: 'variant-1',
  to: 'default',
  trigger: 'click'
}];
function TiFeGo({
  style,
  initialVariant = 'default'
}: {style?: React.CSSProperties;initialVariant?: string;}) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => {
    setVariant(initialVariant);
  }, [initialVariant]);
  return <LayoutGroup>
    <motion.div onTap={() => setVariant(variant === 'default' ? 'variant-1' : variant === 'variant-1' ? 'default' : variant)} layout={true} data-id="frame-mq7zinh9-2" data-name="Frame" style={{
      position: 'absolute',
      width: '347px',
      height: '297px',
      backgroundColor: '#ffb3ba',
      borderRadius: '0px',
      overflow: 'hidden',
      ...style
    }} animate={variant}>
    <motion.div layout={true} data-id="frame-mq7ziqbd-3" variants={frameMq7ziqbd3Variants} initial={initialVariant} data-name="Frame" style={{
        position: 'absolute',
        width: '76px',
        backgroundColor: '#ffdfba',
        borderRadius: '0px',
        overflow: 'hidden',
        left: '56px',
        top: '63px',
        height: variant === 'variant-1' ? '190px' : '63px'
      }} animate={variant}></motion.div>

    <motion.p layout={true} data-id="frame-mq7ziv4x-4" variants={frameMq7ziv4x4Variants} initial={initialVariant} data-name="Text" style={{
        fontSize: '16px',
        color: '#000000',
        fontFamily: 'Inter, sans-serif',
        fontWeight: '400',
        lineHeight: '1.2',
        overflowWrap: 'break-word',
        width: 'max-content',
        height: 'auto',
        position: 'absolute',
        left: '69px',
        top: '205px'
      }} animate={variant}>
      sdgsdgsdgsdg
    </motion.p>

    <motion.div layout={true} data-id="frame-mq7zj2vw-5" variants={frameMq7zj2vw5Variants} initial={initialVariant} data-name="Frame" style={{
        position: 'absolute',
        backgroundColor: '#ffffba',
        borderRadius: '0px',
        overflow: 'hidden',
        left: '173px',
        top: '73px',
        width: '42px',
        height: '46px'
      }} animate={variant}></motion.div>

    <AnimatePresence mode="popLayout">{variant !== "default" && <motion.div layout={true} data-id="frame-mq7zjibh-6" data-name="Frame" style={{
          position: 'absolute',
          width: '36px',
          height: '63px',
          backgroundColor: '#baffc9',
          borderRadius: '0px',
          overflow: 'hidden',
          left: '27px',
          top: '143px'
        }} key="frame-mq7zjibh-6" data-replica-solo="variant-1"
          initial={variant === 'variant-1' ? { opacity: 0, y: 30 } : undefined}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          ></motion.div>}</AnimatePresence>
  </motion.div>
    </LayoutGroup>;
}
export default withResponsiveProps(TiFeGo);
`;

/** Condensed version of the BAD freeform header (live 2026-06-10): fixed root,
 *  varianted children without animate, key present. Must bounce. */
const BAD_HEADER = `import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Navigation Header" */

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'expanded', label: 'Expanded Menu', x: 1200, y: 0 }
];

const headerVariants = {
  default: { backgroundColor: 'rgba(15, 23, 42, 0.85)' },
  expanded: { backgroundColor: 'rgba(15, 23, 42, 0.98)' }
};

const chevronVariants = {
  default: { rotate: 0 },
  expanded: { rotate: 180 }
};

const connections = [
  { from: 'default', to: 'expanded', trigger: 'click', sourceNode: 'menu-toggle' },
  { from: 'expanded', to: 'default', trigger: 'click', sourceNode: 'menu-toggle' }
];

function NavigationHeader({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <MotionConfig transition={{ type: 'spring', stiffness: 260, damping: 28 }}>
        <motion.header data-id="header-container" data-name="Header Container" layout variants={headerVariants} initial={initialVariant} animate={variant}
          style={{ position: 'fixed', top: '0px', left: '0px', display: 'flex', flexDirection: 'column', height: variant === 'expanded' ? '380px' : '80px', ...style }}>
          <motion.div data-id="menu-toggle" data-name="Menu Toggle" layout onTap={() => setVariant(variant === 'default' ? 'expanded' : 'default')} style={{ display: 'flex', width: '38px', height: '38px' }}>
            <motion.svg data-id="chevron-icon" data-name="Chevron Icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" variants={chevronVariants}>
              <polyline points="6 9 12 15 18 9" />
            </motion.svg>
          </motion.div>
        </motion.header>
      </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(NavigationHeader);
`;

/** SECOND CANONICAL FIXTURE — a real builder-written responsive header
 *  (user-provided 2026-06-10, "CeRoKa"): flex-flow root with width/height/
 *  flexDirection ternaries, SPARSE variant objects (entries only where values
 *  differ — '{}' and absent entries are the builder's diff format), a nested
 *  component instance inside AnimatePresence with a per-variant initialVariant
 *  ternary, a composed data-scroll-fx loop on a child, MotionConfig with a
 *  custom spring, order ternaries, an empty canvasNodes fragment. */
const CEROKA = `'use client';

/** @name "Frame" */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useInView, useMotionValue, animate, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import HeHePa from '@/components/HeHePa';

const variantConfig = [{
  name: 'default',
  label: 'Desktop',
  x: 0,
  y: 0,
  isPrimary: true
}, {
  name: 'variant-1',
  label: 'Tablet',
  x: 1348,
  y: 0
}, {
  name: 'variant-2',
  label: 'Frame',
  x: 2157,
  y: 0
}];
const frameMq2w6vxs1Variants = {
  default: {
    display: 'flex',
    padding: '56px'
  },
  'variant-1': {},
  'variant-2': {}
};
const frameMq2w73kb2Variants = {
  default: {
    position: 'relative',
    flex: '0 0 auto'
  },
  'variant-2': {
    position: 'relative',
    flex: '0 0 auto'
  }
};
const textMq2w75kw3Variants = {
  default: {
    color: '#ffffff'
  },
  'variant-2': {
    color: '#ffffff'
  }
};
const frameMq2wau0z1Variants = {
  default: {
    borderRadius: '61px',
    backgroundColor: '#ffffff'
  }
};
const connections = [{
  from: 'variant-1',
  to: 'variant-2',
  trigger: 'click',
  sourceNode: 'frame-mq2w83q9-1'
}, {
  from: 'variant-2',
  to: 'variant-1',
  trigger: 'click',
  sourceNode: 'frame-mq2w83q9-1'
}];
function CeRoKa({
  style,
  initialVariant = 'default'
}: {
  style?: React.CSSProperties;
  initialVariant?: string;
}) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => {
    setVariant(initialVariant);
  }, [initialVariant]);
  const frameMq2wau0z_1Ref = useRef(null);
  const frameMq2wau0z_1LoopInView = useInView(frameMq2wau0z_1Ref);
  const frameMq2wau0z_1LoopRotate = useMotionValue(0);
  useEffect(() => { if (frameMq2wau0z_1LoopInView) { const _c = animate(frameMq2wau0z_1LoopRotate, 360, { duration: 2, repeat: Infinity, ease: 'linear' }); return () => _c.stop(); } }, [frameMq2wau0z_1LoopInView]);
  return <LayoutGroup>
      <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 88, mass: 1, delay: 0 }}>
    <motion.div layout={true} data-id="frame-mq2w6vxs-1" variants={frameMq2w6vxs1Variants} initial={initialVariant} data-name="Frame" style={{
      position: 'absolute',
      backgroundColor: '#000000',
      borderRadius: '0px',
      overflow: 'hidden',
      flex: '0 0 auto',
      alignItems: 'center',
      display: "flex",
      justifyContent: 'space-between',
      padding: '56px',
      width: variant === 'variant-1' ? '609px' : variant === 'variant-2' ? '526px' : '1123px',
      height: variant === 'variant-2' ? '494px' : '156px',
      flexDirection: variant === 'variant-2' ? 'column' : 'row',
      gap: '0px',
      ...style
    }} animate={variant}>
    <motion.div data-scroll-fx='{"loop":{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity","ease":"linear"}}}' ref={frameMq2wau0z_1Ref} data-id="frame-mq2wau0z-1" layout={true} variants={frameMq2wau0z1Variants} initial={initialVariant} data-name="Frame" style={{position: 'relative',
        backgroundColor: '#ffffff',
        borderRadius: '61px',
        overflow: 'hidden',
        width: '63px',
        height: '50px',
        order: variant === 'variant-1' ? 1 : 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center", rotate: frameMq2wau0z_1LoopRotate}} animate={variant}>
    <motion.p layout={true} data-id="text-mq2wej6r-1" data-name="Text" style={{
          fontSize: '16px',
          color: '#000000',
          fontFamily: 'Inter, sans-serif',
          fontWeight: '400',
          lineHeight: '1.2',
          overflowWrap: 'break-word',
          position: 'relative',
          flex: '0 0 auto'
        }}>
      eeee
    </motion.p>
  </motion.div><AnimatePresence mode="popLayout">{variant !== "default" && <HeHePa onTap={() => setVariant(variant === 'variant-1' ? 'variant-2' : variant === 'variant-2' ? 'variant-1' : variant)} initialVariant={variant === 'variant-2' ? 'variant-1' : 'default'} data-id="frame-mq2w83q9-1" layout={true} data-name="Frame" style={{
          position: 'relative',
          flex: '0 0 auto',
          order: variant === 'variant-1' ? 2 : 0
        }} key="frame-mq2w83q9-1" />}</AnimatePresence><AnimatePresence mode="popLayout">{variant !== "variant-1" && <motion.div layout={true} data-id="frame-mq2w73kb-2" variants={frameMq2w73kb2Variants} initial={variant === 'variant-2' ? { opacity: 0, y: 30 } : initialVariant} data-name="Frame" style={{
          position: "relative",
          borderRadius: '0px',
          overflow: 'hidden',
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: '21px',
          height: 'auto',
          width: 'auto',
          flexDirection: variant === 'variant-2' ? 'column' : 'row',
          order: variant === 'variant-1' ? 0 : 0
        }} animate={variant} key="frame-mq2w73kb-2"
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.4 }}
          >
    <motion.p layout={true} data-id="text-mq2w75kw-3" variants={textMq2w75kw3Variants} initial={initialVariant} data-name="Text" style={{
            fontSize: '16px',
            color: '#ffffff',
            fontFamily: 'Inter, sans-serif',
            fontWeight: '400',
            lineHeight: '1.2',
            overflowWrap: 'break-word',
            position: 'relative',
            flex: '0 0 auto'
          }} animate={variant}>
      Eeeh 1
    </motion.p>
  </motion.div>}</AnimatePresence>
  </motion.div>
    </MotionConfig>
    </LayoutGroup>;
}
export default withResponsiveProps(CeRoKa);
const canvasNodes = <>
</>;
`;

describe('variant dialect — canonical builder output passes', () => {
  it('accepts the real drawn component (TiFeGo) with ZERO violations', () => {
    expect(checkFile(TIFEGO, { kind: 'component' })).toEqual([]);
  });

  it('accepts the real responsive flex header (CeRoKa) with ZERO violations — sparse variant objects, instance in AnimatePresence, composed loop, MotionConfig', () => {
    expect(checkFile(CEROKA, { kind: 'component' })).toEqual([]);
  });
});

describe('variant dialect — the bad freeform header bounces', () => {
  it('flags the fixed root and the frozen chevron', () => {
    const cs = codes(checkFile(BAD_HEADER, { kind: 'component' }));
    expect(cs).toContain('COMPONENT_ROOT_POSITION');      // position: 'fixed' root
    expect(cs).toContain('MISSING_ANIMATE_ON_VARIANTS');  // chevron has variants, no animate
  });
});

/** Condensed version of the THIRD freeform attempt (2026-06-10): structurally
 *  sound, but primary named 'collapsed' (canvas hardcodes 'default'), duplicate
 *  initial attrs, a rogue root onTap declared in no connection, and an event-
 *  param handler with stopPropagation. */
const BAD_HEADER_3 = `import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Navigation Header" */

const variantConfig = [
  { name: 'collapsed', label: 'Collapsed', x: 0, y: 0, isPrimary: true },
  { name: 'expanded', label: 'Expanded', x: 450, y: 0 }
];

const btnVariants = {
  collapsed: { backgroundColor: '#F1F5F9' },
  expanded: { backgroundColor: '#E2E8F0' }
};

const connections = [
  { from: 'collapsed', to: 'expanded', trigger: 'click', sourceNode: 'hamburger-btn' },
  { from: 'expanded', to: 'collapsed', trigger: 'click', sourceNode: 'hamburger-btn' }
];

function BaWoWe({ style, initialVariant = 'collapsed' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <MotionConfig transition={{ type: 'spring', stiffness: 350, damping: 35, mass: 1 }}>
        <motion.div layout={true} data-id="header-root" data-name="Navigation Header" animate={variant}
          onTap={() => setVariant(variant === 'collapsed' ? 'expanded' : 'collapsed')}
          style={{ position: 'absolute', width: '390px', height: variant === 'expanded' ? '290px' : '70px', backgroundColor: '#ffffff', overflow: 'hidden', display: 'flex', flexDirection: 'column', ...style }}>
          <motion.button layout={true} data-id="hamburger-btn" data-name="Hamburger Button" variants={btnVariants} initial={initialVariant} animate={variant}
            onTap={(e) => { e.stopPropagation(); setVariant(variant === 'collapsed' ? 'expanded' : 'collapsed'); }}
            style={{ width: '40px', height: '40px', display: 'flex' }}>
          </motion.button>
          <AnimatePresence mode="popLayout">
            {variant === 'expanded' && (
              <motion.div key="menu-container" data-id="menu-container" data-name="Menu Container" layout={true} animate={variant}
                initial={initialVariant}
                style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                initial={variant === 'expanded' ? { opacity: 0, y: -10 } : undefined}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}>
                <motion.a layout={true} data-id="link-home" data-name="Home Link" style={{ fontSize: '15px', color: '#334155' }}>Home</motion.a>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(BaWoWe);
`;

describe('variant dialect — third attempt sins bounce', () => {
  it('flags the non-default primary, duplicate initial, rogue root onTap, and the event-param handler', () => {
    const cs = codes(checkFile(BAD_HEADER_3, { kind: 'component' }));
    expect(cs).toContain('PRIMARY_VARIANT_NAME');       // primary named 'collapsed'
    expect(cs).toContain('DUPLICATE_JSX_ATTR');         // two initial attrs on menu-container
    expect(cs).toContain('ONTAP_WITHOUT_CONNECTION');   // root toggles but no sourceNode-less connection
    expect(cs).toContain('CONNECTION_HANDLER_SHAPE');   // (e) => { e.stopPropagation(); ... }
    expect(cs).toContain('CONNECTION_HANDLER_FALLTHROUGH'); // unconditional else, no `: variant` fallthrough
  });

  it('flags handlers whose else-branch is unconditional (4th-attempt mega-menu case) + missing @name', () => {
    const code = TIFEGO
      .replace(/\/\*\* @name "Frame" \*\//, '')
      .replace(
        "onTap={() => setVariant(variant === 'default' ? 'variant-1' : variant === 'variant-1' ? 'default' : variant)}",
        "onTap={() => setVariant(variant === 'variant-1' ? 'default' : 'variant-1')}",
      );
    const vs = checkFile(code, { kind: 'component' });
    const cs = codes(vs);
    expect(cs).toContain('CONNECTION_HANDLER_FALLTHROUGH');
    expect(cs).toContain('MISSING_NAME_ANNOTATION');
    // the message carries the copy-paste-exact handler from the declared connections
    const hit = vs.find((x) => x.code === 'CONNECTION_HANDLER_FALLTHROUGH')!;
    expect(hit.message).toContain(
      "onTap={() => { const _n = variant === 'default' ? 'variant-1' : variant === 'variant-1' ? 'default' : null; if (_n) setVariant(_n); }}",
    );
  });

  it('root onTap IS legal when a connection has no sourceNode (TiFeGo passes — asserted above)', () => {
    // covered by the TIFEGO zero-violation test: its connections carry no
    // sourceNode and the onTap sits on the ...style root.
    expect(checkFile(TIFEGO, { kind: 'component' })).toEqual([]);
  });
});
