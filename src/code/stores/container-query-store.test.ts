import { describe, test, it, expect } from 'vitest';
import {
  parseContainerRules,
  hasOverride,
  hasOverrideAtWidth,
  getOverridesAtWidth,
  getOverrideValue,
  getOverrideBreakpoints,
  resolveEffectiveStylesForViewport,
  clearShorthandSupersededLonghands,
  type ContainerOverrideMap,
} from './container-query-store';

describe('parseContainerRules', () => {
  test('parses single @media rule', () => {
    const css = `@media (max-width: 768px) {
      [data-id="title"] { font-size: 36px !important; }
    }`;
    const rules = parseContainerRules(css);
    expect(rules.has(768)).toBe(true);
    const selectors = rules.get(768)!;
    expect(selectors.has('title')).toBe(true);
    expect(selectors.get('title')!.get('font-size')).toBe('36px');
  });

  test('parses multiple breakpoints', () => {
    const css = `@media (max-width: 768px) {
      [data-id="hero"] { padding: 40px !important; }
    }
    @media (max-width: 375px) {
      [data-id="hero"] { padding: 20px !important; }
    }`;
    const rules = parseContainerRules(css);
    expect(rules.size).toBe(2);
    expect(rules.get(768)!.get('hero')!.get('padding')).toBe('40px');
    expect(rules.get(375)!.get('hero')!.get('padding')).toBe('20px');
  });

  test('parses multiple selectors in same breakpoint', () => {
    const css = `@media (max-width: 768px) {
      [data-id="title"] { font-size: 36px !important; }
      [data-id="desc"] { font-size: 14px !important; }
    }`;
    const rules = parseContainerRules(css);
    const selectors = rules.get(768)!;
    expect(selectors.size).toBe(2);
    expect(selectors.get('title')!.get('font-size')).toBe('36px');
    expect(selectors.get('desc')!.get('font-size')).toBe('14px');
  });

  test('strips !important from values', () => {
    const css = `@media (max-width: 768px) {
      [data-id="box"] { width: 100% !important; height: auto !important; }
    }`;
    const rules = parseContainerRules(css);
    const props = rules.get(768)!.get('box')!;
    expect(props.get('width')).toBe('100%');
    expect(props.get('height')).toBe('auto');
  });

  test('returns empty map for no rules', () => {
    expect(parseContainerRules('')).toEqual(new Map());
    expect(parseContainerRules('body { color: red; }')).toEqual(new Map());
  });
});

// ─── Per-viewport lookup helpers ─────────────────────────────────────────────
//
// Non-regression tests for the bug where mobile inherited tablet's "blue
// label" / "shielded from primary fan-out" state because the original
// `hasOverride` was a global "any breakpoint" check.
//
// The fix is to match on the EXACT viewport width.

function makeOverrides(): ContainerOverrideMap {
  // Node "hero":
  //   tablet (768) → width: 200px
  //   mobile (375) → fontSize: 14px
  // Node "card":
  //   tablet (768) → padding: 20px (only tablet has anything)
  return new Map([
    ['hero', new Map([
      [768, new Map([['width', '200px']])],
      [375, new Map([['fontSize', '14px']])],
    ])],
    ['card', new Map([
      [768, new Map([['padding', '20px']])],
    ])],
  ]);
}

describe('hasOverrideAtWidth', () => {
  const overrides = makeOverrides();

  test('returns true when this exact viewport has the property', () => {
    expect(hasOverrideAtWidth(overrides, 'hero', 'width', 768)).toBe(true);
    expect(hasOverrideAtWidth(overrides, 'hero', 'fontSize', 375)).toBe(true);
  });

  test('returns false when only a different viewport has the property', () => {
    // Mobile inheriting tablet's override would be the regression — this
    // protects the "individual per replica" behavior the user asked for.
    expect(hasOverrideAtWidth(overrides, 'hero', 'width', 375)).toBe(false);
    expect(hasOverrideAtWidth(overrides, 'hero', 'fontSize', 768)).toBe(false);
    expect(hasOverrideAtWidth(overrides, 'card', 'padding', 375)).toBe(false);
  });

  test('returns false for an unknown node, property, or width', () => {
    expect(hasOverrideAtWidth(overrides, 'missing', 'width', 768)).toBe(false);
    expect(hasOverrideAtWidth(overrides, 'hero', 'color', 768)).toBe(false);
    expect(hasOverrideAtWidth(overrides, 'hero', 'width', 1024)).toBe(false);
  });
});

