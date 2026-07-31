// read-handlers.test.ts — capture normalization: the export must map 1:1 to
// the element's border box regardless of the node's own placement styles.
import { describe, it, expect } from 'vitest';
import { buildCaptureNormalization } from './read-handlers';

function elWithLayout(offsetWidth: number, offsetHeight: number): Element {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: offsetWidth });
  Object.defineProperty(el, 'offsetHeight', { value: offsetHeight });
  return el;
}

describe('buildCaptureNormalization', () => {
  it('zeroes the clone placement that shifts pixels inside the capture canvas', () => {
    const norm = buildCaptureNormalization(elWithLayout(820, 583));
    expect(norm.style).toMatchObject({
      position: 'relative',
      left: '0px',
      top: '0px',
      right: 'auto',
      bottom: 'auto',
      margin: '0px',
      transform: 'none',
    });
  });

  it('pins the canvas to the border box (offsetWidth/offsetHeight)', () => {
    const norm = buildCaptureNormalization(elWithLayout(820, 583));
    expect(norm.width).toBe(820);
    expect(norm.height).toBe(583);
  });

  it('omits explicit dimensions for elements with no HTML layout box (svg)', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const norm = buildCaptureNormalization(svg);
    expect(norm.width).toBeUndefined();
    expect(norm.height).toBeUndefined();
    expect(norm.style.left).toBe('0px');
  });
});
