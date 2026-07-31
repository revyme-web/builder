import { describe, it, expect } from 'vitest';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import {
  FILM_GRAIN_COMPONENT,
  STATIC_TV_COMPONENT,
  PERLIN_NOISE_COMPONENT,
  HALFTONE_COMPONENT,
  SCANLINES_COMPONENT,
  CHROMATIC_NOISE_COMPONENT,
} from './index';

// Sanity-check that each shipped noise code component template:
//  • carries the expected @label / @comment / @controls metadata
//  • exposes the control keys the Properties panel reads to render the form
//  • exports the canonical default function via withResponsiveProps
//
// If a template ever loses its metadata block or the export wrapper, the
// canvas drops a blue placeholder instead of the canvas effect — we want a
// failing test, not a silent regression.

const EXPECTED: Array<[string, string, string, string[]]> = [
  ['FilmGrain', FILM_GRAIN_COMPONENT, 'Film Grain', ['intensity', 'grainScale']],
  ['StaticTV', STATIC_TV_COMPONENT, 'Static TV', ['intensity', 'pixelSize', 'speed']],
  ['PerlinNoise', PERLIN_NOISE_COMPONENT, 'Perlin Noise', ['noiseScale', 'octaves', 'intensity', 'color']],
  ['Halftone', HALFTONE_COMPONENT, 'Halftone', ['dotSpacing', 'maxDot', 'color', 'angle', 'fadeDir']],
  ['Scanlines', SCANLINES_COMPONENT, 'Scanlines', ['lineHeight', 'lineGap', 'color', 'opacity']],
  ['ChromaticNoise', CHROMATIC_NOISE_COMPONENT, 'Chromatic Noise', ['intensity', 'pixelScale', 'saturation']],
];

// FilmGrain, Halftone and Scanlines were rewritten to GPU-friendly CSS / SVG
// markup (no <canvas>, no ResizeObserver). The remaining code components still rely on
// per-pixel Canvas 2D, which is the right tool for those effects.
const CANVAS_BASED: Array<[string, string]> = [
  ['StaticTV', STATIC_TV_COMPONENT],
  ['PerlinNoise', PERLIN_NOISE_COMPONENT],
  ['ChromaticNoise', CHROMATIC_NOISE_COMPONENT],
];

describe('noise code component templates', () => {
  it.each(EXPECTED)('%s exposes @label, @comment and @controls', (name, code, label, keys) => {
    const meta = parseComponentControlsMeta(code);
    expect(meta, `${name} meta`).not.toBeNull();
    expect(meta!.label, `${name}.label`).toBe(label);
    expect(meta!.comment, `${name}.comment`).toBeTruthy();
    expect(Object.keys(meta!.controls), `${name}.controlKeys`).toEqual(keys);
  });

  it.each(EXPECTED)('%s exports default via withResponsiveProps', (name, code) => {
    expect(code, `${name} export`).toMatch(/export default withResponsiveProps\(\w+\);/);
  });

  it.each(CANVAS_BASED)('%s renders a canvas inside its outer wrapper', (name, code) => {
    expect(code, `${name} canvas`).toContain('<canvas ref={canvasRef}');
    expect(code, `${name} ResizeObserver`).toContain('new ResizeObserver');
  });
});
