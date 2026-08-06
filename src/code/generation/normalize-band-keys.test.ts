import { describe, it, expect } from 'vitest';
import { normalizeResponsiveBandKeys, rewriteContainerBreakpoints } from './generator-styles';

/** The real drifted page shape (2026-08-06): config [1440, 564, 429] next to
 *  stray bands keyed [768, 656, 500, 463, 351] from the config-revert era. */
const page = (bands: string) => `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 564, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 429, "isPrimary": false, "order": 2 }
  ],
  "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1600, "y": 0 }, "mobile": { "x": 2408, "y": 0 } }
} */

export default function Page() {
  return <div data-id="root">
    <p data-id="hero-1">Hello</p>
    <style>{\`${bands}\`}</style>
  </div>;
}
`;

const DRIFTED = `
    @media (max-width: 768px) and (min-width: 351.02px) {
      [data-id="hero-1"] { font-size: 40px !important; }
      [data-id="frame-a"] { flex-direction: column !important; }
    }
    @media (max-width: 656px) {
      [data-id="frame-b"] { width: 100% !important; }
    }
    @media (max-width: 500px) {
      [data-id="hero-1"] { font-size: 32px !important; }
      [data-id="frame-c"] { padding: 16px !important; }
    }
    @media (max-width: 351px) {
      [data-id="hero-1"] { left: 0px !important; }
    }
  `;

describe('normalizeResponsiveBandKeys', () => {
  it("flattens each viewport tile's painted state into ONE band keyed at that viewport's width", () => {
    const healed = normalizeResponsiveBandKeys(page(DRIFTED));
    // Tablet (564) painted 768 + 656 (656 has no floor → covers 564); band re-keyed 564.
    expect(healed).toContain('@media (max-width: 564px) and (min-width: 429.02px)');
    // Mobile (429) painted 768 + 656 + 500; band re-keyed 429 (bare max-width, narrowest).
    expect(healed).toContain('@media (max-width: 429px)');
    // Tablet keeps the 40px hero override; mobile gets the narrower band's 32px (cascade winner).
    const tabletBand = healed.slice(healed.indexOf('max-width: 564px'), healed.indexOf('max-width: 429px'));
    expect(tabletBand).toContain('font-size: 40px');
    const mobileBand = healed.slice(healed.indexOf('max-width: 429px'));
    expect(mobileBand).toContain('font-size: 32px');
    expect(mobileBand).toContain('flex-direction: column'); // inherited from the 768-era band it painted
    expect(mobileBand).toContain('padding: 16px');
    // The sub-mobile stray (351) covers NO tile → dropped.
    expect(healed).not.toContain('max-width: 351px');
    expect(healed).not.toContain('left: 0px');
    // No stray keys survive.
    expect(healed).not.toContain('max-width: 768px');
    expect(healed).not.toContain('max-width: 656px');
    expect(healed).not.toContain('max-width: 500px');
  });

  it('is idempotent and a byte-identical no-op on healthy pages', () => {
    const healed = normalizeResponsiveBandKeys(page(DRIFTED));
    expect(normalizeResponsiveBandKeys(healed)).toBe(healed);

    const healthy = page(`
    @media (max-width: 564px) and (min-width: 429.02px) {
      [data-id="hero-1"] { font-size: 40px !important; }
    }
    @media (max-width: 429px) {
      [data-id="hero-1"] { font-size: 32px !important; }
    }
  `);
    expect(normalizeResponsiveBandKeys(healthy)).toBe(healthy);
  });

  it('a viewport resized PAST its stranded band reclaims it ordinally — the real aBode shape', () => {
    // Config mobile already committed at 1310 (wider than every stray band):
    // no band covers 1310, but the mobile overrides still sit in the 500-era
    // band. Phase 2 must give mobile its old look back, flattened at the
    // stray's width (768+656+500 cascade), not drop it.
    const code = page(DRIFTED).replace('"width": 429', '"width": 1310');
    const healed = normalizeResponsiveBandKeys(code);
    expect(healed).toContain('@media (max-width: 1310px) and (min-width: 564.02px)');
    const mobileBand = healed.slice(healed.indexOf('max-width: 1310px'), healed.indexOf('max-width: 564px'));
    expect(mobileBand).toContain('font-size: 32px');
    expect(mobileBand).toContain('flex-direction: column');
    expect(mobileBand).toContain('padding: 16px');
    // Tablet keeps its own flattened band at its key (bare max-width — now the narrowest).
    expect(healed).toContain('@media (max-width: 564px)');
    // Idempotent on the phase-2 output too.
    expect(normalizeResponsiveBandKeys(healed)).toBe(healed);
  });

  it('no-ops without an @canvas config or without band rules', () => {
    const noConfig = `export default function P() { return <div data-id="root"><style>{\`@media (max-width: 500px) { [data-id="x"] { color: red !important; } }\`}</style></div>; }`;
    expect(normalizeResponsiveBandKeys(noConfig)).toBe(noConfig);
    const noBands = page('\n  ');
    expect(normalizeResponsiveBandKeys(noBands)).toBe(noBands);
  });

  it('rewriteContainerBreakpoints normalizes first, so a resize on a drifted page moves the REAL band', () => {
    // The failing real-world flow: mobile (config 429) resized to 900 on the
    // drifted page. Pre-fix the ordinal claim grabbed an arbitrary stray and
    // the mobile tile lost its styles ("looks like desktop now").
    const out = rewriteContainerBreakpoints(page(DRIFTED), 429, 900);
    // Mobile's flattened band followed the resize; hero keeps its 32px.
    expect(out).toContain('max-width: 900px');
    const mobileBand = out.slice(out.indexOf('max-width: 900px'), out.indexOf('max-width: 564px'));
    expect(mobileBand).toContain('font-size: 32px');
    // Tablet's band intact at its own key.
    expect(out).toContain('max-width: 564px');
    expect(out).not.toContain('max-width: 656px');
  });
});
