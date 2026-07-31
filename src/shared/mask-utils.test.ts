// mask-utils.test.ts — Tests for mask CSS parsing/formatting utilities.

import { describe, it, expect } from 'vitest';
import { parseMaskEntries, formatMaskEntries, formatMaskCSS, detectMaskType, maskStopFill, nextMaskActiveEntry, MASK_PRESETS, detectMaskPreset } from '@/shared/mask-utils';

describe('parseMaskEntries', () => {
  it('returns empty array for "none"', () => {
    expect(parseMaskEntries('none')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseMaskEntries('')).toEqual([]);
  });

  it('parses a single linear-gradient mask', () => {
    const result = parseMaskEntries('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)');
    expect(result).toHaveLength(1);
    expect(result[0].gradient).toBe('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)');
    expect(result[0].composite).toBe('');
  });

  it('parses multiple masks with composite keywords', () => {
    const css = 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%) exclude, linear-gradient(101deg, rgba(0,0,0,0.04) 33%, rgb(0,0,0) 100%)';
    const result = parseMaskEntries(css);
    expect(result).toHaveLength(2);
    expect(result[0].composite).toBe('exclude');
    expect(result[0].gradient).toBe('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)');
    expect(result[1].composite).toBe('');
    expect(result[1].gradient).toBe('linear-gradient(101deg, rgba(0,0,0,0.04) 33%, rgb(0,0,0) 100%)');
  });

  it('parses all composite keywords', () => {
    for (const keyword of ['add', 'subtract', 'intersect', 'exclude']) {
      const css = `linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%) ${keyword}`;
      const result = parseMaskEntries(css);
      expect(result[0].composite).toBe(keyword);
    }
  });

  it('parses radial-gradient mask', () => {
    const css = 'radial-gradient(50% 50% at 25% 50%, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)';
    const result = parseMaskEntries(css);
    expect(result).toHaveLength(1);
    expect(result[0].gradient).toContain('radial-gradient');
  });

  it('generates deterministic IDs based on index', () => {
    const css = 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%), linear-gradient(90deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)';
    const result1 = parseMaskEntries(css);
    const result2 = parseMaskEntries(css);
    expect(result1[0].id).toBe(result2[0].id);
    expect(result1[1].id).toBe(result2[1].id);
    expect(result1[0].id).not.toBe(result1[1].id);
  });
});

describe('formatMaskEntries', () => {
  it('returns "none" for empty array', () => {
    expect(formatMaskEntries([])).toBe('none');
  });

  it('formats a single entry without composite', () => {
    const entries = [{ id: 'mask-0', gradient: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)', composite: '' }];
    expect(formatMaskEntries(entries)).toBe('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)');
  });

  it('formats entries with composite keywords', () => {
    const entries = [
      { id: 'mask-0', gradient: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)', composite: 'exclude' },
      { id: 'mask-1', gradient: 'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)', composite: '' },
    ];
    const result = formatMaskEntries(entries);
    expect(result).toBe('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%) exclude, linear-gradient(90deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)');
  });
});

describe('parseMaskEntries → formatMaskEntries roundtrip', () => {
  it('roundtrips a single mask', () => {
    const input = 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)';
    const parsed = parseMaskEntries(input);
    expect(formatMaskEntries(parsed)).toBe(input);
  });

  it('roundtrips multiple masks with composites', () => {
    const input = 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%) exclude, radial-gradient(50% 50% at 25% 50%, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)';
    const parsed = parseMaskEntries(input);
    expect(formatMaskEntries(parsed)).toBe(input);
  });
});

describe('detectMaskType', () => {
  it('detects linear-gradient', () => {
    expect(detectMaskType('linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)')).toBe('Linear');
  });

  it('detects radial-gradient', () => {
    expect(detectMaskType('radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)')).toBe('Radial');
  });

  it('detects conic-gradient', () => {
    expect(detectMaskType('conic-gradient(from 0deg at 50% 50%, rgba(0,0,0,0) 0deg, rgb(0,0,0) 360deg)')).toBe('Conic');
  });

  it('detects image mask', () => {
    expect(detectMaskType('url(https://example.com/mask.webp) center center / cover no-repeat')).toBe('Image');
  });

  it('defaults to Linear for unknown', () => {
    expect(detectMaskType('something-else')).toBe('Linear');
  });
});

describe('maskStopFill', () => {
  it('returns white for fully transparent rgba', () => {
    expect(maskStopFill('rgba(0,0,0,0)')).toBe('rgb(255,255,255)');
  });

  it('returns dark grey for fully opaque rgba', () => {
    expect(maskStopFill('rgba(0,0,0,1)')).toBe('rgb(55,55,55)');
  });

  it('returns mid grey for 50% alpha', () => {
    expect(maskStopFill('rgba(0,0,0,0.5)')).toBe('rgb(155,155,155)');
  });

  it('returns dark grey for rgb() (no alpha = fully opaque)', () => {
    expect(maskStopFill('rgb(0,0,0)')).toBe('#373737');
  });

  it('returns white for unrecognized format', () => {
    expect(maskStopFill('#000')).toBe('#ffffff');
  });
});

