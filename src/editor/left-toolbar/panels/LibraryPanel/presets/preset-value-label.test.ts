import { describe, test, expect } from 'vitest';
import type { PresetToken } from '@/shared/types';
import { presetValueLabel, typographyValueLabel, borderGroupValueLabel } from './preset-value-label';

const tok = (category: PresetToken['category'], value: string, name = `x-${category}`): PresetToken => ({ name, value, category });

describe('presetValueLabel', () => {
  test('dimension presets show their value as written', () => {
    expect(presetValueLabel(tok('spacing', '80px'))).toBe('80px');
    expect(presetValueLabel(tok('margin', ' 24px  0 '))).toBe('24px 0');
    expect(presetValueLabel(tok('radius', '100px'))).toBe('100px');
  });

  test('colour: hex upper-cased, other syntaxes untouched', () => {
    expect(presetValueLabel(tok('color', '#6366f1'))).toBe('#6366F1');
    expect(presetValueLabel(tok('color', 'rgba(0, 0, 0, 0.5)'))).toBe('rgba(0, 0, 0, 0.5)');
  });

  test('shadow: first layer without its colour, extra layers counted', () => {
    expect(presetValueLabel(tok('shadow', '0 1px 3px rgba(0,0,0,0.06)'))).toBe('0 1px 3px');
    expect(presetValueLabel(tok('shadow', '0 4px 12px 2px #000, 0 1px 2px rgba(0,0,0,.2)'))).toBe('0 4px 12px 2px +1');
    expect(presetValueLabel(tok('shadow', 'inset 0 2px 4px var(--color-ink)'))).toBe('inset 0 2px 4px');
    expect(presetValueLabel(tok('shadow', 'none'))).toBe('None');
  });

  test('border shorthand → width + style', () => {
    expect(presetValueLabel(tok('border', '2px dashed #ff0000'))).toBe('2px dashed');
  });

  test('image / video show no text', () => {
    expect(presetValueLabel(tok('image', 'url(/a.png)'))).toBe('');
    expect(presetValueLabel(tok('video', 'url(/a.mp4)'))).toBe('');
  });
});

describe('group labels', () => {
  test('typography → desktop size (not a responsive tier)', () => {
    const group = {
      name: 'heading',
      label: 'Heading',
      tokens: [
        tok('typography', '32px', 'typo-heading-size-sm'),
        tok('typography', '48px', 'typo-heading-size'),
        tok('typography', '700', 'typo-heading-weight'),
      ],
    };
    expect(typographyValueLabel(group)).toBe('48px');
  });

  test('border group → width + style, gradient flavour named', () => {
    const solid = {
      name: 'card', label: 'Card', flavor: 'solid' as const,
      tokens: [tok('border', '1px', 'border-card-width'), tok('border', 'dotted', 'border-card-style'), tok('border', '#000', 'border-card-color')],
    };
    expect(borderGroupValueLabel(solid)).toBe('1px dotted');
    const gradient = {
      name: 'glow', label: 'Glow', flavor: 'gradient' as const,
      tokens: [tok('border', '2px', 'border-glow-width'), tok('border', 'linear-gradient(red, blue)', 'border-glow-image-source')],
    };
    expect(borderGroupValueLabel(gradient)).toBe('2px gradient');
  });
});
