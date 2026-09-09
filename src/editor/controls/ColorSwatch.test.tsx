// ColorSwatch layering: fill BELOW the cut-corner strokes, strokes above.
import { describe, test, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ColorSwatch } from './ColorSwatch';

describe('ColorSwatch', () => {
  test('paints the fill on its own layer and the .cut-border strokes on a layer above it', () => {
    const { container } = render(<ColorSwatch style={{ background: 'linear-gradient(90deg, #fff, #ff0)' }} />);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain('cut-corners');
    expect(shell.className).toContain('border');
    // the shell itself must NOT carry .cut-border (a fill layer would cover it)
    expect(shell.classList.contains('cut-border')).toBe(false);
    const layers = Array.from(shell.children) as HTMLElement[];
    const fill = layers.find(l => l.getAttribute('style'));
    const strokes = layers.find(l => l.classList.contains('cut-border'));
    expect(fill).toBeTruthy();
    expect(strokes).toBeTruthy();
    // strokes come AFTER the fill in DOM order → paint above it
    expect(layers.indexOf(strokes!)).toBeGreaterThan(layers.indexOf(fill!));
    expect(strokes!.className).toContain('-inset-px');
  });
  test('no fill → strokes still present (empty / mixed swatches keep their corners)', () => {
    const { container } = render(<ColorSwatch />);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.querySelector('.cut-border')).toBeTruthy();
  });
});
