// gradient-utils.test.ts — Tests for gradient CSS parsing/formatting utilities.

import { describe, it, expect } from 'vitest';
import { parseGradient, formatGradient, createDefaultGradient } from '@/shared/gradient-utils';

describe('parseGradient', () => {
  it('parses a linear-gradient with degrees', () => {
    const result = parseGradient('linear-gradient(180deg, #ff0000 0%, #0000ff 100%)');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('linear');
    expect(result!.direction).toBe(180);
    expect(result!.stops).toHaveLength(2);
    expect(result!.stops[0].color).toBe('#ff0000');
    expect(result!.stops[0].position).toBe(0);
    expect(result!.stops[1].color).toBe('#0000ff');
    expect(result!.stops[1].position).toBe(100);
  });

  it('parses a linear-gradient with "to" keyword', () => {
    const result = parseGradient('linear-gradient(to right, #000 0%, #fff 100%)');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('linear');
    expect(result!.direction).toBe(90);
  });

  it('parses a radial-gradient with center', () => {
    const result = parseGradient('radial-gradient(circle at 50% 50%, #ff0000 0%, #0000ff 100%)');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('radial');
    expect(result!.centerX).toBe(50);
    expect(result!.centerY).toBe(50);
    expect(result!.stops).toHaveLength(2);
  });

  it('parses a radial-gradient with non-default center', () => {
    const result = parseGradient('radial-gradient(circle at 25% 75%, #aaa 0%, #bbb 100%)');
    expect(result).not.toBeNull();
    expect(result!.centerX).toBe(25);
    expect(result!.centerY).toBe(75);
  });

  it('parses a conic-gradient', () => {
    const result = parseGradient('conic-gradient(from 90deg at 50% 50%, #ff0000 0%, #0000ff 100%)');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('conic');
    expect(result!.angle).toBe(90);
    expect(result!.centerX).toBe(50);
    expect(result!.centerY).toBe(50);
    expect(result!.stops).toHaveLength(2);
  });

  it('parses gradients with 3+ stops', () => {
    const result = parseGradient('linear-gradient(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%)');
    expect(result).not.toBeNull();
    expect(result!.stops).toHaveLength(3);
    expect(result!.stops[1].color).toBe('#00ff00');
    expect(result!.stops[1].position).toBe(50);
  });

  it('parses gradients with rgba() colors', () => {
    const result = parseGradient('linear-gradient(45deg, rgba(255, 0, 0, 0.5) 0%, rgba(0, 0, 255, 1) 100%)');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe(45);
    expect(result!.stops[0].color).toBe('rgba(255, 0, 0, 0.5)');
    expect(result!.stops[1].color).toBe('rgba(0, 0, 255, 1)');
  });

  it('returns null for non-gradient strings', () => {
    expect(parseGradient('#ff0000')).toBeNull();
    expect(parseGradient('solid')).toBeNull();
    expect(parseGradient('')).toBeNull();
    expect(parseGradient('url(image.png)')).toBeNull();
  });

  it('returns null for gradient with fewer than 2 stops', () => {
    expect(parseGradient('linear-gradient(180deg, #ff0000 0%)')).toBeNull();
  });
});

describe('formatGradient', () => {
  it('formats a linear gradient', () => {
    const data = createDefaultGradient();
    const css = formatGradient(data);
    expect(css).toBe('linear-gradient(180deg, #000000 0%, #ffffff 100%)');
  });

  it('formats a radial gradient', () => {
    const data = createDefaultGradient();
    data.type = 'radial';
    data.centerX = 30;
    data.centerY = 70;
    const css = formatGradient(data);
    expect(css).toBe('radial-gradient(50% 50% at 30% 70%, #000000 0%, #ffffff 100%)');
  });

  it('formats a conic gradient', () => {
    const data = createDefaultGradient();
    data.type = 'conic';
    data.angle = 45;
    const css = formatGradient(data);
    expect(css).toBe('conic-gradient(from 45deg at 50% 50%, #000000 0%, #ffffff 100%)');
  });
});

describe('parseGradient → formatGradient roundtrip', () => {
  it('roundtrips a linear gradient', () => {
    const input = 'linear-gradient(180deg, #ff0000 0%, #0000ff 100%)';
    const parsed = parseGradient(input);
    expect(parsed).not.toBeNull();
    const output = formatGradient(parsed!);
    expect(output).toBe(input);
  });

  it('roundtrips a radial gradient', () => {
    const input = 'radial-gradient(50% 50% at 50% 50%, #ff0000 0%, #0000ff 100%)';
    const parsed = parseGradient(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.radiusX).toBe(50);
    expect(parsed!.radiusY).toBe(50);
    const output = formatGradient(parsed!);
    expect(output).toBe(input);
  });

  it('roundtrips a conic gradient', () => {
    const input = 'conic-gradient(from 0deg at 50% 50%, #ff0000 0%, #0000ff 100%)';
    const parsed = parseGradient(input);
    expect(parsed).not.toBeNull();
    const output = formatGradient(parsed!);
    expect(output).toBe(input);
  });
});

describe('createDefaultGradient', () => {
  it('returns a valid linear gradient from black to white', () => {
    const data = createDefaultGradient();
    expect(data.type).toBe('linear');
    expect(data.direction).toBe(180);
    expect(data.stops).toHaveLength(2);
    expect(data.stops[0].color).toBe('#000000');
    expect(data.stops[0].position).toBe(0);
    expect(data.stops[1].color).toBe('#ffffff');
    expect(data.stops[1].position).toBe(100);
  });

  it('creates stops with unique IDs', () => {
    const data = createDefaultGradient();
    expect(data.stops[0].id).not.toBe(data.stops[1].id);
  });
});

describe('deterministic stop IDs', () => {
  it('generates the same stop IDs across multiple parses', () => {
    const css = 'linear-gradient(180deg, #ff0000 0%, #0000ff 100%)';
    const result1 = parseGradient(css);
    const result2 = parseGradient(css);
    expect(result1!.stops[0].id).toBe(result2!.stops[0].id);
    expect(result1!.stops[1].id).toBe(result2!.stops[1].id);
  });

  it('generates different IDs for different stop indices', () => {
    const result = parseGradient('linear-gradient(90deg, #ff0000 0%, #00ff00 50%, #0000ff 100%)');
    const ids = result!.stops.map(s => s.id);
    expect(new Set(ids).size).toBe(3);
  });
});
