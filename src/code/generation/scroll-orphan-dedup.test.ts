import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { updateScrollAnimInCode, type ScrollAnimConfig } from './generator-motion';

// Regression for: "Identifier 'tlHero_3dRotate' has already been declared."
// when updating a scroll transform.
//
// An ORPHANED scroll-transform hook — declared in module scope but no longer
// bound in the JSX because its binding was overwritten with a static value
// (`rotate: "16"`) — is invisible to the binding-based removal in
// updateScrollAnimInCode (which only collects vars still USED in the JSX).
// Re-adding the same property then emitted a SECOND `const heroCubeRotate`,
// a duplicate lexical declaration that fails to parse. The orphan-sweep before
// the hook insert removes any prior declaration of the exact vars being added.

const ORPHAN_CODE = `import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: heroCubeProgress } = useScroll();
  const heroCubeSmooth = useSpring(heroCubeProgress, { duration: 0.5, bounce: 0.25 });
  const heroCubeRotate = useTransform(heroCubeSmooth, [0, 1], [-91, -72]);
  const heroCubeRotateX = useTransform(heroCubeSmooth, [0, 1], [38, 0]);
  const heroCubeOpacity = useTransform(heroCubeSmooth, [0, 1], [0.82, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="hero-cube" style={{ rotate: "16", rotateX: heroCubeRotateX, opacity: heroCubeOpacity }} />
    </div>
  );
}`;

describe('updateScrollAnimInCode — orphaned hook dedup', () => {
  const config: ScrollAnimConfig = {
    nodeId: 'hero-cube',
    trigger: 'onScroll',
    stops: [
      { progress: 0, props: { rotate: '115', rotateX: '38', opacity: '0.82' } },
      { progress: 1, props: { rotate: '0', rotateX: '0', opacity: '1' } },
    ],
  };

  it('emits exactly one declaration of the re-added (orphaned) transform var', () => {
    const result = updateScrollAnimInCode(ORPHAN_CODE, config);
    const decls = result.match(/const heroCubeRotate\s*=\s*useTransform/g) || [];
    expect(decls.length).toBe(1);
  });

  it('does not duplicate the sibling RotateX var', () => {
    const result = updateScrollAnimInCode(ORPHAN_CODE, config);
    const declsX = result.match(/const heroCubeRotateX\s*=\s*useTransform/g) || [];
    expect(declsX.length).toBe(1);
  });

  it('keeps the new value and drops the stale orphan value', () => {
    const result = updateScrollAnimInCode(ORPHAN_CODE, config);
    expect(result).toContain('[115, 0]');
    expect(result).not.toContain('[-91, -72]');
  });

  it('produces parseable code (reproduces the "already been declared" error)', () => {
    const result = updateScrollAnimInCode(ORPHAN_CODE, config);
    expect(() => parse(result, { sourceType: 'module', plugins: ['jsx'] })).not.toThrow();
  });
});
