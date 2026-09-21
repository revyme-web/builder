import { describe, it, expect } from 'vitest';
import { vectorSetFitSize, vectorSetLinkedWrite, vectorSetUnitAction, readFitDim, isFitRow, vectorSetResnap, fitModeAfterHandResize, FIT_DIM_ATTR } from './vector-set-fit';
import { updateHtmlAttrsInCode } from '@/code/generation/generator-attrs';
import { parseJSXToNodes } from '@/code/parsing/parser';

// The reported variant: 240 × 217, placed at 26px wide.
const V = { width: 240, height: 217 };

describe('vectorSetFitSize', () => {
  it('derives height from the width, keeping the aspect', () => {
    // 26 × (217/240) ≈ 23.51 — NOT the intrinsic 217 the user saw.
    expect(vectorSetFitSize(V, 'height', 26)).toBe('23.51px');
  });

  it('derives width from the height', () => {
    expect(vectorSetFitSize(V, 'width', 217)).toBe('240px');
  });

  it('round-trips a natural-size box', () => {
    expect(vectorSetFitSize(V, 'height', 240)).toBe('217px');
  });

  // Both dimensions Fit, or no definite width to work from: the vector at 1:1.
  it('falls back to the natural size with nothing to derive from', () => {
    expect(vectorSetFitSize(V, 'height', null)).toBe('217px');
    expect(vectorSetFitSize(V, 'width', undefined)).toBe('240px');
    expect(vectorSetFitSize(V, 'height', 0)).toBe('217px');
    expect(vectorSetFitSize(V, 'height', NaN)).toBe('217px');
  });

  it('returns null when there is no usable variant, so the caller keeps its own behaviour', () => {
    expect(vectorSetFitSize(null, 'height', 26)).toBeNull();
    expect(vectorSetFitSize({ width: 0, height: 217 }, 'height', 26)).toBeNull();
    expect(vectorSetFitSize({ width: 240, height: 0 }, 'width', 26)).toBeNull();
  });
});


// The reported sequence: type 80 into Height on the 240×217 variant.
describe('the linked pair', () => {
  it('80 tall needs 88.48 wide', () => {
    expect(vectorSetFitSize(V, 'width', 80)).toBe('88.48px');
  });
  it('and that width maps straight back to 80 tall', () => {
    expect(parseFloat(vectorSetFitSize(V, 'height', 88.48)!)).toBeCloseTo(80, 1);
  });
  it('always answers in definite px, never auto', () => {
    for (const d of ['width', 'height'] as const) {
      expect(vectorSetFitSize(V, d, 50)).toMatch(/^[\d.]+px$/);
    }
  });
});

// Fit as a MODE over definite-px storage. Choosing `auto` used to change
// nothing visible and snap straight back to `px`.
describe('vectorSetUnitAction', () => {
  const base = { variant: V, computedWidth: 100, computedHeight: 90.42, fitDim: null as null | 'width' | 'height' | 'both' };

  it('choosing auto marks that row as the Fit side and snaps it to the ratio', () => {
    const a = vectorSetUnitAction({ ...base, dim: 'height', toUnit: 'auto' });
    expect(a).toEqual({ styles: { height: '90.42px', aspectRatio: '' }, fitDim: 'height' });
  });

  // Reference parity: "enter 80 on height and width becomes the computed one".
  it('TYPING into the Fit row makes it fixed and hands Fit to the other row', () => {
    const a = vectorSetUnitAction({ ...base, dim: 'height', toUnit: 'px', typedNum: 80, fitDim: 'height' });
    expect(a).toEqual({ styles: { height: '80px', width: '88.48px', aspectRatio: '' }, fitDim: 'width' });
  });

  it('picking px from the dropdown only drops the mode', () => {
    expect(vectorSetUnitAction({ ...base, dim: 'height', toUnit: 'px', fitDim: 'height' }))
      .toEqual({ styles: {}, fitDim: '' });
    // …and leaves a mode that lives on the OTHER row alone
    expect(vectorSetUnitAction({ ...base, dim: 'height', toUnit: 'px', fitDim: 'width' }))
      .toEqual({ styles: {}, fitDim: undefined });
  });

  it('refuses viewport units and fill', () => {
    for (const u of ['vw', 'vh', 'fill']) {
      expect(vectorSetUnitAction({ ...base, dim: 'width', toUnit: u })).toBe('blocked');
    }
  });

  it('never writes a CSS auto — the storage stays definite px', () => {
    for (const dim of ['width', 'height'] as const) {
      const a = vectorSetUnitAction({ ...base, dim, toUnit: 'auto' });
      if (a === 'blocked') throw new Error('unexpected');
      expect(Object.values(a.styles)).not.toContain('auto');
    }
  });

  it('lets % pass through to the generic logic, dropping the mode on that row', () => {
    expect(vectorSetUnitAction({ ...base, dim: 'width', toUnit: '%', fitDim: 'width' }))
      .toEqual({ styles: {}, fitDim: '', passThrough: true });
  });
});

