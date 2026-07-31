// project-parser.test.ts — Unit tests for component instance expansion.
//
// Focus: instance→root style merge must keep wrapper-only props (position,
// left/top, transform, flex/grid placement, margin, etc.) on the outer
// instance wrapper and NOT bleed onto the inner component root, otherwise
// the canvas double-positions the card visually.

import { describe, it, expect } from 'vitest';
import { parseProjectFile, clearComponentParseCache, resolveInstancePropOverrides } from './project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';

describe('toggle conditional prop resolves by JS truthiness (canvas matches live)', () => {
  // KuWoCo-style: a `hide` toggle drives `display: hide ? "none" : ""` on a child.
  const COMP = `function KuWoCo({ style, hide = false }) {
    return <motion.div data-id="root" style={{ ...style }}><motion.div data-id="inner" style={{ display: hide ? "none" : "" }} /></motion.div>;
  }`;
  const disp = (v: string) => resolveInstancePropOverrides({ hide: v }, COMP).get('hide:inner')?.value;
  it('a truthy route value ("none", from a hoisted toggle var) → display:none, like the live site', () => {
    expect(disp('none')).toBe('none');     // was '' (shown) under strict === 'true'
    expect(disp('true')).toBe('none');
    expect(disp('yes')).toBe('none');
  });
  it('explicit OFF states → "" (shown)', () => {
    expect(disp('false')).toBe('');
    expect(disp('')).toBe('');
    expect(disp('0')).toBe('');
  });
});

// Minimal Card component file that buildComponentFile would produce:
// position: 'absolute' on the root (master-canvas-only positioning), some
// natural visual styles (width/bg/padding/etc.), no height (auto from content).
const CARD_TSX = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

