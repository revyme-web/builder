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

// ─── The Adore corruption (2026-08-14) ───────────────────────────────────────
// Sequence: apply → user INSERTS a sibling after the LayoutGroup (add-section
// on a glided page) → any glide update (remove→re-apply). The old anchored
// `^<LayoutGroup>…</LayoutGroup>$` strip failed on the trailing sibling, the
// leftover group got re-wrapped as ONE child — every section inside a single
// width-less glide item (horizontal blow-out on a centered column root),
// stacked LayoutGroups, and deleted children left empty wrapper husks.
describe('glide-gen — re-apply after sibling insert (the Adore corruption)', () => {
  const applied = setGlideInCode(FAQ_LIST, 'faq-list', SPEC);
  // Simulate generator-crud appending a new child INSIDE faq-list but AFTER
  // the </LayoutGroup> (exactly what add-node does on a glided container).
  const withInsert = applied.replace(
    /<\/LayoutGroup>/,
    `</LayoutGroup>\n      <FAQItem data-id="faq-3" question="C?" answer="C." style={{ order: '2', flex: '0 0 auto', position: 'relative', width: '100%', height: 'auto' }} />`,
  );
  const updated = setGlideInCode(withInsert, 'faq-list', { transition: { type: 'spring', duration: '0.7', bounce: '0.1', delay: '0' } });

  test('produces valid JSX', () => { expect(parses(updated)).toBe(true); });

  test('every child gets its OWN wrapper — never one mega-wrapper', () => {
    expect((updated.match(/data-glide-item/g) || []).length).toBe(3);
    expect(updated).toMatch(/data-glide-item[^>]*order: '0'[^>]*><FAQItem data-id="faq-1"/);
    expect(updated).toMatch(/data-glide-item[^>]*order: '2'[^>]*><FAQItem data-id="faq-3"/);
  });

  test('exactly ONE LayoutGroup — no stacked layers, none wrapped as a child', () => {
    expect((updated.match(/<LayoutGroup>/g) || []).length).toBe(1);
    expect(updated).not.toMatch(/data-glide-item[^>]*>\s*<LayoutGroup>/);
  });

  test('remove fully heals the corrupted shape (stacked groups + mega-wrap + husk)', () => {
    const corrupted = `export default function Page() {
  return <motion.div layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} data-glide='{"transition":{"type":"spring","duration":"0.5","bounce":"0.25","delay":"0"}}' data-id="root" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}><LayoutGroup><motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '0', flex: '0 0 auto' }}><LayoutGroup>
    <LayoutGroup><LayoutGroup><style>{\`\`}</style></LayoutGroup></LayoutGroup>
    <div data-id="hero" data-name="Hero" style={{ width: '100%', height: '100vh', position: 'relative', flex: '0 0 auto' }}>hero</div>
    <div data-id="gallery" data-name="Gallery" style={{ width: '100%', position: 'relative', flex: '0 0 auto' }}>gallery</div>
  </LayoutGroup></motion.div>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '0', flex: '0 0 auto', width: '800px' }}></motion.div></LayoutGroup></motion.div>;
}`;
    const healed = setGlideInCode(corrupted, 'root', null);
    expect(parses(healed)).toBe(true);
    expect(healed).not.toContain('data-glide');
    expect(healed).not.toContain('data-glide-item');
    expect(healed).not.toContain('<LayoutGroup>');
    expect(healed).not.toContain("width: '800px'");           // husk gone
    expect(healed).toContain('data-id="hero"');
    expect(healed).toContain('data-id="gallery"');
    expect(healed).toContain('<style>');                       // page style block survives
    expect(healed).toMatch(/<div[^>]*data-id="root"/);         // motion reverted
  });
});

