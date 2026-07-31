// hoist-prop.test.ts — Verify hoistInstancePropInCode rewrites the
// nested-instance prop to an identifier, adds the parent function
// signature destructure, writes the @pageVariables annotation, AND
// sweeps every matching sibling instance under the SAME shared
// variable (per the user's spec).

import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { hoistInstancePropInCode } from './hoist-prop';
import { setScrollVariantInCode, getScrollVariant } from '../generation/scroll-variant-gen';

describe('hoistInstancePropInCode — single instance', () => {
  it('rewrites the source literal into an identifier and adds the variable', () => {
    const code = `import React from 'react';
import RoHuVu from '@/components/RoHuVu';

function UxTaPa({ style, initialVariant = 'default' }) {
  return (
    <div data-id="root">
      <RoHuVu data-id="nested-1" poon="#4e4e2b" />
    </div>
  );
}
export default UxTaPa;`;

    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'nested-1',
      componentName: 'RoHuVu',
      propName: 'poon',
      variable: { name: 'cardBg', type: 'color', default: '#4e4e2b' },
    });

    // JSX rewritten — literal gone, identifier in its place.
    expect(out).toContain('poon={cardBg}');
    expect(out).not.toMatch(/poon="#4e4e2b"/);

    // Function signature destructure gained the new prop with default.
    expect(out).toMatch(/cardBg\s*=\s*['"]#4e4e2b['"]/);

    // @pageVariables annotation written.
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "cardBg"');
    expect(out).toContain('"type": "color"');
  });

  it('user-chosen name differs from child prop name', () => {
    // The modal lets the user rename — standard. Verify the
    // identifier in the JSX uses the user's name, not the child prop.
    const code = `import RoHuVu from '@/components/RoHuVu';
function Parent({ style }) {
  return <RoHuVu data-id="n" poon="#aaa" />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'RoHuVu',
      propName: 'poon',
      variable: { name: 'accentColor', type: 'color', default: '#aaa' },
    });
    expect(out).toContain('poon={accentColor}');
    expect(out).not.toContain('poon={poon}');
  });
});

describe('hoistInstancePropInCode — multi-instance sweep', () => {
  it('rewrites all sibling instances of the same component sharing the same literal', () => {
    const code = `import RoHuVu from '@/components/RoHuVu';
function Parent({ style }) {
  return (
    <div data-id="root">
      <RoHuVu data-id="a" poon="#4e4e2b" />
      <RoHuVu data-id="b" poon="#4e4e2b" />
      <RoHuVu data-id="c" poon="#deadbe" />
    </div>
  );
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'a',
      componentName: 'RoHuVu',
      propName: 'poon',
      variable: { name: 'shared', type: 'color', default: '#4e4e2b' },
    });
    // Source + matching sibling both swept to the shared identifier.
    expect(out).toMatch(/data-id="a"[\s\S]*poon=\{shared\}/);
    expect(out).toMatch(/data-id="b"[\s\S]*poon=\{shared\}/);
    // Sibling with DIFFERENT literal is left alone — only "same value"
    // siblings fold under the shared variable.
    expect(out).toMatch(/data-id="c"[\s\S]*poon="#deadbe"/);
  });

  it('initialVariant hoist binds ONLY the clicked instance — no sibling sweep', () => {
    // Variant variables are IDENTITY-scoped ("Home State" controls THE Home
    // button). Six nav buttons sharing the same CURRENT variant literal is
    // coincidence — sweeping them all made one variable flip every button
    // (user repro 2026-07-29: header with 6 ViDaPo instances).
    const code = `import ViDaPo from '@/components/ViDaPo';
function Header({ style }) {
  return (
    <div data-id="root">
      <ViDaPo data-id="home" initialVariant="variant-1" />
      <ViDaPo data-id="about" initialVariant="variant-1" content="About" />
      <ViDaPo data-id="service" initialVariant="variant-1" content="Service" />
    </div>
  );
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'home',
      componentName: 'ViDaPo',
      propName: 'initialVariant',
      variable: { name: 'viDaPoVariant', type: 'text', default: 'variant-1' },
    });
    // Clicked instance bound to the variable.
    expect(out).toMatch(/data-id="home"[\s\S]*?initialVariant=\{viDaPoVariant\}/);
    // Siblings keep their literal — even though it matches the source's.
    expect(out).toMatch(/data-id="about"[\s\S]*?initialVariant="variant-1"/);
    expect(out).toMatch(/data-id="service"[\s\S]*?initialVariant="variant-1"/);
    // Variable machinery still fully wired.
    expect(out).toMatch(/viDaPoVariant\s*=\s*['"]variant-1['"]/);
    expect(out).toContain('"name": "viDaPoVariant"');
  });

  it('does NOT touch instances of a DIFFERENT component sharing the same prop name', () => {
    const code = `import RoHuVu from '@/components/RoHuVu';
import OtherComp from '@/components/OtherComp';
function Parent({ style }) {
  return (
    <div data-id="root">
      <RoHuVu data-id="a" poon="#aaa" />
      <OtherComp data-id="b" poon="#aaa" />
    </div>
  );
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'a',
      componentName: 'RoHuVu',
      propName: 'poon',
      variable: { name: 'v', type: 'color', default: '#aaa' },
    });
    expect(out).toMatch(/<RoHuVu[^>]*poon=\{v\}/);
    expect(out).toMatch(/<OtherComp[^>]*poon="#aaa"/);
  });
});