function Card({ ...style }) {
  return (
    <LayoutGroup>
      <motion.div data-id="card" data-name="Card" layout={true} style={{
        position: 'absolute',
        width: '320px',
        backgroundColor: '#ffffff',
        borderRadius: '16px',
        padding: '32px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        ...style,
      }}>
        <p data-id="card-title" layout={true} style={{ position: 'relative', fontSize: '20px', color: '#111' }}>
          Title
        </p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

// Page that uses the Card with absolute positioning + width override.
// This is the common "place a card on the canvas" pattern.
const PAGE_TSX = `
import React from 'react';
import Card from '@/components/Card';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <Card data-id="card1" style={{ position: 'absolute', left: '64px', top: '38px' }} />
    </div>
  );
}
`;

function makeFS() {
  return new InMemoryProjectFS(new Map([
    ['app/page.tsx', PAGE_TSX],
    ['components/Card.tsx', CARD_TSX],
  ]));
}

describe('project-parser: instance → root style merge', () => {
  it('keeps wrapper-only positioning (position/left/top) on the instance wrapper, not the inner root', () => {
    const nodes = parseProjectFile('app/page.tsx', makeFS());

    // Outer instance wrapper — keeps the user-set positioning.
    const card1 = nodes.get('card1');
    expect(card1).toBeDefined();
    expect(card1!.styles.position).toBe('absolute');
    expect(card1!.styles.left).toBe('64px');
    expect(card1!.styles.top).toBe('38px');

    // Inner root — must NOT receive the instance's positioning, otherwise it
    // gets re-offset relative to the wrapper (double-positioning bug). The
    // master's `position: absolute` (buildComponentFile injection) is also
    // stripped because it's master-canvas-only.
    const cardRoot = nodes.get('card1:card');
    expect(cardRoot).toBeDefined();
    expect(cardRoot!.styles.position).toBeUndefined();
    expect(cardRoot!.styles.left).toBeUndefined();
    expect(cardRoot!.styles.top).toBeUndefined();
  });

  it('keeps z-index on the instance wrapper, not the inner root (fixed-header stacking)', () => {
    // Regression: a `position: fixed` header instance with a z-index rendered
    // BEHIND the hero on the canvas. The wrapper is the positioned box, so a
    // z-index merged onto the inner root (which is position:static) is ignored,
    // and the positioned wrapper falls back to auto stacking. z-index must ride
    // the wrapper — see WRAPPER_ONLY_STYLE_PROPS.
    const fixedHeaderPage = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return (
          <div data-id="root">
            <Card data-id="card1" style={{
              position: 'fixed', top: '0px', left: '0px', width: '100%', zIndex: '100',
            }} />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', fixedHeaderPage],
      ['components/Card.tsx', CARD_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    // Wrapper keeps z-index (it is the positioned box).
    const card1 = nodes.get('card1');
    expect(card1!.styles.zIndex).toBe('100');
    expect(card1!.styles.position).toBe('fixed');

    // Inner root must NOT receive z-index — it's position:static, so a z-index
    // there does nothing and the wrapper would stack at auto (the bug).
    const cardRoot = nodes.get('card1:card');
    expect(cardRoot!.styles.zIndex).toBeUndefined();
  });

  it('still merges visual instance overrides (width/background/padding) onto the inner root', () => {
    // Page where the user customizes a card's appearance via the instance tag.
    const customPage = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return (
          <div data-id="root">
            <Card data-id="card1" style={{
              position: 'absolute', left: '64px', top: '38px',
              width: '400px', backgroundColor: '#fee', padding: '40px',
            }} />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', customPage],
      ['components/Card.tsx', CARD_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const cardRoot = nodes.get('card1:card');
    expect(cardRoot).toBeDefined();
    // Visual overrides flow onto the root (mirrors {...style} spread in production).
    expect(cardRoot!.styles.width).toBe('400px');
    expect(cardRoot!.styles.backgroundColor).toBe('#fee');
    expect(cardRoot!.styles.padding).toBe('40px');
    // Wrapper-only props still excluded.
    expect(cardRoot!.styles.position).toBeUndefined();
    expect(cardRoot!.styles.left).toBeUndefined();
    expect(cardRoot!.styles.top).toBeUndefined();
  });

  it('applies a Toggle (boolean) instance prop bound via a ternary — wrap={true} → flexWrap:wrap', () => {
    // Reproduces the canvas-only bug: the instance value lives in `componentProps` (expression literal),
    // not `attrs`, and the binding is a ternary — both previously ignored by the expansion.
    const cardWithWrap = `
      import React from 'react';
      function Card({ style, wrap = false }) {
        return (
          <div data-id="card" style={{ display: 'flex', flexDirection: 'row', ...style, flexWrap: wrap ? "wrap" : "nowrap" }}>
            <div data-id="c1" style={{ width: '100px' }}></div>
          </div>
        );
      }
      export default Card;
    `;
    const page = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return (
          <div data-id="root">
            <Card data-id="card1" wrap={true} style={{ position: 'relative' }} />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Card.tsx', cardWithWrap],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);
    const cardRoot = nodes.get('card1:card');
    expect(cardRoot).toBeDefined();
    expect(cardRoot!.styles.flexWrap).toBe('wrap'); // resolved from the instance's wrap={true}
  });

  it('Toggle instance prop = false resolves the alternate branch (nowrap)', () => {
    const cardWithWrap = `
      import React from 'react';
      function Card({ style, wrap = true }) {
        return <div data-id="card" style={{ display: 'flex', ...style, flexWrap: wrap ? "wrap" : "nowrap" }}></div>;
      }
      export default Card;
    `;
    const page = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return <div data-id="root"><Card data-id="card1" wrap={false} /></div>;
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Card.tsx', cardWithWrap],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);
    expect(nodes.get('card1:card')!.styles.flexWrap).toBe('nowrap');
  });

  it('applies a Number (expression-literal) instance prop bound directly — gap={24}', () => {
    const cardWithGap = `
      import React from 'react';
      function Card({ style, g = 0 }) {
        return <div data-id="card" style={{ display: 'flex', ...style, gap: g }}></div>;
      }
      export default Card;
    `;
    const page = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return <div data-id="root"><Card data-id="card1" g={24} /></div>;
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Card.tsx', cardWithGap],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);
    expect(nodes.get('card1:card')!.styles.gap).toBe('24');
  });

  it('overrides text content when the instance passes a value for a {propName} text binding', () => {
    const cardWithTextVar = `
      import React from 'react';
      function Card({ title = 'Default' }) {
        return (
          <div data-id="card" style={{ width: '320px' }}>
            <p data-id="card-title">{title}</p>
          </div>
        );
      }
      export default Card;
    `;
    const page = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return (
          <div data-id="root">
            <Card data-id="card1" title="Hello from instance" />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Card.tsx', cardWithTextVar],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    // The expanded text node carries the instance value, not the master default.
    const cardTitle = nodes.get('card1:card-title');
    expect(cardTitle).toBeDefined();
    expect(cardTitle!.textContent).toBe('Hello from instance');
  });

  it('falls back to the master default text when the instance has no override', () => {
    const cardWithTextVar = `
      import React from 'react';
      function Card({ title = 'Default' }) {
        return (
          <div data-id="card" style={{ width: '320px' }}>
            <p data-id="card-title">{title}</p>
          </div>
        );
      }
      export default Card;
    `;
    const page = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return <div data-id="root"><Card data-id="card1" /></div>;
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Card.tsx', cardWithTextVar],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    expect(nodes.get('card1:card-title')!.textContent).toBe('Default');
  });

  it('strips wrapper-only layout props (margin, flex, transform) from the inner root', () => {
    const flexPage = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return (
          <div data-id="root" style={{ display: 'flex' }}>
            <Card data-id="card1" style={{
              flex: '1 1 auto',
              alignSelf: 'stretch',
              marginTop: '20px',
              transform: 'rotate(5deg)',
              width: '300px',
            }} />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', flexPage],
      ['components/Card.tsx', CARD_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    // Wrapper keeps all the parent-context layout props.
    const card1 = nodes.get('card1');
    expect(card1!.styles.flex).toBe('1 1 auto');
    expect(card1!.styles.alignSelf).toBe('stretch');
    expect(card1!.styles.marginTop).toBe('20px');
    expect(card1!.styles.transform).toBe('rotate(5deg)');

    // Inner root only gets the visual override (width).
    const cardRoot = nodes.get('card1:card');
    expect(cardRoot!.styles.width).toBe('300px');
    expect(cardRoot!.styles.flex).toBeUndefined();
    expect(cardRoot!.styles.alignSelf).toBeUndefined();
    expect(cardRoot!.styles.marginTop).toBeUndefined();
    expect(cardRoot!.styles.transform).toBeUndefined();
  });
});

// ─── Nested component instances ──────────────────────────────────────────────
//
// `<Outer><Inner/></Outer>` — Outer's master JSX contains an `<Inner/>`
// component reference, and Inner is itself a design component with its
// own master file. The parser must:
//   1. Expand Outer at the page level → Inner instance lands in the
//      page's node map with `componentInstanceId` pointing at Outer.
//   2. Expand Inner at depth 2 → Inner's master root lands as a child
//      of the Inner wrapper.
//
// CRITICAL: the Inner wrapper must be flagged `isComponentInstance=true`
// even though it ALSO carries `componentInstanceId` (from being inside
// Outer's expansion). The Renderer relies on that flag to apply
// wrapper-only style filtering and the master-root sizing fallback;
// without it, the wrapper collapses to 0×0.

const INNER_TSX = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Inner" */

function Inner({ style }) {
  return (
    <LayoutGroup>
      <motion.div data-id="inner-root" layout={true} style={{
        position: 'absolute',
        width: '160px',
        height: '104px',
        backgroundColor: '#ffb3ba',
        ...style,
      }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(Inner);
`;

const OUTER_TSX = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';

/** @name "Outer" */

function Outer({ style }) {
  return (
    <LayoutGroup>
      <motion.div data-id="outer-root" layout={true} style={{
        position: 'absolute',
        width: '349px',
        height: '227px',
        backgroundColor: '#97cffc',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}>
        <Inner data-id="inner" style={{ position: 'relative', flex: '0 0 auto' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Outer);
`;

const NESTED_PAGE_TSX = `
import React from 'react';
import Outer from '@/components/Outer';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <Outer data-id="o1" style={{ position: 'absolute', left: '484px', top: '217px' }} />
    </div>
  );
}
`;

function makeNestedFS() {
  return new InMemoryProjectFS(new Map([
    ['app/page.tsx', NESTED_PAGE_TSX],
    ['components/Outer.tsx', OUTER_TSX],
    ['components/Inner.tsx', INNER_TSX],
  ]));
}

describe('project-parser: static visibility bake (AnimatePresence panels on plain instances)', () => {
  const TABS_TSX = `
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Mini Tabs" */

const variantConfig = [
  { name: 'default', label: 'One', x: 0, y: 0, isPrimary: true },
  { name: 'tab-two', label: 'Two', x: 900, y: 0 }
];

const connections = [
  { from: 'default', to: 'tab-two', trigger: 'click' },
  { from: 'tab-two', to: 'default', trigger: 'click' }
];

function MiniTabs({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="tabs-root" data-name="Mini Tabs" layout={true} onTap={() => setVariant(variant === 'default' ? 'tab-two' : variant === 'tab-two' ? 'default' : variant)} style={{ position: 'absolute', width: '600px', height: '300px', display: 'flex', flexDirection: 'column', backgroundColor: '#161412', ...style }} animate={variant}>
      <AnimatePresence mode="popLayout">
        {variant === 'default' && <motion.p data-id="panel-one" data-name="Panel One" key="panel-one" layout={true} style={{ position: 'absolute', left: '0px', top: '0px', color: '#ffffff' }}>One</motion.p>}
        {variant === 'tab-two' && <motion.p data-id="panel-two" data-name="Panel Two" key="panel-two" layout={true} style={{ position: 'absolute', left: '0px', top: '0px', color: '#ffffff' }}>Two</motion.p>}
      </AnimatePresence>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(MiniTabs);
`;

  const tabsFS = (instanceAttrs: string) => new InMemoryProjectFS(new Map([
    ['app/page.tsx', `
import React from 'react';
import MiniTabs from '@/components/MiniTabs';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <MiniTabs data-id="tabs1" ${instanceAttrs} style={{ position: 'relative' }} />
    </div>
  );
}
`],
    ['components/MiniTabs.tsx', TABS_TSX],
  ]));

  it('plain instance (no initialVariant): default panel visible, other panel baked display:none', () => {
    const nodes = parseProjectFile('app/page.tsx', tabsFS(''));
    const one = nodes.get('tabs1:panel-one');
    const two = nodes.get('tabs1:panel-two');
    expect(one).toBeTruthy();
    expect(two).toBeTruthy();
    expect(one!.styles.display).not.toBe('none');
    expect(two!.styles.display).toBe('none');
    expect(two!.hiddenOnVariants).toBeUndefined(); // static — nothing left to resolve
  });

  it('instance pinned to the second variant shows the second panel only', () => {
    const nodes = parseProjectFile('app/page.tsx', tabsFS('initialVariant="tab-two"'));
    expect(nodes.get('tabs1:panel-one')!.styles.display).toBe('none');
    expect(nodes.get('tabs1:panel-two')!.styles.display).not.toBe('none');
  });
});

describe('project-parser: nested component instances', () => {
  it('does NOT bake display:none onto the expanded root when the instance is hidden per variant', () => {
    // A nested instance hidden on a variant via AnimatePresence + a `display`
    // ternary: `instanceNode.styles.display` is the resolved DEFAULT branch
    // ('none'). Baking it onto the expanded root would hide the instance on
    // EVERY variant (canvas bug: nested menu button didn't render on the
    // variants where it should show). Visibility belongs to the wrapper
    // (`hiddenOnVariants` / `conditionalStyles.display`), not the root.
    const INNER = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
/** @name "Inner" */
const variantConfig = [{ name: 'default', label: 'Inner', x:0,y:0, isPrimary:true }];
function Inner({ style, initialVariant='default' }) {
  return <LayoutGroup><motion.div layout={true} data-id="inner-root" variants={{default:{}}} initial={initialVariant} animate={initialVariant} style={{ position:'absolute', width:'58px', ...style }} /></LayoutGroup>;
}
export default withResponsiveProps(Inner);`;
    const MASTER = `import React, { useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';
const variantConfig = [{name:'default',label:'D',x:0,y:0,isPrimary:true},{name:'variant-1',label:'T',x:100,y:0},{name:'variant-2',label:'M',x:200,y:0}];
function Master({ style, initialVariant='default' }) {
  const [variant,setVariant]=useState(initialVariant);
  return <LayoutGroup><motion.div layout={true} data-id="root" variants={{default:{}}} initial={initialVariant} animate={variant} style={{position:'absolute',display:'flex',...style}}>
    <AnimatePresence mode="popLayout">{variant !== "default" && <Inner data-id="inner-inst" data-name="Inner" style={{position:'relative', display: variant === 'variant-1' ? '' : variant === 'variant-2' ? '' : 'none'}} key="inner-inst" />}</AnimatePresence>
  </motion.div></LayoutGroup>;
}
export default withResponsiveProps(Master);`;
    const fs = new InMemoryProjectFS(new Map([
      ['components/Master.tsx', MASTER],
      ['components/Inner.tsx', INNER],
    ]));
    const nodes = parseProjectFile('components/Master.tsx', fs);

    const root = nodes.get('inner-inst:inner-root');
    expect(root).toBeDefined();
    // Root must NOT have a baked display:none (would hide on every variant —
    // "nested menu button doesn't render where it should show").
    expect(root!.styles.display).not.toBe('none');
    // But it MUST carry the per-variant visibility so the RENDERED element
    // actually hides on the default variant ("I hid it but it's still there").
    expect([...(root!.hiddenOnVariants ?? [])]).toEqual(['default']);
  });

  it('marks both outer and nested instance wrappers with isComponentInstance', () => {
    const nodes = parseProjectFile('app/page.tsx', makeNestedFS());

    // Outer instance — top level of the page, not inside any expansion.
    const outer = nodes.get('o1');
    expect(outer).toBeDefined();
    expect(outer!.isComponentInstance).toBe(true);
    expect(outer!.componentFile).toBe('components/Outer.tsx');
    expect(outer!.componentInstanceId).toBeNull();

    // Outer's master root — IS a component root, NOT an instance wrapper.
    const outerRoot = nodes.get('o1:outer-root');
    expect(outerRoot).toBeDefined();
    expect(outerRoot!.isComponentRoot).toBe(true);
    expect(outerRoot!.isComponentInstance).toBeFalsy();
    expect(outerRoot!.componentInstanceId).toBe('o1');

    // Inner instance — sits INSIDE Outer's expansion. Carries
    // componentInstanceId='o1' (from Outer's expansion) AND
    // componentFile='components/Inner.tsx' (its own component, set
    // when its own expansion runs at depth 2). Must be flagged
    // isComponentInstance=true so the Renderer treats it as a
    // wrapper rather than a regular descendant.
    const innerWrapper = nodes.get('o1:inner');
    expect(innerWrapper).toBeDefined();
    expect(innerWrapper!.isComponentInstance).toBe(true);
    expect(innerWrapper!.componentFile).toBe('components/Inner.tsx');
    expect(innerWrapper!.componentInstanceId).toBe('o1');

    // Inner's master root — lands at depth 2 with the doubly-prefixed id.
    const innerRoot = nodes.get('o1:inner:inner-root');
    expect(innerRoot).toBeDefined();
    expect(innerRoot!.isComponentRoot).toBe(true);
    expect(innerRoot!.isComponentInstance).toBeFalsy();
    expect(innerRoot!.componentInstanceId).toBe('o1:inner');
    // Master-canvas-only positioning is stripped from the inner root
    // when expanded inside an instance.
    expect(innerRoot!.styles.position).toBeUndefined();
  });

  it('does not flag the master root as an instance wrapper', () => {
    // Regression: it'd be tempting to set isComponentInstance based on
    // type alone (uppercase tag), but the master root often has a
    // lowercase JSX type (`motion.div`). Make sure we only flag actual
    // instance tags.
    const nodes = parseProjectFile('app/page.tsx', makeNestedFS());
    for (const [id, node] of nodes) {
      if (node.isComponentRoot) {
        expect(node.isComponentInstance).toBeFalsy();
      }
    }
  });
});

// ─── Per-parent-variant child variant overrides ──────────────────────────────
//
// When a component file embeds another component instance and the user wants
// each PARENT variant to show a different CHILD variant, the JSX uses a
// ternary:
//   <Inner initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'} />
// expandComponent must remap the inner's motionVariants so its keys are
// PARENT variant names — otherwise resolveVariantStyles in the canvas would
// look up the child's variant by accidental name match.

const INNER_WITH_VARIANTS_TSX = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Inner" */

const variantConfig = [
  { name: 'default', label: 'Inner', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Inner', x: 200, y: 0 },
  { name: 'variant-2', label: 'Inner', x: 400, y: 0 },
];

const innerVariants = {
  default: { backgroundColor: '#aaaaaa' },
  'variant-1': { backgroundColor: '#ff0000' },
  'variant-2': { backgroundColor: '#00ff00' },
};

function Inner({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
      <motion.div data-id="inner-root" variants={innerVariants} initial={initialVariant} animate={initialVariant} style={{
        position: 'absolute',
        width: '160px',
        height: '104px',
        backgroundColor: '#aaaaaa',
        ...style,
      }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(Inner);
`;

const OUTER_WITH_TERNARY_TSX = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';

/** @name "Outer" */

const variantConfig = [
  { name: 'default', label: 'Outer', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Outer', x: 400, y: 0 },
];

function Outer({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
      <motion.div data-id="outer-root" style={{
        position: 'absolute',
        width: '300px',
        height: '200px',
        ...style,
      }}>
        <Inner data-id="inner" initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'} style={{ position: 'relative' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Outer);
`;

describe('project-parser: per-parent-variant child variant overrides', () => {
  it('parses the ternary on a child instance and exposes attrConditional', () => {
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Outer.tsx', OUTER_WITH_TERNARY_TSX],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    const inner = nodes.get('inner');
    expect(inner).toBeDefined();
    expect(inner!.attrConditional?.initialVariant).toEqual({
      'variant-1': 'variant-2',
      default: 'default',
    });
    // The default branch also lands in attrs so existing readers that just
    // pull a single value still see a coherent fallback.
    expect(inner!.attrs.initialVariant).toBe('default');
  });

  it('remaps motionVariants on the expanded child by parent variant', () => {
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Outer.tsx', OUTER_WITH_TERNARY_TSX],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    // The Inner master root sits inside the Inner instance which sits inside
    // Outer's JSX; with the per-parent ternary, motionVariants on the
    // expanded inner root should now be keyed by PARENT variant names.
    const innerRoot = nodes.get('inner:inner-root');
    expect(innerRoot).toBeDefined();
    // Default parent variant -> child 'default' is the BASE (baked into styles).
    // Variant-1 parent variant -> child 'variant-2' shows up as motionVariants['variant-1'].
    expect(innerRoot!.motionVariants).toEqual({
      'variant-1': { backgroundColor: '#00ff00' },
    });
  });

  it('clears child motionVariants when the instance has NO initialVariant (no parent-variant name leak)', () => {
    // A nested instance with no initialVariant must render its OWN default on
    // EVERY parent variant — its motionVariants must be cleared so a parent
    // 'variant-1' tile doesn't accidentally name-match the child's 'variant-1'
    // (the bug: nested frame turned red on the parent's 2nd variant while the
    // Variant select still read 'default').
    const OUTER_NO_INITIALVARIANT = OUTER_WITH_TERNARY_TSX.replace(
      `<Inner data-id="inner" initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'} style={{ position: 'relative' }} />`,
      `<Inner data-id="inner" style={{ position: 'relative' }} />`,
    );
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Outer.tsx', OUTER_NO_INITIALVARIANT],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    const innerRoot = nodes.get('inner:inner-root');
    expect(innerRoot).toBeDefined();
    // Cleared — no parent variant maps to a child variant by name.
    expect(innerRoot!.motionVariants ?? {}).toEqual({});
    // Base keeps the child's own default color.
    expect(innerRoot!.styles.backgroundColor).toBe('#aaaaaa');
  });

  it('bakes the default-parent-variant child styles into base styles', () => {
    // When the ternary picks a non-default child variant for parent default,
    // those styles should bake into base so primary-viewport rendering picks
    // them up (the canvas passes variantName=null for the primary).
    const OUTER_DEFAULT_PICKS_VARIANT_1 = OUTER_WITH_TERNARY_TSX.replace(
      `initialVariant === 'variant-1' ? 'variant-2' : 'default'`,
      `initialVariant === 'variant-1' ? 'variant-2' : 'variant-1'`,
    );
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Outer.tsx', OUTER_DEFAULT_PICKS_VARIANT_1],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    const innerRoot = nodes.get('inner:inner-root');
    expect(innerRoot).toBeDefined();
    // Default branch is 'variant-1' → red merged into base.
    expect(innerRoot!.styles.backgroundColor).toBe('#ff0000');
  });

  it('propagates page-level responsiveVariantMap through nested instances to inner descendants', () => {
    // Page → Outer instance has data-responsive (tablet → variant-1).
    // Outer master has Inner instance with `initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'}`.
    // The Inner master root must end up with:
    //   - responsiveVariantMap populated from the page (so the canvas can
    //     resolve which child variant to show per viewport width)
    //   - motionVariants remapped by the OUTER's parent variant names
    // Without the propagation fix, the inner descendant's responsiveVariantMap
    // is null and the canvas falls back to default styles on every viewport.
    const PAGE_TSX = `
import React from 'react';
import Outer from '@/components/Outer';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Outer data-id="hero" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[768,375]}' style={{ position: 'absolute' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Outer.tsx', OUTER_WITH_TERNARY_TSX],
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    // The page-level outer instance node itself doesn't carry the map —
    // it's a wrapper tag that gets expanded; the map flows onto its
    // descendants. Verify the nested-instance wrapper inside the outer
    // expansion got the page's map stamped on it.
    const nestedInstanceWrapper = nodes.get('hero:inner');
    expect(nestedInstanceWrapper).toBeDefined();
    expect(nestedInstanceWrapper!.responsiveVariantMap).toEqual({ 768: 'variant-1' });

    // The expanded inner master root sits at hero:inner:inner-root
    const innerRoot = nodes.get('hero:inner:inner-root');
    expect(innerRoot).toBeDefined();
    // Map carries down through the nested expansion
    expect(innerRoot!.responsiveVariantMap).toEqual({ 768: 'variant-1' });
    // motionVariants is remapped by OUTER variant names — so the canvas can
    // look up motionVariants[outer's variant for tablet] and find the
    // user-chosen child variant styles.
    expect(innerRoot!.motionVariants?.['variant-1']).toEqual({ backgroundColor: '#00ff00' });
  });

  it('KEEPS the root motionVariants for a top-level instance with its own data-responsive', () => {
    // A top-level variant-component instance with `data-responsive` switches its
    // OWN variant per viewport via responsiveVariantMap. Its root motionVariants
    // (keyed by their own names) MUST be kept so resolveVariantStyles can apply
    // the right variant per breakpoint. Regression: the nested-clear `else`
    // branch was wiping them, so the instance rendered identically on every
    // viewport on the page (while the master canvas was fine).
    const PAGE_TSX = `
import React from 'react';
import Inner from '@/components/Inner';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Inner data-id="hero" data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[768,375]}' style={{ position: 'absolute' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const innerRoot = nodes.get('hero:inner-root');
    expect(innerRoot).toBeDefined();
    // Own data-responsive → variants kept (NOT cleared), keyed by their names.
    expect(innerRoot!.motionVariants?.['variant-1']).toEqual({ backgroundColor: '#ff0000' });
    expect(innerRoot!.motionVariants?.['variant-2']).toEqual({ backgroundColor: '#00ff00' });
    // And the responsive map is carried so the canvas can switch per viewport.
    expect(innerRoot!.responsiveVariantMap).toEqual({ 768: 'variant-1', 375: 'variant-2' });
  });

  it('SEEDS the primary breakpoint with the base initialVariant (non-default) so the canvas matches the live site on desktop', () => {
    // Instance with a NON-DEFAULT base initialVariant + data-responsive whose _bp
    // lists the primary width (1440) WITHOUT an override entry. The live runtime keeps
    // the base prop ('variant-1') on 1440; the canvas used to fall back to 'default',
    // re-applying the default variant over the baked-in base → "live shows variant-1,
    // canvas shows default on desktop". The map must now carry 1440 -> 'variant-1'.
    const PAGE_TSX = `
import React from 'react';
import Inner from '@/components/Inner';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Inner data-id="hero" initialVariant="variant-1" data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}' style={{ position: 'absolute' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const innerRoot = nodes.get('hero:inner-root');
    expect(innerRoot).toBeDefined();
    // Primary (1440) seeded with the base variant; explicit overrides untouched.
    expect(innerRoot!.responsiveVariantMap).toEqual({ 1440: 'variant-1', 768: 'variant-1', 375: 'variant-2' });
    // Variants kept so resolveVariantStyles can apply the right one per breakpoint.
    expect(innerRoot!.motionVariants?.['variant-1']).toEqual({ backgroundColor: '#ff0000' });
  });

  it('Scroll Variant `from` does NOT drive the canvas — ONLY data-responsive (the variant CHOICE) does', () => {
    // The canvas variant comes ENTIRELY from data-responsive (the per-viewport CHOICE). A Scroll
    // Variant's `from`/`to` is morph context — it must NOT seed the canvas per-tile variant, so the
    // scroll config and the displayed variant stay completely separate. (At runtime the morph still
    // wins because the withResponsiveProps HOC skips initialVariant when data-scroll-variant present.)
    const PAGE_TSX = `
import React from 'react';
import Inner from '@/components/Inner';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Inner data-id="hero" initialVariant={heroSv} data-scroll-variant='{"trigger":"onScroll","from":"variant-1","to":"variant-2","direction":"down","replay":true}' data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}' style={{ position: 'absolute' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const innerRoot = nodes.get('hero:inner-root');
    expect(innerRoot).toBeDefined();
    // ONLY the data-responsive entries — the scroll `from` (variant-1) does NOT seed 1440.
    expect(innerRoot!.responsiveVariantMap).toEqual({ 768: 'variant-1', 375: 'variant-2' });
    expect(innerRoot!.responsiveVariantMap?.[1440]).toBeUndefined();
  });

  it('Scroll Variant `from` does NOT repaint the canvas — NO data-responsive (the new-page bleed)', () => {
    // An instance with ONLY a Scroll Variant (no data-responsive). The scroll `from` is
    // variant-1, but the canvas must show the BASE (default) styles — changing From must
    // not repaint the static canvas. So the scroll `from` is NOT baked into the expanded
    // base, and there's no responsiveVariantMap → resolveVariantStyles returns base styles.
    const PAGE_TSX = `
import React from 'react';
import Inner from '@/components/Inner';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Inner data-id="hero" initialVariant={heroSv} data-scroll-variant='{"trigger":"onScroll","from":"variant-1","to":"default","direction":"down","replay":true}' style={{ position: 'absolute' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const innerRoot = nodes.get('hero:inner-root');
    expect(innerRoot).toBeDefined();
    // NOT pinned to scroll `from` (variant-1 #ff0000) — base stays the DEFAULT (#aaaaaa).
    expect(innerRoot!.styles.backgroundColor).toBe('#aaaaaa');
    expect(innerRoot!.responsiveVariantMap ?? null).toBeNull();
  });

  it('CARRIES responsiveVariantMap onto an AnimatePresence-only child (no variant styles) so it hides per viewport on a page instance', () => {
    // A child rendered only on one variant via `<AnimatePresence>{initialVariant === "variant-1" && <child/>}`
    // has hiddenOnVariants but NO motionVariants. On a page instance its per-viewport
    // visibility is resolved from responsiveVariantMap — so the expanded child MUST carry
    // the map, else the canvas shows it on every tile while the live site hides it.
    const COMP = `
import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Wrap" */

const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 200, y: 0 },
  { name: 'variant-2', label: 'Mobile', x: 400, y: 0 },
];
const wrapVariants = { default: {}, 'variant-1': {}, 'variant-2': {} };

function Wrap({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
      <motion.div data-id="wrap-root" variants={wrapVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'absolute', width: '300px', height: '200px', ...style }}>
        <AnimatePresence mode="popLayout">{initialVariant === "variant-1" && <motion.div data-id="solo" style={{ position: 'absolute', width: '100px', height: '50px', left: '20px', top: '20px' }} key="solo" data-replica-solo="variant-1" />}</AnimatePresence>
      </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(Wrap);
`;
    const PAGE_TSX = `
import React from 'react';
import Wrap from '@/components/Wrap';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Wrap data-id="w" initialVariant="default" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768]}' style={{ position: 'absolute' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Wrap.tsx', COMP],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const solo = nodes.get('w:solo');
    expect(solo).toBeDefined();
    // Hidden on every variant EXCEPT variant-1 (complement of `=== "variant-1"`).
    expect([...(solo!.hiddenOnVariants ?? [])].sort()).toEqual(['default', 'variant-2']);
    // And it carries the map so resolveVariantStyles can resolve the active variant
    // per viewport (1440 -> default -> hidden; 768 -> variant-1 -> shown).
    expect(solo!.responsiveVariantMap).toEqual({ 768: 'variant-1' });
  });

  it('KEEPS root motionVariants for a top-level instance with the wrapped __applyInstanceSize variants form', () => {
    // The instance-size-override transform wraps the root variants as
    // `variants={__applyInstanceSize(innerVariants, …)}`. Combined with a
    // data-responsive instance, the parser must STILL resolve + keep the root
    // variants (this is the exact NeZaFi header case).
    const INNER_WRAPPED = INNER_WITH_VARIANTS_TSX
      .replace(
        'function Inner({ style, initialVariant = \'default\' }) {',
        `function __applyInstanceSize(variants, w, h) {
  if (w === undefined && h === undefined) return variants;
  const out = {};
  for (const k in variants) out[k] = { ...variants[k], ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
  return out;
}
function Inner({ style, initialVariant = 'default' }) {
  const { width: __instW, height: __instH, ...__instStyle } = style ?? {};`,
      )
      .replace('variants={innerVariants}', 'variants={__applyInstanceSize(innerVariants, __instW, __instH)}')
      .replace('...style,', '...__instStyle,');

    const PAGE_TSX = `
import React from 'react';
import Inner from '@/components/Inner';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Inner data-id="hero" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[768]}' style={{ position: 'absolute', width: '97%' }} />
    </div>
  );
}
`;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Inner.tsx', INNER_WRAPPED],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const innerRoot = nodes.get('hero:inner-root');
    expect(innerRoot).toBeDefined();
    // Variants kept AND the instance's width override (97%) is merged into every
    // variant entry — mirrors runtime __applyInstanceSize so the canvas matches
    // the live site on non-default viewports.
    expect(innerRoot!.motionVariants?.['variant-1']).toMatchObject({ backgroundColor: '#ff0000', width: '97%' });
    expect(innerRoot!.responsiveVariantMap).toEqual({ 768: 'variant-1' });
  });

  it('reads inline-ternary styles on component instance into conditionalStyles', () => {
    // The generator writes per-parent-variant style values for component
    // instances as inline JSX ternaries (NOT as `variants={...}` — that's
    // silently ignored by non-motion components). Parser must accept both
    // `variant ===` and `initialVariant ===` and surface them as
    // conditionalStyles so the canvas can resolve per-variant.
    const PARENT_WITH_INSTANCE_TERNARY = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';

/** @name "Parent" */

const variantConfig = [
  { name: 'default', label: 'Parent', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Parent', x: 400, y: 0 },
];

function Parent({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
      <motion.div data-id="parent-root" style={{ position: 'absolute', width: '300px', height: '200px', ...style }}>
        <Inner data-id="inner" style={{ position: 'absolute', left: initialVariant === 'variant-1' ? '178px' : '53px', top: initialVariant === 'variant-1' ? '110px' : '42px' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Parent);
`;
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Parent.tsx', PARENT_WITH_INSTANCE_TERNARY],
    ]));
    const nodes = parseProjectFile('components/Parent.tsx', fs);

    const inner = nodes.get('inner');
    expect(inner).toBeDefined();
    // Conditional styles surface the per-variant values
    expect(inner!.conditionalStyles?.left).toEqual({ 'variant-1': '178px', default: '53px' });
    expect(inner!.conditionalStyles?.top).toEqual({ 'variant-1': '110px', default: '42px' });
    // Static styles use the default branch
    expect(inner!.styles.left).toBe('53px');
    expect(inner!.styles.top).toBe('42px');
  });

  it('no initialVariant prop leaves base = master defaults, motionVariants cleared', () => {
    // Bare `<Inner />` — no choice expressed at all. We expect:
    //   - base styles = master default (no merge happens)
    //   - motionVariants stays as master's child-variant map (no defaultChildVariant
    //     means no bake-in, so we can't safely clear; the existing behavior is
    //     the safest fallback for users who haven't picked anything yet).
    const OUTER_NO_INITIAL = OUTER_WITH_TERNARY_TSX.replace(
      ` initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'}`,
      '',
    );
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Outer.tsx', OUTER_NO_INITIAL],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    const innerRoot = nodes.get('inner:inner-root');
    // No bake-in: master's default backgroundColor stays.
    expect(innerRoot!.styles.backgroundColor).toBe('#aaaaaa');
  });

  it('plain string initialVariant applies to ALL parent variants via base styles', () => {
    // No ternary, just `<Inner initialVariant="variant-1" />`. The user
    // expects every parent viewport to show the child at variant-1 — so we
    // bake variant-1 into base AND clear motionVariants so the canvas
    // doesn't accidentally name-match the parent variant against a
    // similarly-named child variant.
    const OUTER_PLAIN_INITIAL = OUTER_WITH_TERNARY_TSX.replace(
      `initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'}`,
      `initialVariant="variant-1"`,
    );
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_WITH_VARIANTS_TSX],
      ['components/Outer.tsx', OUTER_PLAIN_INITIAL],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    const innerRoot = nodes.get('inner:inner-root');
    expect(innerRoot!.styles.backgroundColor).toBe('#ff0000'); // variant-1 baked in
    // motionVariants cleared — no per-parent overrides means every parent
    // viewport falls back to base styles (with variant-1 already baked in).
    expect(innerRoot!.motionVariants).toEqual({});
  });
});

// Hoisted-variable forwarding — the canvas has to resolve the chain end-to-end
// so a `<Outer poon2="…" />` on a page paints the colour all the way down
// into the inner Inner element. Two cases:
//   1. Master canvas of `Outer.tsx`: the nested `<Inner poon={poon2}/>` must
//      render with `poon2`'s DEFAULT value (so the user can see the
//      inheritance visually when designing).
//   2. Page-level `<Outer poon2="#abcdef" />`: the override has to flow
//      through the forward and end up on Inner's `backgroundColor`.
describe('project-parser: hoisted-variable forwarding', () => {
  const INNER_TSX = `
    import { motion } from 'framer-motion';
    function Inner({ style, poon = '#4e4e2b' }) {
      return (
        <motion.div data-id="inner-root" data-name="Inner" style={{ backgroundColor: poon, ...style }} />
      );
    }
    export default Inner;
  `;

  const OUTER_TSX = `
    import Inner from './Inner';
    /** @pageVariables { "variables": [{"name":"poon2","type":"color","default":"#FF5F93"}] } */
    function Outer({ style, poon2 = '#FF5F93' }) {
      return (
        <div data-id="outer-root" data-name="Outer" style={{ ...style }}>
          <Inner data-id="inner-instance" poon={poon2} />
        </div>
      );
    }
    export default Outer;
  `;

  it('renders the master canvas with the parent default flowing into the nested instance', () => {
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_TSX],
      ['components/Outer.tsx', OUTER_TSX],
    ]));
    const nodes = parseProjectFile('components/Outer.tsx', fs);

    // The expanded Inner root (prefixed with the nested instance's id)
    // should pick up `backgroundColor: '#FF5F93'` from the OUTER file's
    // poon2 default flowing through `poon={poon2}`.
    const expandedInnerRoot = nodes.get('inner-instance:inner-root');
    expect(expandedInnerRoot, 'inner-instance:inner-root should exist after expansion').toBeTruthy();
    expect(expandedInnerRoot!.styles.backgroundColor).toBe('#FF5F93');
  });

  it('forwards a page-level instance override down through the hoisted chain', () => {
    const PAGE_TSX = `
      import Outer from '@/components/Outer';
      export default function Page() {
        return (
          <div data-id="root" style={{ position: 'relative', width: '100%', height: '900px' }}>
            <Outer data-id="outer-instance" poon2="#e4336d" />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['components/Inner.tsx', INNER_TSX],
      ['components/Outer.tsx', OUTER_TSX],
      ['pages/page.tsx', PAGE_TSX],
    ]));
    const nodes = parseProjectFile('pages/page.tsx', fs);

    // After both expansions land, the deepest Inner root should have the
    // page-level override painted on it: `outer-instance:inner-instance:inner-root`.
    const deepest = nodes.get('outer-instance:inner-instance:inner-root');
    expect(deepest, 'inner root should expand all the way through').toBeTruthy();
    expect(deepest!.styles.backgroundColor).toBe('#e4336d');
  });

  it('applies a forwarded prop when the master uses shorthand object syntax', () => {
    // Regression: `resolveInstancePropOverrides` only matched the
    // explicit `cssProp: propName` form. Master files that wrote
    // `style={{ transform, ...style }}` (shorthand — `transform` means
    // `transform: transform`) silently failed the regex and the prop
    // value never reached the inner element's styles. Visible bug: the
    // GoRoCe nested instance on a parent master rendered FLAT even
    // when the hoisted variable's default was `rotate(105deg)…`.
    const SHORT_INNER = `
      import { motion } from 'framer-motion';
      function ShortChild({ style, transform }) {
        return (
          <motion.div data-id="short-root" style={{ transform, ...style }} />
        );
      }
      export default ShortChild;
    `;
    const SHORT_OUTER = `
      import ShortChild from './ShortChild';
      /** @pageVariables { "variables": [{"name":"tx","type":"text","default":"rotate(45deg)"}] } */
      function ShortParent({ style, tx = 'rotate(45deg)' }) {
        return (
          <div data-id="parent-root" style={{ ...style }}>
            <ShortChild data-id="short-instance" transform={tx} />
          </div>
        );
      }
      export default ShortParent;
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['components/ShortChild.tsx', SHORT_INNER],
      ['components/ShortParent.tsx', SHORT_OUTER],
    ]));
    const nodes = parseProjectFile('components/ShortParent.tsx', fs);

    const expandedShortRoot = nodes.get('short-instance:short-root');
    expect(expandedShortRoot, 'expanded inner should exist').toBeTruthy();
    expect(expandedShortRoot!.styles.transform).toBe('rotate(45deg)');
  });
});

describe('project-parser: overlay-border variable on a component instance', () => {
  // A border authored as an OVERLAY (`::after { border: var(--X) }`) bound to a
  // component prop via a CSS custom property (`'--X': prop`). On the canvas the
  // instance is flattened with PREFIXED ids (`instanceId:masterId`) — so the
  // master's <style> rule (keyed off the unprefixed master id) can't match and
  // the canvas falls back to no overlay, while the live site renders the master
  // directly and overlays correctly. expandComponent must (a) map the prop value
  // onto the expanded root's `--X`, and (b) carry the `::after` rule rewritten to
  // the prefixed id so the Renderer can inject it.
  const OVERLAY_COMP = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function Frame({ style, initialVariant = 'default', zefzef = "" }) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-x-1" data-name="Frame" style={{
      position: 'absolute', width: '580px', height: '394px', overflow: 'hidden',
      ...style, "--zefzef": zefzef }}>
  <style>{\`
    [data-id="frame-x-1"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  border: var(--zefzef);
    }
  \`}</style>
        <motion.div layout={true} data-id="frame-x-2" style={{ position: 'absolute', left: '128px', top: '122px' }}>
          <motion.p layout={true} data-id="text-x-3">siso</motion.p>
        </motion.div>
      </motion.div>
    </LayoutGroup>;
}
export default withResponsiveProps(Frame);
`;
  const OVERLAY_PAGE = `
import React from 'react';
import Frame from '@/components/Frame';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <Frame data-id="frame-x-1" zefzef="121px solid #000000" />
    </div>
  );
}
`;

  function makeOverlayFS() {
    return new InMemoryProjectFS(new Map([
      ['app/page.tsx', OVERLAY_PAGE],
      ['components/Frame.tsx', OVERLAY_COMP],
    ]));
  }

  it('maps the instance prop value onto the expanded root\'s --X custom property', () => {
    const nodes = parseProjectFile('app/page.tsx', makeOverlayFS());
    const root = nodes.get('frame-x-1:frame-x-1');
    expect(root).toBeDefined();
    // NOT the master default "" — the instance value flows into the custom prop
    // so the carried `::after`'s `border: var(--zefzef)` resolves on the canvas.
    expect(root!.styles['--zefzef']).toBe('121px solid #000000');
    // And it must NOT have leaked into an inline `border` (that would sit behind
    // children instead of overlaying).
    expect(root!.styles.border).toBeUndefined();
  });

  it('carries the ::after rule with the PREFIXED instance id so it matches the expanded element', () => {
    const nodes = parseProjectFile('app/page.tsx', makeOverlayFS());
    const root = nodes.get('frame-x-1:frame-x-1');
    expect(root!.afterCSS).toBeTruthy();
    // Selector rewritten from the unprefixed master id to the prefixed instance id.
    expect(root!.afterCSS).toContain('[data-id="frame-x-1:frame-x-1"]::after');
    expect(root!.afterCSS).not.toContain('[data-id="frame-x-1"]::after');
    // var() reference is preserved verbatim — custom-property names are stable.
    expect(root!.afterCSS).toContain('border: var(--zefzef)');
    expect(root!.afterCSS).toContain('z-index: 1');
  });
});

describe('project-parser: per-variant variable on a component INSTANCE', () => {
  const COMP = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }];
const fooVariants = { default: {}, 'variant-1': {} };
function NuSeFi({ style, initialVariant = 'default', zefzefze = "0px" }) {
  return <LayoutGroup>
    <motion.div data-id="frame-x-1" variants={fooVariants} initial={initialVariant} animate={initialVariant} style={{
      position: 'absolute', width: '520px', height: '436px', overflow: 'hidden',
      ...style, borderRadius: initialVariant === 'variant-1' ? zefzefze : '0px' }}></motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(NuSeFi);
`;
  function fs(pageInitial: string) {
    const PAGE = `
import React from 'react';
import NuSeFi from '@/components/NuSeFi';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>
    <NuSeFi initialVariant="${pageInitial}" zefzefze="133px" data-id="frame-x-1" style={{ position: 'absolute', left: '244px', top: '166px' }} />
  </div>;
}
`;
    return new InMemoryProjectFS(new Map([['app/page.tsx', PAGE], ['components/NuSeFi.tsx', COMP]]));
  }

  it('resolves borderRadius to the INSTANCE value on the variant it targets', () => {
    const root = parseProjectFile('app/page.tsx', fs('variant-1')).get('frame-x-1:frame-x-1')!;
    expect(root.conditionalStyles!.borderRadius).toEqual({ 'variant-1': '133px', default: '0px' });
    expect(root.styles.borderRadius).toBe('133px'); // baked for the active (pinned) variant
  });

  it('on the DEFAULT variant the conditional falls to the else branch (no instance radius)', () => {
    const root = parseProjectFile('app/page.tsx', fs('default')).get('frame-x-1:frame-x-1')!;
    // variant-1 branch still carries the instance value, but default isn't baked → else (0px).
    expect(root.styles.borderRadius).toBe('0px');
  });
});

describe('expandComponent: per-viewport CMS rebindings (responsiveBindings)', () => {
  const CARD = `
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
function Card({ title = 'Title', ...style }) {
  return <div data-id="card" style={{ ...style }}><p data-id="card-title">{title}</p></div>;
}
export default withResponsiveProps(Card);
`;
  // Instance with a computed data-responsive: a FIELD-REF rebind on 768 + an
  // unbind→default LITERAL on 375, for the bound `title` text prop.
  const PAGE = `
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (
    <div data-id="root">
      <Card data-id="card1" data-responsive={JSON.stringify({"768":{"title":item.shortTitle},"375":{"title":"Untitled"},"_bp":[1440,768,375]})} />
    </div>
  );
}
`;
  const fs = () => new InMemoryProjectFS(new Map([['app/page.tsx', PAGE], ['components/Card.tsx', CARD]]));

  it('lowers a field-ref (rebind) and a literal (unbind→default) onto the bound text node', () => {
    const node = parseProjectFile('app/page.tsx', fs()).get('card1:card-title')!;
    expect(node.responsiveBindings).toBeDefined();
    expect(node.responsiveBindings!.text![768]).toEqual({ field: 'shortTitle' }); // 768 → different field
    expect(node.responsiveBindings!.text![375]).toEqual({ value: 'Untitled' });    // 375 → literal default
  });
});

// ─── Component-file parse cache ──────────────────────────────────────────────
// expandComponent re-parses each referenced component file on every project
// re-parse; the cache memoises that PURE parse (keyed by exact code) and hands
// back a deep clone so the in-place mutations in expandComponent can't corrupt
// the cached copy across instances. These tests pin: (1) caching never changes
// output (warm == cold), (2) editing a component invalidates (no stale serve),
// (3) two instances of the SAME component get INDEPENDENT expansions even when
// one triggers an in-place attr mutation that the other must not inherit.
describe('project-parser: component-file parse cache', () => {
  // Component with a `{title}` text prop. A `data-responsive` field-ref on an
  // INSTANCE makes expandComponent write `node.responsiveBindings` IN PLACE onto
  // the master's `card-title` node (project-parser.ts:578) — the exact mutation
  // the per-instance clone must isolate.
  const CARD_CMS_TSX = `
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';
function Card({ title = 'Title', ...style }) {
  return <div data-id="card" style={{ ...style }}><p data-id="card-title">{title}</p></div>;
}
export default withResponsiveProps(Card);
`;

  it('produces identical output warm (cache hit) vs cold (cache cleared)', () => {
    clearComponentParseCache();
    const cold = parseProjectFile('app/page.tsx', makeFS());      // miss → parse + cache
    const warm = parseProjectFile('app/page.tsx', makeFS());      // hit → clone
    // Snapshot the expanded component subtree from each and deep-compare.
    const pick = (m: Map<string, any>) => JSON.stringify([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    expect(pick(warm)).toBe(pick(cold));
    // And the warm result is still correct (the merge ran on a fresh clone).
    expect(warm.get('card1:card')!.styles.width).toBe('320px');
  });

  it('invalidates when the component file content changes (no stale serve)', () => {
    clearComponentParseCache();
    const v1 = parseProjectFile('app/page.tsx', makeFS());
    expect(v1.get('card1:card')!.styles.width).toBe('320px');

    // Edit the component: width 320 → 480. Different code string → cache miss.
    const editedCard = CARD_TSX.replace("width: '320px'", "width: '480px'");
    const fs2 = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE_TSX],
      ['components/Card.tsx', editedCard],
    ]));
    const v2 = parseProjectFile('app/page.tsx', fs2);
    expect(v2.get('card1:card')!.styles.width).toBe('480px'); // reflects the edit, not a stale 320
  });

  it('isolates in-place CMS-binding mutations between two instances of the same component', () => {
    clearComponentParseCache();
    // card1 carries a data-responsive field-ref → expandComponent writes
    // `responsiveBindings` IN PLACE onto its card-title clone. card2 is plain →
    // its card-title must have NO responsiveBindings. With a cache leak (shared
    // parse, no clone) card2 would inherit card1's binding off the cached node.
    const page = `
      import React from 'react';
      import Card from '@/components/Card';
      export default function Page() {
        return (
          <div data-id="root">
            <Card data-id="card1" data-responsive={JSON.stringify({"768":{"title":item.shortTitle},"_bp":[1440,768,375]})} />
            <Card data-id="card2" />
          </div>
        );
      }
    `;
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Card.tsx', CARD_CMS_TSX],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);

    const title1 = nodes.get('card1:card-title');
    const title2 = nodes.get('card2:card-title');
    expect(title1).toBeDefined();
    expect(title2).toBeDefined();
    // Instance 1 got the in-place binding…
    expect(title1!.responsiveBindings?.text?.[768]).toEqual({ field: 'shortTitle' });
    // …instance 2 did NOT inherit it (clone isolated the cached pristine parse).
    expect(title2!.responsiveBindings).toBeUndefined();
    expect(title1).not.toBe(title2);
  });
});
