import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

/** A fully dialect-compliant component — the oracle must stay silent. */
const CLEAN_COMPONENT = `import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Pricing Card" */

const variantConfig = [
{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
{ name: 'open', label: 'Open', x: 600, y: 0 }];

const cardVariants = {
  default: { backgroundColor: '#0f172a', scale: 1 },
  'open': { backgroundColor: '#1e293b', scale: 1.02 },
};

function PricingCard({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="card" layout variants={cardVariants} whileHover={{ y: -8 }} initial={initialVariant} animate={initialVariant} style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px', borderRadius: '12px', backgroundColor: '#0f172a', width: initialVariant === 'open' ? '360px' : '320px', ...style }}>
      <motion.h3 data-id="plan" layout style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#ffffff', fontSize: '18px' }}>Pro Plan</motion.h3>
      <motion.p data-id="price" layout style={{ position: 'relative', flex: '0 0 auto', order: '1', color: '#ffffff', fontSize: '40px', fontWeight: '800' }}>$29/mo</motion.p>
      <AnimatePresence mode="popLayout">{initialVariant !== 'default' && <motion.p data-id="note" layout key="note" style={{ color: '#94a3b8' }}>Billed yearly</motion.p>}</AnimatePresence>
      <motion.button data-id="cta" layout style={{ position: 'relative', flex: '0 0 auto', order: '2', backgroundColor: '#3b82f6', color: '#ffffff', borderRadius: '8px', padding: '12px' }}>Buy now</motion.button>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(PricingCard);
`;

/** Every classic freeform sin in one file. */
const SINNER = `import React, { useState } from 'react';
import gsap from 'gsap';
import "./PricingCard.css";

export default function PricingCard() {
  const [hover, setHover] = useState(false);
  return (
    <div className="card p-6 rounded-xl"
      style={{ transform: hover ? 'translateY(-8px)' : 'none', transition: 'all 0.3s ease', display: hover ? 'flex' : 'none' }}>
      <h3>Pro Plan</h3>
      <p>{\`$\${29}/mo\`}</p>
      <style>{\`.card { color: red }\`}</style>
    </div>
  );
}
`;

describe('checkFile — tier 1 syntax', () => {
  it('returns a single SYNTAX_ERROR for unparseable code', () => {
    const vs = checkFile('function broken( { return <div', { kind: 'component' });
    expect(codes(vs)).toEqual(['SYNTAX_ERROR']);
    expect(vs[0].message).toContain('Return the complete corrected file');
  });
});