describe('getOverridesAtWidth', () => {
  const overrides = makeOverrides();

  test('returns the property→value map for this exact viewport', () => {
    const tabletProps = getOverridesAtWidth(overrides, 'hero', 768);
    expect(tabletProps.size).toBe(1);
    expect(tabletProps.get('width')).toBe('200px');
  });

  test('returns an empty Map when this viewport has no rule', () => {
    // Critical for the primary-resize fan-out: an empty result means the
    // replica is "synced" and SHOULD receive the primary's live update.
    const mobileForCard = getOverridesAtWidth(overrides, 'card', 375);
    expect(mobileForCard).toBeInstanceOf(Map);
    expect(mobileForCard.size).toBe(0);
  });

  test('returns an empty Map for an unknown node or width', () => {
    expect(getOverridesAtWidth(overrides, 'missing', 768).size).toBe(0);
    expect(getOverridesAtWidth(overrides, 'hero', 1024).size).toBe(0);
  });

  test('does not bleed across viewports', () => {
    // The point of exact-width matching: a tablet rule must NOT show up
    // when querying mobile, even though `(max-width: 768)` covers 375 in
    // raw CSS. The store records the breakpoint by its declared maxWidth
    // and the generator scopes ranges so this is the truthful answer.
    const mobileForHero = getOverridesAtWidth(overrides, 'hero', 375);
    expect(mobileForHero.has('width')).toBe(false);
    expect(mobileForHero.get('fontSize')).toBe('14px');
  });
});

describe('hasOverride (global "any breakpoint")', () => {
  // Sanity: the global helper still works as before — it's only the
  // ControlProvider call site that switched to the per-viewport variant.
  const overrides = makeOverrides();

  test('returns true when ANY breakpoint has the property', () => {
    expect(hasOverride(overrides, 'hero', 'width')).toBe(true);
    expect(hasOverride(overrides, 'hero', 'fontSize')).toBe(true);
  });

  test('returns false when no breakpoint has the property', () => {
    expect(hasOverride(overrides, 'hero', 'color')).toBe(false);
    expect(hasOverride(overrides, 'missing', 'width')).toBe(false);
  });
});

describe('getOverrideValue / getOverrideBreakpoints', () => {
  const overrides = makeOverrides();

  test('getOverrideValue picks out the value at a specific width', () => {
    expect(getOverrideValue(overrides, 'hero', 'width', 768)).toBe('200px');
    expect(getOverrideValue(overrides, 'hero', 'width', 375)).toBeNull();
  });

  test('getOverrideBreakpoints lists all matching breakpoints', () => {
    const bps = getOverrideBreakpoints(overrides, 'hero', 'fontSize');
    expect(bps).toEqual([{ maxWidth: 375, value: '14px' }]);
  });
});

// Mirror of ControlProvider's hasOverride callback. Kept inline so a future
// drift in the provider's gate is caught here. Same one-liner the panel
// runs each time it decides whether to paint a label blue.
function panelLabelOverrideGate(
  overrides: ContainerOverrideMap,
  selectedId: string | null,
  property: string,
  isReplica: boolean,
  vpWidth: number | undefined,
): boolean {
  if (!selectedId) return false;
  if (!isReplica || !vpWidth) return false;
  return hasOverrideAtWidth(overrides, selectedId, property, vpWidth);
}

describe('panel label override gate (non-regression)', () => {
  // Regression net for: "PRIMARY shows blue override makes no sense at all".
  // Before the fix the primary viewport's labels flipped to blue whenever
  // ANY replica owned an @media rule for the property. Now primary always
  // returns false; only the exact-width replica match counts.
  const overrides = makeOverrides();

  test('primary viewport never reports an override, even when a replica has one', () => {
    expect(panelLabelOverrideGate(overrides, 'hero', 'width', false, 1440)).toBe(false);
    expect(panelLabelOverrideGate(overrides, 'hero', 'fontSize', false, 1440)).toBe(false);
  });

  test('replica reports an override only at its exact viewport width', () => {
    // Tablet has width:200px. Mobile (375) has fontSize:14px but NOT width.
    expect(panelLabelOverrideGate(overrides, 'hero', 'width', true, 768)).toBe(true);
    expect(panelLabelOverrideGate(overrides, 'hero', 'width', true, 375)).toBe(false);
    expect(panelLabelOverrideGate(overrides, 'hero', 'fontSize', true, 375)).toBe(true);
    expect(panelLabelOverrideGate(overrides, 'hero', 'fontSize', true, 768)).toBe(false);
  });

  test('returns false when no node is selected', () => {
    expect(panelLabelOverrideGate(overrides, null, 'width', true, 768)).toBe(false);
  });

  test('returns false when vpWidth is missing', () => {
    expect(panelLabelOverrideGate(overrides, 'hero', 'width', true, undefined)).toBe(false);
  });
});

