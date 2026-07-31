import { describe, it, expect } from 'vitest';
import { forwardEventPropsToComponentRoot, forwardsEventProps } from './event-prop-forwarding';

const COMPONENT = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Button" */

const variantConfig = [
  { name: 'default', label: 'Button', x: 0, y: 0, isPrimary: true },
];

function JiPoZa({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="root-abc" data-name="Button" initial={initialVariant} style={{ position: 'absolute', ...style }}>
      <motion.span layout={true} data-id="label-abc">Open</motion.span>
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(JiPoZa);
`;

describe('event-prop-forwarding', () => {
  it('adds ...rest to the signature and spreads it on the root motion element', () => {
    const out = forwardEventPropsToComponentRoot(COMPONENT);
    expect(forwardsEventProps(out)).toBe(true);
    // Signature excludes data-id/data-name and gathers ...rest.
    expect(out).toMatch(/function JiPoZa\(\{ style, initialVariant = 'default', 'data-id': _dataId, 'data-name': _dataName, \.\.\.rest \}/);
    // Type loosened so the forwarded keys type-check.
    expect(out).toContain('[key: string]: unknown');
    // {...rest} spread on the ROOT motion element, BEFORE its own props so
    // the root's explicit props win.
    expect(out).toContain('<motion.div {...rest} layout={true} data-id="root-abc"');
    // Not spread on the nested span.
    expect(out).toContain('<motion.span layout={true} data-id="label-abc"');
  });

  it('is idempotent — already-forwarding code is unchanged', () => {
    const once = forwardEventPropsToComponentRoot(COMPONENT);
    const twice = forwardEventPropsToComponentRoot(once);
    expect(twice).toBe(once);
  });

  it('handles a signature with no type annotation', () => {
    const untyped = COMPONENT.replace(
      "function JiPoZa({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string })",
      "function JiPoZa({ style, initialVariant = 'default' })",
    );
    const out = forwardEventPropsToComponentRoot(untyped);
    expect(forwardsEventProps(out)).toBe(true);
    expect(out).toMatch(/function JiPoZa\(\{ style, initialVariant = 'default', 'data-id': _dataId, 'data-name': _dataName, \.\.\.rest \}\)/);
    expect(out).toContain('<motion.div {...rest} layout={true}');
  });

  it('returns input unchanged when there is no recognizable signature', () => {
    const weird = `export const Foo = () => <div />;`;
    expect(forwardEventPropsToComponentRoot(weird)).toBe(weird);
  });

  it('the root spread comes before any onTap the root already declares', () => {
    // A component with its OWN root connection should keep its own onTap
    // winning (later attribute wins in JSX) — {...rest} is spread first.
    const withOwn = COMPONENT.replace(
      '<motion.div layout={true} data-id="root-abc"',
      '<motion.div layout={true} onTap={() => setVariant(\'x\')} data-id="root-abc"',
    );
    const out = forwardEventPropsToComponentRoot(withOwn);
    const restIdx = out.indexOf('{...rest}');
    const ownIdx = out.indexOf("onTap={() => setVariant('x')}");
    expect(restIdx).toBeGreaterThan(0);
    expect(ownIdx).toBeGreaterThan(restIdx);
  });
});