describe('checkFile — tier 2 dialect', () => {
  it('passes a fully dialect-compliant component with zero violations', () => {
    expect(checkFile(CLEAN_COMPONENT, { kind: 'component' })).toEqual([]);
  });

  it('batches every violation of the sinner file in ONE report', () => {
    const vs = checkFile(SINNER, { kind: 'component' });
    const cs = codes(vs);
    expect(cs).toContain('GSAP_FORBIDDEN');        // import gsap
    expect(cs).toContain('FORBIDDEN_IMPORT');      // css import
    expect(cs).toContain('EXPORT_SHAPE');          // export default function
    expect(cs).toContain('CLASSNAME_STYLING');     // tailwind classes
    expect(cs).toContain('CSS_TRANSITION');        // transition: all .3s
    expect(cs).toContain('TRANSFORM_STRING');      // transform: translateY
    expect(cs).toContain('DISPLAY_TOGGLE_VISIBILITY'); // display ternary w/ 'none'
    expect(cs).toContain('MISSING_DATA_ID');       // div/h3/p without ids
    expect(cs).toContain('TEXT_EXPRESSION');       // template literal text
    expect(cs).toContain('RAW_STYLE_TAG');         // <style> in a component
  });

  it('allows the Rotation tool\'s rotate-only transform string (builder canonical)', () => {
    const code = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8', transform: 'rotate(185.8deg)', transformBox: 'border-box', transformOrigin: '50% 50%' }}",
    );
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('TRANSFORM_STRING');
  });

  it('still bounces compound transform strings outside the fold grammar', () => {
    // rotate BEFORE scale ≠ the fold's order (translate → scale → rotate) —
    // a hand-rolled compound, not builder output.
    const wrongOrder = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8', transform: 'rotate(20deg) scale(1.2)' }}",
    );
    expect(codes(checkFile(wrongOrder, { kind: 'component' }))).toContain('TRANSFORM_STRING');
    const matrix = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8', transform: 'matrix(1, 0, 0, 1, 10, 10)' }}",
    );
    expect(codes(checkFile(matrix, { kind: 'component' }))).toContain('TRANSFORM_STRING');
  });

  it('allows the Detach-baked folded motion transform (builder canonical, fold order)', () => {
    // The DETACH feature bakes motionPropsToCSSTransform output onto
    // canvas-node copies — a detached variant snapshot must not bounce the
    // file's every future submit (live prime-rule find 2026-06-12).
    const code = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8', transform: 'translateX(-65px) translateY(10px) rotate(238.8deg)', transformBox: 'fill-box', transformOrigin: '50% 50%' }}",
    );
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('TRANSFORM_STRING');
    const scaled = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8', transform: 'translateX(0px) translateY(-6px) scaleX(1.52) rotate(121.6deg)' }}",
    );
    expect(codes(checkFile(scaled, { kind: 'component' }))).not.toContain('TRANSFORM_STRING');
  });

  it('allows builder-written @propMeta / @pageVariables annotations (page variables feature)', () => {
    const code = CLEAN_COMPONENT.replace(
      '/** @name "Pricing Card" */',
      '/** @name "Pricing Card" */\n\n/** @propMeta {"opacity":{"label":"Opacity"}} */\n/** @pageVariables { "variables": [{ "name": "opacity", "type": "number", "default": "1" }] } */',
    );
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('NO_COMMENTS_IN_GENERATED_CODE');
  });

  it('allows builder-written icon set imports (@/icons/* — live false positive 2026-06-10)', () => {
    const code = CLEAN_COMPONENT.replace(
      "import { withResponsiveProps } from '@revyme/runtime';",
      "import { withResponsiveProps } from '@revyme/runtime';\nimport SeYuSe from '@/icons/SeYuSe';",
    );
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('FORBIDDEN_IMPORT');
  });

  it('allows marketplace share-bundle imports (assets.revyme.app) but not arbitrary URLs', () => {
    // The MCP marketplace tools hand the model these URLs so it can compose
    // free community components/vector sets into designs — same loader the
    // paste-URL flow uses.
    const good = CLEAN_COMPONENT.replace(
      "import { withResponsiveProps } from '@revyme/runtime';",
      "import { withResponsiveProps } from '@revyme/runtime';\nimport WeaveField from 'https://assets.revyme.app/components/WeaveField@5948603856ec2d64.js';\nimport IconSet from 'https://assets.revyme.app/vectors/NuPoJo@5948603856ec2d64.js';",
    );
    expect(codes(checkFile(good, { kind: 'component' }))).not.toContain('FORBIDDEN_IMPORT');
    const bad = CLEAN_COMPONENT.replace(
      "import { withResponsiveProps } from '@revyme/runtime';",
      "import { withResponsiveProps } from '@revyme/runtime';\nimport Evil from 'https://evil.example.com/payload.js';",
    );
    expect(codes(checkFile(bad, { kind: 'component' }))).toContain('FORBIDDEN_IMPORT');
  });

  it('flags gsap.* calls even without an import', () => {
    const code = CLEAN_COMPONENT.replace(
      'return (',
      `if (typeof window !== 'undefined') { gsap.to('[data-id="card"]', { x: 10 }); }\n  return (`,
    );
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('GSAP_FORBIDDEN');
  });

  it('flags duplicate data-ids with both line numbers', () => {
    const code = CLEAN_COMPONENT.replace('data-id="price"', 'data-id="plan"');
    const vs = checkFile(code, { kind: 'component' });
    expect(codes(vs)).toContain('DUP_DATA_ID');
  });

  it('allows the accepted text-expression bindings', () => {
    const code = CLEAN_COMPONENT.replace(
      '>$29/mo<',
      `>{initialVariant === 'open' ? '$24/mo' : '$29/mo'}<`,
    );
    expect(checkFile(code, { kind: 'component' })).toEqual([]);
  });

  it('does not demand data-id on transparent wrappers, svg shapes, or rich-text runs', () => {
    const code = CLEAN_COMPONENT.replace(
      '>Pro Plan<',
      '>Pro <strong>Plan</strong><',
    );
    expect(checkFile(code, { kind: 'component' })).toEqual([]);
  });

  it('allows <style> in pages; components may carry ONLY the editor @media/[data-id] block', () => {
    const page = `export default function Page() {
  return (
    <div data-id="root" style={{ display: 'flex' }}>
      <style>{\`@media (max-width: 768px){ [data-id="root"] { gap: 8px; } }\`}</style>
      <p data-id="title">Hello</p>
    </div>
  );
}
`;
    expect(codes(checkFile(page, { kind: 'page' }))).not.toContain('RAW_STYLE_TAG');
    // The canonical responsive block (what updateContainerQueryStyle emits — e.g.
    // a typography preset's breakpoint tiers written into a component master)
    // is EXEMPT on components: the editor parses/edits it (parseContainerRules).
    expect(codes(checkFile(page, { kind: 'component' }))).not.toContain('RAW_STYLE_TAG');
  });

  it('exempts a real typography-preset tier block on a component master', () => {
    const master = CLEAN_COMPONENT.replace(
      '>Pro Plan<',
      `><style>{\`
    @media (max-width: 1199px) {
      [data-id="title"] { font-size: var(--typo-heading-size-md) !important; letter-spacing: var(--typo-heading-spacing-md) !important; }
    }
    @media (max-width: 599px) {
      [data-id="title"] { font-size: var(--typo-heading-size-sm) !important; }
    }
  \`}</style>Pro Plan<`,
    );
    expect(codes(checkFile(master, { kind: 'component' }))).not.toContain('RAW_STYLE_TAG');
  });

  it('still bounces freeform <style> CSS on components (element/class selectors, non-media)', () => {
    const cls = CLEAN_COMPONENT.replace(
      '>Pro Plan<',
      '><style>{`.card { color: red }`}</style>Pro Plan<',
    );
    expect(codes(checkFile(cls, { kind: 'component' }))).toContain('RAW_STYLE_TAG');
    const elementSel = CLEAN_COMPONENT.replace(
      '>Pro Plan<',
      '><style>{`@media (max-width: 768px){ p { color: red } }`}</style>Pro Plan<',
    );
    expect(codes(checkFile(elementSel, { kind: 'component' }))).toContain('RAW_STYLE_TAG');
    const mixed = CLEAN_COMPONENT.replace(
      '>Pro Plan<',
      '><style>{`[data-id="x"] { color: red } @media (max-width: 768px){ [data-id="x"] { gap: 8px } }`}</style>Pro Plan<',
    );
    expect(codes(checkFile(mixed, { kind: 'component' }))).toContain('RAW_STYLE_TAG');
  });

  it('flags prose comments but allows feature annotations', () => {
    const withProse = CLEAN_COMPONENT.replace(
      'const cardVariants',
      '// this maps the hover state\nconst cardVariants',
    );
    expect(codes(checkFile(withProse, { kind: 'component' }))).toContain('NO_COMMENTS_IN_GENERATED_CODE');
    // CLEAN_COMPONENT itself contains /** @name */ and passes (asserted above)
  });

  it('bounces bare animate objects (the Loop misclassification) but allows real loops, variants, and ternaries', () => {
    // the misclassified entrance the AI produced live (2026-06-10)
    const wrongAppear = CLEAN_COMPONENT.replace(
      'data-id="plan" layout',
      'data-id="plan" layout initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }}',
    );
    expect(codes(checkFile(wrongAppear, { kind: 'component' }))).toContain('BARE_ANIMATE_OBJECT');

    // a genuine loop (repeat present) is fine
    const loop = CLEAN_COMPONENT.replace(
      'data-id="plan" layout',
      'data-id="plan" layout animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity }}',
    );
    expect(codes(checkFile(loop, { kind: 'component' }))).not.toContain('BARE_ANIMATE_OBJECT');

    // CLEAN_COMPONENT itself has animate={initialVariant} (identifier) — already passes (asserted above)
  });

  it('requires viewport={{ once: true }} next to whileInView, and accepts the correct appear shape', () => {
    const missingOnce = CLEAN_COMPONENT.replace(
      'data-id="plan" layout',
      'data-id="plan" layout initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}',
    );
    expect(codes(checkFile(missingOnce, { kind: 'component' }))).toContain('APPEAR_MISSING_VIEWPORT_ONCE');

    const correct = CLEAN_COMPONENT.replace(
      'data-id="plan" layout',
      'data-id="plan" layout initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }}',
    );
    expect(checkFile(correct, { kind: 'component' })).toEqual([]);
  });

  it('requires use client + @controls for code components', () => {
    const vs = checkFile(CLEAN_COMPONENT, { kind: 'code-component' });
    expect(codes(vs)).toContain('USE_CLIENT_REQUIRED');
    expect(codes(vs)).toContain('CODE_COMPONENT_ANNOTATIONS_REQUIRED');
  });
});

describe('checkFile — tier 3 resolve', () => {
  it('flags a file the real parser cannot extract nodes from', () => {
    const code = `import { withResponsiveProps } from '@revyme/runtime';
function Empty() { return null; }
export default withResponsiveProps(Empty);
`;
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('RESOLVE_EMPTY');
  });
});

describe('checkFile — WOULD_CRASH (mutation-queue validator injected into the gate)', () => {
  it('bounces a file referencing an undeclared identifier (parses fine, ReferenceErrors at runtime)', () => {
    const code = CLEAN_COMPONENT.replace(
      "backgroundColor: '#0f172a',",
      'backgroundColor: brandColor,',
    );
    const vs = checkFile(code, { kind: 'component' });
    const hit = vs.find((x) => x.code === 'WOULD_CRASH');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('brandColor');
  });

  it('clean files stay silent', () => {
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component' }))).not.toContain('WOULD_CRASH');
  });
});

describe('checkFile — VARIABLE_TERNARY_BINDING (variables bind as the WHOLE value)', () => {
  it('bounces a variable buried in a style ternary (live find: activeColor tabs)', () => {
    const code = CLEAN_COMPONENT.replace(
      "borderRadius: '12px', backgroundColor: '#0f172a',",
      "borderRadius: '12px', backgroundColor: initialVariant === 'open' ? accentColor : 'rgba(0, 0, 0, 0)',",
    ).replace(
      "function PricingCard({ style, initialVariant = 'default' }",
      "function PricingCard({ style, initialVariant = 'default', accentColor = '#ff4524' }",
    );
    const vs = checkFile(code, { kind: 'component' });
    const hit = vs.find((x) => x.code === 'VARIABLE_TERNARY_BINDING');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('accentColor');
    expect(hit!.message).toContain('AnimatePresence');
  });

  it('literal-only ternaries stay legal (layout/order ternaries)', () => {
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component' }))).not.toContain('VARIABLE_TERNARY_BINDING');
  });
});

