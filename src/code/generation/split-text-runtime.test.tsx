// split-text-runtime.test.tsx — EXECUTE the runtime component.
//
// The codegen tests only assert on emitted strings. These render the real
// `<RevymeSplitText>` so the split, the mask wrappers and the expression passthrough are
// verified against the component that actually ships, not against a description of it.

import { describe, it, expect, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { RevymeSplitText } from '@revyme/runtime';

// jsdom has no IntersectionObserver; framer's useInView needs one. The stub never fires, so
// units stay at their `initial` state — which is exactly what we want to assert on (the DOM
// structure), and it also proves the component renders its tree before any observer callback.
beforeAll(() => {
  if (!('IntersectionObserver' in globalThis)) {
    (globalThis as any).IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
      root = null; rootMargin = ''; thresholds = [];
    };
  }
});

const spec = (o: Record<string, unknown> = {}) => ({ animationType: 'character', opacity: 0, y: 20, ...o } as any);

describe('RevymeSplitText renders', () => {
  it('splits a plain string into per-character spans', () => {
    const { container } = render(<RevymeSplitText spec={spec()}>Hi there</RevymeSplitText>);
    expect(container.textContent).toBe('Hi there');
    // 7 letters (space is a text node between word wrappers)
    expect(container.querySelectorAll('span[style*="inline-block"]').length).toBeGreaterThanOrEqual(7);
  });

  it('a CMS-style resolved value works exactly like a literal — the whole point', () => {
    const item = { title: 'MATE' };
    const { container } = render(<RevymeSplitText spec={spec()}>{item.title}</RevymeSplitText>);
    expect(container.textContent).toBe('MATE');
    expect(container.textContent).not.toContain('{');
  });

  it('mask adds the clip wrapper per word', () => {
    const { container } = render(<RevymeSplitText spec={spec({ mask: true })}>ab cd</RevymeSplitText>);
    const clips = [...container.querySelectorAll('span')].filter(s => s.style.overflow === 'hidden');
    expect(clips).toHaveLength(2);
    expect(clips[0].style.paddingBottom).toBe('0.14em');
  });

  it('word mode emits one unit per word', () => {
    const { container } = render(<RevymeSplitText spec={spec({ animationType: 'word' })}>one two three</RevymeSplitText>);
    expect(container.textContent).toBe('one two three');
  });

  it('line mode breaks on \\n', () => {
    const { container } = render(<RevymeSplitText spec={spec({ animationType: 'line' })}>{'a\nb'}</RevymeSplitText>);
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });

  it('<br /> children become line breaks', () => {
    const { container } = render(<RevymeSplitText spec={spec()}>{['a', <br key="b" />, 'c']}</RevymeSplitText>);
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(container.textContent).toBe('ac');
  });

  it('rich children are rendered VERBATIM rather than mangled', () => {
    const { container } = render(
      <RevymeSplitText spec={spec()}>{['plain ', <em key="e">marked</em>]}</RevymeSplitText>,
    );
    expect(container.querySelector('em')?.textContent).toBe('marked');
    expect(container.textContent).toBe('plain marked');
  });

  it('a bezier ease string does not throw (framer rejects the raw string)', () => {
    expect(() => render(
      <RevymeSplitText spec={spec({ transition: { type: 'tween', duration: 1.15, ease: '[0.22, 1, 0.36, 1]' } })}>
        Hi
      </RevymeSplitText>,
    )).not.toThrow();
  });

  it('no spec renders the text unharmed', () => {
    const { container } = render(<RevymeSplitText>Hello</RevymeSplitText>);
    expect(container.textContent).toBe('Hello');
  });

  it('scroll mode renders without throwing', () => {
    expect(() => render(
      <RevymeSplitText spec={spec({ trigger: 'scroll', scrollStart: 90, scrollEnd: 35 })}>Hi</RevymeSplitText>,
    )).not.toThrow();
  });
});