describe('nextMaskActiveEntry — mask editor active-entry resync', () => {
  // The bug (live find 2026-07-04): committing an edit to the 2nd mask entry
  // rewrites maskImage, which re-fires the value-sync effect for the SAME node.
  // The old code reset the active entry to 0 → the popup snapped to the 1st
  // entry on the first slider drag, so the 2nd entry could never be edited.

  it('preserves the active entry on a SAME-NODE mask change (the fix)', () => {
    // Editing entry 1 (2-entry mask) must KEEP the popup on entry 1.
    expect(nextMaskActiveEntry({ nodeChanged: false, maskChanged: true, prevActiveIdx: 1, entryCount: 2 })).toBe(1);
  });

  it('resets to the first entry when a DIFFERENT node is selected', () => {
    expect(nextMaskActiveEntry({ nodeChanged: true, maskChanged: true, prevActiveIdx: 1, entryCount: 2 })).toBe(0);
    // node change wins even when the mask value happens to be identical
    expect(nextMaskActiveEntry({ nodeChanged: true, maskChanged: false, prevActiveIdx: 3, entryCount: 4 })).toBe(0);
  });

  it('clamps the active entry into range when an entry was removed', () => {
    // Was editing entry 1, then it (or a later entry) got removed → 1 entry left.
    expect(nextMaskActiveEntry({ nodeChanged: false, maskChanged: true, prevActiveIdx: 1, entryCount: 1 })).toBe(0);
    expect(nextMaskActiveEntry({ nodeChanged: false, maskChanged: true, prevActiveIdx: 2, entryCount: 0 })).toBe(0);
  });

  it('leaves the active entry untouched when nothing changed', () => {
    expect(nextMaskActiveEntry({ nodeChanged: false, maskChanged: false, prevActiveIdx: 2, entryCount: 3 })).toBe(2);
  });

  it('keeps deeper entries editable (3rd of 3)', () => {
    expect(nextMaskActiveEntry({ nodeChanged: false, maskChanged: true, prevActiveIdx: 2, entryCount: 3 })).toBe(2);
  });
});

describe('formatMaskCSS — DOM-correct multi-layer mask emit', () => {
  // Bug (live find 2026-07-04): `mask-image: 'A, B subtract'` is INVALID CSS —
  // the browser drops the 2nd layer, so a 2nd mask does nothing. Masks must use
  // mask-image (gradients) + mask-composite (operators), and the operators are
  // SHIFTED up one layer (the last layer's op is a no-op). Pixel-verified in
  // Chromium: mask-image A,B + mask-composite 'subtract, add' punches B out of A.
  const A = 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)';
  const B = 'radial-gradient(circle, rgb(0,0,0) 0%, rgba(0,0,0,0) 60%)';

  it('single layer → image only, no composite', () => {
    const out = formatMaskCSS([{ id: 'm0', gradient: A, composite: '' }]);
    expect(out.image).toBe(A);
    expect(out.composite).toBe('');
    expect(out.webkitComposite).toBe('');
  });

  it('two layers → shifted composite (entry[1].composite lands on layer 0)', () => {
    const out = formatMaskCSS([
      { id: 'm0', gradient: A, composite: '' },
      { id: 'm1', gradient: B, composite: 'subtract' },
    ]);
    expect(out.image).toBe(`${A}, ${B}`);
    expect(out.composite).toBe('subtract, add');
    expect(out.webkitComposite).toBe('source-out, source-over');
  });

  it('maps every standard operator to its webkit keyword', () => {
    const mk = (op: string) => formatMaskCSS([
      { id: 'm0', gradient: A, composite: '' },
      { id: 'm1', gradient: B, composite: op },
    ]).webkitComposite.split(',')[0].trim();
    expect(mk('add')).toBe('source-over');
    expect(mk('subtract')).toBe('source-out');
    expect(mk('intersect')).toBe('source-in');
    expect(mk('exclude')).toBe('xor');
  });

  it('empty entries → none', () => {
    expect(formatMaskCSS([]).image).toBe('none');
  });

  it('round-trips: entries → formatMaskCSS → parseMaskEntries(image, composite)', () => {
    const entries = [
      { id: 'm0', gradient: A, composite: '' },
      { id: 'm1', gradient: B, composite: 'subtract' },
    ];
    const { image, composite } = formatMaskCSS(entries);
    const back = parseMaskEntries(image, composite);
    expect(back.map(e => e.gradient)).toEqual([A, B]);
    expect(back.map(e => e.composite)).toEqual(['', 'subtract']);
  });

  it('still parses the legacy inline format (single-arg)', () => {
    const back = parseMaskEntries(`${A}, ${B} subtract`);
    expect(back.map(e => e.composite)).toEqual(['', 'subtract']);
  });
});

describe('mask presets', () => {
  it('every preset produces valid entries with a first gradient', () => {
    for (const [name, p] of Object.entries(MASK_PRESETS)) {
      const es = p.entries();
      expect(es.length, name).toBeGreaterThan(0);
      expect(es[0].gradient, name).toMatch(/gradient/);
      expect(es[0].composite, name).toBe(''); // first entry never composites
    }
  });

  it('the all-edges preset combines two gradients with intersect', () => {
    const es = MASK_PRESETS['fade-edges'].entries();
    expect(es.length).toBe(2);
    expect(es[1].composite).toBe('intersect');
    // and it emits valid multi-layer CSS
    const { image, composite } = formatMaskCSS(es);
    expect(image.split('gradient').length - 1).toBe(2);
    expect(composite).toBe('intersect, add');
  });

  it('detectMaskPreset round-trips an applied preset, else custom', () => {
    expect(detectMaskPreset(MASK_PRESETS['fade-top'].entries())).toBe('fade-top');
    expect(detectMaskPreset(MASK_PRESETS['vignette'].entries())).toBe('vignette');
    expect(detectMaskPreset([{ id: 'x', gradient: 'linear-gradient(12deg, #000, #fff)', composite: '' }])).toBe('custom');
    expect(detectMaskPreset([])).toBe('custom');
  });
});
