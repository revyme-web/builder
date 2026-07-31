import { describe, test, expect } from 'vitest';
import { sanitizeSvgMarkupForJsx } from './svg-sanitize';

// The Inkscape-export shape that killed a dragged wordmark's add-mutation
// (2026-07-28): an XML comment + a <style> block whose CSS braces start a JSX
// expression the moment the markup lands as inner content.
const INKSCAPE = `<!-- Created with Inkscape (http://www.inkscape.org/) -->
<style type="text/css"><![CDATA[
	.st0{fill:#E43225;}
	.st1{fill:#F7971D;stroke:#000;stroke-width:2;}
]]></style>
<g transform="translate(-76,-142)">
  <path class="st0" d="m 195.5,262.8 v -33.5 h 19.8" />
  <path class="st1" d="m 10,10 h 5" />
</g>`;

describe('sanitizeSvgMarkupForJsx', () => {
  test('strips XML comments', () => {
    const out = sanitizeSvgMarkupForJsx(INKSCAPE);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('Inkscape');
  });

  test('drops <style> blocks and inlines class colors as presentation attributes', () => {
    const out = sanitizeSvgMarkupForJsx(INKSCAPE);
    expect(out).not.toContain('<style');
    expect(out).not.toContain('class=');
    expect(out).toContain('fill="#E43225"');
    expect(out).toContain('fill="#F7971D" stroke="#000" stroke-width="2"');
    // No brace from the CSS survives anywhere (raw `{` = JSX expression start).
    expect(out).not.toMatch(/\{/);
  });

  test('de-namespaces attributes: xlink:href survives as href, the rest drop', () => {
    const out = sanitizeSvgMarkupForJsx(
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve"><use xlink:href="#a"/></svg>`,
    );
    expect(out).toContain('href="#a"');
    expect(out).not.toContain('xlink:');
    expect(out).not.toContain('xml:space');
  });

  test('entity-escapes stray braces in element text', () => {
    const out = sanitizeSvgMarkupForJsx(`<title>curly {stuff} here</title><path d="M0 0"/>`);
    expect(out).toContain('curly &#123;stuff&#125; here');
  });

  test('clean single-path markup (simple-icons) passes through untouched', () => {
    const clean = `<path d="M9.1 23.6v-7.9H6.6v-3.6h2.4v-1.5c0-4 1.8-5.9 5.8-5.9Z"/>`;
    expect(sanitizeSvgMarkupForJsx(clean)).toBe(clean);
  });
});

// Rectangular 1:1 normalization used by the drop dialect (icon-viewbox).
import { normalizeSvgGeometryToBox } from './icon-viewbox';
describe('normalizeSvgGeometryToBox', () => {
  test('scales paths + primitives into a W×H box', () => {
    const out = normalizeSvgGeometryToBox('0 0 100 50', '<path d="M0 0 H100 V50"/><rect x="10" y="5" width="20" height="10"/>', 200, 100);
    expect(out?.viewBox).toBe('0 0 200 100');
    expect(out?.inner).toContain('d="M 0 0 H 200 V 100"');
    expect(out?.inner).toContain('x="20"');
    expect(out?.inner).toContain('width="40"');
  });
  test('null for gradient/defs/transform markup', () => {
    expect(normalizeSvgGeometryToBox('0 0 10 10', '<g transform="scale(2)"><path d="M0 0"/></g>', 20, 20)).toBeNull();
    expect(normalizeSvgGeometryToBox('0 0 10 10', '<defs><linearGradient id="g"/></defs>', 20, 20)).toBeNull();
  });
});
