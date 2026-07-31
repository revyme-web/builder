import { describe, test, expect, beforeEach, it } from 'vitest';
import { transform } from '@babel/standalone';
import {
  updateContainerQueryStyle, updateVariantStyleInCode, setConditionalStyleInCode,
  rewriteResponsiveBreakpoints, addResponsiveBreakpoint, removeResponsiveBreakpoint,
  setConditionalOrderInCode,
} from './generator-styles';
import { updateNodeInCode } from './generator-crud';
import { parseJSXToNodes } from '../parsing/parser';
import { resolveVariantStyles } from '@/canvas/Renderer';
import { syncViewportWidths } from '../stores/viewport-store';
import { checkFile } from '../oracle/check-file';

const PAGE_WITH_OVERRIDE = `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="cta" style={{ width: '500px', height: '400px' }}>Hello</div>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376px) {
      [data-id="cta"] { width: 332px !important; height: 200px !important; }
    }
  \`}</style>
    </div>
  );
}
`;

const PAGE_NO_OVERRIDE = `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="cta" style={{ width: '500px' }}>Hello</div>
    </div>
  );
}
`;

beforeEach(() => {
  // Match the default viewport setup so getMinWidth resolves correctly.
  syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });
});

describe('updateContainerQueryStyle — empty value removes the property', () => {
  test('passing height: "" drops the height declaration entirely', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_OVERRIDE, 'cta', 768, { height: '' });

    // Width should still be there.
    expect(out).toContain(`width: 332px !important;`);
    // Height line should NOT survive in any form (no `height: !important`,
    // no `height: ""`, no orphan property).
    expect(out).not.toMatch(/height\s*:\s*!important/);
    expect(out).not.toMatch(/height\s*:\s*['"]?\s*['"]?\s*!important/);
  });

  test('clearing the last property in a rule removes the data-id selector', () => {
    let out = updateContainerQueryStyle(PAGE_WITH_OVERRIDE, 'cta', 768, { width: '' });
    out = updateContainerQueryStyle(out, 'cta', 768, { height: '' });

    // The selector for cta at 768 should be gone.
    expect(out).not.toContain(`[data-id="cta"]`);
  });

  test('clearing the only rule in a breakpoint removes the @media wrapper', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_OVERRIDE, 'cta', 768, { width: '', height: '' });

    expect(out).not.toContain(`@media`);
  });

  test('clearing the only rule in the entire style block removes the <style> block', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_OVERRIDE, 'cta', 768, { width: '', height: '' });

    expect(out).not.toContain(`<style>`);
    expect(out).not.toContain(`</style>`);
  });

  test('no-op when called with empty value on a property that wasn\'t overridden', () => {
    const out = updateContainerQueryStyle(PAGE_NO_OVERRIDE, 'cta', 768, { height: '' });

    // No <style> block should be created from a pure no-op.
    expect(out).not.toContain(`<style>`);
  });

  test('mixed write: setting one prop and clearing another in the same call', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_OVERRIDE, 'cta', 768, {
      width: '400px', // change
      height: '',     // remove
    });

    expect(out).toContain(`width: 400px !important;`);
    expect(out).not.toMatch(/height\s*:\s*!important/);
    expect(out).not.toContain(`height: 200px`);
  });
});

describe('updateContainerQueryStyle — inset-pin auto-clear', () => {
  // When the user pins an element with full inset on a REPLICA (left +
  // right and/or top + bottom set), the base inline width / height
  // wins via the CSS cascade — an absolute element with width set
  // IGNORES right entirely. The serializer must auto-emit
  // `width: auto !important` / `height: auto !important` so the
  // replica's inset can actually grow the element with its parent.
  // Base has inline width/height (the trigger for the auto-clear). A
  // pre-existing <style> block is required because the serializer only
  // creates one when matching the `}}>\n` pattern, and our tests focus
  // on the cascade logic, not the block-creation path.
  const PAGE_WITH_WIDTH = `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="cta" style={{ width: '338px', height: '163px' }}>Hello</div>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376px) {
      [data-id="other"] { color: red !important; }
    }
  \`}</style>
    </div>
  );
}
`;

  test('writing left + right on a replica auto-emits width: auto', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_WIDTH, 'cta', 768, {
      left: '85px',
      right: '194px',
    });
    expect(out).toContain(`left: 85px !important;`);
    expect(out).toContain(`right: 194px !important;`);
    expect(out).toContain(`width: auto !important;`);
  });

  test('writing top + bottom on a replica auto-emits height: auto', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_WIDTH, 'cta', 768, {
      top: '141px',
      bottom: '235px',
    });
    expect(out).toContain(`top: 141px !important;`);
    expect(out).toContain(`bottom: 235px !important;`);
    expect(out).toContain(`height: auto !important;`);
  });

  test('writing full inset (L/R/T/B) auto-emits BOTH width: auto and height: auto', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_WIDTH, 'cta', 768, {
      left: '85px',
      right: '194px',
      top: '141px',
      bottom: '235px',
    });
    expect(out).toContain(`width: auto !important;`);
    expect(out).toContain(`height: auto !important;`);
  });

  test('writing only left (no right) does NOT add width: auto', () => {
    const out = updateContainerQueryStyle(PAGE_WITH_WIDTH, 'cta', 768, {
      left: '85px',
    });
    expect(out).toContain(`left: 85px !important;`);
    expect(out).not.toContain(`width: auto`);
  });

  test('explicit user width takes precedence over auto-emit', () => {
    // User explicitly set width on the replica → preserve their choice,
    // don't auto-override with auto.
    const out = updateContainerQueryStyle(PAGE_WITH_WIDTH, 'cta', 768, {
      left: '85px',
      right: '194px',
      width: '400px',
    });
    expect(out).toContain(`width: 400px !important;`);
    expect(out).not.toContain(`width: auto`);
  });
});


describe('updateVariantStyleInCode — slot-hoisted canvas nodes', () => {
  // A page with a `const cn_X = …` slot-hoisted canvas node feeding a
  // Marquee. Writing a variant style onto the slot canvas-node previously
  // emitted `initial={initialVariant} animate={initialVariant}` on the
  // motion tag inside the cn_ const — but the cn_ const lives at MODULE
  // scope, where `initialVariant` (a function param) doesn't exist, so
  // the preview crashed on module load with
  //   `ReferenceError: initialVariant is not defined`.
  //
  // Additionally, the generated `const fooVariants = …` was being
  // inserted right before the function, AFTER the cn_ const — that
  // produces a TDZ error: the cn_ const references `variants={fooVariants}`
  // at its own init time, but `fooVariants` is declared later in the file.
  const BASE = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Marquee from '@/components/Marquee';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
];

const cn_frame_1 = <div data-id="frame-1" data-canvas-node="true" data-name="Frame" style={{
  position: 'absolute',
  width: '227px',
  height: '185px',
  backgroundColor: '#ffb3ba',
  left: '-260px',
  top: '-20px'
}}></div>;

function JiHuBi({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.div layout={true} data-id="frame-root" style={{
      position: 'absolute',
      width: '940px',
      height: '483px',
      ...style
    }}>
      <Marquee data-id="marquee-1">{cn_frame_1}</Marquee>
    </motion.div>
  );
}

export default withResponsiveProps(JiHuBi);
`;

  it('does NOT emit initial={initialVariant} on a slot-hoisted canvas node', () => {
    const out = updateVariantStyleInCode(BASE, 'frame-1', 'default', { backgroundColor: '#ab6f75' });

    // The cn_ const should have `variants={…}` but NEITHER `initial={initialVariant}`
    // NOR `animate={initialVariant}` (would crash at module load).
    const cnDecl = out.match(/const cn_frame_1[\s\S]*?;/)?.[0] ?? '';
    expect(cnDecl).toContain('variants={');
    expect(cnDecl).not.toContain('initial={initialVariant}');
    expect(cnDecl).not.toContain('animate={initialVariant}');
  });

  it('inserts the variants const BEFORE the cn_ const (prevents TDZ)', () => {
    const out = updateVariantStyleInCode(BASE, 'frame-1', 'default', { backgroundColor: '#ab6f75' });

    // The variants object must be declared BEFORE the cn_ const that references it.
    const variantsIdx = out.search(/const\s+frame1Variants\s*=/);
    const cnIdx = out.indexOf('const cn_frame_1 =');
    expect(variantsIdx).toBeGreaterThan(-1);
    expect(cnIdx).toBeGreaterThan(-1);
    expect(variantsIdx).toBeLessThan(cnIdx);
  });
});


describe('updateVariantStyleInCode — rotate: 0 override on a variant (not stripped)', () => {
  // Regression: rotating a plain motion element back to 0° on a NON-default
  // variant whose DEFAULT variant is rotated (e.g. 90°) must write an EXPLICIT
  // `rotate: 0` — a real override that differs from the inherited 90°. The
  // rotate HANDLE used to commit `transform: mergeRotation(orig, 0) === ''`,
  // which the variant routing reads as "reset override" and DELETES the key,
  // leaving `'variant-1': {}` (the tile rendered rotated like the primary).
  // The handle now routes plain variant rotations through commitVariantRotation
  // → `updateVariantStyle { rotate: '0' }`; this asserts the generator keeps it.
  const BASE = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 500, y: 0 },
];

const pTrackVariants = {
  default: { fontSize: '20px', rotate: 90 },
  'variant-1': {},
};

function LeCeJo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.p layout={true} data-id="p-track" variants={pTrackVariants} initial={['default', initialVariant]} style={{ rotate: '90', fontSize: '20px' }} animate={['default', initialVariant]}>Tracking</motion.p>
  );
}

export default withResponsiveProps(LeCeJo);
`;

  it('writes rotate: 0 into the variant entry (does NOT leave it empty)', () => {
    const out = updateVariantStyleInCode(BASE, 'p-track', 'variant-1', { rotate: '0' });
    // The variant-1 entry must carry an explicit numeric `rotate: 0`.
    const v1 = out.match(/'variant-1':\s*\{([^}]*)\}/);
    expect(v1).not.toBeNull();
    expect(v1![1]).toMatch(/rotate:\s*0\b/);
    // The default's 90° must NOT be clobbered.
    expect(out).toMatch(/default:\s*\{[^}]*rotate:\s*90\b/);
  });
});


