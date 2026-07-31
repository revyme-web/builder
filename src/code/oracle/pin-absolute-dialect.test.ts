import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// A minimal page with ONE child whose attrs + style are spliced in, so each
// test varies only the thing under test. data-id="x" is the node under test;
// "root" is treated as pre-existing in the default helper.
const PAGE = (attr: string, style: string) => `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    <div data-id="x" data-name="X"${attr} style={{ ${style} }}></div>
  </div>;
}`;

// The gate passes the PREVIOUS file's data-ids; the rule only flags NEW nodes.
// Default: "root" already existed, so "x" is the new node under test.
const pins = (code: string, existing: Set<string> = new Set(['root'])) =>
  checkFile(code, { kind: 'page', existingDataIds: existing }).filter((x) => x.code === 'PIN_ABSOLUTE_NODE').length;

describe('PIN_ABSOLUTE_NODE — NEW absolute nodes must carry data-pinned="true"', () => {
  it('a new absolute node WITHOUT data-pinned bounces', () => {
    expect(pins(PAGE('', "position: 'absolute', top: '10px', left: '10px', width: '50px', height: '50px'"))).toBe(1);
  });

  it('a new absolute node WITH data-pinned="true" passes', () => {
    expect(pins(PAGE(' data-pinned="true"', "position: 'absolute', top: '10px', left: '10px', width: '50px', height: '50px'"))).toBe(0);
  });

  it('data-pinned="false" still bounces (explicitly unpinned)', () => {
    expect(pins(PAGE(' data-pinned="false"', "position: 'absolute', top: '10px'"))).toBe(1);
  });

  it('a PRE-EXISTING absolute node is NOT flagged (only new nodes)', () => {
    expect(pins(PAGE('', "position: 'absolute', top: '10px'"), new Set(['root', 'x']))).toBe(0);
  });

  it('with NO existingDataIds the rule stays silent (direct/standalone checks)', () => {
    expect(checkFile(PAGE('', "position: 'absolute', top: '10px'"), { kind: 'page' })
      .filter((x) => x.code === 'PIN_ABSOLUTE_NODE').length).toBe(0);
  });

  it('position: relative is never flagged', () => {
    expect(pins(PAGE('', "position: 'relative', width: '50px'"))).toBe(0);
  });

  it('position: fixed is never flagged (sticky/overlay chrome, not a pinned node)', () => {
    expect(pins(PAGE('', "position: 'fixed', top: '0px'"))).toBe(0);
  });

  it('overlay nodes (data-overlay) are excluded — the portal owns their position', () => {
    expect(pins(PAGE(' data-overlay="ov-1"', "position: 'absolute', top: '10px'"))).toBe(0);
  });

  it('a component ROOT (…style spread) is excluded — positioned by variantConfig', () => {
    expect(pins(PAGE('', "position: 'absolute', width: '300px', ...style"))).toBe(0);
  });

  it('canvas-workspace nodes (inside const canvasNodes) are excluded', () => {
    const code = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}></div>;
}
const canvasNodes = (<><div data-id="cn" data-name="CN" style={{ position: 'absolute', left: '0px', top: '0px', width: '40px', height: '40px' }}></div></>);`;
    expect(checkFile(code, { kind: 'page', existingDataIds: new Set(['root']) })
      .filter((x) => x.code === 'PIN_ABSOLUTE_NODE').length).toBe(0);
  });

  it('NOT enforced inside component files — masters position absolute children via the variant system', () => {
    const comp = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
/** @name "Card" */
function Card({ style }: { style?: React.CSSProperties }) {
  return (
    <motion.div data-id="card" data-name="Card" style={{ position: 'absolute', width: '300px', ...style }}>
      <motion.div data-id="badge" data-name="Badge" style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px' }}></motion.div>
    </motion.div>
  );
}
export default withResponsiveProps(Card);`;
    // page-only rule: a brand-new design component (all children new) stays clean
    expect(checkFile(comp, { kind: 'component', existingDataIds: new Set() })
      .filter((x) => x.code === 'PIN_ABSOLUTE_NODE').length).toBe(0);
  });
});