describe('checkFile — boolean-toggle visibility must use AnimatePresence', () => {
  // A DotSlider-style component: 3 variants + a boolean PROP toggle (dot1) that
  // shows/hides a dot per INSTANCE. The toggle is per-instance, NOT per-variant.
  const HEAD = `'use client';
/** @propMeta {"dot1":{"type":"toggle","label":"Dot 1"}} */
/** @name "Dots" */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'One', x: 0, y: 0, isPrimary: true },{ name: 'two', label: 'Two', x: 200, y: 0 },{ name: 'three', label: 'Three', x: 400, y: 0 }];
function Dots({ style, initialVariant = 'default', dot1 = true }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup><motion.div layout={true} data-id="root" data-name="Dots" style={{ position: 'absolute', width: 'auto', height: 'auto', display: 'flex', ...style }} animate={variant}>`;
  const TAIL = `</motion.div></LayoutGroup>;
}
export default withResponsiveProps(Dots);`;
  const DOT = `<motion.div layout={true} data-id="dot-1" data-name="Dot 1" key="dot-1" style={{ position: 'relative', width: '13px', height: '13px', flex: '0 0 auto' }}></motion.div>`;
  const build = (body: string) => HEAD + body + `</motion.div></LayoutGroup>;
}
export default withResponsiveProps(Dots);`;

  it('BOUNCES a bare {dot1 && <el/>} (not wrapped in AnimatePresence)', () => {
    const vs = checkFile(build(`{dot1 && ${DOT}}`), { kind: 'component', path: 'components/Dots.tsx' });
    expect(codes(vs)).toContain('VISIBILITY_NEEDS_ANIMATEPRESENCE');
  });

  it('ALLOWS a boolean prop toggle wrapped in AnimatePresence (no VARIANT_VISIBILITY_CONDITION)', () => {
    const vs = checkFile(build(`<AnimatePresence mode="popLayout">{dot1 && ${DOT}}</AnimatePresence>`), { kind: 'component', path: 'components/Dots.tsx' });
    expect(codes(vs)).not.toContain('VARIANT_VISIBILITY_CONDITION');
    expect(codes(vs)).not.toContain('VISIBILITY_NEEDS_ANIMATEPRESENCE');
  });

  it('STILL bounces a NON-prop condition (variant-derived boolean) in AnimatePresence', () => {
    // `isDesktop` is a local const, NOT a destructured prop → not a per-instance
    // toggle → the canvas can't resolve it per variant → still rejected.
    const body = `<AnimatePresence mode="popLayout">{dot1Bogus && <motion.div layout={true} data-id="x" data-name="X" key="x" style={{ position: 'relative', width: '13px', height: '13px', flex: '0 0 auto' }}></motion.div>}</AnimatePresence>`;
    const vs = checkFile(build(body), { kind: 'component', path: 'components/Dots.tsx' });
    expect(codes(vs)).toContain('VARIANT_VISIBILITY_CONDITION');
  });

  it('STILL allows an inline variant comparison in AnimatePresence', () => {
    const body = `<AnimatePresence mode="popLayout">{variant === 'two' && <motion.div layout={true} data-id="solo" data-name="Solo" key="solo" style={{ position: 'relative', width: '13px', height: '13px', flex: '0 0 auto' }}></motion.div>}</AnimatePresence>`;
    const vs = checkFile(build(body), { kind: 'component', path: 'components/Dots.tsx' });
    expect(codes(vs)).not.toContain('VARIANT_VISIBILITY_CONDITION');
    expect(codes(vs)).not.toContain('VISIBILITY_NEEDS_ANIMATEPRESENCE');
  });
});

describe('checkFile — image variable must bind as the whole value (Pick-image control)', () => {
  const HEAD = `'use client';
/** @propMeta {"image1":{"type":"image","label":"Image 1"}} */
/** @name "Img" */
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'L', x: 0, y: 0, isPrimary: true }];
function Img({ style, initialVariant = 'default', image1 = 'url(https://x/a.jpg)' }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup><motion.div layout={true} data-id="root" data-name="Img" style={{ position: 'absolute', width: '100px', height: '100px', display: 'flex', ...style }}>`;
  const TAIL = `</motion.div></LayoutGroup>;
}
export default withResponsiveProps(Img);`;
  const pic = (bg: string) => HEAD + `<motion.div layout={true} data-id="pic" data-name="Pic" style={{ position: 'relative', width: '56px', height: '56px', flex: '0 0 auto', order: '0', ${bg} }}></motion.div>` + TAIL;

  it('BOUNCES a url-wrapped image PROP: backgroundImage: `url(${image1})`', () => {
    expect(codes(checkFile(pic('backgroundImage: `url(${image1})`'), { kind: 'component', path: 'components/Img.tsx' }))).toContain('IMAGE_VARIABLE_URL_WRAPPED');
  });
  it('ALLOWS the whole-value bare form: backgroundImage: image1', () => {
    expect(codes(checkFile(pic('backgroundImage: image1'), { kind: 'component', path: 'components/Img.tsx' }))).not.toContain('IMAGE_VARIABLE_URL_WRAPPED');
  });
  it('EXEMPTS a CMS field: backgroundImage: `url(${item.image})` (MemberExpression)', () => {
    expect(codes(checkFile(pic('backgroundImage: `url(${item.image})`'), { kind: 'component', path: 'components/Img.tsx' }))).not.toContain('IMAGE_VARIABLE_URL_WRAPPED');
  });
});

describe('checkFile — FIT-text foreignObject is exempt from MISSING_DATA_ID', () => {
  const HEAD = `'use client';
/** @name "Fit" */
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'L', x: 0, y: 0, isPrimary: true }];
function Fit({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <LayoutGroup><motion.div layout={true} data-id="root" data-name="Fit" style={{ position: 'absolute', width: '100px', height: '100px', display: 'flex', ...style }}>`;
  const TAIL = `</motion.div></LayoutGroup>;
}
export default withResponsiveProps(Fit);`;
  it('does NOT flag a <foreignObject> wrapper inside a FIT-text svg', () => {
    const fit = HEAD + `<svg data-id="t-svg" data-name="FIT" width="100%" viewBox="0 0 100 40"><foreignObject width="100%" height="100%" style={{ overflow: 'visible' }}><p data-id="t" data-name="Text" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '40px', color: '#fff' }}>Hi</p></foreignObject></svg>` + TAIL;
    expect(codes(checkFile(fit, { kind: 'component', path: 'components/Fit.tsx' }))).not.toContain('MISSING_DATA_ID');
  });
});

