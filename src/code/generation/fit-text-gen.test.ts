import { describe, it, expect } from 'vitest';
import { wrapInFitSVGInCode, unwrapFitSVGInCode , calculateFitRefit } from './fit-text-gen';

describe('wrapInFitSVGInCode', () => {
  const CODE = `export default function Page() {
  return <div data-id="root">
    <p data-id="title" style={{fontSize: '48px', fontWeight: '700'}}>Build the future</p>
  </div>;
}`;

  it('wraps text element in SVG foreignObject', () => {
    const result = wrapInFitSVGInCode(CODE, 'title', { width: 520, height: 60, fontSize: 48 });
    expect(result).toContain('data-id="title-svg"');
    expect(result).toContain('viewBox="0 0 520 60"');
    expect(result).toContain('<foreignObject');
    expect(result).toContain('data-id="title"');
    expect(result).toContain("width: '100%'");
    expect(result).toContain("whiteSpace: 'pre'");
  });

  it('preserves original styles on inner element', () => {
    const result = wrapInFitSVGInCode(CODE, 'title', { width: 520, height: 60, fontSize: 48 });
    expect(result).toContain("fontSize: '48px'");
    expect(result).toContain("fontWeight: '700'");
  });

  it('returns unchanged code if nodeId not found', () => {
    const result = wrapInFitSVGInCode(CODE, 'nonexistent', { width: 100, height: 20, fontSize: 16 });
    expect(result).toBe(CODE);
  });
});

describe('unwrapFitSVGInCode', () => {
  const WRAPPED_CODE = `export default function Page() {
  return <div data-id="root">
    <svg data-id="title-svg" data-name="FIT" style={{width: '100%', height: 'auto', overflow: 'visible', display: 'block'}} viewBox="0 0 520 60">
  <foreignObject width="100%" height="100%" style={{overflow: 'visible'}}>
    <p data-id="title" style={{fontSize: '48px', fontWeight: '700', whiteSpace: 'nowrap', margin: '0'}}>Build the future</p>
  </foreignObject>
</svg>
  </div>;
}`;

  it('removes SVG wrapper and restores inner element', () => {
    const result = unwrapFitSVGInCode(WRAPPED_CODE, 'title');
    expect(result).not.toContain('data-id="title-svg"');
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('foreignObject');
    expect(result).toContain('data-id="title"');
  });

  it('removes whiteSpace and margin added by FIT', () => {
    const result = unwrapFitSVGInCode(WRAPPED_CODE, 'title');
    expect(result).not.toContain("whiteSpace: 'nowrap'");
    expect(result).not.toContain("margin: '0'");
  });

  it('preserves original styles', () => {
    const result = unwrapFitSVGInCode(WRAPPED_CODE, 'title');
    expect(result).toContain("fontSize: '48px'");
    expect(result).toContain("fontWeight: '700'");
  });

  it('strips the fit-owned scale transform + marginTop + centering leftovers', () => {
    const wrapped = `export default function Page() {
  return <div data-id="root">
    <svg data-id="title-svg" data-name="FIT" style={{width: '100%', height: 'auto'}} viewBox="0 0 1010 78">
  <foreignObject width="100%" height="100%" style={{overflow: 'visible'}}>
    <p data-id="title" style={{fontSize: '41px', marginTop: '25px', lineHeight: '0.7', transform: 'scale(1.0500)', transformOrigin: 'center', textAlign: 'center'}}>ELIAS</p>
  </foreignObject>
</svg>
  </div>;
}`;
    const result = unwrapFitSVGInCode(wrapped, 'title');
    expect(result).not.toContain("marginTop: '25px'");
    expect(result).not.toContain("transform: 'scale(1.0500)'");
    expect(result).not.toContain("transformOrigin: 'center'");
    expect(result).toContain("lineHeight: '0.7'");   // user-authored — kept
    expect(result).toContain("textAlign: 'center'"); // user-authored — kept
    expect(result).toContain("fontSize: '41px'");
  });

  it('returns unchanged code if SVG wrapper not found', () => {
    const plainCode = `<p data-id="title" style={{fontSize: '48px'}}>Hello</p>`;
    const result = unwrapFitSVGInCode(plainCode, 'title');
    expect(result).toBe(plainCode);
  });

  it('roundtrip: wrap then unwrap restores close to original', () => {
    const original = `export default function Page() {
  return <div data-id="root">
    <p data-id="title" style={{fontSize: '48px', fontWeight: '700'}}>Build the future</p>
  </div>;
}`;
    const wrapped = wrapInFitSVGInCode(original, 'title', { width: 520, height: 60, fontSize: 48 });
    const unwrapped = unwrapFitSVGInCode(wrapped, 'title');
    expect(unwrapped).toContain('data-id="title"');
    expect(unwrapped).toContain("fontSize: '48px'");
    expect(unwrapped).not.toContain('data-id="title-svg"');
    expect(unwrapped).not.toContain('foreignObject');
  });
});

