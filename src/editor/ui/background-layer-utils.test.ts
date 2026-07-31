// background-layer-utils.test.ts — Tests for multi-layer background parsing/formatting.

import { describe, it, expect } from 'vitest';
import {
  splitCSSLayers,
  parseBackgroundLayers,
  formatBackgroundLayers,
  isMultiLayerBackground,
  createDefaultLayer,
  getLayerLabel,
} from './background-layer-utils';

describe('splitCSSLayers', () => {
  it('splits simple comma-separated values', () => {
    expect(splitCSSLayers('cover, contain')).toEqual(['cover', 'contain']);
  });

  it('respects parentheses depth', () => {
    const input = 'linear-gradient(red, blue), url(photo.jpg)';
    const result = splitCSSLayers(input);
    expect(result).toEqual(['linear-gradient(red, blue)', 'url(photo.jpg)']);
  });

  it('handles complex gradient + url', () => {
    const input = "linear-gradient(rgba(10, 10, 10, 0.4), rgba(10, 10, 10, 0.8)), url('https://images.unsplash.com/photo-123?w=1920&q=80')";
    const result = splitCSSLayers(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('linear-gradient');
    expect(result[1]).toContain('url(');
  });

  it('handles single value', () => {
    expect(splitCSSLayers('linear-gradient(red, blue)')).toEqual(['linear-gradient(red, blue)']);
  });

  it('handles empty string', () => {
    expect(splitCSSLayers('')).toEqual([]);
  });

  it('handles nested parentheses', () => {
    const input = 'linear-gradient(rgba(0,0,0,0.5), rgba(255,255,255,0.8)), radial-gradient(circle at 50% 50%, #ff0000, #0000ff)';
    const result = splitCSSLayers(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('rgba(0,0,0,0.5)');
    expect(result[1]).toContain('radial-gradient');
  });

  it('handles quoted URLs', () => {
    const input = "url('photo.jpg'), url(\"bg.png\")";
    const result = splitCSSLayers(input);
    expect(result).toHaveLength(2);
  });

  it('handles three layers', () => {
    const input = 'linear-gradient(red, blue), linear-gradient(green, yellow), url(bg.jpg)';
    const result = splitCSSLayers(input);
    expect(result).toHaveLength(3);
  });
});

describe('parseBackgroundLayers', () => {
  it('parses gradient + image combo', () => {
    const styles = {
      backgroundImage: "linear-gradient(rgba(10,10,10,0.4), rgba(10,10,10,0.8)), url('photo.jpg')",
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center, center',
    };
    const layers = parseBackgroundLayers(styles);
    expect(layers).toHaveLength(2);
    expect(layers[0].type).toBe('gradient');
    expect(layers[0].value).toContain('linear-gradient');
    expect(layers[0].size).toBe('cover');
    expect(layers[1].type).toBe('image');
    expect(layers[1].value).toContain('url(');
    expect(layers[1].size).toBe('cover');
  });

  it('parses single gradient', () => {
    const styles = { backgroundImage: 'linear-gradient(180deg, #000 0%, #fff 100%)' };
    const layers = parseBackgroundLayers(styles);
    expect(layers).toHaveLength(1);
    expect(layers[0].type).toBe('gradient');
  });

  it('parses single image', () => {
    const styles = {
      backgroundImage: 'url(https://example.com/photo.jpg)',
      backgroundSize: 'contain',
      backgroundPosition: 'top',
      backgroundRepeat: 'repeat-x',
      backgroundAttachment: 'fixed',
    };
    const layers = parseBackgroundLayers(styles);
    expect(layers).toHaveLength(1);
    expect(layers[0].type).toBe('image');
    expect(layers[0].size).toBe('contain');
    expect(layers[0].position).toBe('top');
    expect(layers[0].repeat).toBe('repeat-x');
    expect(layers[0].attachment).toBe('fixed');
  });

  it('returns empty array for no background', () => {
    expect(parseBackgroundLayers({})).toEqual([]);
    expect(parseBackgroundLayers({ backgroundImage: 'none' })).toEqual([]);
  });

  it('falls back to background shorthand', () => {
    const styles = { background: 'linear-gradient(red, blue)' };
    const layers = parseBackgroundLayers(styles);
    expect(layers).toHaveLength(1);
    expect(layers[0].type).toBe('gradient');
  });

  it('defaults missing per-layer properties to first value or defaults', () => {
    const styles = {
      backgroundImage: 'linear-gradient(red, blue), url(bg.jpg)',
      backgroundSize: 'cover',  // only one value — should apply to both
    };
    const layers = parseBackgroundLayers(styles);
    expect(layers).toHaveLength(2);
    expect(layers[0].size).toBe('cover');
    expect(layers[1].size).toBe('cover');
    expect(layers[0].position).toBe('center');  // default
    expect(layers[0].repeat).toBe('no-repeat');  // default
    expect(layers[0].attachment).toBe('scroll');  // default
    expect(layers[0].blendMode).toBe('normal');  // default
  });
});

describe('formatBackgroundLayers', () => {
  it('formats multiple layers to comma-separated CSS', () => {
    const layers = [
      { id: '1', type: 'gradient' as const, value: 'linear-gradient(red, blue)', size: 'cover', position: 'center', repeat: 'no-repeat', attachment: 'scroll', blendMode: 'normal' },
      { id: '2', type: 'image' as const, value: 'url(photo.jpg)', size: 'contain', position: 'top', repeat: 'repeat', attachment: 'fixed', blendMode: 'multiply' },
    ];
    const result = formatBackgroundLayers(layers);
    expect(result.backgroundImage).toBe('linear-gradient(red, blue), url(photo.jpg)');
    expect(result.backgroundSize).toBe('cover, contain');
    expect(result.backgroundPosition).toBe('center, top');
    expect(result.backgroundRepeat).toBe('no-repeat, repeat');
    expect(result.backgroundAttachment).toBe('scroll, fixed');
    expect(result.backgroundBlendMode).toBe('normal, multiply');
  });

  it('formats empty layers to empty strings', () => {
    const result = formatBackgroundLayers([]);
    expect(result.backgroundImage).toBe('');
    expect(result.backgroundSize).toBe('');
  });

  it('round-trips parse → format', () => {
    const original = {
      backgroundImage: "linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.8)), url('photo.jpg')",
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center, top',
      backgroundRepeat: 'no-repeat, no-repeat',
      backgroundAttachment: 'scroll, fixed',
      backgroundBlendMode: 'normal, normal',
    };
    const layers = parseBackgroundLayers(original);
    const result = formatBackgroundLayers(layers);
    expect(result.backgroundImage).toBe(original.backgroundImage);
    expect(result.backgroundSize).toBe(original.backgroundSize);
    expect(result.backgroundPosition).toBe(original.backgroundPosition);
    expect(result.backgroundRepeat).toBe(original.backgroundRepeat);
    expect(result.backgroundAttachment).toBe(original.backgroundAttachment);
    expect(result.backgroundBlendMode).toBe(original.backgroundBlendMode);
  });
});

describe('isMultiLayerBackground', () => {
  it('returns true for multiple layers', () => {
    expect(isMultiLayerBackground({
      backgroundImage: 'linear-gradient(red, blue), url(photo.jpg)',
    })).toBe(true);
  });

  it('returns false for single layer', () => {
    expect(isMultiLayerBackground({
      backgroundImage: 'linear-gradient(red, blue)',
    })).toBe(false);
  });

  it('returns false for no background', () => {
    expect(isMultiLayerBackground({})).toBe(false);
  });

  it('returns false for none', () => {
    expect(isMultiLayerBackground({ backgroundImage: 'none' })).toBe(false);
  });
});

describe('createDefaultLayer', () => {
  it('creates gradient layer with default value', () => {
    const layer = createDefaultLayer('gradient');
    expect(layer.type).toBe('gradient');
    expect(layer.value).toContain('linear-gradient');
    expect(layer.size).toBe('cover');
    expect(layer.id).toBeTruthy();
  });

  it('creates image layer with empty value', () => {
    const layer = createDefaultLayer('image');
    expect(layer.type).toBe('image');
    expect(layer.value).toBe('');
  });

  it('creates color layer as flat gradient', () => {
    const layer = createDefaultLayer('color');
    expect(layer.type).toBe('color');
    expect(layer.value).toContain('linear-gradient');
    expect(layer.value).toContain('rgba');
  });

  it('creates unique IDs', () => {
    const a = createDefaultLayer('gradient');
    const b = createDefaultLayer('gradient');
    expect(a.id).not.toBe(b.id);
  });
});

describe('getLayerLabel', () => {
  it('labels linear gradient', () => {
    expect(getLayerLabel({ id: '1', type: 'gradient', value: 'linear-gradient(red, blue)', size: '', position: '', repeat: '', attachment: '', blendMode: '' }))
      .toBe('Linear Gradient');
  });

  it('labels radial gradient', () => {
    expect(getLayerLabel({ id: '1', type: 'gradient', value: 'radial-gradient(circle, red, blue)', size: '', position: '', repeat: '', attachment: '', blendMode: '' }))
      .toBe('Radial Gradient');
  });

  it('labels unsplash image', () => {
    expect(getLayerLabel({ id: '1', type: 'image', value: "url('https://images.unsplash.com/photo-123')", size: '', position: '', repeat: '', attachment: '', blendMode: '' }))
      .toBe('Unsplash Image');
  });

  it('labels color overlay', () => {
    expect(getLayerLabel({ id: '1', type: 'color', value: 'linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5))', size: '', position: '', repeat: '', attachment: '', blendMode: '' }))
      .toBe('rgba(0,0,0,0.5)');
  });
});

describe('solid-color layer encoded as linear-gradient(C, C) is detected as color (not gradient)', () => {
  it("the user's case: real gradient + solid-color overlay → ['gradient','color']", () => {
    const styles = {
      backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0) 62%, #000000 100%), linear-gradient(rgba(79, 91, 74, 0.5), rgba(79, 91, 74, 0.5))',
      backgroundSize: 'cover, cover',
    };
    const layers = parseBackgroundLayers(styles);
    expect(layers.map(l => l.type)).toEqual(['gradient', 'color']);
    // The color layer's label shows the colour, not "Linear Gradient".
    expect(getLayerLabel(layers[1])).toBe('rgba(79, 91, 74, 0.5)');
  });
  it('a real 2-stop gradient WITHOUT an angle but DIFFERENT colours stays a gradient', () => {
    const layers = parseBackgroundLayers({ backgroundImage: 'linear-gradient(rgba(0,0,0,0) 62%, #000000 100%)' });
    expect(layers[0].type).toBe('gradient');
  });
  it('an angled gradient with identical-looking stops stays a gradient', () => {
    const layers = parseBackgroundLayers({ backgroundImage: 'linear-gradient(180deg, #fff, #fff)' });
    expect(layers[0].type).toBe('gradient');
  });
  it('hex solid-color trick is also detected as color', () => {
    const layers = parseBackgroundLayers({ backgroundImage: 'linear-gradient(#4f5b4a, #4f5b4a)' });
    expect(layers[0].type).toBe('color');
  });
});

describe('parse folds backgroundColor into a bottom layer; format clears it', () => {
  it('parseBackgroundLayers appends a separate backgroundColor as the last color layer', () => {
    const layers = parseBackgroundLayers({ backgroundImage: 'linear-gradient(180deg, #111, #222)', backgroundColor: 'var(--color-olive)' });
    expect(layers.length).toBe(2);
    expect(layers[1].type).toBe('color');
    expect(layers[1].value).toBe('linear-gradient(var(--color-olive), var(--color-olive))');
  });
  it('ignores a transparent backgroundColor', () => {
    expect(parseBackgroundLayers({ backgroundImage: 'linear-gradient(#111, #222)', backgroundColor: 'rgba(0,0,0,0)' }).length).toBe(1);
  });
  it('formatBackgroundLayers clears the separate backgroundColor', () => {
    const out = formatBackgroundLayers([{ id: 'a', type: 'gradient', value: 'linear-gradient(#111,#222)', size: 'cover', position: 'center', repeat: 'no-repeat', attachment: 'scroll', blendMode: 'normal' }]);
    expect(out.backgroundColor).toBe('');
  });
});