describe('checkFile — component variables (props + bindings + @propMeta)', () => {
  it('the canonical variable format passes with ZERO violations', () => {
    const code = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Var Card" */
/** @propMeta {"title":{"type":"plainText","label":"Title"},"accentColor":{"type":"color","label":"Accent"},"cardGap":{"type":"number","label":"Gap","min":0,"max":64,"step":1,"unit":"px"}} */

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }
];

function VarCard({ style, initialVariant = 'default', title = 'Hover Me', accentColor = '#ff4524', cardGap = 16 }: { style?: React.CSSProperties; initialVariant?: string; title?: string; accentColor?: string; cardGap?: number }) {
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="card" data-name="Card" layout={true} style={{ position: 'absolute', width: '320px', height: '200px', display: 'flex', flexDirection: 'column', gap: cardGap, padding: '24px', backgroundColor: accentColor, overflow: 'hidden', ...style }}>
      <motion.h4 data-id="card-title" data-name="Title" layout={true} style={{ position: 'relative', flex: '0 0 auto', fontSize: '20px', color: '#ffffff', margin: '0px' }}>{title}</motion.h4>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(VarCard);
`;
    expect(checkFile(code, { kind: 'component' })).toEqual([]);
  });
});

describe('checkFile — code components', () => {
  it('the built-in Aurora code component passes with ZERO violations (prime rule)', async () => {
    const { AURORA_BACKGROUND_COMPONENT } = await import('@/code/project/default-code-components/AuroraBackground');
    expect(checkFile(AURORA_BACKGROUND_COMPONENT, { kind: 'code-component' })).toEqual([]);
  });

  it('code component internals do not need data-ids (black box edited via @controls)', () => {
    const codeComponent = `'use client';

/** @label "Dots" */
/** @comment "Animated dots" */
/** @controls { "speed": { "type": "number", "label": "Speed", "default": 1 } } */

import { useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Dots({ speed = 1, ...props }) {
  const ref = useRef(null);
  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', overflow: 'hidden', ...props.style }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(Dots);
`;
    expect(codes(checkFile(codeComponent, { kind: 'code-component' }))).not.toContain('MISSING_DATA_ID');
  });

  it('bounces ...props.style spread that is not LAST in a style object (canvas/publish divergence)', () => {
    const codeComponent = `'use client';

/** @label "Dots" */
/** @comment "Animated dots" */
/** @controls { "speed": { "type": "number", "label": "Speed", "default": 1 } } */

import { withResponsiveProps } from '@revyme/runtime';

function Dots({ speed = 1, ...props }) {
  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={{ ...props.style, position: 'relative', overflow: 'hidden' }} />
  );
}

export default withResponsiveProps(Dots);
`;
    const vs = checkFile(codeComponent, { kind: 'code-component' });
    const hit = vs.find((x) => x.code === 'CODE_COMPONENT_STYLE_SPREAD_ORDER');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('LAST');
  });
});

describe('checkFile — template slot ({children} is sacred)', () => {
  const LAYOUT = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}>
      <header data-id="chrome-header" data-name="Header" style={{ display: 'flex', padding: '24px', width: '100%' }}>
        <span data-id="chrome-logo" data-name="Logo" style={{ fontWeight: '800', color: '#111110' }}>LOGO</span>
      </header>
      {children}
    </div>
  );
}
`;

  it('passes a clean template (one plain slot) with zero violations', () => {
    expect(checkFile(LAYOUT, { kind: 'template' })).toEqual([]);
  });

  it('bounces a template whose {children} slot was removed', () => {
    const code = LAYOUT.replace('{children}', '');
    const vs = checkFile(code, { kind: 'template' });
    expect(codes(vs)).toContain('TEMPLATE_CHILDREN_MISSING');
    expect(vs.find((x) => x.code === 'TEMPLATE_CHILDREN_MISSING')!.message).toContain('exactly once');
  });

  it('bounces a duplicated {children} slot', () => {
    const code = LAYOUT.replace('{children}', '{children}\n      {children}');
    expect(codes(checkFile(code, { kind: 'template' }))).toContain('TEMPLATE_CHILDREN_DUPLICATED');
  });

  it('bounces a conditionally rendered {children} slot', () => {
    const code = LAYOUT.replace('{children}', "{true ? children : null}");
    expect(codes(checkFile(code, { kind: 'template' }))).toContain('TEMPLATE_CHILDREN_CONDITIONAL');
  });

  it('bounces a {children} slot wrapped in its own element (must be a direct root child)', () => {
    const code = LAYOUT.replace(
      '{children}',
      '<main data-id="tpl-main" data-name="Page Content" style={{ display: \'flex\', flexDirection: \'column\', width: \'100%\' }}>{children}</main>',
    );
    const vs = checkFile(code, { kind: 'template' });
    const hit = vs.find((x) => x.code === 'TEMPLATE_CHILDREN_WRAPPED');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('<main>');
    expect(hit!.message).toContain('DIRECT child');
  });

  it('plain pages are NOT subject to the slot rule', () => {
    const page = LAYOUT.replace('{children}', '').replace('LayoutClient({ children }: { children: React.ReactNode })', 'Page()');
    expect(codes(checkFile(page, { kind: 'page' }))).not.toContain('TEMPLATE_CHILDREN_MISSING');
  });
});

describe('checkFile — FORBIDDEN_ALIGN_VALUE (Align control has no baseline/stretch)', () => {
  it.each(['baseline', 'stretch'])('flags alignItems: %s', (val) => {
    const code = CLEAN_COMPONENT.replace("display: 'flex',", `display: 'flex', alignItems: '${val}',`);
    const vs = checkFile(code, { kind: 'component' });
    expect(codes(vs)).toContain('FORBIDDEN_ALIGN_VALUE');
    expect(vs.find((x) => x.code === 'FORBIDDEN_ALIGN_VALUE')!.message).toContain("'flex-start'");
  });

  it('stays silent for the values the Align control offers', () => {
    for (const val of ['flex-start', 'center', 'flex-end']) {
      const code = CLEAN_COMPONENT.replace("display: 'flex',", `display: 'flex', alignItems: '${val}',`);
      expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('FORBIDDEN_ALIGN_VALUE');
    }
  });

  it('flags a ternary branch resolving to a forbidden value', () => {
    const code = CLEAN_COMPONENT.replace(
      "display: 'flex',",
      "display: 'flex', alignItems: initialVariant === 'open' ? 'baseline' : 'center',",
    );
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('FORBIDDEN_ALIGN_VALUE');
  });

  it('applies on pages too', () => {
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'stretch' }} />;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).toContain('FORBIDDEN_ALIGN_VALUE');
  });
});

describe('checkFile — USE_CLIENT_REQUIRED on pages and templates', () => {
  const PAGE_NO_DIRECTIVE = `/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }} />;
}`;

  it('bounces a page without the directive', () => {
    expect(codes(checkFile(PAGE_NO_DIRECTIVE, { kind: 'page' }))).toContain('USE_CLIENT_REQUIRED');
  });

  it('bounces a template without the directive', () => {
    expect(codes(checkFile(PAGE_NO_DIRECTIVE, { kind: 'template' }))).toContain('USE_CLIENT_REQUIRED');
  });

  it("stays silent with 'use client' first, and on components (imported by client files)", () => {
    expect(codes(checkFile(`'use client';\n${PAGE_NO_DIRECTIVE}`, { kind: 'page' }))).not.toContain('USE_CLIENT_REQUIRED');
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component' }))).not.toContain('USE_CLIENT_REQUIRED');
  });
});

describe('checkFile — PAGE_ROOT_REQUIRED (the canvas mounts at data-id="root")', () => {
  it('bounces a page whose outermost element is not data-id="root"', () => {
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="main" data-name="Page" style={{ position: 'relative', width: '100%' }} />;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).toContain('PAGE_ROOT_REQUIRED');
  });

  it('does not apply to components (their root is any data-id)', () => {
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component' }))).not.toContain('PAGE_ROOT_REQUIRED');
  });
});

describe('checkFile — COMPONENT_NAME_MATCHES_FILE (registry keys by exported name)', () => {
  it('bounces when the exported function differs from the file basename', () => {
    const vs = checkFile(CLEAN_COMPONENT, { kind: 'component', path: 'components/OtherName.tsx' });
    expect(codes(vs)).toContain('COMPONENT_NAME_MATCHES_FILE');
    expect(vs.find((x) => x.code === 'COMPONENT_NAME_MATCHES_FILE')!.message).toContain('PricingCard');
  });

  it('stays silent when the names match, or when no path is provided', () => {
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component', path: 'components/PricingCard.tsx' })))
      .not.toContain('COMPONENT_NAME_MATCHES_FILE');
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component' }))).not.toContain('COMPONENT_NAME_MATCHES_FILE');
  });
});

describe('checkFile — CODE_COMPONENT_STATIC_FALLBACK (rAF code components must gate on useStaticCanvas)', () => {
  const RAF_CODE_COMPONENT = (gate: string) => `'use client';

/** @label "Spin" */
/** @controls { "speed": { "type": "slider", "label": "Speed", "min": 0, "max": 10, "default": 1 } } */

import { useEffect, useRef } from 'react';
import { withResponsiveProps${gate ? ', useStaticCanvas' : ''} } from '@revyme/runtime';

function Spin({ speed = 1, ...props }) {
  const canvasRef = useRef(null);
  ${gate}
  useEffect(() => {
    let raf = 0;
    const loop = () => { raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [speed]);
  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', overflow: 'hidden', ...props.style }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(Spin);
`;

  it('bounces an unguarded requestAnimationFrame loop', () => {
    expect(codes(checkFile(RAF_CODE_COMPONENT(''), { kind: 'code-component' }))).toContain('CODE_COMPONENT_STATIC_FALLBACK');
  });

  it('stays silent when useStaticCanvas is used', () => {
    expect(codes(checkFile(RAF_CODE_COMPONENT('const isStatic = useStaticCanvas();'), { kind: 'code-component' })))
      .not.toContain('CODE_COMPONENT_STATIC_FALLBACK');
  });
});

