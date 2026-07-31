import { describe, it, expect } from 'vitest';
import {
  updateScrollSpeedInCode, updateScrollDirectionAnimInCode, updateScrollAnimInCode,
} from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
import { parseScrollSpeed, parseScrollDirection, parseScrollHooks, getScrollDataForNode } from '@/code/parsing/scroll-parser';

const PAGE = `import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root"><motion.div data-id="box" style={{ opacity: 1, left: '10px' }}></motion.div></div>);
}`;

// Apply all three scroll effects to one node and assert each survives the others.
function applyAll(code: string): string {
  let out = updateScrollSpeedInCode(code, { nodeId: 'box', speed: 110 });
  out = updateScrollAnimInCode(out, {                       // scrubbed Transform
    nodeId: 'box', trigger: 'layerInView',
    stops: [{ progress: 0, props: { scale: '0.5' } }, { progress: 1, props: { scale: '1' } }],
    transition: { type: 'spring', duration: '0.5', bounce: '0.25' },
  });
  out = updateScrollDirectionAnimInCode(out, {              // discrete Animation
    nodeId: 'box', toProps: { opacity: '0', rotate: '66' }, direction: 'down', replay: true,
  });
  return out;
}

describe('Scroll Speed + Transform + Animation all coexist on one node', () => {
  it('all three present after stacking, valid JSX', () => {
    const out = applyAll(PAGE);
    expect(parseScrollSpeed(out, 'box')).toBe(110);          // Speed
    expect(parseScrollDirection(out, 'box')).not.toBeNull(); // Animation (direction)
    const scrub = getScrollDataForNode(parseScrollHooks(out), 'box');
    expect(scrub.bindings.length).toBeGreaterThan(0);        // Transform (scrubbed)
    expect(parseJSX(out)).not.toBeNull();
  });

  it('re-editing the Animation keeps Speed + Transform', () => {
    let out = applyAll(PAGE);
    out = updateScrollDirectionAnimInCode(out, { nodeId: 'box', toProps: { opacity: '0.3' }, direction: 'up', replay: false });
    expect(parseScrollSpeed(out, 'box')).toBe(110);
    expect(getScrollDataForNode(parseScrollHooks(out), 'box').bindings.length).toBeGreaterThan(0);
    expect(parseJSX(out)).not.toBeNull();
  });

  it('re-editing the Transform keeps Speed + Animation', () => {
    let out = applyAll(PAGE);
    out = updateScrollAnimInCode(out, {
      nodeId: 'box', trigger: 'layerInView',
      stops: [{ progress: 0, props: { scale: '0.8' } }, { progress: 1, props: { scale: '1' } }],
      transition: { type: 'spring', duration: '0.5', bounce: '0.25' },
    });
    expect(parseScrollSpeed(out, 'box')).toBe(110);
    expect(parseScrollDirection(out, 'box')).not.toBeNull();
    expect(parseJSX(out)).not.toBeNull();
  });

  it('re-editing the Speed keeps Transform + Animation', () => {
    let out = applyAll(PAGE);
    out = updateScrollSpeedInCode(out, { nodeId: 'box', speed: 200 });
    expect(parseScrollSpeed(out, 'box')).toBe(200);
    expect(parseScrollDirection(out, 'box')).not.toBeNull();
    expect(getScrollDataForNode(parseScrollHooks(out), 'box').bindings.length).toBeGreaterThan(0);
    expect(parseJSX(out)).not.toBeNull();
  });
});

describe('Scroll Speed must not corrupt a sibling opacity binding', () => {
  it('adding Speed after a Transform keeps `opacity:` intact (not `opacit`)', () => {
    // Scroll Transform first → style has opacity + scale motion bindings.
    let out = updateScrollAnimInCode(PAGE, {
      nodeId: 'box', trigger: 'layerInView',
      stops: [{ progress: 0, props: { opacity: '0.5', scale: '0.5' } },
              { progress: 1, props: { opacity: '1', scale: '1' } }],
      transition: { type: 'spring', duration: '0.5', bounce: '0.25' },
    });
    expect(out).toMatch(/opacity:\s*\w+Opacity/);
    // Now Scroll Speed injects a `y:` binding — must NOT clip `opacity:`.
    out = updateScrollSpeedInCode(out, { nodeId: 'box', speed: 670 });
    expect(out).not.toContain('opacit,');       // the corruption signature
    expect(out).not.toContain('opacit}');
    expect(out).toMatch(/opacity:\s*\w+Opacity/); // binding still whole
    expect(out).toMatch(/y:\s*\w+SpeedY/);        // speed binding added
    expect(parseScrollSpeed(out, 'box')).toBe(670);
    expect(parseJSX(out)).not.toBeNull();
  });
});
