import { describe, test, expect } from 'vitest';
import { parse } from '@babel/parser';
import { setGlideInCode, getGlide, hasGlide } from './glide-gen';

const parses = (code: string) => {
  parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  return true;
};

// A faq-list normal node with two component-instance children (the real case).
const FAQ_LIST = `export default function Page() {
  return <div data-id="root" style={{ display: 'flex' }}>
    <div data-id="faq-list" data-name="FAQ List" style={{ width: '100%', height: 'auto', order: '1', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <FAQItem data-id="faq-1" question="A?" answer="A." style={{ order: '0', flex: '0 0 auto', position: 'relative', width: '100%', height: 'auto' }} />
      <FAQItem data-id="faq-2" question="B?" answer="B." style={{ order: '1', flex: '0 0 auto', position: 'relative', width: '100%', height: 'auto' }} />
    </div>
  </div>;
}`;

const SPEC = { transition: { type: 'spring', duration: '0.5', bounce: '0.25', delay: '0' } };

describe('glide-gen — add', () => {
  const out = setGlideInCode(FAQ_LIST, 'faq-list', SPEC);

  test('produces valid JSX', () => { expect(parses(out)).toBe(true); });

  test('faq-list becomes motion.div with layout + data-glide', () => {
    expect(out).toMatch(/<motion\.div data-id="faq-list"|<motion\.div[^>]*data-id="faq-list"/);
    expect(out).toContain('layout');
    expect(getGlide(out, 'faq-list')).toEqual(SPEC);
    expect(hasGlide(out, 'faq-list')).toBe(true);
  });

  test('children are wrapped in ONE LayoutGroup', () => {
    expect((out.match(/<LayoutGroup>/g) || []).length).toBe(1);
    expect((out.match(/<\/LayoutGroup>/g) || []).length).toBe(1);
  });

  test('each instance is wrapped in a motion.div data-glide-item carrying its order/flex', () => {
    expect((out.match(/data-glide-item/g) || []).length).toBe(2);
    // wrapper for faq-1 copies order '0'; faq-2 copies order '1'
    expect(out).toMatch(/data-glide-item layout transition=\{\{[^{}]*\}\} style=\{\{ order: '0', flex: '0 0 auto', width: '100%' \}\}><FAQItem data-id="faq-1"/);
    expect(out).toMatch(/data-glide-item[^>]*order: '1'[^>]*><FAQItem data-id="faq-2"/);
  });

  test('transition is emitted as a JSX object literal (numbers unquoted, type quoted)', () => {
    expect(out).toContain("transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }}");
  });

  test('imports LayoutGroup from framer-motion', () => {
    expect(out).toMatch(/import\s*\{[^}]*\bLayoutGroup\b[^}]*\}\s*from\s*'framer-motion'/);
  });

  test('the instances themselves are untouched (still have their data-ids + props)', () => {
    expect(out).toContain('<FAQItem data-id="faq-1" question="A?" answer="A."');
    expect(out).toContain('<FAQItem data-id="faq-2" question="B?" answer="B."');
  });
});

describe('glide-gen — remove (round-trip)', () => {
  test('add then remove restores the original structure', () => {
    const added = setGlideInCode(FAQ_LIST, 'faq-list', SPEC);
    const removed = setGlideInCode(added, 'faq-list', null);
    expect(parses(removed)).toBe(true);
    expect(removed).not.toContain('data-glide');
    expect(removed).not.toContain('data-glide-item');
    // No LayoutGroup JSX remains (a leftover unused import is pruned by syncImports on flush).
    expect(removed).not.toContain('<LayoutGroup>');
    expect(hasGlide(removed, 'faq-list')).toBe(false);
    // faq-list reverts to a plain <div> (no other motion props were on it)
    expect(removed).toMatch(/<div data-id="faq-list"/);
    expect(removed).not.toContain('motion.div data-id="faq-list"');
    // children intact
    expect(removed).toContain('<FAQItem data-id="faq-1" question="A?" answer="A."');
    expect(removed).toContain('<FAQItem data-id="faq-2" question="B?" answer="B."');
  });
});

describe('glide-gen — update transition', () => {
  test('re-applying with a new transition updates node + wrappers, no double-wrap', () => {
    const added = setGlideInCode(FAQ_LIST, 'faq-list', SPEC);
    const updated = setGlideInCode(added, 'faq-list', { transition: { type: 'tween', duration: '0.3', ease: 'easeOut' } });
    expect(parses(updated)).toBe(true);
    // still exactly one LayoutGroup + two wrappers (no accumulation)
    expect((updated.match(/<LayoutGroup>/g) || []).length).toBe(1);
    expect((updated.match(/data-glide-item/g) || []).length).toBe(2);
    // new transition everywhere, old gone
    expect(updated).toContain("transition={{ type: 'tween', duration: 0.3, ease: 'easeOut' }}");
    expect(updated).not.toContain("type: 'spring'");
    expect(getGlide(updated, 'faq-list')).toEqual({ transition: { type: 'tween', duration: '0.3', ease: 'easeOut' } });
  });
});