describe('removeGlide — complex layout values survive', () => {
  test('the fixed-header dialect layout={cond ? "size" : true} is preserved (Wisp prod heal, 2026-08-16)', () => {
    const code = `export default function C() {
  return <motion.div layoutScroll={(style as any)?.position === 'fixed'} layout={(style as any)?.position === 'fixed' ? "size" : true} transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} data-glide='{"transition":{"type":"spring","duration":"0.5","bounce":"0.25","delay":"0"}}' data-id="x" style={{ width: '100px' }}><LayoutGroup>
    <motion.div data-glide-item layout transition={{ type: 'spring', duration: 0.5, bounce: 0.25, delay: 0 }} style={{ order: '0' }}><div data-id="c" style={{ width: '5px' }}></div></motion.div>
  </LayoutGroup></motion.div>;
}`;
    const out = setGlideInCode(code, 'x', null);
    expect(parses(out)).toBe(true);                                  // old \blayout\b strip orphaned `={…}`
    expect(out).toContain('layout={(style as any)?.position === \'fixed\' ? "size" : true}');
    expect(out).toContain('layoutScroll=');
    expect(out).not.toContain('data-glide');
    expect(out).not.toContain('data-glide-item');
    expect(out).toContain('data-id="c"');
    // glide's own root transition IS stripped (balanced scan, not the lazy regex)
    expect(out.slice(0, out.indexOf('data-id="x"'))).not.toContain('transition={{');
  });

  test('per-key transition objects strip fully (inner }} does not truncate)', () => {
    const code = `export default function C() {
  return <motion.div layout transition={{ layout: { duration: 1 }, borderRadius: { duration: 0 } }} data-glide='{"transition":{"type":"spring"}}' data-id="x" style={{ width: '100px' }}><div data-id="c" style={{ width: '5px' }}></div></motion.div>;
}`;
    const out = setGlideInCode(code, 'x', null);
    expect(parses(out)).toBe(true);
    expect(out).not.toContain('transition=');
    expect(out).not.toContain('data-glide');
  });
});

describe('glide on LEAF nodes — corruption-proofing (the UI never offers Glide on text; wild files/AI writes can still carry it)', () => {
  const parses = (c: string) => {
    try { parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; }
    catch { return false; }
  };
  const SPEC = { transition: { type: 'spring', duration: '0.5', bounce: '0.25', delay: '0' } };

  test('a text node gets motion tag + layout + data-glide, and its text is NOT wrapped', () => {
    const code = `import React from 'react';
export default function C() {
  return <div data-id="root"><p data-id="t1" style={{ fontSize: '48px' }}>Watch your balance actually move.</p></div>;
}`;
    const out = setGlideInCode(code, 't1', SPEC);
    expect(parses(out)).toBe(true);
    expect(out).toContain('motion.p');
    expect(out).toMatch(/data-id="t1"/);
    expect(out).toContain(`data-glide='`);
    // The whole point: no ELEMENT child inside the text tag. The old path
    // wrapped the raw text in <LayoutGroup>, corrupting the text pipeline
    // (2026-08-18).
    expect(out).not.toContain('<LayoutGroup>');
    expect(out).not.toContain('data-glide-item');
    expect(out).toContain('Watch your balance actually move.');
    expect(hasGlide(out, 't1')).toBe(true);
  });

  test('leaf glide round-trips through remove', () => {
    const code = `import React from 'react';
export default function C() {
  return <div data-id="root"><h2 data-id="t2">Hello</h2></div>;
}`;
    const applied = setGlideInCode(code, 't2', SPEC);
    const removed = setGlideInCode(applied, 't2', null);
    expect(parses(removed)).toBe(true);
    expect(removed).not.toContain('data-glide');
    expect(removed).not.toContain('transition=');
    expect(removed).toContain('>Hello<');
    expect(hasGlide(removed, 't2')).toBe(false);
  });

  test('container nodes keep the full LayoutGroup + item-wrapper behavior', () => {
    const code = `import React from 'react';
export default function C() {
  return <div data-id="box" style={{ display: 'flex' }}><div data-id="a" style={{ width: '10px' }}></div><div data-id="b" style={{ width: '20px' }}></div></div>;
}`;
    const out = setGlideInCode(code, 'box', SPEC);
    expect(parses(out)).toBe(true);
    expect(out).toContain('<LayoutGroup>');
    expect(out.match(/data-glide-item/g)?.length).toBe(2);
  });
});
