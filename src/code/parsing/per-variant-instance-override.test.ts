import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { parseProjectFile, clearComponentParseCache } from './project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';
import { resolveVariantStyles } from '@/canvas/Renderer';

// SeJoRe: variant-1 paints black, default paints pink.
const SEJORE = `'use client';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }];
function SeJoRe({ style, initialVariant = 'default' }) {
  return <motion.div data-id="sj-root" data-name="SeJoRe"
    initial={initialVariant} animate={['default', initialVariant]}
    variants={{ default: { backgroundColor: '#ffaaaa' }, 'variant-1': { backgroundColor: '#000000' } }}
    style={{ position: 'absolute', width: '100px', height: '100px', ...style }} />;
}
export default withResponsiveProps(SeJoRe);`;

// ViMoNe nests SeJoRe and hoists its variant on parent variant-1 (seJoReVariant1 var branch).
const VIMONE = `'use client';
/** @pageVariables { "variables": [ { "name": "seJoReVariant1", "type": "text", "default": "default" } ] } */
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import SeJoRe from '@/components/SeJoRe';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }];
function ViMoNe({ style, initialVariant = 'default', seJoReVariant1 = 'default' }) {
  return <motion.div data-id="vm-root" data-name="Frame" style={{ position: 'absolute', width: '400px', height: '300px', ...style }}>
    <SeJoRe data-id="sj" data-name="SeJoRe" initialVariant={initialVariant === 'variant-1' ? seJoReVariant1 : 'default'} />
  </motion.div>;
}
export default withResponsiveProps(ViMoNe);`;

const PAGE = (vm: string) => `import React from 'react';
import ViMoNe from '@/components/ViMoNe';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <ViMoNe data-id="vm1" data-name="Frame"${vm} style={{ position: 'absolute', left: '0px', top: '0px' }} />
  </div>;
}`;

// The resolved variant lives on the expanded nested-instance node as `componentVariant` (the Renderer
// resolves the variant STYLES from it at render time — they're not baked into node.styles at parse time).
const variantOfSeJoRe = (vmAttrs: string): string | undefined => {
  clearComponentParseCache();
  const fs = new InMemoryProjectFS(new Map([
    ['app/page.tsx', PAGE(vmAttrs)],
    ['components/ViMoNe.tsx', VIMONE],
    ['components/SeJoRe.tsx', SEJORE],
  ]));
  const nodes = parseProjectFile('app/page.tsx', fs);
  // The SeJoRe ROOT (re-expanded from its own resolved initialVariant) carries the resolved variant. The
  // instance WRAPPER inherits the OUTER (ViMoNe) variant, so it's the wrong node to check.
  const rootId = [...nodes.keys()].find((k) => k.endsWith(':sj-root'));
  return rootId ? (nodes.get(rootId) as { componentVariant?: string }).componentVariant ?? undefined : undefined;
};

// A forwarded variant var BAKED as an expression literal (`baPoWeVariant={"variant-1"}`) — the shape
// substituteTemplateVarAttrsForCanvas produces for a route-override template var — lands in componentProps,
// NOT attrs. The expandComponent substitution must read instanceProps (attrs + componentProps), else the
// nested instance keeps its master default (the template→Header→BaPoWe "black on canvas, white live" bug).
const VIMONE_DIRECT = `'use client';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import SeJoRe from '@/components/SeJoRe';
function ViMoNe({ style, baPoWeVariant = 'default' }) {
  return <motion.div data-id="vm-root" data-name="Frame" style={{ position: 'absolute', width: '400px', height: '300px', ...style }}>
    <SeJoRe data-id="sj" data-name="SeJoRe" initialVariant={baPoWeVariant} />
  </motion.div>;
}
export default withResponsiveProps(ViMoNe);`;

// The real Header→Logo Mark shape: the nested instance's variant is a PER-PARENT-VARIANT conditional keyed on
// the Header's variant (`variant === 'variant-6' ? baPoWeVariant : 'default'`), and the Header carries the
// resolved variant via a literal/canvasVariant (not in attrs.initialVariant as a plain attr). The variable
// branch must resolve to the OUTER instance's prop (route override), not the baked page-var default.
describe('per-parent-variant conditional resolves the VARIABLE branch via the outer override', () => {
  const HEADER_COND = `'use client';
/** @propMeta {"baPoWeVariant":{"variantOf":"SeJoRe"}} */
/** @pageVariables { "variables": [ { "name": "baPoWeVariant", "type": "text", "default": "variant-4" } ] } */
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import SeJoRe from '@/components/SeJoRe';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-6' }];
function Header({ style, initialVariant = 'default', baPoWeVariant = 'variant-4' }) {
  const [variant, setVariant] = useState(initialVariant);
  return <motion.div data-id="h-root" data-name="Header" initial={initialVariant} animate={['default', variant]} style={{ position: 'relative', width: '300px', height: '60px', ...style }}>
    <SeJoRe data-id="logo-mark" data-name="Logo Mark" initialVariant={variant === 'variant-6' ? baPoWeVariant : 'default'} />
  </motion.div>;
}
export default withResponsiveProps(Header);`;
  const layout = (headerAttr: string) => `'use client';
/** @pageVariables { "variables": [ { "name": "baPoWeVariant", "type": "text", "default": "variant-4" } ] } */
import React from 'react';
import Header from '@/components/Header';
export default function LayoutClient({ children, baPoWeVariant = 'variant-4' }) {
  return <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%' }}>
    <Header data-id="Header-1" data-name="Header"${headerAttr} baPoWeVariant={baPoWeVariant} style={{ position: 'fixed', width: '100%' }}></Header>
  </div>;
}`;
  const run = (headerAttr: string, routeVal: string): string | undefined => {
    clearComponentParseCache();
    const code = layout(headerAttr);
    const fs = new InMemoryProjectFS(new Map([
      ['components/SeJoRe.tsx', SEJORE],
      ['components/Header.tsx', HEADER_COND],
      ['app/LayoutClient.tsx', code],
    ]));
    const nodes = parseProjectFile('app/LayoutClient.tsx', fs, code, { baPoWeVariant: routeVal });
    const root = [...nodes.keys()].find((k) => k.endsWith(':sj-root'));
    return root ? (nodes.get(root) as { componentVariant?: string }).componentVariant : undefined;
  };

  it('Header at variant-6 → nested instance takes the ROUTE OVERRIDE (not the baked variant-4 default)', () => {
    expect(run(' initialVariant="variant-6"', 'variant-1')).toBe('variant-1');
  });

  it('Header at default → nested instance takes the else-branch literal, ignoring the override', () => {
    expect(run(' initialVariant="default"', 'variant-1')).toBe('default');
  });
});

