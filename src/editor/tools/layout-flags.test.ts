// layout-flags.test.ts — which layout mode the Layout panel surfaces.
//
// Context: layouts are a FRAME concept. Text elements never mount the
// Layout tool at all (gated in PropertiesPanel) — the text tool's Adjust
// control writes `display:flex` alignment plumbing onto text nodes, which
// once made the panel surface frame controls on a <p>. The text
// multi-column "Block" mode was removed entirely (2026-08-12): CSS multicol
// can't coexist with Adjust's display:flex, and it behaved erratically with
// auto width / fixed height. Legacy `columnCount` in user source still
// renders, but it never counts as a layout here.

import { describe, it, expect } from 'vitest';
import { detectLayoutFlags } from './LayoutTool';

describe('detectLayoutFlags', () => {
  it('display:flex is a flex layout', () => {
    expect(detectLayoutFlags({ display: 'flex' })).toEqual({ hasFlex: true, hasGrid: false, hasLayout: true });
  });

  it('display:grid is a grid layout', () => {
    expect(detectLayoutFlags({ display: 'grid' })).toEqual({ hasFlex: false, hasGrid: true, hasLayout: true });
  });

  it('hidden node with flex props keeps its authored layout', () => {
    expect(detectLayoutFlags({ display: 'none', flexDirection: 'row', gap: '8px' }).hasFlex).toBe(true);
  });

  it('grid takes precedence when both prop families coexist', () => {
    const flags = detectLayoutFlags({ flexDirection: 'row', gridTemplateColumns: '1fr 1fr' });
    expect(flags.hasGrid).toBe(true);
    expect(flags.hasFlex).toBe(false);
  });

  it('legacy multicol props are NOT a layout (Block mode removed 2026-08-12)', () => {
    expect(detectLayoutFlags({ columnCount: '2', columnGap: '2rem' })).toEqual({
      hasFlex: false, hasGrid: false, hasLayout: false,
    });
  });

  it('no layout props at all → no layout', () => {
    expect(detectLayoutFlags({ width: '100px', color: '#fff' }).hasLayout).toBe(false);
  });
});

// A design component writes per-variant layout props as inline ternaries, and
// the "off" branch carries the CSS INITIALS so the other variants stay neutral
// (`flexDirection: initialVariant === 'variant-2' ? 'column' : 'row'`). The
// parser lifts that branch into the base styles, so Desktop and Tablet showed a
// full Flex panel for a frame whose layout exists only on variant-2 (user
// report 2026-09-21).
describe('detectLayoutFlags — CSS initials are not a layout', () => {
  it('ignores the neutral branch of a per-variant ternary', () => {
    expect(detectLayoutFlags({
      flexDirection: 'row', alignItems: 'stretch', justifyContent: 'flex-start',
    }).hasLayout).toBe(false);
  });

  it('still detects a real layout with no display', () => {
    expect(detectLayoutFlags({ flexDirection: 'column' }).hasFlex).toBe(true);
    expect(detectLayoutFlags({ alignItems: 'center' }).hasFlex).toBe(true);
    expect(detectLayoutFlags({ gap: '12px' }).hasFlex).toBe(true);
  });

  it('an explicit display always wins', () => {
    expect(detectLayoutFlags({ display: 'flex', flexDirection: 'row' }).hasFlex).toBe(true);
    expect(detectLayoutFlags({ display: 'inline-flex' }).hasFlex).toBe(true);
  });

  // The case this function was written for: Hide and Layout are independent, so
  // a hidden frame keeps its authored layout even when the props are initials.
  it('keeps the HIDDEN-node behaviour', () => {
    expect(detectLayoutFlags({ display: 'none', flexDirection: 'row' }).hasFlex).toBe(true);
    expect(detectLayoutFlags({ display: 'none', alignItems: 'stretch' }).hasFlex).toBe(true);
  });

  it('grid props are unaffected', () => {
    expect(detectLayoutFlags({ gridTemplateColumns: '1fr 1fr' }).hasGrid).toBe(true);
  });

  it('gap: 0 alone is not a layout', () => {
    expect(detectLayoutFlags({ gap: '0px' }).hasLayout).toBe(false);
  });
});
