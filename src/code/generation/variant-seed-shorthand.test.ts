// variant-seed-shorthand.test.ts — the animate-back seed must never destroy the
// default entry it is seeding into.
//
// User report 2026-08-08: nudging the TABLET variant's padding-bottom 32 → 42
// collapsed the section on every tile. The Padding control sends the whole box
// (`padding: '' ` to drop the shorthand + the four sides), and `padding` — being
// absent from the inline style — resolved to its CSS initial `0px` and was
// APPENDED to the `default` entry, behind `paddingTop: '90px'`. Last key wins,
// so the primary lost all its padding; and because `animate={['default', …]}`
// makes the default entry always-on, every variant lost it too.

import { describe, it, expect } from 'vitest';
import { updateVariantStyleInCode, healSparseVariantDefaults, healStrandedVariantShorthands } from './generator-styles';

const footer = () => `const variantConfig = [
  { name: 'default', label: 'Footer', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'tablet', x: 1640, y: 0 },
];
const frameMsk6imqi8Variants = {
  default: { paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px',},
  'variant-1': { paddingTop: '32px', paddingRight: '16px', paddingBottom: '32px', paddingLeft: '16px',},
};
function GoNeZa({ style, initialVariant = 'default', ...rest }) {
  return <motion.div data-id="root" {...rest}>
    <motion.div data-id="frame-msk6imqi-8" variants={frameMsk6imqi8Variants} initial={['default', initialVariant]} animate={['default', initialVariant]} data-name="top" style={{
      position: 'relative', width: '100%', height: 'min-content', display: 'flex',
      paddingRight: '0px', paddingTop: '80px', paddingBottom: '80px'
    }}>x</motion.div>
  </motion.div>;
}`;

/** The exact payload the Padding control emits: drop the shorthand, state all four sides. */
const paddingWrite = { padding: '', paddingTop: '32px', paddingRight: '16px', paddingBottom: '42px', paddingLeft: '16px' };

describe('updateVariantStyleInCode — padding on a variant', () => {
  it('writes the tablet value without touching the default entry', () => {
    const out = updateVariantStyleInCode(footer(), 'frame-msk6imqi-8', 'variant-1', paddingWrite);
    expect(out).toContain("paddingBottom: '42px'");
    // The default entry keeps its own padding, unchanged and un-nullified.
    const def = /default:\s*\{([^}]*)\}/.exec(out)![1];
    expect(def).toContain("paddingTop: '90px'");
    expect(def).toContain("paddingBottom: '80px'");
    expect(def).not.toMatch(/(?:^|[,{\s])padding\s*:/);
  });

  it('never seeds a shorthand behind the longhands it would nullify', () => {
    const out = updateVariantStyleInCode(footer(), 'frame-msk6imqi-8', 'variant-1', paddingWrite);
    const def = /default:\s*\{([^}]*)\}/.exec(out)![1];
    const padIdx = def.search(/(?:^|[,{\s])padding\s*:/);
    // Either absent (the fix) or — if some future path does seed it — ahead of
    // the sides. Never behind them.
    if (padIdx !== -1) expect(padIdx).toBeLessThan(def.indexOf('paddingTop'));
  });

  it('a prop being REMOVED gets no animate-back seed', () => {
    // `gap: ''` alone — nothing is being set, so nothing needs a return value.
    const out = updateVariantStyleInCode(footer(), 'frame-msk6imqi-8', 'variant-1', { gap: '' });
    const def = /default:\s*\{([^}]*)\}/.exec(out)![1];
    expect(def).not.toContain('gap');
  });

  it('a genuinely new prop still gets its seed (the guard is not a blanket skip)', () => {
    const out = updateVariantStyleInCode(footer(), 'frame-msk6imqi-8', 'variant-1', { opacity: '0.5' });
    const def = /default:\s*\{([^}]*)\}/.exec(out)![1];
    expect(def).toContain('opacity');
  });
});

describe('healSparseVariantDefaults — same guard', () => {
  it('does not seed a shorthand into a default that states its longhands', () => {
    // A variant entry carrying `padding` while default carries the sides: the
    // file-wide healer must not "fix" that by nullifying the default.
    const code = footer().replace(
      "'variant-1': { paddingTop: '32px', paddingRight: '16px', paddingBottom: '32px', paddingLeft: '16px',}",
      "'variant-1': { padding: '16px' }",
    );
    const out = healSparseVariantDefaults(code);
    const def = /default:\s*\{([^}]*)\}/.exec(out)![1];
    expect(def).toContain("paddingTop: '90px'");
    expect(def).not.toMatch(/(?:^|[,{\s])padding\s*:/);
  });
});

describe('healStrandedVariantShorthands', () => {
  /** The exact corruption the seed produced in the user's Footer. */
  const corrupted = () => `const frameMsk6imqi8Variants = {
  default: { paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px', padding: '0px',},
  'variant-1': { paddingTop: '32px', paddingRight: '16px', paddingBottom: '42px', paddingLeft: '16px',},
};
function C({ initialVariant = 'default' }) {
  return <motion.div data-id="frame-msk6imqi-8" variants={frameMsk6imqi8Variants} animate={['default', initialVariant]}>x</motion.div>;
}`;

  it('drops the trailing shorthand and keeps every side value', () => {
    const out = healStrandedVariantShorthands(corrupted());
    const def = /default:\s*\{([^}]*)\}/.exec(out)![1];
    expect(def).not.toMatch(/(?:^|[,{\s])padding\s*:/);
    expect(def).toContain("paddingTop: '90px'");
    expect(def).toContain("paddingRight: '0px'");
    expect(def).toContain("paddingBottom: '80px'");
    expect(def).toContain("paddingLeft: '0px'");
    // The variant entry is untouched.
    expect(out).toContain("paddingBottom: '42px'");
  });

  it('leaves a correctly-ordered shorthand alone', () => {
    const ok = corrupted().replace(
      "{ paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px', padding: '0px',}",
      "{ padding: '0px', paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px',}",
    );
    expect(healStrandedVariantShorthands(ok)).toBe(ok);
  });

  it('leaves a shorthand-only entry alone', () => {
    const only = corrupted().replace(
      "{ paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px', padding: '0px',}",
      "{ padding: '0px',}",
    );
    expect(healStrandedVariantShorthands(only)).toBe(only);
  });

  it('is idempotent and a no-op on a file with no variants', () => {
    const once = healStrandedVariantShorthands(corrupted());
    expect(healStrandedVariantShorthands(once)).toBe(once);
    const plain = `function A() { return <div style={{ paddingTop: '4px', padding: '0px' }} />; }`;
    expect(healStrandedVariantShorthands(plain)).toBe(plain);
  });

  it('covers the other shorthands too', () => {
    const margins = corrupted().replace(
      "{ paddingTop: '90px', paddingRight: '0px', paddingBottom: '80px', paddingLeft: '0px', padding: '0px',}",
      "{ marginTop: '10px', margin: '0px',}",
    );
    const out = healStrandedVariantShorthands(margins);
    expect(out).toContain("marginTop: '10px'");
    expect(/default:\s*\{([^}]*)\}/.exec(out)![1]).not.toMatch(/(?:^|[,{\s])margin\s*:/);
  });
});