describe('checkFile — SLOT_CHILDREN_NOT_NEUTRALIZED (slot components must strip workspace positioning)', () => {
  // Slot children arrive with canvas-workspace position:absolute + left/top.
  // The editor strips these on the ghost, the LIVE site does not — a slot
  // component that renders {children} verbatim publishes EMPTY (live find
  // 2026-07-30: hand-rolled marquee).
  const SLOT_COMPONENT = (body: string) => `'use client';

/** @label "Strip" */
/** @controls { "children": { "type": "slot", "label": "Items", "slotMax": "infinite" } } */

import { useRef, useEffect, cloneElement, isValidElement, Children } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function Strip({ children, ...props }) {
  const trackRef = useRef(null);
  const isStatic = useStaticCanvas();
  ${body}
  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', overflow: 'hidden', ...props.style }}>
      <div ref={trackRef} style={{ display: 'flex' }}>{children}</div>
    </div>
  );
}

export default withResponsiveProps(Strip);
`;

  it('flags a slot component that renders children without neutralising positioning', () => {
    expect(codes(checkFile(SLOT_COMPONENT(''), { kind: 'code-component' })))
      .toContain('SLOT_CHILDREN_NOT_NEUTRALIZED');
  });

  it('passes with the imperative neutralise pass (the default-template shape)', () => {
    const neutralise = `useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    Array.from(track.children).forEach(function (c) {
      const s = c.style;
      s.position = 'relative';
      s.left = 'auto'; s.top = 'auto'; s.right = 'auto'; s.bottom = 'auto';
    });
  }, [children]);`;
    expect(codes(checkFile(SLOT_COMPONENT(neutralise), { kind: 'code-component' })))
      .not.toContain('SLOT_CHILDREN_NOT_NEUTRALIZED');
  });

  it('passes with a cloneElement sanitize writing position relative', () => {
    const clone = `const items = Children.map(children, (child) =>
    isValidElement(child) ? cloneElement(child, { style: { ...child.props.style, position: 'relative', left: 'auto', top: 'auto' } }) : child);`;
    expect(codes(checkFile(SLOT_COMPONENT(clone), { kind: 'code-component' })))
      .not.toContain('SLOT_CHILDREN_NOT_NEUTRALIZED');
  });

  it('never fires on components without a slot control', () => {
    const noSlot = SLOT_COMPONENT('').replace('"type": "slot"', '"type": "text"');
    expect(codes(checkFile(noSlot, { kind: 'code-component' })))
      .not.toContain('SLOT_CHILDREN_NOT_NEUTRALIZED');
  });
});

describe('checkFile — INSTANCE_INTERNAL_STYLE (instance tags carry placement only)', () => {
  const pageWithInstance = (instanceStyle: string) => `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import HeroCard from '@/components/HeroCard';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <HeroCard data-id="hero-card" data-name="Hero Card" style={{ ${instanceStyle} }} />
  </div>;
}`;

  it('bounces paint/typography props on the instance tag', () => {
    const vs = checkFile(pageWithInstance(`position: 'relative', backgroundColor: '#ff0000', fontSize: '18px'`), { kind: 'page' });
    const hit = vs.find((x) => x.code === 'INSTANCE_INTERNAL_STYLE');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('backgroundColor');
    expect(hit!.message).toContain('fontSize');
  });

  it('allows placement props on the instance tag', () => {
    expect(codes(checkFile(
      pageWithInstance(`position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', opacity: 0.9`),
      { kind: 'page' },
    ))).not.toContain('INSTANCE_INTERNAL_STYLE');
  });

  it('does not flag in-file capitalized motion elements (MotionLink class)', () => {
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';

const MotionLink = motion.create(Link);

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <MotionLink data-id="nav-link" data-name="Nav Link" href="/about" style={{ color: '#3b82f6', fontSize: '15px' }}>About</MotionLink>
  </div>;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).not.toContain('INSTANCE_INTERNAL_STYLE');
  });
});

describe('checkFile — cursor dialect ({...withCursor(…)} is literal)', () => {
  const cursorPage = (attach: string) => `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import { withCursor } from '@revyme/runtime';
import Pointer from '@/components/Pointer';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="cta" data-name="CTA" ${attach} style={{ display: 'flex', padding: '24px' }}>
      <p data-id="cta-label">Hover me</p>
    </div>
  </div>;
}`;

  it('the canonical spread passes with zero cursor violations', () => {
    const vs = checkFile(cursorPage(`{...withCursor(Pointer, { mode: 'follow', side: 'bottom', transition: { type: 'spring', stiffness: 300, damping: 30 } })}`), { kind: 'page' });
    expect(codes(vs)).not.toContain('CURSOR_NOT_SPREAD');
    expect(codes(vs)).not.toContain('CURSOR_UNRESOLVED');
  });

  it('bounces withCursor outside the spread form (handler assignment)', () => {
    const vs = checkFile(cursorPage(`onMouseEnter={withCursor(Pointer, { mode: 'follow' }).onMouseEnter}`), { kind: 'page' });
    expect(codes(vs)).toContain('CURSOR_NOT_SPREAD');
  });

  it('bounces a spread with whitespace after the brace (parser matches literally)', () => {
    const vs = checkFile(cursorPage(`{ ...withCursor(Pointer, { mode: 'follow' })}`), { kind: 'page' });
    expect(codes(vs)).toContain('CURSOR_NOT_SPREAD');
  });

  it('bounces a spread missing the REQUIRED options object', () => {
    const vs = checkFile(cursorPage(`{...withCursor(Pointer)}`), { kind: 'page' });
    expect(codes(vs)).toContain('CURSOR_UNRESOLVED');
  });

  it('bounces a spread on a tag with no preceding data-id (unattributable)', () => {
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';
import { withCursor } from '@revyme/runtime';
import Pointer from '@/components/Pointer';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div {...withCursor(Pointer, { mode: 'follow' })} data-id="cta" data-name="CTA" style={{ display: 'flex' }} />
  </div>;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).toContain('CURSOR_UNRESOLVED');
  });

  it('cursor-as-variable on a component master parses (camelCase prop)', () => {
    const comp = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps, withCursor } from '@revyme/runtime';

/** @name "Hover Card" */

function HoverCard({ style, myCursor = () => null }) {
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="card" data-name="Card" layout {...withCursor(myCursor, {})} style={{ display: 'flex', padding: '24px', ...style }}>
      <motion.p data-id="label" layout style={{ color: '#ffffff' }}>Hello</motion.p>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(HoverCard);
`;
    const vs = checkFile(comp, { kind: 'component' });
    expect(codes(vs)).not.toContain('CURSOR_NOT_SPREAD');
    expect(codes(vs)).not.toContain('CURSOR_UNRESOLVED');
  });
});

describe('checkFile — builder overlays are exempt from FIXED_DEPTH (prime rule)', () => {
  it('a data-overlay element with position fixed inside a conditional passes', () => {
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React, { useState } from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  const [open, setOpen] = useState(false);
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="trigger" data-name="Trigger" data-overlay-trigger='{"targetId":"ov-1","trigger":"click","dismiss":"outside"}' onClick={() => setOpen(!open)} style={{ position: 'absolute', width: '225px', height: '121px', left: '35%', top: '26%' }}></div>
    {open && <motion.div data-id="ov-1" data-overlay='{"type":"relative","triggerId":"trigger","side":"top","align":"start","offsetX":-132,"offsetY":-203}' style={{
      position: 'fixed',
      zIndex: '50',
      width: '393px',
      height: '100px',
      backgroundColor: '#7CBFFF'
    }}></motion.div>}
  </div>;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).not.toContain('FIXED_DEPTH');
  });

  it('plain nested fixed still bounces', () => {
    const page = `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="wrap" data-name="Wrap" style={{ display: 'flex' }}>
      <div data-id="deep" data-name="Deep" style={{ position: 'fixed', top: '0px' }} />
    </div>
  </div>;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).toContain('FIXED_DEPTH');
  });
});