describe('forwarded variant var baked as a componentProps literal resolves on the canvas', () => {
  it('passes the {"variant-1"} expression literal through to the nested instance', () => {
    clearComponentParseCache();
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', `import React from 'react';
import ViMoNe from '@/components/ViMoNe';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <ViMoNe data-id="vm1" data-name="Frame" baPoWeVariant={"variant-1"} style={{ position: 'absolute', left: '0px', top: '0px' }} />
  </div>;
}`],
      ['components/ViMoNe.tsx', VIMONE_DIRECT],
      ['components/SeJoRe.tsx', SEJORE],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);
    const rootId = [...nodes.keys()].find((k) => k.endsWith(':sj-root'));
    expect(rootId ? (nodes.get(rootId) as { componentVariant?: string }).componentVariant : undefined).toBe('variant-1');
  });
});

describe('per-variant variant variable resolves on the CANVAS for a page instance', () => {
  it('parent variant-1 + seJoReVariant1="variant-1" → nested SeJoRe resolves to variant-1', () => {
    expect(variantOfSeJoRe(' initialVariant="variant-1" seJoReVariant1="variant-1"')).toBe('variant-1');
  });

  it('parent default → nested SeJoRe resolves the default branch', () => {
    expect(variantOfSeJoRe(' initialVariant="default"')).toBe('default');
  });

  it('parent variant-1 WITHOUT override → inherits the variable default', () => {
    expect(variantOfSeJoRe(' initialVariant="variant-1"')).toBe('default');
  });
});

describe('the resolved variant STYLE paints on the canvas (not just componentVariant)', () => {
  // SeJoRe with a CONST variant object — the shape the generator emits (an INLINE `variants={{…}}` is NOT
  // parsed into motionVariants, so it can't carry a per-variant style). variant-1 → black, default/base → pink.
  const SEJORE_CONST = `'use client';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }];
const fv = { default: { backgroundColor: '#ffaaaa' }, 'variant-1': { backgroundColor: '#000000' } };
function SeJoRe({ style, initialVariant = 'default', ...rest }) {
  return <motion.div data-id="sj-root" data-name="SeJoRe" variants={fv} initial={['default', initialVariant]} animate={['default', initialVariant]} {...rest} style={{ position: 'absolute', width: '100px', height: '100px', backgroundColor: '#ffaaaa', ...style }} />;
}
export default withResponsiveProps(SeJoRe);`;
  const sjRoot = (vmAttrs: string) => {
    clearComponentParseCache();
    const fs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', PAGE(vmAttrs)],
      ['components/ViMoNe.tsx', VIMONE],
      ['components/SeJoRe.tsx', SEJORE_CONST],
    ]));
    const nodes = parseProjectFile('app/page.tsx', fs);
    return nodes.get([...nodes.keys()].find((k) => k.endsWith(':sj-root'))!)!;
  };
  // Regression: a component nested INSIDE another component on a plain page gets componentVariant='variant-1'
  // but NO responsiveVariantMap (it's not a page-LEVEL instance). On a page render `variantName` is null, so
  // resolveVariantStyles must fall back to componentVariant — else it paints the base (#ffaaaa) instead of
  // variant-1 (#000000). (componentVariant resolution above was already correct; only the STYLE didn't paint.)
  it('parent variant-1 + override → root paints variant-1 black, NOT the pink default', () => {
    expect(resolveVariantStyles(sjRoot(' initialVariant="variant-1" seJoReVariant1="variant-1"'), null, 1440).backgroundColor).toBe('#000000');
  });
  it('parent default → root paints the pink base (no spurious variant-1)', () => {
    expect(resolveVariantStyles(sjRoot(' initialVariant="default"'), null, 1440).backgroundColor).toBe('#ffaaaa');
  });
});
