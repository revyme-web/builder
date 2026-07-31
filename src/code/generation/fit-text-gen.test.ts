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