describe('glide-gen — root container with a <style> child (do not wrap non-visual tags)', () => {
  test('wraps real sections but skips the <style> block', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
    <style>{\`.x{color:red}\`}</style>
    <div data-id="sec-a" style={{ order: '0', flex: '0 0 auto' }}>A</div>
    <div data-id="sec-b" style={{ order: '1', flex: '0 0 auto' }}>B</div>
  </div>;
}`;
    const out = setGlideInCode(code, 'root', SPEC);
    expect(parses(out)).toBe(true);
    // Only the two sections get wrappers — not the <style>.
    expect((out.match(/data-glide-item/g) || []).length).toBe(2);
    // The <style> tag is untouched (not wrapped in a motion.div).
    expect(out).not.toMatch(/data-glide-item[^>]*>\s*<style/);
    expect(out).toContain('<style>{`.x{color:red}`}</style>');
  });
});

describe('glide-gen — wrapper mirrors child cross-axis size (centering fix)', () => {
  // A centered column (alignItems: center). The wrapper must NOT force width:100%
  // (that left-aligns content); it copies the child's own width — omitting it for
  // a no-width child so the parent still centers it.
  const CENTERED = `export default function Page() {
  return <div data-id="root" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <KuPaJo data-id="c1" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
    <div data-id="c2" style={{ position: 'relative', width: '636px', height: '226px', flex: '0 0 auto', order: '1' }}></div>
  </div>;
}`;
  test('no-width child → wrapper has NO width (parent centers it); never width:100%', () => {
    const out = setGlideInCode(CENTERED, 'root', SPEC);
    expect(parses(out)).toBe(true);
    expect(out).not.toContain("width: '100%'");
    // KuPaJo wrapper: order/flex only, no width.
    expect(out).toMatch(/data-glide-item[^>]*style=\{\{ order: '0', flex: '0 0 auto' \}\}><KuPaJo/);
  });
  test('fixed-width child → wrapper copies that exact width (so it stays centered, not full-bleed)', () => {
    const out = setGlideInCode(CENTERED, 'root', SPEC);
    expect(out).toMatch(/data-glide-item[^>]*width: '636px'[^>]*><div data-id="c2"/);
  });
});

describe('glide-gen — plain element children', () => {
  test('wraps plain-div children too and round-trips', () => {
    const code = `export default function P() {
  return <div data-id="list" style={{ display: 'flex', flexDirection: 'column' }}>
    <div data-id="a" style={{ order: '0', flex: '0 0 auto' }}>A</div>
    <div data-id="b" style={{ order: '1', flex: '0 0 auto' }}>B</div>
  </div>;
}`;
    const added = setGlideInCode(code, 'list', SPEC);
    expect(parses(added)).toBe(true);
    expect((added.match(/data-glide-item/g) || []).length).toBe(2);
    const removed = setGlideInCode(added, 'list', null);
    expect(parses(removed)).toBe(true);
    expect(removed).not.toContain('data-glide');
    expect(removed).toContain('<div data-id="a" style={{ order: \'0\', flex: \'0 0 auto\' }}>A</div>');
  });
});

describe('glide-gen — wrapper width comes from the child STYLE, not data-* attrs', () => {
  test('a child with a data-scroll-variant media query does not leak into the wrapper width', () => {
    const code = `export default function P() {
  return <div data-id="root" style={{ display: 'flex', flexDirection: 'column' }}>
    <Header data-scroll-variant='{"responsive":[{"scope":{"query":"(max-width: 768px) and (min-width: 376px)"}}]}' data-id="nav" data-name="Header" style={{ position: 'fixed', width: '100%', zIndex: '98' }} />
    <div data-id="b" style={{ order: '1', flex: '0 0 auto', width: '100%' }}>B</div>
  </div>;
}`;
    const out = setGlideInCode(code, 'root', SPEC);
    expect(parses(out)).toBe(true);
    // the Header's wrapper must take width from its style ('100%'), NOT the media query
    expect(out).not.toMatch(/data-glide-item[^>]*width: 768px/);
    expect(out).toMatch(/data-glide-item layout transition=\{\{[^{}]*\}\} style=\{\{ order: '0', flex: '0 0 auto', width: '100%' \}\}><Header/);
  });
});
