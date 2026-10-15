import { describe, it, expect } from 'vitest';
import { formatBorderAfterCSSVars, borderStateToOverlayVars, clearedOverlayVars, isVarBackedBorderAfterBody, resolveBorderAfterBodyVars, zeroWidthOverlayVars, overlayWidthVisible, planOverlayVarRemoval } from './border-overlay-vars';
import { parseBorderAfterCSS, extractBorderAfterRuleBody, type BorderState } from './border-utils';
import { updateNodeInCode } from '@/code/generation/generator-crud';
import { updateBorderOverlayStyle, updateVariantStyleInCode } from '@/code/generation/generator-styles';
import { parseJSXToNodes, extractStyleCSS } from '@/code/parsing/parser';

const side = (width: number, color = '#ffffff', style = 'solid') => ({ width, style, color });
const uniform: BorderState = { top: side(61), right: side(61), bottom: side(61), left: side(61), isUniform: true };
const mixed: BorderState = { top: side(1, '#a7a7a7'), right: side(0, '#000000'), bottom: side(1, '#a7a7a7'), left: side(0, '#000000'), isUniform: false };

describe('variable-backed overlay border', () => {
  it('the ::after body reads the three variables and keeps the layer geometry', () => {
    const body = formatBorderAfterCSSVars();
    expect(body).toContain('position: absolute;');
    expect(body).toContain('inset: 0;');
    expect(body).toContain('pointer-events: none;');
    expect(body).toContain('border-width: var(--rvb-bw);');
    expect(body).toContain('border-style: var(--rvb-bs);');
    expect(body).toContain('border-color: var(--rvb-bc);');
    expect(isVarBackedBorderAfterBody(body)).toBe(true);
    expect(isVarBackedBorderAfterBody("border-width: 61px;")).toBe(false);
  });
  it('state ↔ vars round-trips through the literal parser (uniform + per-side)', () => {
    for (const st of [uniform, mixed]) {
      const vars = borderStateToOverlayVars(st);
      const literal = resolveBorderAfterBodyVars(formatBorderAfterCSSVars(), (n) => vars[n]);
      const parsed = parseBorderAfterCSS(literal)!;
      expect(parsed.isUniform).toBe(st.isUniform);
      expect(parsed.top.width).toBe(st.top.width);
      expect(parsed.right.width).toBe(st.right.width);
      expect(parsed.top.color.toLowerCase()).toBe(st.top.color);
    }
    expect(borderStateToOverlayVars(mixed)['--rvb-bw']).toBe('1px 0px 1px 0px');
  });
  it('cleared vars delete all three', () => {
    expect(clearedOverlayVars()).toEqual({ '--rvb-bw': '', '--rvb-bs': '', '--rvb-bc': '' });
  });
});

