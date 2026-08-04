import { describe, test, expect } from 'vitest';
import {
  BUILDER_THEMES,
  DEFAULT_BUILDER_THEME_ID,
  DARK_ACCENT_TEXT_MIX,
  getBuilderThemeById,
} from './builder-themes';

// These palettes recolour the BUILDER chrome (`--accent` in
// src/styles/globals.css), not the user's project tokens. The tests guard the
// contract `editor/builder-theme.ts` depends on, not the taste of the colours.

describe('builder themes', () => {
  test('ships the intended palettes, Default first', () => {
    expect(BUILDER_THEMES.map((t) => t.id)).toEqual([
      'default', 'monochrome', 'forest', 'ocean', 'ember', 'amber', 'rose',
    ]);
    // Default leads the menu — it's the reset row.
    expect(BUILDER_THEMES[0].id).toBe(DEFAULT_BUILDER_THEME_ID);
  });

  test('every label clears WCAG AA on its own accent fill', () => {
    // The bar globals.css sets for the stock accent ("it has to clear AA in
    // both directions"). The first pass at Forest/Ocean/Ember/Rose all landed
    // around 4.0 and looked fine by eye — this is why the check is automated.
    const lum = (hex: string) => {
      const c = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [l1, l2] = [lum(a), lum(b)];
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    for (const t of BUILDER_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const { accent, accentFg } = t[mode];
        expect(ratio(accent, accentFg), `${t.id} (${mode}): ${accentFg} on ${accent}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('dark-mode --accent-text derivation clears AA on the dark chrome', () => {
    // `editor/builder-theme.ts` paints `--accent-text` in dark mode as
    // color-mix(accent DARK_ACCENT_TEXT_MIX, white) — because `.dark`'s own
    // rule collapses it to the RAW accent, which left Rose at 1.9:1 on the
    // dropdown surface (the unreadable "Upgrade your plan" report). This
    // replicates that srgb mix and holds every palette to WCAG AA on the
    // LIGHTEST dark chrome surface accent text sits on (--dropdown-bg
    // #3d3d3d; --bg-surface #111111 is easier and follows for free).
    const lum = (hex: string) => {
      const c = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [l1, l2] = [lum(a), lum(b)];
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const mixWithWhite = (hex: string, accentShare: number) => {
      const ch = [1, 3, 5].map((i) =>
        Math.round(parseInt(hex.slice(i, i + 2), 16) * accentShare + 255 * (1 - accentShare)),
      );
      return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    };
    const DROPDOWN_BG_DARK = '#3d3d3d';
    for (const t of BUILDER_THEMES) {
      if (t.id === DEFAULT_BUILDER_THEME_ID) continue; // Default keeps the stylesheet's raw-accent collapse (brass: 6.4:1)
      const lifted = mixWithWhite(t.dark.accent, DARK_ACCENT_TEXT_MIX);
      expect(ratio(lifted, DROPDOWN_BG_DARK), `${t.id}: ${lifted} on ${DROPDOWN_BG_DARK}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  test('no palette collides with the component-master purple', () => {
    // `--accent-secondary` (#9a66ff) re-skins the chrome inside a component
    // master. An accent in that neighbourhood would make the mode ambiguous.
    const hueOf = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return -1;                       // greyscale — never confusable
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const purple = hueOf('#9a66ff');                // ~260°
    for (const t of BUILDER_THEMES) {
      const h = hueOf(t.light.accent);
      if (h < 0) continue;
      const delta = Math.min(Math.abs(h - purple), 360 - Math.abs(h - purple));
      expect(delta, `${t.id} (${t.light.accent}) sits too close to the component purple`).toBeGreaterThan(40);
    }
  });

  test('ids are unique', () => {
    expect(new Set(BUILDER_THEMES.map((t) => t.id)).size).toBe(BUILDER_THEMES.length);
  });

  test('every palette declares both modes as plain hex', () => {
    // `paint()` indexes light/dark directly and writes the value straight into
    // a CSS custom property — a missing or malformed entry would silently
    // produce an invalid declaration rather than throw.
    for (const t of BUILDER_THEMES) {
      expect(t.light.accent, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.light.accentFg, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.dark.accent, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.dark.accentFg, t.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('Default matches the shipped globals.css accent', () => {
    // If this drifts, picking Default (which CLEARS the overrides) would land
    // on a different colour than the menu row implies.
    const d = getBuilderThemeById(DEFAULT_BUILDER_THEME_ID)!;
    expect(d.light.accent).toBe('#cec997');
    expect(d.dark.accent).toBe('#cec997');
    expect(d.light.accentFg).toBe('#0d1017');
  });

  test('Monochrome inverts between light and dark', () => {
    const m = getBuilderThemeById('monochrome')!;
    expect(m.light.accent).toBe('#111111');
    expect(m.light.accentFg).toBe('#ffffff');
    expect(m.dark.accent).toBe('#ffffff');
    expect(m.dark.accentFg).toBe('#111111');
    // The whole point: accent and its label swap places with the mode.
    expect(m.light.accent).toBe(m.dark.accentFg);
    expect(m.light.accentFg).toBe(m.dark.accent);
  });

  test('non-inverting palettes keep one hue across modes', () => {
    // globals.css argues a brand accent that changes hue between light and
    // dark stops being a brand colour. Monochrome is the deliberate exception.
    for (const t of BUILDER_THEMES.filter((x) => x.id !== 'monochrome')) {
      expect(t.light.accent, t.id).toBe(t.dark.accent);
    }
  });

  test('getBuilderThemeById returns undefined for an unknown id', () => {
    // builder-theme.ts falls back to Default on a stale stored id.
    expect(getBuilderThemeById('removed-palette')).toBeUndefined();
  });
});
