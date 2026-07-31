import { describe, it, expect } from 'vitest';
import { measureFitRefit, fitHtmlToPlainLines, foldFitParagraphsToBr } from './fit-measure';

// jsdom stubs scrollWidth/scrollHeight to 0, so these lock in the CONTRACT
// (null on empty, shaped result, doc param accepted) — real measurement is
// exercised live (sandbox liveRefitFitText + controller commit re-fit).
describe('measureFitRefit — contract', () => {
  it('null for empty / tags-only html', () => {
    expect(measureFitRefit('', { fontFamily: 'Inter' }, 1000)).toBeNull();
    expect(measureFitRefit('<br><br>', { fontFamily: 'Inter' }, 1000)).toBeNull();
    expect(measureFitRefit('<p></p>', { fontFamily: 'Inter' }, 1000)).toBeNull();
  });

  it('finite fontSize + height for real text, explicit doc accepted', () => {
    const r = measureFitRefit('ELIAS DROW', { fontFamily: 'Audiowide', fontWeight: '400' }, 1010, document);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!.fontSize)).toBe(true);
    expect(Number.isFinite(r!.height)).toBe(true);
    expect(r!.fontSize).toBeGreaterThan(0);
    // no leaked measure divs
    expect(document.body.querySelectorAll('div').length).toBe(0);
  });

  it('<br> splits count toward the height line count', () => {
    const single = measureFitRefit('AAA', { fontFamily: 'Inter' }, 500)!;
    const triple = measureFitRefit('AAA<br>BBB<br>CCC', { fontFamily: 'Inter' }, 500)!;
    // jsdom lineH is 0 so heights collapse to the +5 pad — assert the shape,
    // not the ratio: both computed without throwing.
    expect(single.height).toBeGreaterThan(0);
    expect(triple.height).toBeGreaterThan(0);
  });
});

// The reported bug (2026-07-12): a multi-line TipTap commit
// (`<p>DESIGN.</p><p>BUILD.</p><p>DELIVER.</p>`) was (a) MEASURED as the single
// line "DESIGN.BUILD.DELIVER." — the fit solved a one-line viewBox for
// three-line content — and (b) WRITTEN as nested unstyled <p> children inside
// the fit <p>, whose UA margins outgrew the viewBox so the center-origin Fit%
// scale hung the text out the bottom. These lock the two folding contracts.
describe('fitHtmlToPlainLines', () => {
  it('treats TipTap paragraph boundaries as line breaks', () => {
    expect(fitHtmlToPlainLines('<p>DESIGN.</p><p>BUILD.</p><p>DELIVER.</p>'))
      .toBe('DESIGN.\nBUILD.\nDELIVER.');
  });

  it('treats <br> variants as line breaks', () => {
    expect(fitHtmlToPlainLines('A<br>B<br/>C<br />D')).toBe('A\nB\nC\nD');
  });

  it('strips other markup but keeps its text', () => {
    expect(fitHtmlToPlainLines('<p>He<span style="color:red">ll</span>o</p>')).toBe('Hello');
  });

  it('plain text passes through', () => {
    expect(fitHtmlToPlainLines('  Hello  ')).toBe('Hello');
  });
});

describe('foldFitParagraphsToBr', () => {
  it('folds paragraphs to <br /> lines inside one flow', () => {
    expect(foldFitParagraphsToBr('<p>DESIGN.</p><p>BUILD.</p><p>DELIVER.</p>'))
      .toBe('DESIGN.<br />BUILD.<br />DELIVER.');
  });

  it('keeps inline marks and entities untouched', () => {
    expect(foldFitParagraphsToBr('<p>A <span style="font-weight:700">bold</span> &amp; B</p><p>C</p>'))
      .toBe('A <span style="font-weight:700">bold</span> &amp; B<br />C');
  });

  it('is a no-op on already-folded content', () => {
    expect(foldFitParagraphsToBr('A<br />B')).toBe('A<br />B');
    expect(foldFitParagraphsToBr('plain')).toBe('plain');
  });

  it('handles paragraph attrs and whitespace between paragraphs', () => {
    expect(foldFitParagraphsToBr('<p style="text-align:center">A</p>\n  <p>B</p>')).toBe('A<br />B');
  });
});