// ─── Additional wrapInFitSVGInCode tests ─────────────────────────────────────

describe('wrapInFitSVGInCode — whiteSpace and SVG style', () => {
  const CODE = `export default function Page() {
  return <div data-id="root">
    <p data-id="title" style={{fontSize: '48px', fontWeight: '700'}}>Build the future</p>
  </div>;
}`;

  it('adds whiteSpace: pre to SVG wrapper style', () => {
    const result = wrapInFitSVGInCode(CODE, 'title', { width: 520, height: 60, fontSize: 48 });
    // The SVG wrapper element should have whiteSpace: 'pre' in its own style
    expect(result).toContain("whiteSpace: 'pre'");
    // Confirm it is on the SVG wrapper (data-id="title-svg"), not the inner element
    const svgLine = result.split('\n').find(l => l.includes('data-id="title-svg"'));
    expect(svgLine).toBeDefined();
    expect(svgLine).toContain("whiteSpace: 'pre'");
  });

  it('removes width and height from inner element', () => {
    const codeWithSize = `export default function Page() {
  return <div data-id="root">
    <p data-id="title" style={{fontSize: '48px', fontWeight: '700', width: '300px', height: '60px'}}>Build the future</p>
  </div>;
}`;
    const result = wrapInFitSVGInCode(codeWithSize, 'title', { width: 520, height: 60, fontSize: 48 });
    // The inner element should not have width/height anymore (SVG controls sizing)
    // Find the inner p element's style block
    const innerPStart = result.indexOf('data-id="title"');
    const innerStyleStart = result.indexOf('style={{', innerPStart);
    const innerStyleEnd = result.indexOf('}}', innerStyleStart) + 2;
    const innerStyle = result.slice(innerStyleStart, innerStyleEnd);
    expect(innerStyle).not.toMatch(/width:\s*'/);
    expect(innerStyle).not.toMatch(/height:\s*'/);
  });

  it('adds lineHeight: 1 to inner element', () => {
    const result = wrapInFitSVGInCode(CODE, 'title', { width: 520, height: 60, fontSize: 48 });
    // The inner element should have lineHeight: '1' added
    const innerPStart = result.indexOf('data-id="title"');
    const innerStyleStart = result.indexOf('style={{', innerPStart);
    const innerStyleEnd = result.indexOf('}}', innerStyleStart) + 2;
    const innerStyle = result.slice(innerStyleStart, innerStyleEnd);
    expect(innerStyle).toContain("lineHeight: '1'");
  });

  it('replaces fontSize with calculated optimal value', () => {
    const result = wrapInFitSVGInCode(CODE, 'title', { width: 520, height: 60, fontSize: 72 });
    // The inner element's fontSize should be updated to the calculated optimal size
    const innerPStart = result.indexOf('data-id="title"');
    const innerStyleStart = result.indexOf('style={{', innerPStart);
    const innerStyleEnd = result.indexOf('}}', innerStyleStart) + 2;
    const innerStyle = result.slice(innerStyleStart, innerStyleEnd);
    expect(innerStyle).toContain("fontSize: '72px'");
    // Should NOT contain the original fontSize
    expect(innerStyle).not.toContain("fontSize: '48px'");
  });
});

describe('unwrapFitSVGInCode — removes lineHeight added by FIT', () => {
  it('removes lineHeight: 1 added by FIT wrap', () => {
    const wrappedCode = `export default function Page() {
  return <div data-id="root">
    <svg data-id="title-svg" data-name="FIT" style={{width: '100%', height: 'auto', overflow: 'visible', display: 'block', whiteSpace: 'pre'}} viewBox="0 0 520 60">
  <foreignObject width="100%" height="100%" style={{overflow: 'visible'}}>
    <p data-id="title" style={{fontSize: '48px', fontWeight: '700', margin: '0', lineHeight: '1'}}>Build the future</p>
  </foreignObject>
</svg>
  </div>;
}`;
    const result = unwrapFitSVGInCode(wrappedCode, 'title');
    expect(result).not.toContain("lineHeight: '1'");
    // Original styles should be preserved
    expect(result).toContain("fontSize: '48px'");
    expect(result).toContain("fontWeight: '700'");
  });
});

describe('wrapInFitSVGInCode + unwrapFitSVGInCode roundtrip — parseable code', () => {
  it('wrap then unwrap produces code that can be parsed by parseJSXToNodes', async () => {
    // Dynamic import so this test file stays lightweight if parser is unavailable
    const { parseJSXToNodes } = await import('../parsing/parser');

    const original = `export default function Page() {
  return <div data-id="root" style={{}}>
    <h1 data-id="heading" style={{fontSize: '64px', fontWeight: '800'}}>Welcome</h1>
  </div>;
}`;
    const wrapped = wrapInFitSVGInCode(original, 'heading', { width: 400, height: 80, fontSize: 64 });
    // Wrapped code should parse
    const wrappedNodes = parseJSXToNodes(wrapped);
    expect(wrappedNodes.size).toBeGreaterThan(0);
    expect(wrappedNodes.has('heading')).toBe(true);

    const unwrapped = unwrapFitSVGInCode(wrapped, 'heading');
    // Unwrapped code should also parse
    const unwrappedNodes = parseJSXToNodes(unwrapped);
    expect(unwrappedNodes.size).toBeGreaterThan(0);
    expect(unwrappedNodes.has('heading')).toBe(true);
    // SVG wrapper should be gone
    expect(unwrappedNodes.has('heading-svg')).toBe(false);
  });
});

// calculateFitRefit is DOM-measured (scrollWidth/scrollHeight), which jsdom
// stubs to 0 — so these tests lock in the CONTRACT (null on empty, shaped
// result on text), not the measured numbers. Real measurement is exercised
// live (TipTap commit + font-family/weight/spacing re-fit).
describe('calculateFitRefit — contract', () => {
  it('returns null for empty / tags-only html', () => {
    expect(calculateFitRefit('', { fontFamily: 'Inter' }, 1000)).toBeNull();
    expect(calculateFitRefit('<br><br>', { fontFamily: 'Inter' }, 1000)).toBeNull();
  });

  it('returns finite fontSize + height for real text', () => {
    const r = calculateFitRefit('ELIAS DROW', { fontFamily: 'Audiowide', fontWeight: '400' }, 1010);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!.fontSize)).toBe(true);
    expect(Number.isFinite(r!.height)).toBe(true);
    expect(r!.fontSize).toBeGreaterThan(0);
  });
});