describe('a border on ONE variant only (user report 2026-10-15)', () => {
  const black1: BorderState = { top: side(1, '#000000'), right: side(1, '#000000'), bottom: side(1, '#000000'), left: side(1, '#000000'), isUniform: true };

  it('the primary\'s "no border" keeps style + colour at 0px, so the width still eases', () => {
    expect(zeroWidthOverlayVars(black1)).toEqual({ '--rvb-bw': '0px', '--rvb-bs': 'solid', '--rvb-bc': '#000000' });
    expect(zeroWidthOverlayVars(mixed)['--rvb-bw']).toBe('0px 0px 0px 0px');
  });

  it('overlayWidthVisible: any side above 0', () => {
    expect(overlayWidthVisible('11px')).toBe(true);
    expect(overlayWidthVisible('0px 0px 1px 0px')).toBe(true);
    expect(overlayWidthVisible('0px')).toBe(false);
    expect(overlayWidthVisible('0px 0px 0px 0px')).toBe(false);
    expect(overlayWidthVisible(undefined)).toBe(false);
  });

  describe('planOverlayVarRemoval', () => {
    const hoverOnly = {
      default: { backgroundColor: '#ffdfba', '--rvb-bw': '0px', '--rvb-bs': 'solid', '--rvb-bc': '#000000' },
      'default-hover': { backgroundColor: '#422e17', '--rvb-bw': '11px', '--rvb-bs': 'solid', '--rvb-bc': '#000000' },
    };
    it('× on the primary while the hover has its own border: zero the primary, keep the rule', () => {
      expect(planOverlayVarRemoval({ variants: hoverOnly, baseWidth: '1px', tileVariant: null })).toEqual({ kind: 'zero-primary' });
    });
    it('× on the primary with no variant border left: remove everything, every entry cleared', () => {
      const plan = planOverlayVarRemoval({
        variants: { default: hoverOnly.default, 'default-hover': { backgroundColor: '#422e17' } }, baseWidth: '1px', tileVariant: null,
      });
      expect(plan).toEqual({ kind: 'remove-all', clearVariants: ['default'] });
    });
    it('× on a variant the primary\'s border shows through: a zero-width override on that variant', () => {
      // The reported file: primary 24px, hover its own 16px, `variant-2` no entry at all.
      const reported = {
        default: { '--rvb-bw': '24px', '--rvb-bs': 'solid', '--rvb-bc': '#000000' },
        'default-hover': { '--rvb-bw': '16px', '--rvb-bs': 'solid', '--rvb-bc': '#000000' },
      };
      expect(planOverlayVarRemoval({ variants: reported, baseWidth: '24px', tileVariant: 'variant-2' })).toEqual({ kind: 'zero-variant' });
      expect(planOverlayVarRemoval({ variants: reported, baseWidth: '24px', tileVariant: 'default-hover' })).toEqual({ kind: 'zero-variant' });
    });
    it('× on a variant while the primary has none but another variant has one: inherit the primary\'s none', () => {
      const two = { ...hoverOnly, 'variant-2': { '--rvb-bw': '4px', '--rvb-bs': 'solid', '--rvb-bc': '#000000' } };
      expect(planOverlayVarRemoval({ variants: two, baseWidth: '0px', tileVariant: 'default-hover' })).toEqual({ kind: 'inherit' });
    });
    it('× on the hover when it held the only border: nothing visible is left → remove everything', () => {
      expect(planOverlayVarRemoval({ variants: hoverOnly, baseWidth: '0px', tileVariant: 'default-hover' }))
        .toEqual({ kind: 'remove-all', clearVariants: ['default', 'default-hover'] });
    });
    it('the primary\'s mirrored default entry never counts as a variant\'s own border', () => {
      const seeded = { default: { '--rvb-bw': '3px' }, 'default-hover': { backgroundColor: '#000' } };
      expect(planOverlayVarRemoval({ variants: seeded, baseWidth: '3px', tileVariant: null }).kind).toBe('remove-all');
    });
  });

  // The reported component, before any border. Replays the writes BorderControl
  // now queues through the REAL generators: add on the hover tile, widen it,
  // then × on the primary.
  const BEFORE = `'use client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';
const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Frame - Hover', x: 0, y: 141, interactionType: 'hover', parentVariant: 'default' },
];
const frameVariants = {
  default: { backgroundColor: '#ffdfba' },
  'default-hover': { backgroundColor: '#422e17' },
};
export default function MaKaRo({ style }: { style?: React.CSSProperties }) {
  const [variant] = useState('default');
  return (
    <motion.div data-id="frame" variants={frameVariants} style={{
      position: 'absolute',
      width: '193px',
      height: '94px',
      backgroundColor: '#ffdfba',
      overflow: 'hidden', ...style}} initial={['default', variant]} animate={['default', variant]}></motion.div>
  );
}
`;
  const node = (code: string) => parseJSXToNodes(code).get('frame')!;

  it('adding on the hover leaves the primary at 0px; × on the primary keeps the hover\'s border', () => {
    // 1. first var-backed write on the HOVER tile (no base border existed)
    let code = updateBorderOverlayStyle(BEFORE, 'frame', formatBorderAfterCSSVars());
    code = updateNodeInCode(code, 'frame', zeroWidthOverlayVars(black1));
    code = updateVariantStyleInCode(code, 'frame', 'default-hover', borderStateToOverlayVars(black1));
    // 2. widen the hover to 11px
    code = updateVariantStyleInCode(code, 'frame', 'default-hover', { '--rvb-bw': '11px' });
    let n = node(code);
    expect(n.styles['--rvb-bw']).toBe('0px');
    expect(n.motionVariants?.['default-hover']?.['--rvb-bw']).toBe('11px');
    expect(n.motionVariants?.default?.['--rvb-bw'] ?? '0px').toBe('0px');   // the animate-back seed is "no border"

    // 3. the primary gets its own 1px border, then × on the primary
    code = updateNodeInCode(code, 'frame', borderStateToOverlayVars(black1));
    expect((code.match(/'--rvb-bw'/g) ?? []).length).toBeLessThanOrEqual(3);   // updated in place, never appended twice
    n = node(code);
    const plan = planOverlayVarRemoval({ variants: n.motionVariants, baseWidth: n.styles['--rvb-bw'], tileVariant: null });
    expect(plan.kind).toBe('zero-primary');
    code = updateNodeInCode(code, 'frame', zeroWidthOverlayVars(black1));
    n = node(code);
    expect(n.styles['--rvb-bw']).toBe('0px');
    expect(n.motionVariants?.['default-hover']?.['--rvb-bw']).toBe('11px');
    expect(extractBorderAfterRuleBody(extractStyleCSS(code), 'frame')).toContain('var(--rvb-bw)');   // the shared rule survives
  });

  // The reported file (2026-10-15): primary 24px, hover its own 16px, a second
  // top-level variant with no entry at all. × on that variant did nothing.
  const ZAZARE = `'use client';
import React, { useState } from 'react';
import { motion } from 'framer-motion';
const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Frame - Hover', x: 0, y: 191, interactionType: 'hover', parentVariant: 'default' },
  { name: 'variant-2', label: 'Frame', x: 183, y: 0 },
];
const frameVariants = {
  default: { '--rvb-bw': '24px', '--rvb-bs': 'solid', '--rvb-bc': '#000000', padding: '0px',},
  'default-hover': { '--rvb-bw': '16px', '--rvb-bs': 'solid', '--rvb-bc': '#000000', display: 'flex', padding: '21px',},
};
export default function ZaZaRe({ style }: { style?: React.CSSProperties }) {
  const [variant] = useState('default');
  return (
    <motion.div data-id="frame" variants={frameVariants} style={{
          position: 'absolute',
          width: '122px',
          backgroundColor: '#97cffc',
          overflow: 'hidden'
        , '--rvb-bw': '24px', '--rvb-bs': 'solid', '--rvb-bc': '#000000', ...style}} initial={['default', variant]} animate={['default', variant]}>
  <style>{\`
    [data-id="frame"]::after {
${formatBorderAfterCSSVars()}
    }
  \`}</style></motion.div>
  );
}
`;

  it('× on a variant with no entry overrides it with no border; Reset Override brings the primary\'s back', () => {
    const black24: BorderState = { top: side(24, '#000000'), right: side(24, '#000000'), bottom: side(24, '#000000'), left: side(24, '#000000'), isUniform: true };
    let n = node(ZAZARE);
    const plan = planOverlayVarRemoval({ variants: n.motionVariants, baseWidth: n.styles['--rvb-bw'], tileVariant: 'variant-2' });
    expect(plan.kind).toBe('zero-variant');
    let code = updateVariantStyleInCode(ZAZARE, 'frame', 'variant-2', zeroWidthOverlayVars(black24));
    n = node(code);
    expect(n.motionVariants?.['variant-2']?.['--rvb-bw']).toBe('0px');   // its own entry → the purple override
    expect(n.styles['--rvb-bw']).toBe('24px');                            // primary untouched
    expect(n.motionVariants?.['default-hover']?.['--rvb-bw']).toBe('16px');
    expect(extractBorderAfterRuleBody(extractStyleCSS(code), 'frame')).toContain('var(--rvb-bw)');
    // Reset Override: the generic reset clears the border alias keys (--rvb-* included) in the entry.
    code = updateVariantStyleInCode(code, 'frame', 'variant-2', clearedOverlayVars());
    expect(node(code).motionVariants?.['variant-2']?.['--rvb-bw']).toBeUndefined();
  });
});