describe('checkFile — AnimatePresence enter/exit pair (overlay scaffold)', () => {
  it('allows animate={{…}} when paired with exit (the overlay-gen presence pattern)', () => {
    const code = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8' }} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}",
    );
    expect(codes(checkFile(code, { kind: 'component' }))).not.toContain('BARE_ANIMATE_OBJECT');
  });

  it('still bounces a bare animate object without exit/repeat/whileInView', () => {
    const code = CLEAN_COMPONENT.replace(
      "style={{ color: '#94a3b8' }}",
      "style={{ color: '#94a3b8' }} animate={{ opacity: 1 }}",
    );
    expect(codes(checkFile(code, { kind: 'component' }))).toContain('BARE_ANIMATE_OBJECT');
  });
});

describe('Glide ("Flow") wrappers are transparent to the oracle', () => {
  it('does NOT flag a data-id-less <motion.div data-glide-item> wrapper as MISSING_DATA_ID', () => {
    const page = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
export default function Page() {
  return <motion.div layout data-glide='{"transition":{"type":"spring"}}' data-id="root" data-name="Home" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}><LayoutGroup>
    <motion.div data-glide-item layout transition={{ type: 'spring' }} style={{ order: '0', flex: '0 0 auto', width: '100%' }}><div data-id="sec-a" data-name="A" style={{ position: 'relative', width: '100%', height: '120px' }}></div></motion.div>
    <motion.div data-glide-item layout transition={{ type: 'spring' }} style={{ order: '1', flex: '0 0 auto', width: '100%' }}><div data-id="sec-b" data-name="B" style={{ position: 'relative', width: '100%', height: '120px' }}></div></motion.div>
  </LayoutGroup></motion.div>;
}`;
    expect(codes(checkFile(page, { kind: 'page' }))).not.toContain('MISSING_DATA_ID');
  });
});

describe('BG_COLOR_WITH_IMAGE — fill is single-color OR multi-layer (conditional)', () => {
  const pg = (s: string) => `export default function Page() { return <div data-id="root" data-name="R" style={{ position: 'relative', width: '100%', height: '200px', ${s} }}></div>; }`;
  it('flags an element with BOTH backgroundColor and backgroundImage', () => {
    expect(codes(checkFile(pg("backgroundColor: '#000000', backgroundImage: 'linear-gradient(#111, #222)'"), { kind: 'page' }))).toContain('BG_COLOR_WITH_IMAGE');
  });
  it('does NOT flag a backgroundColor alone', () => {
    expect(codes(checkFile(pg("backgroundColor: '#000000'"), { kind: 'page' }))).not.toContain('BG_COLOR_WITH_IMAGE');
  });
  it('does NOT flag a backgroundImage alone', () => {
    expect(codes(checkFile(pg("backgroundImage: 'linear-gradient(#111, #222)'"), { kind: 'page' }))).not.toContain('BG_COLOR_WITH_IMAGE');
  });
});

describe('checkFile — CMS_IMAGE_SRC_WRAP (image src/poster must be a plain URL)', () => {
  const page = (jsx: string) => `export default function Page() { return ${jsx}; }`;

  it('flags a template-literal url() wrap on src', () => {
    expect(codes(checkFile(page('<img data-id="i" src={`url(${item.image})`} />'), { kind: 'page' }))).toContain('CMS_IMAGE_SRC_WRAP');
  });
  it('flags a string url() wrap on src', () => {
    expect(codes(checkFile(page(`<img data-id="i" src="url('https://x/p.jpg')" />`), { kind: 'page' }))).toContain('CMS_IMAGE_SRC_WRAP');
  });
  it('flags a url() wrap on poster', () => {
    expect(codes(checkFile(page('<video data-id="v" poster={`url(${item.cover})`} />'), { kind: 'page' }))).toContain('CMS_IMAGE_SRC_WRAP');
  });
  it('does NOT flag a plain src binding', () => {
    expect(codes(checkFile(page('<img data-id="i" src={item.image} />'), { kind: 'page' }))).not.toContain('CMS_IMAGE_SRC_WRAP');
  });
  it('does NOT flag a backgroundImage style url() wrap (only backgroundImage wraps)', () => {
    expect(codes(checkFile(page('<div data-id="d" style={{ backgroundImage: `url(${item.image})` }} />'), { kind: 'page' }))).not.toContain('CMS_IMAGE_SRC_WRAP');
  });
});

describe('SLOT_COMPONENT_INLINE_CHILDREN — slot items must be connected canvas nodes', () => {
  const codes = (head: string, slot: string, tail = '') => `'use client';
import { motion } from 'framer-motion';
import CompanyMarquee from '@/components/CompanyMarquee';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>
    <CompanyMarquee data-id="mq" data-name="Marquee" speed={36} gap={56} fade={90} style={{ position: 'relative', width: '100%', height: '52px' }}>${slot}</CompanyMarquee>
  </div>;
}
${tail}`;

  const has = (vs: { code: string }[]) => vs.some(x => x.code === 'SLOT_COMPONENT_INLINE_CHILDREN');

  it('flags an INLINE data-id child without data-canvas-node', () => {
    const code = codes('', `<div data-id="ic-1" data-name="Chart" style={{ width: '40px', height: '40px', backgroundImage: 'url(x.svg)' }} />`);
    expect(has(checkFile(code, { kind: 'page' }))).toBe(true);
  });

  it('passes a CONNECTED canvas node referenced as {cn_x}', () => {
    const code = codes('', `{cn_ic_1}`, `const cn_ic_1 = <div data-id="ic-1" data-name="Chart" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '80px', width: '40px', height: '40px' }} />;`);
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });

  it('passes an inline child that DOES carry data-canvas-node="true"', () => {
    const code = codes('', `<div data-id="ic-1" data-name="Chart" data-canvas-node="true" style={{ position: 'absolute', left: '-400px', top: '80px', width: '40px', height: '40px' }} />`);
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });

  it('does not flag a plain (non-@/components) element with element children', () => {
    const code = `'use client';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', display: 'flex' }}>
    <div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex', order: '0' }}><p data-id="x" data-name="X" style={{ position: 'relative', order: '0' }}>hi</p></div>
  </div>;
}`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });
});

describe('GRID_NEEDS_TEMPLATE — a grid container needs tracks', () => {
  const page = (gridStyle: string) => `'use client';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>
    <div data-id="bento" data-name="Bento" style={{ ${gridStyle} }}>
      <div data-id="c1" data-name="A" style={{ position: 'relative', order: '0' }}>a</div>
      <div data-id="c2" data-name="B" style={{ position: 'relative', order: '1' }}>b</div>
    </div>
  </div>;
}`;
  const ex = new Set<string>(['root']); // bento + cards are NEW
  const has = (vs: { code: string }[]) => vs.some(x => x.code === 'GRID_NEEDS_TEMPLATE');

  it('flags display:grid with no track template', () => {
    expect(has(checkFile(page(`position: 'relative', display: 'grid', gap: '16px'`), { kind: 'page', existingDataIds: ex }))).toBe(true);
  });
  it('passes display:grid WITH gridTemplateColumns', () => {
    expect(has(checkFile(page(`position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridAutoRows: 'minmax(200px, auto)', gap: '16px'`), { kind: 'page', existingDataIds: ex }))).toBe(false);
  });
  it('does not flag a flex container', () => {
    expect(has(checkFile(page(`position: 'relative', display: 'flex', flexDirection: 'row', gap: '16px'`), { kind: 'page', existingDataIds: ex }))).toBe(false);
  });
  it('new-node-only: silent for pre-existing grid', () => {
    expect(has(checkFile(page(`position: 'relative', display: 'grid', gap: '16px'`), { kind: 'page', existingDataIds: new Set(['root','bento','c1','c2']) }))).toBe(false);
  });
});

describe('NO_COMMENTS — code components are exempt; pages still rejected', () => {
  const codeComp = `'use client';