describe('FIT lifts layout-participation props to the wrapper (2026-09-06)', () => {
  const ABS = `export default function Page() {
  return <div data-id="hero" style={{position: 'relative', display: 'flex'}}>
    <p data-id="title" style={{fontSize: '145px', color: '#fff', position: 'absolute', zIndex: '3', order: '1', left: "50%", top: '50%', transform: 'translateX(-50%) translateY(-50%)', width: '640px'}}>NIKITA</p>
  </div>;
}`;
  const wrapperOf = (code: string) => code.match(/<svg data-id="title-svg"[^>]*style=\{\{([^}]*)\}\}/)![1];
  const innerOf = (code: string) => code.match(/<p data-id="title"[^>]*style=\{\{([^}]*)\}\}/)![1];

  it('an ABSOLUTE text stays absolute: position/pins/transform/z/order move to the wrapper, width replaces 100%', () => {
    const out = wrapInFitSVGInCode(ABS, 'title', { width: 1010, height: 178, fontSize: 145, marginTop: 24 });
    const w = wrapperOf(out), i = innerOf(out);
    expect(w).toContain("position: 'absolute'");
    expect(w).toContain('left: "50%"');
    expect(w).toContain("top: '50%'");
    expect(w).toContain("transform: 'translateX(-50%) translateY(-50%)'");
    expect(w).toContain("zIndex: '3'");
    expect(w).toContain("order: '1'");
    expect(w).toContain("width: '640px'");
    expect(w).not.toContain("width: '100%'");
    expect(w).toContain("height: 'auto'");
    // inner: flow child of the foreignObject, no layout props left
    expect(i).toContain("position: 'relative'");
    expect(i).not.toMatch(/left:|top:|zIndex:|order:|transform:|width:/);
    expect(i).toContain("fontSize: '145px'");
  });

  it('a fit-owned scale transform stays on the inner', () => {
    const code = ABS.replace("transform: 'translateX(-50%) translateY(-50%)', ", "transform: 'scale(0.8)', transformOrigin: 'center', ");
    const out = wrapInFitSVGInCode(code, 'title', { width: 1010, height: 178, fontSize: 145 });
    expect(innerOf(out)).toContain("transform: 'scale(0.8)'");
    expect(wrapperOf(out)).not.toContain('scale(');
  });

  it('unwrap LOWERS the wrapper\'s live props back (incl. a width the Size tool changed) and drops wrapper-only keys', () => {
    let out = wrapInFitSVGInCode(ABS, 'title', { width: 1010, height: 178, fontSize: 145 });
    out = out.replace("width: '640px'", "width: '720px'");            // Size tool edit on the wrapper
    const back = unwrapFitSVGInCode(out, 'title');
    expect(back).not.toContain('title-svg');
    const i = back.match(/<p data-id="title"[^>]*style=\{\{([^}]*)\}\}/)![1];
    expect(i).toContain("position: 'absolute'");
    expect(i).toContain('left: "50%"');
    expect(i).toContain("transform: 'translateX(-50%) translateY(-50%)'");
    expect(i).toContain("zIndex: '3'");
    expect(i).toContain("width: '720px'");
    expect(i).not.toMatch(/height: 'auto'|overflow:|display: 'block'|whiteSpace: 'pre'/);
  });

  it('a plain flow text keeps the historical wrapper (width 100%, nothing lifted)', () => {
    const CODE = `export default function Page() {
  return <div data-id="root"><p data-id="t" style={{fontSize: '48px', position: 'relative'}}>x</p></div>;
}`;
    const out = wrapInFitSVGInCode(CODE, 't', { width: 520, height: 60, fontSize: 48 });
    expect(out.match(/<svg data-id="t-svg"[^>]*style=\{\{([^}]*)\}\}/)![1]).toContain("width: '100%'");
    expect(out.match(/<svg data-id="t-svg"[^>]*style=\{\{([^}]*)\}\}/)![1]).toContain("position: 'relative'");
  });
});

