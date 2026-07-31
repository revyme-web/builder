// useTextStyles.spanFlatten.test.ts — the whole-node TEXT-MARK write vs a
// rich-text node's inner `<span style>` runs.
//
// A span's own value always beats the `<p>`'s (CSS compares declarations per
// ELEMENT, never across ancestors), so setting the property on the node is
// invisible until the spans give it up — the FLATTEN. That's right for a BASE
// write, but a SCOPED write (page replica `@media` rule / component variant)
// only authors the value for ONE viewport while the strip removes it from all of
// them: sizing a 48px heading on mobile dropped the span's 48px and left primary
// + tablet on the `<p>`'s own 16px (user report 2026-07-26). A scoped write now
// HOISTS the span's value onto the base first.
//
// The helper runs the real `getInlineSpanPropertyState`, so these fragments are
// exercised through the actual span parser.

import { describe, test, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));

import { planSpanFlatten } from './useTextStyles';

// The exact shape from the report: `<p>` at 16px, one span carrying 48px.
const HEADLINE = `<span style={{ color: 'rgb(255, 255, 255)', fontSize: '48px', fontWeight: 'bold' }}><strong>Accounting software that handles it all.</strong></span>`;
// Two runs with DIFFERENT colours — no single base value can represent it.
const MIXED = `<span style={{ color: 'red' }}>red</span> and <span style={{ color: 'blue' }}>blue</span>`;

describe('planSpanFlatten', () => {
  test('BASE write strips the spans with no hoist (unchanged behaviour)', () => {
    const plan = planSpanFlatten({
      property: 'fontSize', hasMixedContent: true, textContent: HEADLINE, isScopedWrite: false,
    });
    expect(plan.strip).toBe(true);
    expect(plan.hoistValue).toBeUndefined();
  });

  test('SCOPED write hoists the span value to the base before stripping', () => {
    const plan = planSpanFlatten({
      property: 'fontSize', hasMixedContent: true, textContent: HEADLINE, isScopedWrite: true,
    });
    expect(plan.strip).toBe(true);
    expect(plan.hoistValue).toBe('48px');
  });

  test('SCOPED write on a MIXED run strips nothing (per-run formatting preserved)', () => {
    const plan = planSpanFlatten({
      property: 'color', hasMixedContent: true, textContent: MIXED, isScopedWrite: true,
    });
    expect(plan.strip).toBe(false);
    expect(plan.hoistValue).toBeUndefined();
  });

  test('a BASE write on a mixed run still flattens (the node value wins everywhere)', () => {
    const plan = planSpanFlatten({
      property: 'color', hasMixedContent: true, textContent: MIXED, isScopedWrite: false,
    });
    expect(plan.strip).toBe(true);
  });

  test('hoists a colour the same way', () => {
    const plan = planSpanFlatten({
      property: 'color', hasMixedContent: true, textContent: HEADLINE, isScopedWrite: true,
    });
    expect(plan.strip).toBe(true);
    expect(plan.hoistValue).toBe('rgb(255, 255, 255)');
  });

  test('no-op for a property the spans do not carry', () => {
    // The headline span has no letterSpacing — nothing to flatten or hoist.
    expect(planSpanFlatten({
      property: 'letterSpacing', hasMixedContent: true, textContent: HEADLINE, isScopedWrite: true,
    })).toEqual({ strip: false });
  });

  test('no-op for a PARAGRAPH property (not span-overridable)', () => {
    expect(planSpanFlatten({
      property: 'textAlign', hasMixedContent: true, textContent: HEADLINE, isScopedWrite: false,
    })).toEqual({ strip: false });
  });

  test('no-op on a plain (non-rich) text node', () => {
    expect(planSpanFlatten({
      property: 'fontSize', hasMixedContent: false, textContent: 'just words', isScopedWrite: true,
    })).toEqual({ strip: false });
    expect(planSpanFlatten({
      property: 'fontSize', hasMixedContent: false, textContent: 'just words', isScopedWrite: false,
    })).toEqual({ strip: false });
  });

  test('no-op on empty content', () => {
    expect(planSpanFlatten({
      property: 'fontSize', hasMixedContent: true, textContent: '', isScopedWrite: true,
    })).toEqual({ strip: false });
  });
});