/** @label "Thing" */
/** @comment "does a thing" */
/** @controls { "speed": { "type": "slider", "label": "Speed", "min": 0, "max": 10, "default": 1 } } */
import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';
function Thing({ speed = 1, ...props }) {
  // a documentation comment explaining the math
  const ref = useRef(null);
  const isStatic = useStaticCanvas();
  useEffect(() => { /* loop setup */ }, [isStatic]);
  return <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', ...props.style }} />;
}
export default withResponsiveProps(Thing);`;
  const has = (vs: { code: string }[]) => vs.some(x => x.code === 'NO_COMMENTS_IN_GENERATED_CODE');

  it('allows prose comments in a code component (kind code-component)', () => {
    expect(has(checkFile(codeComp, { kind: 'code-component' as any }))).toBe(false);
  });
  it('allows prose in a code component detected by @controls (kind component)', () => {
    expect(has(checkFile(codeComp, { kind: 'component' }))).toBe(false);
  });
  it('still forbids a stray prose comment on a page', () => {
    const page = `'use client';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>{/* stray prose */}<span data-id="x" data-name="X" style={{ position: 'relative' }}>hi</span></div>;
}`;
    expect(has(checkFile(page, { kind: 'page' }))).toBe(true);
  });
  it('still allows @pageVariables / @propMeta annotation comments on a page', () => {
    const page = `'use client';
/** @pageVariables { "count": { "type": "number", "default": 0 } } */
/** @propMeta { "count": { "type": "number", "label": "Count" } } */
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>hi</div>;
}`;
    expect(has(checkFile(page, { kind: 'page' }))).toBe(false);
  });
});

describe('CANVAS_FILL_FEEDBACK — fill canvas must be absolute', () => {
  const comp = (canvasStyle: string) => `'use client';
/** @label "C" */
/** @comment "c" */
/** @controls { "speed": { "type": "slider", "label": "Speed", "min": 0, "max": 5, "default": 1 } } */
import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';
function C({ speed = 1, ...props }) {
  const ref = useRef(null);
  const isStatic = useStaticCanvas();
  useEffect(() => { if (isStatic) return; let raf = requestAnimationFrame(function l(){ raf = requestAnimationFrame(l); }); return () => cancelAnimationFrame(raf); }, [isStatic]);
  return <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', overflow: 'hidden', ...props.style }}><canvas ref={ref} style={{ ${canvasStyle} }} /></div>;
}
export default withResponsiveProps(C);`;
  const has = (vs: { code: string }[]) => vs.some(x => x.code === 'CANVAS_FILL_FEEDBACK');

  it('flags an in-flow fill canvas (height 100%, no position)', () => {
    expect(has(checkFile(comp("width: '100%', height: '100%', display: 'block'"), { kind: 'code-component' as any }))).toBe(true);
  });
  it('passes an absolute fill canvas', () => {
    expect(has(checkFile(comp("position: 'absolute', top: '0px', left: '0px', width: '100%', height: '100%', display: 'block'"), { kind: 'code-component' as any }))).toBe(false);
  });
  it('passes a fixed-size canvas (no 100%)', () => {
    expect(has(checkFile(comp("width: '320px', height: '180px', display: 'block'"), { kind: 'code-component' as any }))).toBe(false);
  });
});

describe('UNRESOLVABLE_TERNARY — page state-driven values must be page variables', () => {
  const has = (vs: { code: string }[]) => vs.some(x => x.code === 'UNRESOLVABLE_TERNARY');
  it('flags a text value ternary on a page', () => {
    const code = `export default function Page() { const [a] = [0]; return <div data-id="root" data-name="R" style={{ position: 'relative' }}><p data-id="t" data-name="T" style={{ position: 'relative' }}>{a ? '$19' : '$15'}</p></div>; }`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(true);
  });
  it('flags a style value ternary on a page', () => {
    const code = `export default function Page() { const [a] = [0]; return <div data-id="root" data-name="R" style={{ position: 'relative', backgroundColor: a ? '#fff' : '#000' }} />; }`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(true);
  });
  it('passes a page-variable binding (bare identifier in text + style)', () => {
    const code = `export default function Page() { const [price] = ['x']; return <div data-id="root" data-name="R" style={{ position: 'relative', backgroundColor: price }}><p data-id="t" data-name="T" style={{ position: 'relative' }}>{price}</p></div>; }`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });
  it('does not flag an element ternary (conditional render)', () => {
    const code = `export default function Page() { const [a] = [0]; return <div data-id="root" data-name="R" style={{ position: 'relative' }}>{a ? <span data-id="x" data-name="X" style={{ position: 'relative' }} /> : <span data-id="y" data-name="Y" style={{ position: 'relative' }} />}</div>; }`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });
  it('does not run for design components (variant ternaries are valid there)', () => {
    const code = `export default function Card() { return <p data-id="t" data-name="T" style={{ color: variant === 'v1' ? '#fff' : '#000' }}>{variant === 'v1' ? 'A' : 'B'}</p>; }`;
    expect(has(checkFile(code, { kind: 'component' }))).toBe(false);
  });
});

describe('CMS_NAV_LINK_MISSING_MARKER — collection row links need data-cms-nav', () => {
  const has = (vs: { code: string }[]) => vs.some(x => x.code === 'CMS_NAV_LINK_MISSING_MARKER');
  it('flags a .map() row Link whose href uses an item _slug but lacks data-cms-nav', () => {
    const code = `import Link from 'next/link';