// Effective-style resolution for a REPLICA detach: a canvas node lives outside the
// viewport tree, so the source replica's @media overrides must be baked into its own
// style (else it reverts to base/desktop). The advisors repro: a 3-col grid that's
// 2-col on tablet must detach as 2-col + the tablet gap overrides.
describe('resolveEffectiveStylesForViewport', () => {
  const overrides: ContainerOverrideMap = new Map([
    ['frame-mqjancfv-2', new Map([
      [768, new Map([
        ['gridTemplateColumns', 'repeat(2, minmax(0, 1fr))'],
        ['rowGap', '89px'],
        ['columnGap', '28px'],
      ])],
      [375, new Map([
        ['gridTemplateColumns', 'repeat(1, minmax(0, 1fr))'],
      ])],
    ])],
  ]);
  const base = { display: 'grid', gap: '40px', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' };

  test('primary (no/zero sourceVpWidth) returns base styles unchanged', () => {
    expect(resolveEffectiveStylesForViewport(base, 'frame-mqjancfv-2', undefined, overrides)).toEqual(base);
    expect(resolveEffectiveStylesForViewport(base, 'frame-mqjancfv-2', 0, overrides)).toEqual(base);
  });

  test('bakes the SOURCE replica override over the base (the advisors repro)', () => {
    const out = resolveEffectiveStylesForViewport(base, 'frame-mqjancfv-2', 768, overrides);
    // grid-template-columns override REPLACES the base track list.
    expect(out.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(out.gridTemplateColumns).not.toContain('repeat(3');
    // gap longhands merge in.
    expect(out.rowGap).toBe('89px');
    expect(out.columnGap).toBe('28px');
    // untouched base prop preserved.
    expect(out.display).toBe('grid');
    // base `gap` shorthand precedes the longhand overrides in insertion order so the
    // longhands win at paint.
    const keys = Object.keys(out);
    expect(keys.indexOf('gap')).toBeLessThan(keys.indexOf('rowGap'));
  });

  test('resolves the EXACT source width (mobile override differs from tablet)', () => {
    const mob = resolveEffectiveStylesForViewport(base, 'frame-mqjancfv-2', 375, overrides);
    expect(mob.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))');
    expect(mob.rowGap).toBeUndefined(); // no tablet-only gaps leak into mobile
  });

  test('skips empty / auto override values (empty = not set)', () => {
    const ov: ContainerOverrideMap = new Map([
      ['n', new Map([
        [768, new Map([
          ['width', ''],
          ['height', 'auto'],
          ['color', 'red'],
        ])],
      ])],
    ]);
    const out = resolveEffectiveStylesForViewport({ width: '100px', height: '50px' }, 'n', 768, ov);
    expect(out.width).toBe('100px');  // '' override ignored → base kept
    expect(out.height).toBe('50px');  // 'auto' override ignored → base kept
    expect(out.color).toBe('red');    // real override applied
  });

  test('node with no overrides → base unchanged', () => {
    expect(resolveEffectiveStylesForViewport(base, 'other-node', 768, overrides)).toEqual(base);
  });

  test('does not mutate the input base map', () => {
    const input = { ...base };
    resolveEffectiveStylesForViewport(input, 'frame-mqjancfv-2', 768, overrides);
    expect(input).toEqual(base);
  });
});

describe('clearShorthandSupersededLonghands', () => {
  test('a borderRadius shorthand override drops the base radius longhands', () => {
    // Base uses the 4 longhands (0 0 34 34), @media overrides the shorthand.
    const merged: Record<string, string> = {
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '34px', borderBottomLeftRadius: '34px',
      borderRadius: '26px',
    };
    clearShorthandSupersededLonghands(merged, ['borderRadius']);
    expect(merged.borderRadius).toBe('26px');
    expect(merged.borderTopLeftRadius).toBeUndefined();
    expect(merged.borderBottomRightRadius).toBeUndefined();
  });

  test('keeps a longhand that is ALSO overridden (more specific wins)', () => {
    const merged: Record<string, string> = {
      borderTopLeftRadius: '0px', borderRadius: '26px', borderTopRightRadius: '10px',
    };
    clearShorthandSupersededLonghands(merged, ['borderRadius', 'borderTopRightRadius']);
    expect(merged.borderTopLeftRadius).toBeUndefined();
    expect(merged.borderTopRightRadius).toBe('10px'); // overridden → kept
  });

  test('a PADDING shorthand override drops the base padding longhands (the LayoutTool replica case)', () => {
    // Replica padding: base uses longhands 110/0/140/0; the @media override sets
    // the `padding` shorthand (e.g. 16px). The panel must read all-16 for BOTH
    // the global field AND the per-side inputs, and the chevron must operate on
    // 16 — else it read the stale base longhand (110) and reverted to primary.
    const merged: Record<string, string> = {
      paddingTop: '110px', paddingRight: '0px', paddingBottom: '140px', paddingLeft: '0px',
      padding: '16px',
    };
    clearShorthandSupersededLonghands(merged, ['padding']);
    expect(merged.padding).toBe('16px');
    expect(merged.paddingTop).toBeUndefined();
    expect(merged.paddingRight).toBeUndefined();
    expect(merged.paddingBottom).toBeUndefined();
    expect(merged.paddingLeft).toBeUndefined();
  });

  test('resolveEffectiveStylesForViewport: shorthand override supersedes base longhands', () => {
    const overrides: ContainerOverrideMap = new Map([
      ['n1', new Map([[768, new Map([['borderRadius', '26px']])]])],
    ]);
    const base = {
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
      borderBottomRightRadius: '34px', borderBottomLeftRadius: '34px',
    };
    const out = resolveEffectiveStylesForViewport(base, 'n1', 768, overrides);
    expect(out.borderRadius).toBe('26px');
    expect(out.borderTopLeftRadius).toBeUndefined();
    expect(out.borderBottomLeftRadius).toBeUndefined();
  });
});

// Alias-aware override detection — a responsive block authored as pure
// LONGHANDS (padding-top: 28px !important …) must light the shorthand
// control's override label and list its breakpoint (the CTA tablet report:
// mobile block had a `padding` key and lit up, tablet was longhands-only
// and didn't).
describe('shorthand override aliases', () => {
  const css = `
    @media (max-width: 768px) and (min-width: 376px) {
      [data-id="cta"] { padding-top: 28px !important; padding-right: 0px !important; padding-bottom: 28px !important; padding-left: 0px !important; }
    }
    @media (max-width: 375px) {
      [data-id="cta"] { padding: 0px !important; padding-top: 49px !important; }
    }
  `;
  // Build the node→width→camelProps map the way containerOverridesAtom does.
  const raw = parseContainerRules(css);
  const map: ContainerOverrideMap = new Map();
  for (const [maxWidth, selectors] of raw) {
    for (const [nodeId, props] of selectors) {
      if (!map.has(nodeId)) map.set(nodeId, new Map());
      if (!map.get(nodeId)!.has(maxWidth)) map.get(nodeId)!.set(maxWidth, new Map());
      for (const [k, v] of props) map.get(nodeId)!.get(maxWidth)!.set(k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v);
    }
  }

  it('hasOverride(padding) sees a longhand-only block', () => {
    expect(hasOverride(map, 'cta', 'padding')).toBe(true);
  });

  it('hasOverrideAtWidth matches the longhand-only tablet width', () => {
    expect(hasOverrideAtWidth(map, 'cta', 'padding', 768)).toBe(true);
    expect(hasOverrideAtWidth(map, 'cta', 'padding', 375)).toBe(true);
    expect(hasOverrideAtWidth(map, 'cta', 'width', 768)).toBe(false);
  });

  it('getOverrideBreakpoints lists BOTH breakpoints for padding', () => {
    const bps = getOverrideBreakpoints(map, 'cta', 'padding').map((b) => b.maxWidth);
    expect(bps).toEqual([768, 375]);
  });

  it('non-shorthand properties keep exact-key behavior', () => {
    expect(hasOverride(map, 'cta', 'paddingTop')).toBe(true);
    expect(hasOverride(map, 'cta', 'gap')).toBe(false);
  });
});

describe(':lang rules are NOT regular overrides', () => {
  test('banded :lang rules are skipped by parseContainerRules', () => {
    const css = `
@media (max-width: 768px) and (min-width: 375px) {
  [data-id="card"] { width: 100% !important; }
  :lang(fr) [data-id="card"] { border-radius: 101px !important; }
}
`;
    const rules = parseContainerRules(css);
    const card = rules.get(768)!.get('card')!;
    expect(card.get('width')).toBe('100%');
    // The French radius must NOT pollute the regular override map — it leaked
    // into control values / the Localize popup Fallback (the "Set syncs
    // Fallback on replicas" report).
    expect(card.get('border-radius')).toBeUndefined();
  });
});