describe('MotionLink variant style + comma values (the per-variant rgba crash)', () => {
  // The "Start free trial" button is `<MotionLink>` (= motion.create(Link)). It
  // forwards `variants`/`animate`, so a per-variant style belongs in the variants
  // OBJECT — not the inline-ternary path that PascalCase component instances use.
  // Misrouting it there, then writing an rgba() value, shredded the value on its
  // commas → "Unexpected token". Two guards: (1) MotionLink uses the variants
  // object; (2) the inline-ternary writer is comma-safe for real instances.
  const MOTIONLINK = `import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { withResponsiveProps } from '@revyme/runtime';
const MotionLink = motion.create(Link);
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Hover', x: 0, y: 120, interactionType: 'hover', parentVariant: 'default' },
];
function StartTrialButton({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  return <MotionLink data-id="cta" data-name="Start Trial Button" {...rest} href="#" layout={true} initial={['default', initialVariant]} animate={['default', variant]} style={{
    position: 'absolute',
    width: '194px',
    height: '48px',
    backgroundColor: '#000000'
  }}>x</MotionLink>;
}
export default withResponsiveProps(StartTrialButton);
`;

  it('routes a MotionLink per-variant color to the variants OBJECT (not an inline ternary) and stays valid', () => {
    const out = updateVariantStyleInCode(MOTIONLINK, 'cta', 'default-hover', { backgroundColor: 'rgba(71, 117, 71, 0.45)' });
    // No inline conditional ternary on the MotionLink style.
    expect(out).not.toMatch(/backgroundColor:\s*variant\s*===/);
    // The color lands in a variants object, with the commas intact.
    expect(out).toContain('rgba(71, 117, 71, 0.45)');
    expect(out).toMatch(/variants=\{/);
    // Valid JS (this used to throw "Unexpected token").
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  it('setConditionalStyleInCode keeps comma values whole + updates cleanly (no shredding)', () => {
    // Simulate a REAL component-instance inline-ternary write with an rgba value.
    const base = `function C({ initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  return <Inst data-id="x" style={{ position: 'absolute', width: '10px' }}>y</Inst>;
}`;
    const first = setConditionalStyleInCode(base, 'x', 'backgroundColor', 'hover', 'rgba(71, 117, 71, 0.45)');
    expect(first).toContain('rgba(71, 117, 71, 0.45)');
    expect(() => transform(first, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
    // Update to a NEW comma value — the old value must be fully replaced, not
    // partially (the bug left a `, 117, 71, 0.45)' : ''` tail).
    const second = setConditionalStyleInCode(first, 'x', 'backgroundColor', 'hover', 'rgba(87, 195, 87, 0.45)');
    expect(second).toContain('rgba(87, 195, 87, 0.45)');
    expect(second).not.toContain('rgba(71, 117, 71, 0.45)');
    expect((second.match(/rgba\(/g) || []).length).toBe(1); // exactly one color, no leftover fragment
    expect(() => transform(second, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });
});

describe('variant writes on `const canvasNodes` fragment elements (module scope)', () => {
  // A component whose `const canvasNodes = (<>…</>)` fragment holds a floating
  // svg shape. Dragging/resizing it while a variant is active routed a variant
  // write onto it — which injected `variants={…} initial={initialVariant}` (and
  // `initialVariant === …` ternaries). But the fragment is MODULE scope, where
  // `initialVariant` (a function param) is undefined → the generated code fails
  // validation ("References undefined identifier: initialVariant") and the whole
  // mutation batch is rejected, so the drag/resize REVERTS on mouseup. Canvas
  // nodes never participate in variants, so the write must collapse to a plain
  // inline-style write on the element itself.
  const BASE = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 500, y: 0 },
];

function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-1" style={{ position: 'absolute', width: '400px', height: '300px', ...style }}></motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Foo);
const canvasNodes = <>
  <svg data-id="shape-c1" data-name="Triangle" width="100" height="100" viewBox="0 0 100 100" style={{ position: 'absolute', left: '50px', top: '50px', width: '100px', height: '100px' }}>
    <polygon points="50,0 100,100 0,100" fill="#3b82f6" />
  </svg>
  </>;
`;

  const parses = (code: string) => {
    expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  };

  it('updateVariantStyle on a canvas-node shape writes inline (no variants object, no initialVariant)', () => {
    const out = updateVariantStyleInCode(BASE, 'shape-c1', 'default', { left: '80px', top: '80px' });
    parses(out);
    expect(out).not.toContain('shapeC1Variants');
    expect(out).not.toContain('initial={initialVariant}');
    expect(out).toContain("left: '80px'");
    expect(out).toContain("top: '80px'");
  });

  it('setConditionalStyle (variant-1) on a canvas-node shape writes plain inline (no ternary)', () => {
    const out = setConditionalStyleInCode(BASE, 'shape-c1', 'width', 'variant-1', '150px');
    parses(out);
    expect(out).not.toContain("initialVariant === 'variant-1'");
    expect(out).toContain("width: '150px'");
  });
});


describe('setConditionalStyleInCode — first style prop does not leave a dangling comma', () => {
  // Removing the FIRST prop in a style object left a leading comma
  // (`style={{ width: …, height: … }}` → `style={{, height: … }}`) → the
  // "Unexpected token" syntax error that reverted vector/shape variant resizes
  // (their inline style starts with width/height).
  const COMPONENT = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 500, y: 0 },
];

function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-1" style={{ ...style }}>
      <motion.svg data-id="shape-1" data-name="Triangle" viewBox="0 0 100 100" style={{ width: '114px', height: '66px', left: '586px', top: '578px' }}>
        <polygon points="57,0 114,66 0,66" fill="#3b82f6" />
      </motion.svg>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Foo);
`;

  it('removing width (the first prop) keeps valid JSX', () => {
    const out = setConditionalStyleInCode(COMPONENT, 'shape-1', 'width', 'variant-1', '200px');
    expect(out).not.toMatch(/\{\{\s*,/);
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
    expect(out).toContain("initialVariant === 'variant-1' ? '200px' : '114px'");
  });
});


describe('setConditionalStyleInCode — display Hide on a CMS .map() row (plain <Link>)', () => {
  // A CMS row is a plain <Link> (NOT motion.*) inside a .map() callback — a variants
  // OBJECT wouldn't apply at runtime, and it can't be wrapped in AnimatePresence. So
  // per-variant Hide must be an inline `display` ternary (keyed on initialVariant when
  // there are no connections). The Renderer resolves conditionalStyles.display for the
  // template AND every ghost copy.
  const COMPONENT = `'use client';
function Advisors({ style, initialVariant = 'default' }) {
  return <motion.div data-id="list" data-name="Advisors">
    {advisors.map((item, idx) => <Link data-id="item-1" key={idx} style={{
      display: 'flex',
      flexDirection: 'row',
      width: '100%'
    }}>{item.name}</Link>)}
  </motion.div>;
}`;

  test('writes a display:none ternary on variant-1, base flex preserved', () => {
    const out = setConditionalStyleInCode(COMPONENT, 'item-1', 'display', 'variant-1', 'none');
    expect(out).toContain("display: initialVariant === 'variant-1' ? 'none' : 'flex'");
  });

  test('reset (empty value) collapses back to the plain base display', () => {
    let out = setConditionalStyleInCode(COMPONENT, 'item-1', 'display', 'variant-1', 'none');
    out = setConditionalStyleInCode(out, 'item-1', 'display', 'variant-1', '');
    expect(out).toContain("display: 'flex'");
    expect(out).not.toContain("initialVariant === 'variant-1'");
  });
});

describe('setConditionalStyleInCode — layout props as inline ternaries', () => {
  // A component WITH connections → uses `variant` (useState). flexDirection
  // lives in the variants object initially; setting it on variant-1 must move it
  // to an inline ternary AND strip it from every variant entry.
  const COMPONENT = `'use client';
const frameVariants = {
  default: { flexDirection: 'column', width: '440px' },
  'variant-1': { flexDirection: 'column', width: '440px' },
};
function Foo({ style, initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  return <motion.div layout={true} data-id="frame-1" variants={frameVariants} style={{
    position: 'absolute',
    flexDirection: 'column',
    width: '440px',
    ...style
  }} animate={variant}></motion.div>;
}`;

  test('writes a ternary keyed on `variant` and derives default from inline', () => {
    const out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'flexDirection', 'variant-1', 'row');
    // Inline ternary, default branch = the previous inline value 'column'.
    expect(out).toContain("flexDirection: variant === 'variant-1' ? 'row' : 'column'");
    // Inserted before the ...style spread.
    expect(out).toMatch(/flexDirection: variant === 'variant-1' \? 'row' : 'column',\s*\.\.\.style/);
  });

  test('strips flexDirection from EVERY variant object entry', () => {
    const out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'flexDirection', 'variant-1', 'row');
    const constBlock = out.slice(out.indexOf('const frameVariants'), out.indexOf('function Foo'));
    expect(constBlock).not.toContain('flexDirection');
    // Non-layout props in the variant object are untouched.
    expect(constBlock).toContain("width: '440px'");
  });

  test('merges a second variant branch without dropping the first', () => {
    let out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'flexDirection', 'variant-1', 'row');
    out = setConditionalStyleInCode(out, 'frame-1', 'flexDirection', 'variant-2', 'row-reverse');
    expect(out).toContain("variant === 'variant-1' ? 'row'");
    expect(out).toContain("variant === 'variant-2' ? 'row-reverse'");
    expect(out).toContain(": 'column'"); // default preserved
  });

  test('collapses back to a plain value when the variant equals default', () => {
    let out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'flexDirection', 'variant-1', 'row');
    // Set variant-1 back to the default → no non-default branch remains.
    out = setConditionalStyleInCode(out, 'frame-1', 'flexDirection', 'variant-1', 'column');
    expect(out).not.toContain('variant ===');
    expect(out).toContain("flexDirection: 'column'");
  });

  test("reset override (value '') drops the variant branch → collapses to plain default", () => {
    let out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'flexDirection', 'variant-1', 'row');
    expect(out).toContain("variant === 'variant-1' ? 'row'");
    // Reset override on variant-1 → branch removed, back to plain 'column'.
    out = setConditionalStyleInCode(out, 'frame-1', 'flexDirection', 'variant-1', '');
    expect(out).not.toContain('variant ===');
    expect(out).toContain("flexDirection: 'column'");
  });

  test('uses `initialVariant` when the component has no useState variant', () => {
    const noConnections = COMPONENT
      .replace('const [variant, setVariant] = useState(initialVariant);', '')
      .replace('animate={variant}', 'animate={initialVariant}');
    const out = setConditionalStyleInCode(noConnections, 'frame-1', 'gap', 'variant-1', '42px');
    expect(out).toContain("gap: initialVariant === 'variant-1' ? '42px' : '0px'");
  });

  // "Remove layout" on a component MASTER: the Layout tool's minus button clears
  // every flex/grid prop on the DEFAULT variant. Each clear must fully REMOVE the
  // inline prop — NOT rewrite it to CSS_LAYOUT_DEFAULTS. A leftover
  // `gridAutoFlow: 'row'` / `flexDirection: 'row'` keeps hasFlexProps/hasGridProps
  // true → the tool re-detects a grid it can never clear ("switches to GRID, stuck").
  describe('remove layout — clearing the default branch drops the prop', () => {
    const MASTER = `'use client';
const frameVariants = { default: { order: 3, display: 'block' } };
function Foo({ style, initialVariant = 'default' }) {
  return <motion.div layout={true} data-id="frame-1" variants={frameVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{
    position: 'relative',
    width: '100%',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: '0px',
    gridAutoFlow: 'row',
    gridTemplateColumns: ''
  }}></motion.div>;
}`;

    test('clearing flexDirection on default removes it (no CSS-default writeback)', () => {
      const out = setConditionalStyleInCode(MASTER, 'frame-1', 'flexDirection', 'default', '');
      expect(out).not.toMatch(/flexDirection\s*:/);
      // Untouched siblings remain.
      expect(out).toContain("width: '100%'");
    });

    test('clearing gridAutoFlow on default removes it — not rewritten to row', () => {
      const out = setConditionalStyleInCode(MASTER, 'frame-1', 'gridAutoFlow', 'default', '');
      expect(out).not.toMatch(/gridAutoFlow\s*:/);
    });

    test('clearing every layout prop leaves a syntactically valid, layout-free style', () => {
      const LAYOUT_PROPS = [
        'flexDirection', 'alignItems', 'justifyContent', 'flexWrap', 'alignContent',
        'gap', 'rowGap', 'gridTemplateColumns', 'gridTemplateRows', 'gridAutoRows',
        'gridAutoColumns', 'gridAutoFlow', 'justifyItems', 'columnGap',
      ];
      let out = MASTER;
      for (const p of LAYOUT_PROPS) out = setConditionalStyleInCode(out, 'frame-1', p, 'default', '');
      // None of the layout props survive.
      for (const p of LAYOUT_PROPS) expect(out).not.toContain(`${p}:`);
      // Still parses.
      expect(() => transform(out, { presets: ['react'], filename: 'f.jsx' })).not.toThrow();
      // Non-layout inline props survive.
      expect(out).toContain("width: '100%'");
      expect(out).toContain("position: 'relative'");
    });

    test('a sibling-variant branch is preserved when only the default is cleared', () => {
      // flexDirection overridden on variant-1 → clearing default keeps the ternary
      // (with a CSS-default else) rather than nuking the whole prop.
      let out = setConditionalStyleInCode(MASTER, 'frame-1', 'flexDirection', 'variant-1', 'column');
      expect(out).toContain("=== 'variant-1' ? 'column'");
      out = setConditionalStyleInCode(out, 'frame-1', 'flexDirection', 'default', '');
      // Still a ternary (variant-1 override survives), NOT removed.
      expect(out).toContain("=== 'variant-1' ? 'column'");
    });
  });

  // width/height: routed through the SAME conditional-style path so a per-variant
  // RESIZE rides the `layout` FLIP instead of value-tweening out of sync with the
  // children's reflow (the menu-shove bug). px values, default derived from inline.
  test('width: variant resize writes a px ternary + strips width from variants', () => {
    const out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'width', 'variant-1', '600px');
    // Inline ternary, default branch = the previous inline width '440px'.
    expect(out).toContain("width: variant === 'variant-1' ? '600px' : '440px'");
    // Stripped from EVERY variant object entry so motion can't overlay + value-tween it.
    const constBlock = out.slice(out.indexOf('const frameVariants'), out.indexOf('function Foo'));
    expect(constBlock).not.toContain('width');
    // flexDirection (still in variants) untouched.
    expect(constBlock).toContain("flexDirection: 'column'");
  });

  test('height: variant resize builds a ternary from the inline base', () => {
    // Add an inline height to derive the default branch from.
    const withH = COMPONENT.replace("width: '440px',\n    ...style", "width: '440px',\n    height: '125px',\n    ...style");
    const out = setConditionalStyleInCode(withH, 'frame-1', 'height', 'variant-2', '462px');
    expect(out).toContain("height: variant === 'variant-2' ? '462px' : '125px'");
  });

  test('width: reset override (value "") drops the variant branch → back to plain inline', () => {
    let out = setConditionalStyleInCode(COMPONENT, 'frame-1', 'width', 'variant-1', '600px');
    expect(out).toContain("width: variant === 'variant-1' ? '600px' : '440px'");
    out = setConditionalStyleInCode(out, 'frame-1', 'width', 'variant-1', '');
    expect(out).not.toContain('variant ===');
    expect(out).toContain("width: '440px'");
  });
});

describe('updateVariantStyleInCode — every variant element gets its OWN animate', () => {
  // Relying on framer-motion parent→child propagation (only the first element
  // carrying animate) breaks across COMPONENT boundaries: a child with variants
  // but no animate inherits the OUTER component's variant when nested. So EACH
  // variant element must carry its own `animate={initialVariant}`.
  const COMP = `'use client';
import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [{ name: 'default', label: 'F', x:0,y:0, isPrimary:true }, { name: 'variant-1', label: 'F', x:100,y:0 }];
function Foo({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <div data-id="root" style={{ position: 'absolute' }}>
      <div data-id="bar-a" style={{ position: 'absolute', top: '12px' }}></div>
      <div data-id="bar-b" style={{ position: 'absolute', top: '37px' }}></div>
    </div>
  </LayoutGroup>;
}`;

  test('two sibling variant elements BOTH get animate (not just the first)', () => {
    let out = updateVariantStyleInCode(COMP, 'bar-a', 'variant-1', { transform: 'rotate(45deg)' });
    out = updateVariantStyleInCode(out, 'bar-b', 'variant-1', { transform: 'rotate(-45deg)' });
    // Each bar's tag carries its own animate.
    const aIdx = out.indexOf('data-id="bar-a"');
    const aTag = out.slice(out.lastIndexOf('<', aIdx), out.indexOf('>', aIdx));
    expect(aTag).toContain("animate={['default', initialVariant]}");
    const bIdx = out.indexOf('data-id="bar-b"');
    const bTag = out.slice(out.lastIndexOf('<', bIdx), out.indexOf('>', bIdx));
    expect(bTag).toContain("animate={['default', initialVariant]}");
  });

  test('uses animate={variant} when the component has a useState variant (connections)', () => {
    const withVariant = COMP.replace(
      'function Foo({ style, initialVariant = \'default\' }) {',
      'function Foo({ style, initialVariant = \'default\' }) {\n  const [variant, setVariant] = useState(initialVariant);',
    );
    const out = updateVariantStyleInCode(withVariant, 'bar-a', 'variant-1', { transform: 'rotate(45deg)' });
    const aIdx = out.indexOf('data-id="bar-a"');
    const aTag = out.slice(out.lastIndexOf('<', aIdx), out.indexOf('>', aIdx));
    expect(aTag).toContain("animate={['default', variant]}");
  });
});

describe('updateVariantStyleInCode — transform string → motion motion props', () => {
  const COMP = `'use client';
import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [{ name: 'default', label: 'F', x:0,y:0, isPrimary:true }, { name: 'variant-1', label: 'F', x:100,y:0 }];
function Foo({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <div data-id="root" style={{ position: 'absolute' }}>
      <div data-id="bar" style={{ position: 'absolute' }}></div>
    </div>
  </LayoutGroup>;
}`;

  test('writes rotate: 30 (motion prop, unquoted) — NOT transform: rotate(30deg)', () => {
    // A raw transform string on a layout={true} element fights motion's FLIP
    // projection; the motion prop composes with it.
    const out = updateVariantStyleInCode(COMP, 'bar', 'variant-1', { transform: 'rotate(30deg)' });
    expect(out).toContain('rotate: 30');
    expect(out).not.toContain("transform: 'rotate(30deg)'");
    expect(out).not.toContain('transform: "rotate(30deg)"');
  });

  test('compound transform → multiple motion props', () => {
    const out = updateVariantStyleInCode(COMP, 'bar', 'variant-1', { transform: 'rotate(15deg) scale(0.5)' });
    expect(out).toContain('rotate: 15');
    expect(out).toContain('scale: 0.5');
    expect(out).not.toContain('transform:');
  });

  test('leaves non-transform styles untouched', () => {
    const out = updateVariantStyleInCode(COMP, 'bar', 'variant-1', { backgroundColor: '#fff', transform: 'rotate(10deg)' });
    expect(out).toContain("backgroundColor: '#fff'");
    expect(out).toContain('rotate: 10');
  });

  test('repeated NEGATIVE rotate writes REPLACE (no duplicate keys piling up)', () => {
    // Regression: the replace regex matched only positive numbers, so an
    // existing `rotate: -2` was missed and a new key appended each drag frame.
    let out = updateVariantStyleInCode(COMP, 'bar', 'variant-1', { transform: 'rotate(-2deg)' });
    out = updateVariantStyleInCode(out, 'bar', 'variant-1', { transform: 'rotate(-25deg)' });
    out = updateVariantStyleInCode(out, 'bar', 'variant-1', { transform: 'rotate(-30deg)' });
    // Exactly ONE rotate key in the variant-1 ENTRY (its own braces — the
    // default entry now also carries a neutral `rotate: 0`). Scope to the
    // barVariants const (variantConfig also has a `'variant-1'`).
    const vc = out.slice(out.indexOf('barVariants'));
    const v1Start = vc.indexOf("'variant-1'");
    const v1 = vc.slice(vc.indexOf('{', v1Start), vc.indexOf('}', vc.indexOf('{', v1Start)));
    expect((v1.match(/rotate:/g) || []).length).toBe(1);
    expect(v1).toContain('rotate: -30');
    expect(v1).not.toContain('rotate: -2');
  });

  test('setting a transform on a non-default variant adds NEUTRAL values to default (animate-back)', () => {
    // framer-motion can only animate a prop BACK if the target variant sets it.
    // So `default` must get rotate:0 / skewX:0 etc. when variant-1 sets them.
    const out = updateVariantStyleInCode(COMP, 'bar', 'variant-1', { transform: 'rotate(47deg) skewX(28deg)' });
    const vc = out.slice(out.indexOf('barVariants'));
    const def = vc.slice(vc.indexOf('default'), vc.indexOf('}', vc.indexOf('{', vc.indexOf('default'))));
    expect(def).toContain('rotate: 0');   // neutral, unquoted
    expect(def).toContain('skewX: 0');
  });
});

describe('updateVariantStyleInCode — empty values never bake into a variant (default included)', () => {
  // Repro of the multi-select fill bug: SelectionTool writes
  // { backgroundColor, background: '', backgroundImage: '' } to the DEFAULT
  // variant. The empties used to land literally; framer-motion then applies
  // the empty `background` shorthand over the just-set backgroundColor and the
  // node renders with NO color.
  const COMP = `'use client';
const fooVariants = {
  default: { top: '16px', rotate: 0,},
  'variant-1': { top: '26.5px', rotate: 45,},
};
function C({ style, initialVariant = 'default' }) {
  return (
    <motion.div data-id="foo" variants={fooVariants} initial={initialVariant} animate={initialVariant} style={{position: 'absolute', backgroundColor: '#bae1ff'}}></motion.div>
  );
}`;

  const sliceDefault = (out: string) => {
    const vc = out.slice(out.indexOf('fooVariants'));
    return vc.slice(vc.indexOf('default'), vc.indexOf('}', vc.indexOf('{', vc.indexOf('default'))) + 1);
  };

  test('multi-fill: backgroundColor written, empty background/backgroundImage NOT', () => {
    const out = updateVariantStyleInCode(COMP, 'foo', 'default', {
      backgroundColor: '#ffffff', background: '', backgroundImage: '',
    });
    const def = sliceDefault(out);
    expect(def).toContain("backgroundColor: '#ffffff'");
    expect(def).not.toContain("background: ''");
    expect(def).not.toContain("backgroundImage: ''");
    // and the whole file is parseable JS (no `key: ''` corruption)
    expect(out).not.toMatch(/background:\s*'',/);
  });

  test('empty value DELETES an existing key from the default variant', () => {
    // default already carries background: 'red'; writing '' must remove it,
    // not leave `background: ''`.
    const withBg = COMP.replace("default: { top: '16px', rotate: 0,}", "default: { top: '16px', rotate: 0, background: 'red',}");
    const out = updateVariantStyleInCode(withBg, 'foo', 'default', { background: '' });
    const def = sliceDefault(out);
    expect(def).not.toContain('background:');
  });

  test('non-default variant still strips empties (unchanged behavior)', () => {
    const out = updateVariantStyleInCode(COMP, 'foo', 'variant-1', {
      backgroundColor: '#ffffff', background: '', backgroundImage: '',
    });
    const vc = out.slice(out.indexOf('fooVariants'));
    const v1 = vc.slice(vc.indexOf("'variant-1'"), vc.indexOf('}', vc.indexOf('{', vc.indexOf("'variant-1'"))) + 1);
    expect(v1).toContain("backgroundColor: '#ffffff'");
    expect(v1).not.toContain("background: ''");
  });
});

describe('updateVariantStyleInCode — CSS custom-property keys are QUOTED (valid JS)', () => {
  // Detaching an overlay-border variable per variant writes `--X` into the variant object.
  // A bare `--X:` key is a JS syntax error — it must be quoted (`'--X': '...'`). This covers
  // both creating the variants const and adding to an existing entry.
  const WITH_VARIANTS = `'use client';
const fooVariants = {
  default: { backgroundColor: '#bae1ff' },
  'variant-1': { backgroundColor: '#bae1ff' },
};
function C({ style, initialVariant = 'default', azegazegzeg = "" }) {
  return (
    <motion.div data-id="foo" variants={fooVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'absolute', "--azegazegzeg": azegazegzeg }}></motion.div>
  );
}`;
  const NO_VARIANTS = `'use client';
function C({ style, initialVariant = 'default', azegazegzeg = "" }) {
  return (
    <motion.div data-id="foo" initial={initialVariant} animate={initialVariant} style={{ position: 'absolute', "--azegazegzeg": azegazegzeg }}></motion.div>
  );
}`;

  test('adds a quoted --custom-prop to an existing variant entry', () => {
    const out = updateVariantStyleInCode(WITH_VARIANTS, 'foo', 'variant-1', { '--azegazegzeg': 'none' });
    expect(out).toContain("'--azegazegzeg': 'none'");
    expect(out).not.toMatch(/[^'"]--azegazegzeg\s*:/); // never a bare unquoted key
    // The variants object literal must still be valid JS.
    const objSrc = out.slice(out.indexOf('{', out.indexOf('fooVariants')), out.indexOf('};', out.indexOf('fooVariants')) + 1);
    expect(() => new Function(`return ${objSrc}`)).not.toThrow();
  });

  test('creates a variants const with a quoted --custom-prop key', () => {
    const out = updateVariantStyleInCode(NO_VARIANTS, 'foo', 'variant-1', { '--azegazegzeg': 'none' });
    expect(out).toContain("'--azegazegzeg': 'none'");
    expect(out).not.toMatch(/[^'"]--azegazegzeg\s*:/);
  });

  test('re-setting an existing quoted --custom-prop replaces (no duplicate key)', () => {
    const once = updateVariantStyleInCode(WITH_VARIANTS, 'foo', 'variant-1', { '--azegazegzeg': 'none' });
    const twice = updateVariantStyleInCode(once, 'foo', 'variant-1', { '--azegazegzeg': '0px solid red' });
    expect(twice).toContain("'--azegazegzeg': '0px solid red'");
    expect(twice).not.toContain("'--azegazegzeg': 'none'");
    // Within the variant-1 entry specifically, the key appears exactly once (replaced, not
    // duplicated). The inline base style keeps its own `"--azegazegzeg": azegazegzeg` — that's
    // the variable binding, expected to remain.
    const vc = twice.slice(twice.indexOf('fooVariants'));
    const v1 = vc.slice(vc.indexOf("'variant-1'"), vc.indexOf('}', vc.indexOf('{', vc.indexOf("'variant-1'"))) + 1);
    expect((v1.match(/--azegazegzeg/g) || []).length).toBe(1);
  });

  test('empty value DELETES a quoted --custom-prop from a variant (re-attach reverts to base)', () => {
    // The "Set Variable" re-attach on a non-primary variant clears the detach override
    // (`--X: none`) so the variant inherits the base binding again. Empty value = delete key.
    const code = `'use client';
const fooVariants = {
  default: {},
  'variant-1': { '--azegazegzeg': 'none', boxShadow: '0px 4px 8px rgba(0,0,0,0.25)' },
};
function C({ style, initialVariant = 'default', azegazegzeg = "" }) {
  return <motion.div data-id="foo" variants={fooVariants} initial={initialVariant} animate={initialVariant} style={{ "--azegazegzeg": azegazegzeg }}></motion.div>;
}`;
    const out = updateVariantStyleInCode(code, 'foo', 'variant-1', { '--azegazegzeg': '' });
    const vc = out.slice(out.indexOf('fooVariants'));
    const v1 = vc.slice(vc.indexOf("'variant-1'"), vc.indexOf('}', vc.indexOf('{', vc.indexOf("'variant-1'"))) + 1);
    expect(v1).not.toContain('--azegazegzeg'); // detach override removed → inherits base binding
    expect(v1).toContain('boxShadow');         // siblings untouched
  });
});

describe('updateVariantStyleInCode — nested svg group → motion converts the MATCHING close', () => {
  // Dragging a vector GROUP (nested <svg> in <svg>) into a variant on a component
  // master. Converting the tag to motion.* must depth-count to the group's OWN
  // closing </svg>, not a child's — else `<svg>…</motion.svg>` mismatched tags
  // crash with "Expected corresponding JSX closing tag for <svg>".
  const BASE = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
];

function FiLiZo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.div layout={true} data-id="frame-root" style={{ position: 'absolute', ...style }}><svg data-id="grp" data-name="Group" viewBox="0 0 217 202" style={{ position: "absolute", width: "217px", height: "202px" }}><svg data-id="shape-a" x="0" y="57" width="67" height="47" viewBox="0 0 67 47">
      <polygon points="33.5,0 67,47 0,47" fill="#3b82f6" />
    </svg><svg data-id="grp2" x="149" y="0" width="68" height="202" viewBox="0 0 68 202"><svg data-id="shape-b" x="10" y="0" width="58" height="74" viewBox="0 0 58 74">
      <polygon points="29,0 58,74 0,74" fill="#3b82f6" />
    </svg></svg></svg></motion.div>
  );
}

export default withResponsiveProps(FiLiZo);
`;

  it('produces balanced, parseable JSX (group → motion.svg, children stay <svg>)', () => {
    const out = updateVariantStyleInCode(BASE, 'grp', 'default', { opacity: '0.5' });
    // The GROUP itself is now motion.svg, opened AND closed consistently.
    expect(out).toMatch(/<motion\.svg data-id="grp"[\s\S]*?<\/motion\.svg>/);
    // The nested vectors stay plain <svg> — exactly one </motion.svg> exists.
    expect((out.match(/<\/motion\.svg>/g) || []).length).toBe(1);
    expect((out.match(/<motion\.svg/g) || []).length).toBe(1);
    // shape-a is closed by its OWN </svg>, immediately before the sibling <svg.
    expect(out).toContain('</svg><svg data-id="grp2"');
    // And it parses (the actual failure was a Babel JSX-closing-tag error).
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });
});

describe('updateVariantStyleInCode — instance rotation becomes a numeric motion prop', () => {
  // A vector-set instance (PascalCase tag) inside a connected component. Rotation
  // written as a CSS `transform` fights motion's layout projection and never shows
  // on the live site — it must become a `rotate` MOTION prop (numeric, neutral
  // default 0) so motion animates it AND composes with the projection.
  const COMPONENT = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import VuHeMa from '@/icons/VuHeMa';

const variantConfig = [
  { name: 'default', label: 'F', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'F', x: 1042, y: 0 },
];

function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-1" style={{ ...style }} initial={initialVariant} animate={variant}>
      <VuHeMa data-id="vector-1" layout={true} data-name="Group" name="icon-2" style={{ position: 'absolute', left: variant === 'variant-1' ? '35%' : '10%', width: '447px' }} />
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Foo);
`;
  const parses = (out: string) =>
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

  it('writes `rotate` as an unquoted number with a neutral (0) default branch — no CSS transform', () => {
    const out = updateVariantStyleInCode(COMPONENT, 'vector-1', 'variant-1', { transform: 'rotate(-203.1deg)' });
    expect(out).toContain("rotate: variant === 'variant-1' ? -203.1 : 0");
    expect(out).not.toContain('transform:');
    // non-motion ternary (left) stays a quoted string
    expect(out).toContain("left: variant === 'variant-1' ? '35%' : '10%'");
    parses(out);
  });

  it('rotating on default preserves the variant-1 rotation', () => {
    let out = updateVariantStyleInCode(COMPONENT, 'vector-1', 'variant-1', { transform: 'rotate(45deg)' });
    out = updateVariantStyleInCode(out, 'vector-1', 'default', { transform: 'rotate(10deg)' });
    expect(out).toContain("rotate: variant === 'variant-1' ? 45 : 10");
    parses(out);
  });

  it('resetting the rotation removes the rotate prop entirely', () => {
    let out = updateVariantStyleInCode(COMPONENT, 'vector-1', 'variant-1', { transform: 'rotate(45deg)' });
    out = updateVariantStyleInCode(out, 'vector-1', 'variant-1', { transform: '' });
    expect(out).not.toContain('rotate');
    parses(out);
  });

  it('migrates a stale CSS transform ternary to a rotate motion prop on the next rotate', () => {
    const withStale = COMPONENT.replace(
      "width: '447px'",
      "width: '447px', transform: variant === 'variant-1' ? 'rotate(-203.1deg)' : ''",
    );
    const out = updateVariantStyleInCode(withStale, 'vector-1', 'variant-1', { transform: 'rotate(90deg)' });
    expect(out).not.toContain('rotate(');         // CSS transform gone
    expect(out).toContain("rotate: variant === 'variant-1' ? 90 : 0");
    parses(out);
  });
});

describe('updateVariantStyleInCode — rotation pivot mirrored to the default variant', () => {
  // A normal <motion.svg> group with an existing variants object (position only).
  // Rotating it on variant-1 must mirror the pivot (transformBox/transformOrigin)
  // AND a neutral rotate:0 onto the DEFAULT entry — else motion animates the
  // origin into existence on the first transition and the rotation wobbles.
  const BASE = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'F', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'F', x: 776, y: 0 },
];
const vec1Variants = {
  default: { left: '113px', top: '84px' },
};
function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-1" style={{ ...style }} animate={variant}>
      <motion.svg data-id="vector-1" variants={vec1Variants} initial={initialVariant} data-name="Group" style={{ position: 'absolute', left: '113px', top: '84px', width: '349px', height: '264px' }} animate={variant}></motion.svg>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Foo);
`;

  it('mirrors transformBox + transformOrigin + rotate:0 to the default entry', () => {
    const out = updateVariantStyleInCode(BASE, 'vector-1', 'variant-1', {
      transform: 'rotate(32deg)', transformBox: 'border-box', transformOrigin: '174.5px 132px',
    });
    const def = out.match(/default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).toContain('rotate: 0');
    expect(def).toContain("transformBox: 'border-box'");
    expect(def).toContain("transformOrigin: '174.5px 132px'");
    // variant-1 still carries the actual rotation
    expect(out).toMatch(/'variant-1':\s*\{[^}]*rotate:\s*32/);
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  it('does NOT add pivot props to default on a non-rotation write', () => {
    const out = updateVariantStyleInCode(BASE, 'vector-1', 'variant-1', { backgroundColor: '#fff' });
    const def = out.match(/default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).not.toContain('transformOrigin');
    expect(def).not.toContain('transformBox');
  });
});

describe('geometry as a routed `d` style (per-tile shape edit foundation)', () => {
  // Per-tile shape geometry is carried as the CSS `d` property so it rides the
  // SAME variant-object / @media rails as width/height — confirm both generators
  // accept a `d` value (it is NOT special-cased) and emit valid output.
  const COMPONENT = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'F', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'F', x: 1, y: 0 }];
function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup><motion.div layout={true} data-id="frame-1" style={{ ...style }} animate={variant}>
    <path data-id="p1" d="M0,0 L10,10 Z" />
  </motion.div></LayoutGroup>;
}
export default withResponsiveProps(Foo);`;

  const PAGE = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root">
      <path data-id="p1" d="M0,0 L10,10 Z" style={{ width: '10px' }} />
  <style>{\`
    @media (max-width: 768px) and (min-width: 376px) {
      [data-id="p1"] { width: 10px !important; }
    }
  \`}</style>
    </div>
  );
}`;

  it('updateVariantStyleInCode stores RAW `d` (motion animates the d attribute, not CSS path())', () => {
    // Caller passes the CSS `path("…")` form (correct for @media); the variant writer must UNWRAP it to
    // raw path data, or framer-motion sets an invalid `d` attribute and the shape vanishes on the live site.
    const out = updateVariantStyleInCode(COMPONENT, 'p1', 'variant-1', { d: 'path("M0,0 L5,5 Z")' });
    expect(out).toContain("d: 'M0,0 L5,5 Z'");
    expect(out).not.toContain('path("M0,0 L5,5 Z")');
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  it('updateContainerQueryStyle puts `d` in an @media rule', () => {
    const out = updateContainerQueryStyle(PAGE, 'p1', 768, { d: 'path("M0,0 L5,5 Z")' });
    expect(out).toContain('d: path("M0,0 L5,5 Z") !important');
  });

  it('svg wrapper per-variant SIZE migrates from inline ternary into the variants object', () => {
    // `layout` FLIP can't project an <svg> root, so a width/height ternary on a
    // motion.svg never animates in the live runtime. Size must live in the
    // variants object (value-tween). An OLDER inline ternary is collapsed to its
    // default branch so a stale conditional can't ride on top of the variant.
    const SVG = `const sVariants = {
  default: { left: '117px', top: '136px' },
  'variant-1': { left: '117px', top: '40px' },
};
function C({ initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  return <motion.svg data-id="s2" variants={sVariants} initial={initialVariant} viewBox="0 0 266 340" style={{ position: 'absolute', left: '117px', top: '136px', width: '266px', height: variant === 'variant-1' ? '532px' : '340px' }} animate={variant} />;
}`;
    const out = updateVariantStyleInCode(SVG, 's2', 'variant-1', { width: '266px', height: '532px', left: '117px', top: '40px' });
    // inline ternary collapsed to its static default branch
    expect(out).toContain("height: '340px'");
    expect(out).not.toContain("? '532px'");
    // size now value-tweens from the variants object
    expect(out).toMatch(/'variant-1':\s*\{[^}]*height:\s*'532px'/);
    expect(out).toMatch(/default:\s*\{[^}]*height:\s*'340px'/);
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  it('HTML child width/height ternary is NOT touched (only svg wrappers migrate)', () => {
    const HTML = `function C({ initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  return <motion.div data-id="d2" variants={dVariants} style={{ width: '100px', height: variant === 'variant-1' ? '50px' : '20px' }} animate={variant} />;
}`;
    const out = updateVariantStyleInCode(HTML, 'd2', 'variant-1', { left: '5px' });
    // the div keeps its inline FLIP ternary — only the new prop is added
    expect(out).toContain("? '50px'");
  });
});

describe('readBaseValues anchoring (the x-matches-transformBox corruption, 2026-06-11)', () => {
  const CODE = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'B', x: 600, y: 0 }];

function Card({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="root-frame" data-name="Frame" style={{ position: 'absolute', width: '676px', height: '481px', ...style }}>
      <svg data-id="group-1" data-name="Group" viewBox="0 0 413 314" style={{ position: 'absolute', left: '132px', top: '84px', width: '413px', height: '314px', overflow: 'visible' }}><motion.svg data-id="shape-plain" data-name="Triangle" x="0" y="0" width="124" height="134" viewBox="0 0 124 134" overflow="visible">
        <polygon points="62,0 124,134 0,134" fill="#3b82f6" />
      </motion.svg><motion.svg data-id="shape-pivot" data-name="Triangle" x="317" y="197" width="143" height="79" viewBox="0 0 143 79" overflow="visible" style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}>
        <polygon points="71.5,0 143,79 0,79" fill="#3b82f6" />
      </motion.svg></svg>
    </motion.div>
  </LayoutGroup>;
}

export default withResponsiveProps(Card);
`;

  it('x base value never reads transformBox value (anchored key match)', () => {
    const out = updateVariantStyleInCode(CODE, 'shape-pivot', 'variant-1', { x: '-317', y: '-3' });
    const def = out.match(/shapePivotVariants = \{[\s\S]*?default: \{([^}]*)\}/)?.[1] ?? '';
    expect(def).not.toContain('fill-box');
    expect(def).toContain('x: 0');
  });

  it('a STYLELESS tag never reads the next sibling tag style object (tag-bound)', () => {
    const out = updateVariantStyleInCode(CODE, 'shape-plain', 'variant-1', { x: '193', y: '0' });
    const def = out.match(/shapePlainVariants = \{[\s\S]*?default: \{([^}]*)\}/)?.[1] ?? '';
    expect(def).not.toContain('fill-box');
    expect(def).toContain('x: 0');
  });
});

describe('orphan variants const (already-declared crash, 2026-06-12)', () => {
  const ORPHAN_CODE = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'B', x: 1048, y: 0 }];

const pathMqa2sv924Variants = {
  default: { left: '533px', top: '169px' },
  'variant-1': { left: '533px', top: '169px' },
};

function Card({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="root-frame" data-name="Frame" style={{ position: 'absolute', width: '848px', height: '431px', ...style }}>
      <motion.svg data-id="group-1" data-name="Group" viewBox="0 0 610 259" style={{ position: 'absolute', left: '87px', top: '86px', width: '610px', height: '259px', overflow: 'visible' }}><svg data-id="path-mqa2sv92-4" data-name="Path" x="377" y="63" width="233" height="196" viewBox="650 386 233 196" overflow="visible">
    <path data-id="path-mqa2sv92-4-g0" d="M677 515L682 387z" fill="none" stroke="#c12525" strokeWidth="15"></path>
  </svg></motion.svg>
    </motion.div>
  </LayoutGroup>;
}

export default withResponsiveProps(Card);
`;

  it('reuses the existing const instead of re-declaring (validator-clean)', async () => {
    const out = updateVariantStyleInCode(ORPHAN_CODE, 'path-mqa2sv92-4', 'variant-1', { x: '115', y: '-63' });
    // exactly ONE declaration
    expect([...out.matchAll(/const pathMqa2sv924Variants\s*=/g)]).toHaveLength(1);
    // the tag got wired: variants prop + motionized open/close
    expect(out).toContain('variants={pathMqa2sv924Variants}');
    expect(out).toContain('<motion.svg data-id="path-mqa2sv92-4"');
    // the entry landed in the EXISTING const
    const entry = out.match(/pathMqa2sv924Variants = \{[\s\S]*?'variant-1': \{([^}]*)\}/)?.[1] ?? '';
    expect(entry).toContain('x: 115');
    expect(entry).toContain('y: -63');
    // and the result passes the mutation validator (no duplicate identifier)
    const { validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
    expect(validateGeneratedCode(out)).toBeNull();
  });

  it('a fresh node (no orphan) still creates the const exactly once', () => {
    const fresh = ORPHAN_CODE.replace(/const pathMqa2sv924Variants = \{[\s\S]*?\};\n\n/, '');
    const out = updateVariantStyleInCode(fresh, 'path-mqa2sv92-4', 'variant-1', { x: '115', y: '-63' });
    expect([...out.matchAll(/const pathMqa2sv924Variants\s*=/g)]).toHaveLength(1);
    expect(out).toContain('variants={pathMqa2sv924Variants}');
  });
});


describe('updateVariantStyleInCode — SVG presentation animate-back seeds', () => {
  // The live-site stuck-fill (2026-06-12): variant-1 set fill/strokeWidth/
  // strokeDasharray but default stayed {} — the seed only read inline style,
  // and shape bases live as TAG ATTRS. Reverting default→ kept the variant
  // values (motion keeps unstated animated values). The seed now falls back
  // to the tag's attrs (camel or kebab) and SVG spec defaults, and any write
  // HEALS bases for every prop the entry already carries.
  const FIXTURE = `import { motion } from 'framer-motion';
const g0Variants = {
  default: {},
  'variant-1': { strokeDasharray: '11,6' }
};
function Card({ initialVariant = 'default' }) {
  return <motion.svg data-id="shape-1" x="101" y="166" width="112" height="56" viewBox="0 0 112 56" overflow="visible">
    <motion.path data-id="shape-1-g0" variants={g0Variants} initial={['default', initialVariant]} fill="#3b82f6" stroke="#000000" stroke-width="0" d="M56,0 L112,56 L0,56 Z" />
  </motion.svg>;
}
export default Card;
`;

  test('fill write seeds the default from the tag ATTR + heals existing entry props', () => {
    const out = updateVariantStyleInCode(FIXTURE, 'shape-1-g0', 'variant-1', { fill: '#191d22' });
    const def = out.match(/g0Variants = \{[\s\S]*?default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).toContain("fill: '#3b82f6'");          // attr base
    expect(def).toContain("strokeDasharray: 'none'");  // HEAL: pre-existing entry prop, spec default
    const v1 = out.match(/'variant-1':\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(v1).toContain("fill: '#191d22'");
  });

  test('strokeWidth seeds from the KEBAB attr form', () => {
    const out = updateVariantStyleInCode(FIXTURE, 'shape-1-g0', 'variant-1', { strokeWidth: '19' });
    const def = out.match(/g0Variants = \{[\s\S]*?default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).toContain("strokeWidth: '0'");
  });
});

describe('responsive breakpoint rewriters preserve CMS field-refs (computed form)', () => {
  // A computed data-responsive carrying a live item.field rebind on 768.
  const COMPUTED = `<ProjectsCard data-id="c1" projectTitle={item.title} data-responsive={JSON.stringify({"768":{"projectTitle":item.shortTitle},"_bp":[1440,768,375]})} />`;
  const parses = (jsx: string) =>
    expect(() => transform(`const x = (${jsx});`, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

  it('resize re-keys the field-ref entry (768 → 800) and keeps item.shortTitle', () => {
    const out = rewriteResponsiveBreakpoints(COMPUTED, 768, 800, [1440, 800, 375]);
    expect(out).toContain('"800":{"projectTitle":item.shortTitle}');
    expect(out).not.toContain('"768":');
    expect(out).toContain('JSON.stringify(');
    parses(out);
  });

  it('add viewport copies the source entry to the new width, preserving the field-ref', () => {
    const out = addResponsiveBreakpoint(COMPUTED, 600, 768, [1440, 768, 600, 375]);
    expect(out).toContain('"600":{"projectTitle":item.shortTitle}');
    expect(out).toContain('"768":{"projectTitle":item.shortTitle}');
    parses(out);
  });

  it('remove viewport drops only that entry (downgrades to no attr when it was the only one)', () => {
    const out = removeResponsiveBreakpoint(COMPUTED, 768, [1440, 375]);
    expect(out).not.toContain('item.shortTitle');
    expect(out).not.toContain('data-responsive'); // 768 was the only entry → attr removed
    parses(out);
  });

  it('leaves the legacy STRING form working too', () => {
    const STR = `<Card data-id="c2" data-responsive='{"768":{"gap":16},"_bp":[1440,768,375]}' />`;
    const out = rewriteResponsiveBreakpoints(STR, 768, 800, [1440, 800, 375]);
    expect(out).toContain(`data-responsive='`);
    expect(out).toContain('"800":{"gap":16}');
    parses(out);
  });
});

describe('writeInstanceConditionalStyles — removing the FIRST style prop leaves no dangling comma', () => {
  // A component INSTANCE (uppercase tag) inside a master routes its per-variant
  // style writes through writeInstanceConditionalStyles. Converting it to
  // absolute clears `order` — which was the FIRST style prop — and the removal
  // regex consumed `order: '1'` but NOT its trailing comma, leaving `style={{,`
  // → a parse crash that took down the whole page.
  const INSTANCE = `'use client';
function Foo({ style, initialVariant = 'default' }) {
  return <div data-id="root">
    <CoVuSe data-id="inst-1" style={{
      order: '1',
      position: 'relative',
      width: '100px',
      height: '45px'
    }} data-name="Text" />
  </div>;
}`;

  it('clearing the first prop (order) does not produce `style={{,`', () => {
    const out = updateVariantStyleInCode(INSTANCE, 'inst-1', 'default', {
      position: 'absolute', left: '84px', top: '85px', flex: '', order: '',
    });
    expect(out).not.toContain('style={{,');
    expect(out).not.toMatch(/style=\{\{\s*,/);
    expect(out).not.toMatch(/order\s*:/);
    // The real move still landed.
    expect(out).toContain("position: 'absolute'");
    expect(out).toContain("left: '84px'");
    // Still parses.
    expect(() => transform(out, { presets: ['react'], filename: 'f.jsx' })).not.toThrow();
  });

  it('clearing the ONLY prop collapses to an empty object, not a comma', () => {
    const single = `function Foo() {
  return <CoVuSe data-id="inst-2" style={{ order: '1' }} data-name="Text" />;
}`;
    const out = updateVariantStyleInCode(single, 'inst-2', 'default', { order: '' });
    expect(out).not.toMatch(/style=\{\{\s*,/);
    expect(() => transform(out, { presets: ['react'], filename: 'f.jsx' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setConditionalOrderInCode — the per-variant FLIP reorder.
//
// Regression suite for the blank-page crash of 2026-07-27: reordering a child
// on a variant tile rewrote `order` into an inline ternary, but the removal of
// the OLD `order: '1',` only consumed a LEADING comma. When `order` happened to
// be the first property in the style object, its trailing comma survived and
// the file was left holding `style={{,` — a syntax error, so the module failed
// to parse and the whole page went blank.
// ─────────────────────────────────────────────────────────────────────────────
describe('setConditionalOrderInCode', () => {
  const parses = (code: string) =>
    expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

  /** A component master — `setConditionalOrderInCode` picks its driver
   *  identifier (`variant` vs `initialVariant`) from the presence of useState. */
  const comp = (styleObj: string) => `'use client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';

function Card({ initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  return (
    <motion.div data-id="row" style={{ display: 'flex' }}>
      <motion.p data-id="p-1" data-name="Tracking Expenses" style={{${styleObj}}}>Tracking expenses</motion.p>
    </motion.div>
  );
}
export default Card;
`;

  const styleOf = (code: string) =>
    code.match(/data-name="Tracking Expenses" style=\{\{([\s\S]*?)\}\}/)![1];

  test('order as the FIRST property — no dangling comma, file still parses', () => {
    // The exact shape from the live component (user report 2026-07-27).
    const before = comp(`
            order: '1',
            transformOrigin: '50% 50%',
            fontSize: '20px'
          `);
    const out = setConditionalOrderInCode(before, 'p-1', { default: 1, 'variant-1': 0 });

    expect(out).not.toContain('style={{,');
    expect(out).not.toMatch(/style=\{\{\s*,/);
    parses(out);
    expect(styleOf(out)).toContain("order: variant === 'variant-1' ? 0 : 1");
    // The old literal must be gone, not merely shadowed.
    expect(styleOf(out)).not.toMatch(/order:\s*'1'/);
  });

  test('order as the ONLY property', () => {
    const out = setConditionalOrderInCode(comp(` order: '2' `), 'p-1', { default: 2, 'variant-1': 0 });
    parses(out);
    expect(styleOf(out)).toContain("order: variant === 'variant-1' ? 0 : 2");
    expect(styleOf(out)).not.toMatch(/order:\s*'2'/);
  });

  test('order in the MIDDLE keeps exactly one separating comma', () => {
    const out = setConditionalOrderInCode(
      comp(` width: 'auto', order: '0', height: 'auto' `), 'p-1', { default: 0, 'variant-1': 3 },
    );
    parses(out);
    expect(styleOf(out)).toMatch(/width: 'auto',\s*height: 'auto'/);
    expect(styleOf(out)).not.toMatch(/,\s*,/);
  });

  test('order LAST', () => {
    const out = setConditionalOrderInCode(
      comp(` width: 'auto', order: '4' `), 'p-1', { default: 4, 'variant-1': 1 },
    );
    parses(out);
    expect(styleOf(out)).not.toMatch(/,\s*,/);
    expect(styleOf(out)).toContain("order: variant === 'variant-1' ? 1 : 4");
  });

  test('a no-op reorder emits a plain literal, not `? 1 : 1`', () => {
    // Dragging a node back to where it already was used to append a dead branch
    // per attempt — `variant === 'variant-1' ? 1 : 1`.
    const out = setConditionalOrderInCode(comp(` order: '1' `), 'p-1', { default: 1, 'variant-1': 1 });
    parses(out);
    // QUOTED. A bare `order: 1` renders but the reorder engine (which serialises
    // `String(n)`) can't resolve it, so dragging the node silently no-ops.
    expect(styleOf(out)).toContain("order: '1'");
    expect(styleOf(out)).not.toMatch(/order:\s*1\b/);
    expect(styleOf(out)).not.toContain('? 1 : 1');
  });

  test("the builder's own oracle accepts every shape this emits", () => {
    // The conformance thesis, applied to this one generator: whatever
    // `setConditionalOrderInCode` writes must survive `checkFile`. Caught the
    // real regression that the collapse-to-literal branch emitted a bare
    // `order: 0`, tripping ORDER_MUST_BE_STRING six times on a live component.
    const cases: Array<[string, Record<string, number>]> = [
      [` order: '1', width: 'auto' `, { default: 1, 'variant-1': 1 }],   // collapses to a literal
      [` order: '0', width: 'auto' `, { default: 0, 'variant-1': 2 }],   // stays a ternary
      [` width: 'auto' `, { default: 0 }],                               // default only
      [` order: '2' `, { default: 2, 'variant-1': 0, 'variant-2': 5 }],  // multi-branch
    ];
    for (const [style, map] of cases) {
      const out = setConditionalOrderInCode(comp(style), 'p-1', map);
      parses(out);
      const codes = checkFile(out, { kind: 'component' })
        .filter(x => x.code === 'ORDER_MUST_BE_STRING' || x.code === 'FLEX_CHILD_MISSING_ORDER');
      expect(codes.map(x => x.code), `for ${style} → ${JSON.stringify(map)}`).toEqual([]);
    }
  });

  test('re-running a reorder does not accumulate branches', () => {
    let out = comp(` order: '0', width: 'auto' `);
    for (let i = 0; i < 4; i++) out = setConditionalOrderInCode(out, 'p-1', { default: 0, 'variant-1': 2 });
    parses(out);
    expect(styleOf(out).match(/variant === 'variant-1'/g)!.length).toBe(1);
  });

  test('existing branches from OTHER variants survive a new reorder', () => {
    const first = setConditionalOrderInCode(comp(` order: '0' `), 'p-1', { default: 0, 'variant-1': 2 });
    const second = setConditionalOrderInCode(first, 'p-1', { default: 0, 'variant-2': 1 });
    parses(second);
    expect(styleOf(second)).toContain("variant === 'variant-1' ? 2");
    expect(styleOf(second)).toContain("variant === 'variant-2' ? 1");
  });

  test('never bites into `border:` (the "b is not defined" trap)', () => {
    const out = setConditionalOrderInCode(
      comp(` border: '1px solid red', borderColor: 'blue', order: '1' `), 'p-1', { default: 1, 'variant-1': 0 },
    );
    parses(out);
    expect(styleOf(out)).toContain("border: '1px solid red'");
    expect(styleOf(out)).toContain("borderColor: 'blue'");
  });

  test('inserts before a `...style` spread so the spread stays last', () => {
    const out = setConditionalOrderInCode(
      comp(` order: '1', width: 'auto', ...style `), 'p-1', { default: 1, 'variant-1': 0 },
    );
    parses(out);
    const s = styleOf(out);
    expect(s.indexOf('order:')).toBeLessThan(s.indexOf('...style'));
  });
});

describe('updateVariantStyleInCode — pure translate (centering pin) stays CSS, no x/y doubling', () => {
  // Center-pin inside a master (user report 2026-07-29): PositionTool writes
  // { left/top %, right/bottom '', transform: 'translate(-50%, -50%)' }. The
  // inline writer (updateNodeInCode) KEEPS a pure translate as CSS `transform`,
  // but this writer converted it to motion x/y in the default mirror — same
  // shift in two channels. resolveVariantStyles folds variant x/y ON TOP of the
  // inline transform → translate(-100%, -100%) → the node jumped up-left by
  // half its size on the tile. A pure translate must stay a `transform` string
  // (the merge then OVERRIDES the identical inline value); rotate/scale/skew
  // keep converting, same gate as updateNodeInCode.
  const MASTER = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'F', x: 0, y: 0, isPrimary: true },
];
const childVariants = {
  default: { left: '52px', top: '100px', right: '52px', bottom: '99px' },
};
function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="root-1" data-name="Frame" style={{ position: 'relative', width: '485px', height: '505px', ...style }}>
      <motion.div layout={true} data-id="child-1" variants={childVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} data-name="Frame" style={{ position: 'absolute', left: '52px', top: '100px', right: '52px', bottom: '99px' }} data-pinned="true"></motion.div>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(Foo);
`;
  const PIN_STYLES = {
    left: '50.0000%', top: '50.0743%', right: '', bottom: '',
    transform: 'translate(-50%, -50%)',
  };

  it('keeps a pure translate as a `transform` string in the default entry (no x/y)', () => {
    const out = updateVariantStyleInCode(MASTER, 'child-1', 'default', PIN_STYLES);
    const def = out.match(/default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).toContain("transform: 'translate(-50%, -50%)'");
    expect(def).not.toMatch(/[{,\s]x:/);
    expect(def).not.toMatch(/[{,\s]y:/);
    // right/bottom cleared from the entry (empty string = remove)
    expect(def).not.toContain('right:');
    expect(def).not.toContain('bottom:');
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  it('still converts rotate/scale/skew transforms to motion props', () => {
    const out = updateVariantStyleInCode(MASTER, 'child-1', 'default', { transform: 'rotate(30deg)' });
    const def = out.match(/default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).toContain('rotate: 30');
    expect(def).not.toContain('transform:');
  });

  it('un-centering (transform reset) removes the stale translate string from the entry', () => {
    // Center first (entry gains the transform string), then convert back to
    // edge pins — the reset write must REMOVE the string, not orphan it.
    const centered = updateVariantStyleInCode(MASTER, 'child-1', 'default', PIN_STYLES);
    const out = updateVariantStyleInCode(centered, 'child-1', 'default', {
      left: '52px', top: '100px', right: '52px', bottom: '99px', transform: '',
    });
    const def = out.match(/default:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(def).not.toContain('transform:');
    expect(def).toContain("left: '52px'");
  });

  it('end-to-end: canvas resolve of the center-pinned tile has a SINGLE translate', () => {
    // Replay the full center-pin mutation sequence the queue runs, then resolve
    // the node exactly like the Renderer does for the master tile.
    let code = MASTER;
    code = setConditionalStyleInCode(code, 'child-1', 'width', 'default', '381px');
    code = setConditionalStyleInCode(code, 'child-1', 'height', 'default', '306px');
    code = updateNodeInCode(code, 'child-1', PIN_STYLES);
    code = updateVariantStyleInCode(code, 'child-1', 'default', PIN_STYLES);
    const nodes = parseJSXToNodes(code);
    const child = nodes.get('child-1')!;
    const resolved = resolveVariantStyles(child, 'default');
    expect(resolved.transform).toBe('translate(-50%, -50%)');
    expect(resolved.left).toBe('50.0000%');
    expect(resolved.top).toBe('50.0743%');
    expect(resolved.right).toBeUndefined();
    expect(resolved.bottom).toBeUndefined();
  });
});
