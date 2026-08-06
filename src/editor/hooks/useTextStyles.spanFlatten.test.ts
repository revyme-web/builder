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

import { planSpanFlatten, planVariantHoistFanout } from './useTextStyles';

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

describe('useResponsiveText (HTML-string) runs — hasMixedContent is FALSE', () => {
  // A node with per-viewport text overrides stores its primary content as an
  // HTML STRING inside useResponsiveText(…) and parses with hasMixedContent
  // FALSE — keying the flatten on the flag left those spans out-painting every
  // node-level write ("switch back to solid doesn't update", 2026-08-07). The
  // content probe alone decides; keys are KEBAB in this form.
  const STRING_RUNS =
    '<span style="color: transparent; -webkit-text-fill-color: rgb(233, 103, 103);">Building with pre</span>'
    + '<span style="color: transparent; -webkit-text-fill-color: rgb(233, 103, 103);">cision</span>';

  test('base write strips despite hasMixedContent false', () => {
    const plan = planSpanFlatten({
      property: 'color', hasMixedContent: false, textContent: STRING_RUNS, isScopedWrite: false,
    });
    expect(plan.strip).toBe(true);
  });

  test('kebab-only keys are probed (camel probe was blind to font-size:)', () => {
    const plan = planSpanFlatten({
      property: 'fontSize', hasMixedContent: false,
      textContent: '<span style="font-size: 40px;">on and exp</span>', isScopedWrite: false,
    });
    expect(plan.strip).toBe(true);
  });

  test('scoped write hoists the single string-form span value', () => {
    const plan = planSpanFlatten({
      property: 'fontSize', hasMixedContent: false,
      textContent: '<span style="font-size: 40px;">all the text</span>', isScopedWrite: true,
    });
    expect(plan.strip).toBe(true);
    expect(plan.hoistValue).toBe('40px');
  });

  test('span-less plain content still never strips', () => {
    expect(planSpanFlatten({
      property: 'color', hasMixedContent: false, textContent: 'sdfqsdfqsdf', isScopedWrite: false,
    })).toEqual({ strip: false });
  });
});

describe('motion.span runs (design-component variantized text)', () => {
  // The variant pass motionizes inner spans (`<span>` → `<motion.span
  // layout={true}>`). The cheap `'<span'` probe was blind to them, so inside
  // variant components the flatten NEVER fired — a span's baked color beat
  // every variant color forever ("button text won't change color", 2026-08-05).
  const MOTION_SPAN_CONTENT =
    `<motion.span layout={true} style={{ color: 'rgb(21, 21, 21)' }}>CONTACT US</motion.span>`;

  test('base write strips the motion.span color', () => {
    const plan = planSpanFlatten({
      property: 'color',
      hasMixedContent: true,
      textContent: MOTION_SPAN_CONTENT,
      isScopedWrite: false,
    });
    expect(plan.strip).toBe(true);
  });

  test('variant-scoped write hoists the motion.span color then strips', () => {
    const plan = planSpanFlatten({
      property: 'color',
      hasMixedContent: true,
      textContent: MOTION_SPAN_CONTENT,
      isScopedWrite: true,
    });
    expect(plan.strip).toBe(true);
    expect(plan.hoistValue).toBe('rgb(21, 21, 21)');
  });

  test('still no-ops when the motion.span does not carry the property', () => {
    const plan = planSpanFlatten({
      property: 'fontSize',
      hasMixedContent: true,
      textContent: MOTION_SPAN_CONTENT,
      isScopedWrite: false,
    });
    expect(plan.strip).toBe(false);
  });
});

describe('planVariantHoistFanout', () => {
  // The span shadowed every variant entry's value — after the strip those
  // stale entries resurrect over the hoisted base (framer applies variant
  // entries inline). Editing variant-3's color flipped every other tile to
  // the entries' old white (2026-08-05).
  const MV = {
    default: { color: '#ffffff' },
    'default-hover': { color: '#ffffff' },
    'default-pressed': { color: '#ffffff' },
    'variant-3-hover': { color: '#ffffff' },
    'variant-3-pressed': { color: '#ffffff' },
  };

  test('returns every non-edited entry carrying the property', () => {
    const out = planVariantHoistFanout(MV, 'color', 'variant-3');
    expect(out.sort()).toEqual(['default', 'default-hover', 'default-pressed', 'variant-3-hover', 'variant-3-pressed'].sort());
  });

  test('excludes the edited variant', () => {
    const out = planVariantHoistFanout(MV, 'color', 'default-hover');
    expect(out).not.toContain('default-hover');
    expect(out).toContain('default');
  });

  test('entries without the property are skipped', () => {
    const out = planVariantHoistFanout({ default: { color: '#fff' }, open: { height: '10px' } }, 'color', 'v2');
    expect(out).toEqual(['default']);
  });

  test('null variants → empty', () => {
    expect(planVariantHoistFanout(null, 'color', 'v')).toEqual([]);
  });
});
