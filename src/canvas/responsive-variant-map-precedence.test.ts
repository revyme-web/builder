// responsive-variant-map-precedence.test.ts — a per-tile variant in responsiveVariantMap[vpWidth] must
// WIN over the instance's BASE variant (passed as `variantName`) on a page replica. Otherwise a
// per-viewport variant VARIABLE (`initialVariant={__mqN ? var : base}`) whose base resolves to a
// concrete variant (e.g. 'default') never switches the tile — it just shows the base everywhere.
import { describe, it, expect } from 'vitest';
import { resolveVariantStyles } from './Renderer';

describe('responsiveVariantMap[vpWidth] precedence over base variantName (page replica)', () => {
  const node: any = {
    id: 'btn',
    styles: { backgroundColor: 'red' },
    motionVariants: { default: { backgroundColor: 'red' }, 'variant-2': { backgroundColor: 'green' } },
    responsiveVariantMap: { 768: 'variant-2' },
  };

  it('tablet (768) → the per-viewport variant, even when base variantName = default', () => {
    expect(resolveVariantStyles(node, 'default', 768).backgroundColor).toBe('green');
  });

  it('desktop (1440, not in the map) → the base variant', () => {
    expect(resolveVariantStyles(node, 'default', 1440).backgroundColor).toBe('red');
  });

  it('a component-master viewport (no responsiveVariantMap) is unaffected — variantName wins', () => {
    const master: any = { id: 'm', styles: { backgroundColor: 'red' }, motionVariants: { default: { backgroundColor: 'red' }, 'variant-1': { backgroundColor: 'blue' } } };
    expect(resolveVariantStyles(master, 'variant-1', 768).backgroundColor).toBe('blue');
  });
});

// The instance-wrapper height/width copy (Renderer patchElement + buildNodeElement)
// must read the ROOT's VARIANT-RESOLVED styles, not its base `styles`. A per-viewport
// variant replica whose conditional height differs
// (`height: variant === 'variant-2' ? '293px' : '117px'`) lives on the root's
// conditionalStyles; the root's own height is skipped for a component-root-in-instance,
// so the wrapper is the only place the resolved size can land. Reading base gave every
// tile the default (117px) → squished rows on tablet (live find 2026-07-03). This locks
// in that resolveVariantStyles — what the wrapper now reads — resolves conditional
// dimensions per per-viewport variant.
describe('conditional height resolves per per-viewport variant (instance-wrapper sizing)', () => {
  const row: any = {
    id: 'service-1:service-1',
    styles: { height: '117px', width: '1180px', flexDirection: 'row' },
    conditionalStyles: {
      height: { 'variant-2': '293px', default: '117px' },
      flexDirection: { 'variant-2': 'column', default: 'row' },
      width: { 'variant-2': '399px', default: '1180px' },
    },
    responsiveVariantMap: { 768: 'variant-2' },
  };

  it('tablet (768, variant-2) → the taller conditional height + column', () => {
    const r = resolveVariantStyles(row, null, 768);
    expect(r.height).toBe('293px');
    expect(r.flexDirection).toBe('column');
  });

  it('desktop (1440, no map entry) → the default conditional height + row', () => {
    const r = resolveVariantStyles(row, null, 1440);
    expect(r.height).toBe('117px');
    expect(r.flexDirection).toBe('row');
  });
});