describe('readFitDim', () => {
  it('accepts only the three modes', () => {
    expect(readFitDim({ 'data-fit-dim': 'width' })).toBe('width');
    expect(readFitDim({ 'data-fit-dim': 'height' })).toBe('height');
    expect(readFitDim({ 'data-fit-dim': 'both' })).toBe('both');
    expect(readFitDim({ 'data-fit-dim': 'neither' })).toBeNull();
    expect(readFitDim({})).toBeNull();
    expect(readFitDim(null)).toBeNull();
  });
});

// User report 2026-09-21: "if one is auto and the other one i make auto as well,
// currently it just makes the other px, but it needs to stay both auto and
// resolve the same width height as the root variant".
describe('both rows on Fit', () => {
  const base = { variant: V, computedWidth: 159, computedHeight: 144 };

  it('the SECOND auto keeps the first and takes the variant natural size on both', () => {
    const a = vectorSetUnitAction({ ...base, dim: 'height', toUnit: 'auto', fitDim: 'width' });
    expect(a).toEqual({ styles: { width: `${V.width}px`, height: `${V.height}px`, aspectRatio: '' }, fitDim: 'both' });
    // …from either side
    const b = vectorSetUnitAction({ ...base, dim: 'width', toUnit: 'auto', fitDim: 'height' });
    expect(b).toEqual({ styles: { width: `${V.width}px`, height: `${V.height}px`, aspectRatio: '' }, fitDim: 'both' });
  });

  it('re-choosing auto while already on both is stable', () => {
    const a = vectorSetUnitAction({ ...base, dim: 'width', toUnit: 'auto', fitDim: 'both' });
    if (a === 'blocked') throw new Error('unexpected');
    expect(a.fitDim).toBe('both');
  });

  it('both rows read as auto; a single mode only its own row', () => {
    expect([isFitRow('both', 'width'), isFitRow('both', 'height')]).toEqual([true, true]);
    expect([isFitRow('width', 'width'), isFitRow('width', 'height')]).toEqual([true, false]);
    expect(isFitRow(null, 'width')).toBe(false);
  });

  it('leaving Fit on ONE row keeps the other on it', () => {
    // dropdown px
    expect(vectorSetUnitAction({ ...base, dim: 'width', toUnit: 'px', fitDim: 'both' }))
      .toEqual({ styles: {}, fitDim: 'height' });
    // typing a number
    const typed = vectorSetUnitAction({ ...base, dim: 'height', toUnit: 'px', typedNum: 80, fitDim: 'both' });
    if (typed === 'blocked') throw new Error('unexpected');
    expect(typed.fitDim).toBe('width');
    expect(typed.styles.height).toBe('80px');
    // a pass-through unit
    expect(vectorSetUnitAction({ ...base, dim: 'width', toUnit: '%', fitDim: 'both' }))
      .toEqual({ styles: {}, fitDim: 'height', passThrough: true });
  });

  it('a hand resize ends it, but not a single Fit row', () => {
    expect(fitModeAfterHandResize('both')).toBe('');
    expect(fitModeAfterHandResize('width')).toBeUndefined();
    expect(fitModeAfterHandResize(null)).toBeUndefined();
  });
});