describe('hoistInstancePropInCode — ternary source value', () => {
  it('picks the DEFAULT branch of a conditional prop as the variable default', () => {
    // The nested instance's prop is already per-parent-variant via the
    // existing conditional-prop ternary system. Hoisting should grab the
    // FALLBACK branch (`'fallback'`) — the rest of the ternary collapses
    // because the new identifier replaces the whole expression.
    const code = `import RoHuVu from '@/components/RoHuVu';
function Parent({ style, variant }) {
  return <RoHuVu data-id="n" poon={variant === 'variant-1' ? 'red' : 'fallback'} />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'RoHuVu',
      propName: 'poon',
      variable: { name: 'v', type: 'color', default: 'fallback' },
    });
    expect(out).toContain('poon={v}');
    expect(out).not.toContain("variant === 'variant-1'");
    expect(out).toMatch(/v\s*=\s*['"]fallback['"]/);
  });
});

describe('hoistInstancePropInCode — function signature update', () => {
  it('adds to the existing destructured params', () => {
    const code = `function Parent({ style, initialVariant = 'default' }) {
  return <Child data-id="n" foo="x" />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'Child',
      propName: 'foo',
      variable: { name: 'bar', type: 'text', default: 'x' },
    });
    // All three destructured names present, separated by commas.
    expect(out).toMatch(/style/);
    expect(out).toMatch(/initialVariant/);
    expect(out).toMatch(/bar\s*=\s*['"]x['"]/);
  });

  it('handles a function with no params at all', () => {
    const code = `function Parent() {
  return <Child data-id="n" foo="x" />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'Child',
      propName: 'foo',
      variable: { name: 'bar', type: 'text', default: 'x' },
    });
    // New params introduced for the first time.
    expect(out).toMatch(/Parent\(\{[^}]*bar/);
  });

  it('inserts the new prop BEFORE a ...rest element (rest must stay last)', () => {
    // Masters carry `...rest` to forward DOM props to the root. A naive push
    // appended AFTER it → invalid `{ …, ...rest, newProp }` → SyntaxError that
    // crashed the page (the reported hoist-variable regression).
    const code = `function Parent({ style, initialVariant = 'default', ...rest }) {
  return <Child data-id="n" initialVariant={someState} />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'Child',
      propName: 'initialVariant',
      variable: { name: 'childVariant', type: 'text', default: 'default' },
    });
    // The new prop sits BEFORE ...rest, not after it.
    expect(out).toMatch(/childVariant\s*=\s*['"]default['"]\s*,\s*\.\.\.rest/);
    expect(out).not.toMatch(/\.\.\.rest\s*,\s*childVariant/);
    // And the result is still valid, parseable JS (no SyntaxError).
    expect(() => parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
  });

  it('returns code unchanged if the signature already has the chosen variable name', () => {
    // Modal validation should prevent this, but the transform must
    // defend so we never silently corrupt the function signature.
    const code = `function Parent({ style, bar = 'existing' }) {
  return <Child data-id="n" foo="x" />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'Child',
      propName: 'foo',
      variable: { name: 'bar', type: 'text', default: 'new' },
    });
    // Original `bar = 'existing'` preserved (NOT overwritten with 'new').
    expect(out).toContain("bar = 'existing'");
    // No duplicate `bar` in destructure.
    const barCount = (out.match(/\bbar\b/g) ?? []).length;
    // Three references: the destructure, the @pageVariables JSON name,
    // and the JSX identifier replacement. Any more is a bug.
    expect(barCount).toBeLessThanOrEqual(3);
  });
});

describe('hoistInstancePropInCode — no-op safety', () => {
  it('injects the attribute when the source instance has no matching prop', () => {
    // (Was a no-op before; intentionally changed — see the new
    // "injects the attribute when the source instance is using the
    // master default" test below for the full rationale.)
    const code = `function Parent({ style }) {
  return <Child data-id="n" other="x" />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'n',
      componentName: 'Child',
      propName: 'foo',
      variable: { name: 'v', type: 'text', default: 'x' },
    });
    // Hoist proceeds: the missing attr is injected with the identifier.
    expect(out).toContain('foo={v}');
    expect(out).toMatch(/v\s*=\s*['"]x['"]/);
    expect(out).toContain('@pageVariables');
  });

  it('returns code unchanged when the instance id is missing', () => {
    const code = `function Parent({ style }) {
  return <Child data-id="real" foo="x" />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'missing',
      componentName: 'Child',
      propName: 'foo',
      variable: { name: 'v', type: 'text', default: 'x' },
    });
    expect(out).toBe(code);
  });

  it('injects the attribute when the source instance is using the master default (no JSX attr)', () => {
    // Regression: when the nested instance JSX doesn't yet have the
    // prop the user is hoisting (the instance is using the master's
    // default value), `extractAndRewriteSourceInstance` used to bail
    // and the whole hoist transform became a no-op — visible bug:
    // user clicked "Hoist Variable" on the `border` row but the
    // master file got no @pageVariables entry, no signature update,
    // and the instance JSX still had no `border` attribute. The fix
    // injects a fresh `border={varName}` JSX attribute in that case.
    const code = `import React from 'react';
import ZaSuGa from '@/components/ZaSuGa';

function XiBiLe({ style, initialVariant = 'default' }) {
  return (
    <div data-id="frame-mpphsydd-1">
      <ZaSuGa data-id="frame-mppht1hn-2" style={{ position: 'absolute', left: '131px', top: '47px' }} />
    </div>
  );
}
export default XiBiLe;`;

    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'frame-mppht1hn-2',
      componentName: 'ZaSuGa',
      propName: 'border',
      variable: { name: 'borderhoisted', type: 'text', default: '1px solid #000' },
    });

    // JSX gained a new `border={borderhoisted}` attribute on the instance.
    expect(out).toContain('border={borderhoisted}');
    // Function signature destructure gained the new prop with default.
    expect(out).toMatch(/borderhoisted\s*=\s*['"]1px solid #000['"]/);
    // @pageVariables annotation written.
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "borderhoisted"');
  });
});

describe('hoistInstancePropInCode — transition prop', () => {
  it('hoists a transition prop whose value is a JSON string', () => {
    const code = `import React from 'react';
import GoRoCe from '@/components/GoRoCe';

function UxTaPa({ style, initialVariant = 'default' }) {
  return (
    <div data-id="root">
      <GoRoCe data-id="gc-1" transition='{"type":"tween","duration":0.3}' />
    </div>
  );
}
export default UxTaPa;`;

    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'gc-1',
      componentName: 'GoRoCe',
      propName: 'transition',
      variable: { name: 'transhoist', type: 'text', default: '{"type":"tween","duration":0.3}' },
    });

    expect(out).toContain('transition={transhoist}');
    expect(out).toContain('transhoist =');
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "transhoist"');
  });

  it('injects transition prop when the instance does not yet have it', () => {
    const code = `import React from 'react';
import GoRoCe from '@/components/GoRoCe';

function UxTaPa({ style, initialVariant = 'default' }) {
  return (
    <div data-id="root">
      <GoRoCe data-id="gc-1" />
    </div>
  );
}
export default UxTaPa;`;

    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'gc-1',
      componentName: 'GoRoCe',
      propName: 'transition',
      variable: { name: 'transhoist', type: 'text', default: '{"type":"tween"}' },
    });

    expect(out).toContain('transition={transhoist}');
    expect(out).toContain('@pageVariables');
  });
});

describe('hoistInstancePropInCode — non-literal attr values', () => {
  it('still rewrites and creates the variable when the source attr value is an inline object', () => {
    // Regression: `readLiteralFromAttr` doesn't handle ObjectExpression /
    // ArrayExpression / arbitrary Identifier values — it returned null
    // and the whole transform became a silent no-op. The user-visible
    // bug was the transition row: `transition={{type: 'tween'}}` is the
    // common shape, and hoisting it produced NO @pageVariables entry,
    // NO destructure update, NO JSX rewrite. Now the rewrite always
    // proceeds — the modal-picked default becomes the variable's
    // default and the JSX gets wired through.
    const code = `import GoRoCe from '@/components/GoRoCe';
function Parent({ style }) {
  return <GoRoCe data-id="gc" transition={{type:'tween',duration:0.3}} />;
}`;
    const out = hoistInstancePropInCode(code, {
      instanceNodeId: 'gc',
      componentName: 'GoRoCe',
      propName: 'transition',
      variable: { name: 'transhoist', type: 'text', default: '{"type":"tween","duration":0.3}' },
    });
    // JSX rewritten to the identifier.
    expect(out).toContain('transition={transhoist}');
    // Function signature gained the new prop with the user's default.
    expect(out).toContain('transhoist =');
    // @pageVariables annotation written.
    expect(out).toContain('@pageVariables');
    expect(out).toContain('"name": "transhoist"');
  });
});

describe('hoistInstancePropInCode — scroll-variant coexistence (fromVar)', () => {
  it('hoisting the variant on a scroll-variant instance wires fromVar + KEEPS the binding', () => {
    const base = `import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Header from '@/components/Header';
export default function LayoutClient({ children, scrollSection3 = "" }) {
  return (<div data-id="root">
    <Header data-id="hdr" initialVariant="default" />
  </div>);
}`;
    // Give the instance a scroll variant first (sectionInView, default → default-scrolled).
    const withSv = setScrollVariantInCode(base, 'hdr', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
    });
    // Now hoist the variant.
    const out = hoistInstancePropInCode(withSv, {
      instanceNodeId: 'hdr',
      componentName: 'Header',
      propName: 'initialVariant',
      variable: { name: 'headerVariant', type: 'text', default: 'default' },
    });
    // fromVar wired onto the spec (the resting→`fromVar || (...)` codegen itself is
    // covered in scroll-variant.test.ts; here we assert the HOIST WIRING).
    expect(out).toContain('"fromVar":"headerVariant"');
    expect(getScrollVariant(out, 'hdr')?.fromVar).toBe('headerVariant');
    // Binding stays OWNED by the scroll machine — NOT swapped to the variable.
    expect(out).toMatch(/initialVariant=\{hdrSv\}/);
    expect(out).not.toMatch(/initialVariant=\{headerVariant\}/);
    // Variable added to the params (default '' so it falls through) + the annotation.
    expect(out).toContain('"name": "headerVariant"');
    // Result is valid JS.
    expect(() => parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
  });

  it('PER-VIEWPORT: hoisting on a replica (scope) writes responsive[scope].fromVar, base UNCHANGED', () => {
    const base = `import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Header from '@/components/Header';
export default function LayoutClient({ children, headerVariant = "" }) {
  return (<div data-id="root">
    <Header data-id="hdr" initialVariant="default" />
  </div>);
}`;
    // Desktop already binds `headerVariant`.
    const withSv = setScrollVariantInCode(base, 'hdr', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
      fromVar: 'headerVariant',
    });
    // Hoist on TABLET (scope) → a SEPARATE per-viewport variable, base kept.
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = hoistInstancePropInCode(withSv, {
      instanceNodeId: 'hdr',
      componentName: 'Header',
      propName: 'initialVariant',
      variable: { name: 'headerVariantTablet', type: 'text', default: '' },
      scope: { query: TABLET },
    });
    const spec = getScrollVariant(out, 'hdr')!;
    expect(spec.fromVar).toBe('headerVariant');                       // base (Desktop) UNCHANGED
    const tab = (spec.responsive ?? []).find((r) => 'query' in r.scope && r.scope.query === TABLET);
    expect(tab?.fromVar).toBe('headerVariantTablet');                  // Tablet → its OWN variable
    expect(out).toContain('"name": "headerVariantTablet"');            // variable added to params/annotation
    expect(() => parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
  });
});
