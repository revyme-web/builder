// move-strips-banded-order.test.ts — a REPARENT must strip the moved node's
// per-viewport banded `order` overrides.
//
// The bug (2026-08-11): "Social Proof" lived inside the hero with banded
// `order: 2 !important` at 912/430 (a replica reorder of the HERO's children).
// A layers-drag made it a sibling of the hero at root. The band rules follow
// the node's data-id into the new parent, where `2` is a foreign numbering —
// and on a templated page (whose canvas merge strips the sections' inline
// `order` and stacks them by DOM order) that single banded order sorted the
// section BELOW everything: it "disappeared" to the bottom of the tablet and
// mobile tiles while desktop / iPad (no band rule) looked fine.
//
// The strip lives in moveNodeInCode — the one choke point every reparent
// flows through (layers drag, canvas drag, plugin SDK, AI moves) — guarded on
// the parent actually changing: per-viewport section order divergence within
// ONE parent is a feature and must survive same-parent moves.

import { describe, it, expect, beforeEach } from 'vitest';
import { transform } from '@babel/standalone';
import { moveNodeInCode } from './generator-crud';
import { findBandedOrderWidths, stripBandedOrderForNode } from './generator-styles';
import { syncViewportWidths } from '../stores/viewport-store';

const parses = (code: string) =>
  expect(() => transform(code, { presets: [['react', { runtime: 'classic' }]] })).not.toThrow();

beforeEach(() => {
  syncViewportWidths({ desktop: 1440, tablet: 912, mobile: 430 });
});

// Shape of the real page: stats inside the hero, banded order for the HERO's
// child space at two widths plus a node-local width override that must survive.
const PAGE = `'use client';

import React from 'react';

export default function Page() {
  return <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
  <style>{\`
    @media (max-width: 912px) and (min-width: 430.02px) {
      [data-id="stats"] { order: 2 !important; width: 415px !important; }
      [data-id="arc"] { order: 0 !important; }
    }
    @media (max-width: 430px) {
      [data-id="stats"] { order: 2 !important; padding-top: 32px !important; }
      [data-id="arc"] { order: 0 !important; }
    }
  \`}</style>
    <div data-id="hero" style={{ display: 'flex', order: '0' }}>
      <div data-id="arc" style={{ order: '1' }}>arc</div>
      <div data-id="stats" style={{ order: '2' }}>stats</div>
    </div>
    <div data-id="faq" style={{ order: '1' }}>faq</div>
  </div>;
}
`;

describe('findBandedOrderWidths', () => {
  it('reports every band width carrying an order for the node', () => {
    expect(findBandedOrderWidths(PAGE, 'stats').sort((a, b) => a - b)).toEqual([430, 912]);
  });

  it('is empty for a node with banded props but no order', () => {
    const page = PAGE.replace('order: 2 !important; width: 415px', 'width: 415px')
      .replace('order: 2 !important; padding-top', 'padding-top');
    expect(findBandedOrderWidths(page, 'stats')).toEqual([]);
  });

  it('is empty for a node absent from the style block', () => {
    expect(findBandedOrderWidths(PAGE, 'faq')).toEqual([]);
  });
});

describe('stripBandedOrderForNode', () => {
  it('removes order from every band, keeps the node-local overrides', () => {
    const out = stripBandedOrderForNode(PAGE, 'stats');
    expect(out).not.toMatch(/\[data-id="stats"\]\s*\{[^}]*order/);
    expect(out).toContain('width: 415px !important');
    expect(out).toContain('padding-top: 32px !important');
    parses(out);
  });

  it("leaves the OTHER nodes' banded orders untouched", () => {
    const out = stripBandedOrderForNode(PAGE, 'stats');
    expect(out.match(/\[data-id="arc"\]\s*\{\s*order: 0 !important;\s*\}/g)?.length).toBe(2);
  });

  it('is a no-op when the node has no banded order', () => {
    expect(stripBandedOrderForNode(PAGE, 'faq')).toBe(PAGE);
  });

  it('preserves :lang() rules through the rewrite', () => {
    const src = PAGE.replace(
      '<style>{`',
      '<style>{`\n    :lang(fr) [data-id="stats"] { opacity: 1 !important; }',
    );
    const out = stripBandedOrderForNode(src, 'stats');
    expect(out).toContain(':lang(fr) [data-id="stats"] { opacity: 1 !important; }');
    expect(out).not.toMatch(/\[data-id="stats"\]\s*\{[^}]*order/);
  });
});

describe('moveNodeInCode — banded order on reparent', () => {
  it('strips the banded order when the parent CHANGES', () => {
    const out = moveNodeInCode(PAGE, 'stats', 'root', undefined, 1);
    expect(out).not.toMatch(/\[data-id="stats"\]\s*\{[^}]*order/);
    // Node-local band overrides survive the move.
    expect(out).toContain('width: 415px !important');
    // The sibling left behind keeps its band numbering.
    expect(out).toMatch(/\[data-id="arc"\]\s*\{\s*order: 0 !important;/);
    parses(out);
  });

  it('keeps the banded order on a SAME-parent move (per-viewport reorder is a feature)', () => {
    const out = moveNodeInCode(PAGE, 'stats', 'hero', undefined, 0);
    expect(out).toMatch(/\[data-id="stats"\]\s*\{[^}]*order: 2 !important/);
    parses(out);
  });

  it('strips on exit from the tree (reparent into another section)', () => {
    const out = moveNodeInCode(PAGE, 'stats', 'faq', undefined, 0);
    expect(out).not.toMatch(/\[data-id="stats"\]\s*\{[^}]*order/);
    parses(out);
  });

  it('anchor insert: insertBeforeId places the node before that sibling in JSX', () => {
    const out = moveNodeInCode(PAGE, 'stats', 'root', undefined, undefined, undefined, undefined, undefined, 'hero');
    // Match the JSX opening tags, NOT the first occurrence of the data-id —
    // the style block mentions these ids first and would satisfy any order.
    const heroIdx = out.indexOf('<div data-id="hero"');
    const statsIdx = out.indexOf('<div data-id="stats"');
    expect(statsIdx).toBeGreaterThan(-1);
    expect(statsIdx).toBeLessThan(heroIdx);
    parses(out);
  });
});