// `auto` has to FOLLOW the variant, or it is a label over frozen numbers.
describe('vectorSetResnap — the icon picker swaps the variant', () => {
  const TALL = { width: 50, height: 200 };

  it('both: the new variant natural size', () => {
    expect(vectorSetResnap('both', TALL, { width: 159, height: 144 })).toEqual({ width: '50px', height: '200px' });
  });

  it('one row: re-derived from the FIXED row at the new aspect', () => {
    expect(vectorSetResnap('width', TALL, { width: 159, height: 80 })).toEqual({ width: '20px' });
    expect(vectorSetResnap('height', TALL, { width: 100, height: 90 })).toEqual({ height: '400px' });
  });

  it('leaves a non-Fit instance alone', () => {
    expect(vectorSetResnap(null, TALL, { width: 159, height: 144 })).toBeNull();
  });

  it('does not invent a size when the fixed row is not px', () => {
    expect(vectorSetResnap('width', TALL, { width: 159, height: NaN })).toBeNull();
  });
});

// The mode lives in the SOURCE. This is the mechanism, not my model of it: the
// real generator writes the marker on an instance tag and the real parser has
// to hand it back in `attrs`, or the panel never sees the mode.
describe('the marker round-trips through the source', () => {
  const PAGE = `import Icons from '@/components/Icons';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Icons data-id="ic-1" name="icon-1" style={{ width: '159px', height: '144px' }} />
    </div>
  );
}
`;
  const modeIn = (code: string) => readFitDim(parseJSXToNodes(code).get('ic-1')?.attrs);

  it('writes, reads back, replaces and removes', () => {
    expect(modeIn(PAGE)).toBeNull();
    const one = updateHtmlAttrsInCode(PAGE, 'ic-1', { [FIT_DIM_ATTR]: 'width' });
    expect(modeIn(one)).toBe('width');
    const both = updateHtmlAttrsInCode(one, 'ic-1', { [FIT_DIM_ATTR]: 'both' });
    expect(modeIn(both)).toBe('both');
    expect(both.match(/data-fit-dim/g)?.length).toBe(1);   // replaced, not appended
    const none = updateHtmlAttrsInCode(both, 'ic-1', { [FIT_DIM_ATTR]: '' });
    expect(none).toBe(PAGE);
  });
});

// User report 2026-09-21: the chevrons stretched the vector on ONE axis for the
// whole scrub and only the mouse-up snapped it back to its aspect. The live
// patch and the commit now come from this one function.
describe('vectorSetLinkedWrite — live scrub and commit share it', () => {
  it('a px on one row writes BOTH rows at the variant aspect', () => {
    expect(vectorSetLinkedWrite(V, 'height', '80px')).toEqual({ height: '80px', width: vectorSetFitSize(V, 'width', 80) });
    expect(vectorSetLinkedWrite(V, 'width', '100px')).toEqual({ width: '100px', height: vectorSetFitSize(V, 'height', 100) });
  });

  it('every frame of a scrub holds the aspect, so mouse-up has nothing to correct', () => {
    const ratio = V.width / V.height;
    for (let h = 40; h <= 400; h += 7) {
      const w = vectorSetLinkedWrite(V, 'height', `${h}px`)!;
      expect(parseFloat(w.width) / parseFloat(w.height)).toBeCloseTo(ratio, 1);
    }
  });

  it('a chevron held past zero stops at 1px instead of jumping to the natural size', () => {
    for (const v of ['0px', '-12px']) {
      const w = vectorSetLinkedWrite(V, 'width', v)!;
      expect(w.width).toBe('1px');
      expect(parseFloat(w.height)).toBeLessThan(2);
    }
  });

  it('is not ours when the value is not px, or the variant is unknown', () => {
    expect(vectorSetLinkedWrite(V, 'width', '50%')).toBeNull();
    expect(vectorSetLinkedWrite(V, 'width', 'auto')).toBeNull();
    expect(vectorSetLinkedWrite(null, 'width', '50px')).toBeNull();
  });
});