export default function Page() {
  return <div data-id="root" data-name="R" style={{ position: 'relative' }}>{works.map((w) => (
    <Link key={w._id} data-id="card" data-name="C" href={\`/works/\${w._slug}\`} style={{ display: 'flex' }}>x</Link>
  ))}</div>;
}`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(true);
  });
  it('passes when the row Link carries data-cms-nav + the safe slug form', () => {
    const code = `import Link from 'next/link';
export default function Page() {
  return <div data-id="root" data-name="R" style={{ position: 'relative' }}>{works.map((w) => (
    <Link key={w._id} data-cms-nav="row" data-id="card" data-name="C" href={\`/works/\${w?._slug ?? ''}\`} style={{ display: 'flex' }}>x</Link>
  ))}</div>;
}`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });
  it('does not flag a Link whose href has no item _slug', () => {
    const code = `import Link from 'next/link';
export default function Page() {
  return <div data-id="root" data-name="R" style={{ position: 'relative' }}><Link data-id="a" data-name="A" href={\`/about\`} style={{ display: 'flex' }}>x</Link></div>;
}`;
    expect(has(checkFile(code, { kind: 'page' }))).toBe(false);
  });
});

// Editor-injected runtime helpers (useResponsiveText fence + useMediaQuery hook)
// carry documentation comments — they are BUILDER output, exempt from NO_COMMENTS
// (a page that used per-viewport text/fit bounced every MCP submit otherwise).
describe('NO_COMMENTS — injected helper exemptions', () => {
  const PAGE_WITH_HELPERS = `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */
import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';

function useMediaQuery(query) {
  // Lazy initializer reads the REAL match on the first client render.
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

// @useResponsiveText-begin
function useResponsiveText(primary, overrides, vpWidths) {
  // Bucket the current width into one of the configured viewports.
  return primary;
}
// @useResponsiveText-end

export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px)');
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      <p data-id="t1" data-name="Text" style={{ position: 'relative', fontSize: '16px' }}>{useResponsiveText('Hello', { 768: 'Hi' }, [768, 1440])}</p>
    </div>
  );
}
`;

  it('does NOT flag comments inside the injected helper blocks', () => {
    const out = checkFile(PAGE_WITH_HELPERS, { kind: 'page' }).filter((x) => x.code === 'NO_COMMENTS_IN_GENERATED_CODE');
    expect(out).toEqual([]);
  });

  it('still flags prose comments OUTSIDE the helper blocks', () => {
    const bad = PAGE_WITH_HELPERS.replace('export default function Page()', '// my prose note\nexport default function Page()');
    const out = checkFile(bad, { kind: 'page' }).filter((x) => x.code === 'NO_COMMENTS_IN_GENERATED_CODE');
    expect(out.length).toBeGreaterThan(0);
  });

  // The HALF-FENCE case, straight off a live page (2026-07-26): babel's
  // `generate` drops leading comments when it regenerates the node they sit on,
  // so `// @useResponsiveText-begin` vanishes while the FunctionDeclaration —
  // and the `-end` marker below it — survive. The pair regex then matches
  // NOTHING and every comment inside the builder's OWN helper is flagged; that
  // page bounced every submit with 13 of them. `text-override-gen` already keeps
  // a marker-independent fallback for exactly this (its `hasDef` declRegex,
  // added after "Identifier 'useResponsiveText' has already been declared") —
  // the oracle needs the same one.
  it('exempts the helper even when the -begin marker was lost', () => {
    const halfFence = PAGE_WITH_HELPERS.replace('// @useResponsiveText-begin\n', '');
    expect(halfFence).not.toContain('@useResponsiveText-begin');
    expect(halfFence).toContain('@useResponsiveText-end');
    const out = checkFile(halfFence, { kind: 'page' }).filter((x) => x.code === 'NO_COMMENTS_IN_GENERATED_CODE');
    expect(out).toEqual([]);
  });

  it('exempts the helper when BOTH markers are gone', () => {
    const noFence = PAGE_WITH_HELPERS
      .replace('// @useResponsiveText-begin\n', '').replace('// @useResponsiveText-end\n', '');
    const out = checkFile(noFence, { kind: 'page' }).filter((x) => x.code === 'NO_COMMENTS_IN_GENERATED_CODE');
    expect(out).toEqual([]);
  });
});

// The Fill tool's background video: the builder writes `<video data-bg-video>`
// as a child of the frame that owns the fill, DELIBERATELY without a data-id so
// `getElementIdsAtPoint` skips it (Renderer.syncBgVideoChild) — the video must
// not be selectable in front of its own frame. It also uses `inset: '0'`, which
// is right for "fill my parent" on an element the Position tool never edits.
// Flagging either asks the model to break a builder invariant (live page,
// 2026-07-26).
describe('checkFile — the background-video child is builder-owned', () => {
  const page = (videoTag: string) => `'use client';
/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */
import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      <div data-id="hero" data-name="Frame" style={{ position: 'relative', width: '100%', height: '400px', isolation: 'isolate' }}>${videoTag}</div>
    </div>
  );
}
`;
  const BG_VIDEO = `<video data-bg-video src="https://cdn.example.com/v.mp4" autoPlay muted loop playsInline style={{ position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: "-1", objectFit: "cover" }} />`;

  it('does not demand a data-id on it', () => {
    const out = checkFile(page(BG_VIDEO), { kind: 'page' }).filter((x) => x.code === 'MISSING_DATA_ID');
    expect(out).toEqual([]);
  });

  it('accepts its `inset` shorthand', () => {
    const out = checkFile(page(BG_VIDEO), { kind: 'page' }).filter((x) => x.code === 'INSET_SHORTHAND');
    expect(out).toEqual([]);
  });

  it('still demands both from an ORDINARY video', () => {
    const plain = `<video src="https://cdn.example.com/v.mp4" style={{ position: "absolute", inset: "0" }} />`;
    const codes = checkFile(page(plain), { kind: 'page' }).map((x) => x.code);
    expect(codes).toContain('MISSING_DATA_ID');
    expect(codes).toContain('INSET_SHORTHAND');
  });
});

describe('checkFile — CODE_COMPONENT_MISSING_DEFAULT_SIZE (code components are fixed-size)', () => {
  const codeComponent = (annotations: string) => `'use client';

/** @label "Dots" */
/** @comment "Animated dots" */
${annotations}/** @controls { "speed": { "type": "number", "label": "Speed", "default": 1 } } */

import { useRef } from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Dots({ speed = 1, ...props }) {
  const ref = useRef(null);
  return (
    <div data-id={props['data-id']} data-name={props['data-name']} style={{ position: 'relative', overflow: 'hidden', ...props.style }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

export default withResponsiveProps(Dots);
`;

  it('bounces a code component without @defaultWidth/@defaultHeight', () => {
    const vs = checkFile(codeComponent(''), { kind: 'code-component' });
    expect(codes(vs)).toContain('CODE_COMPONENT_MISSING_DEFAULT_SIZE');
    expect(vs.find((x) => x.code === 'CODE_COMPONENT_MISSING_DEFAULT_SIZE')!.message).toContain('@defaultWidth and @defaultHeight');
  });

  it('names only the missing axis', () => {
    const vs = checkFile(codeComponent('/** @defaultWidth 600 */\n'), { kind: 'code-component' });
    const hit = vs.find((x) => x.code === 'CODE_COMPONENT_MISSING_DEFAULT_SIZE')!;
    expect(hit.message).toContain('@defaultHeight');
    expect(hit.message).not.toContain('@defaultWidth and');
  });

  it('passes with both annotations declared', () => {
    const vs = checkFile(codeComponent('/** @defaultWidth 600 */\n/** @defaultHeight 400 */\n'), { kind: 'code-component' });
    expect(codes(vs)).not.toContain('CODE_COMPONENT_MISSING_DEFAULT_SIZE');
  });

  it('never fires for pages or design components', () => {
    expect(codes(checkFile(CLEAN_COMPONENT, { kind: 'component' }))).not.toContain('CODE_COMPONENT_MISSING_DEFAULT_SIZE');
  });
});

// RAW_STYLE_TAG — the editor's own border-overlay codegen writes a top-level
// `[data-id="…"]::after { … }` rule into component masters (SiteHeader Login
// pill). That editor-owned shape must pass; freeform CSS still bounces.
describe('RAW_STYLE_TAG pseudo-overlay exemption', () => {
  const wrap = (css: string) => `export default function C() {
  return <div data-id="root" style={{ display: 'flex' }}>
    <style>{\`${css}\`}</style>
  </div>;
}`;
  it('data-id ::after border overlay passes on a component', () => {
    const v = checkFile(wrap(`
    [data-id="sh-login"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-width: 1px;
    }
  `), { kind: 'component' });
    expect(v.some((x) => x.code === 'RAW_STYLE_TAG')).toBe(false);
  });
  it('mixed ::after + @media data-id block passes', () => {
    const v = checkFile(wrap(`
    [data-id="a"]::before { content: ''; }
    @media (max-width: 768px) { [data-id="a"] { gap: 4px !important; } }
  `), { kind: 'component' });
    expect(v.some((x) => x.code === 'RAW_STYLE_TAG')).toBe(false);
  });
  it('freeform class/element selectors still bounce', () => {
    const v = checkFile(wrap(`.nav { color: red; } [data-id="a"]::after { content: ''; }`), { kind: 'component' });
    expect(v.some((x) => x.code === 'RAW_STYLE_TAG')).toBe(true);
  });
  it('plain top-level data-id rule (no pseudo) still bounces', () => {
    const v = checkFile(wrap(`[data-id="a"] { color: red; }`), { kind: 'component' });
    expect(v.some((x) => x.code === 'RAW_STYLE_TAG')).toBe(true);
  });
});