describe('wrapInFitSVGInCode — hug width bakes to px', () => {
  const vb = { width: 520, height: 60, fontSize: 48 };
  it('replaces a lifted `auto` width with the painted px (Fixed) — a FIT box is never hug', () => {
    const code = `<p data-id="title" style={{width: 'auto', fontSize: '48px'}}>Hi</p>`;
    const out = wrapInFitSVGInCode(code, 'title', vb, { width: '235px' });
    const w = out.slice(out.indexOf('<svg'), out.indexOf('<foreignObject'));
    expect(w).toContain("width: '235px'");
    expect(w).not.toContain("width: 'auto'");
    expect(out).not.toMatch(/<p[^>]*width/);
  });
  it('keeps an explicit px / % width even when a measurement is offered', () => {
    const code = `<p data-id="title" style={{width: '50%', fontSize: '48px'}}>Hi</p>`;
    const out = wrapInFitSVGInCode(code, 'title', vb, { width: '235px' });
    expect(out.slice(out.indexOf('<svg'), out.indexOf('<foreignObject'))).toContain("width: '50%'");
  });
  it('without a measurement a hug width falls back to the 100% default (never writes auto)', () => {
    const code = `<p data-id="title" style={{width: 'fit-content', fontSize: '48px'}}>Hi</p>`;
    const out = wrapInFitSVGInCode(code, 'title', vb);
    const w = out.slice(out.indexOf('<svg'), out.indexOf('<foreignObject'));
    expect(w).toContain("width: '100%'");
    expect(w).not.toContain('fit-content');
  });
});

describe('wrapInFitSVGInCode — a text whose FIRST style pair is removed', () => {
  it('leaves no leading comma when height (the first kept pair) is stripped', async () => {
    const { parseJSX } = await import('@/code/parsing/ast-utils');
    const code = `export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <h1 data-id="t" data-name="Title" style={{ position: 'relative', width: 'auto', height: 'auto', fontSize: '64px', color: '#111', flex: '0 0 auto', order: '0' }}>Hello</h1>
    </div>
  );
}
`;
    const out = wrapInFitSVGInCode(code, 't', { width: 900, height: 80, fontSize: 64, marginTop: 2 }, { width: '100%' });
    expect(out).not.toMatch(/style=\{\{\s*,/);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/data-id="t"[^>]*style=\{\{fontSize: '64px'/);
  });
});
