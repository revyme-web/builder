import { describe, it, expect } from 'vitest';
import { updateScrollSpeedInCode, removeScrollSpeedFromCode } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

const PAGE = `import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root"><motion.div data-id="box" style={{ opacity: 1, left: '10px' }}></motion.div></div>);
}`;

// Plain (non-motion) frame — the real-world bug: opening tag became
// <motion.div> but the closing </div> was left, breaking the JSX.
const PLAIN = `export default function Page() {
  return (
    <div data-id="root">
      <div data-id="box" data-name="Frame" style={{ position: 'absolute', left: '535px', top: '107px' }}></div>
    </div>
  );
}`;

describe('Scroll Speed on a plain <div> rewrites BOTH tags to motion.*', () => {
  it('opening AND matching closing tag become motion.div (valid JSX)', () => {
    const out = updateScrollSpeedInCode(PLAIN, { nodeId: 'box', speed: 110 });
    expect(out).toContain('<motion.div data-id="box"');
    expect(out).toContain('</motion.div>');
    expect(out).toContain('y: boxSpeedY');
    expect(parseJSX(out)).not.toBeNull();   // would throw on the mismatched-tag bug
  });
});

describe('Scroll Speed (parallax) gen', () => {
  it('emits useScroll().scrollY + useTransform y multiplier + style y binding', () => {
    const out = updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 110 });
    expect(out).toContain('const { scrollY: boxSpeedScroll } = useScroll();');
    expect(out).toContain('const boxSpeedY = useTransform(boxSpeedScroll, (v) => v * (1 - 110 / 100));');
    expect(out).toContain('y: boxSpeedY');
    expect(out).toContain('left: \'10px\'');   // existing style preserved
    expect(parseJSX(out)).not.toBeNull();
  });
  it('re-gen does not duplicate', () => {
    let out = updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 110 });
    out = updateScrollSpeedInCode(out, { nodeId: 'box', speed: 40 });
    expect((out.match(/boxSpeedY = useTransform/g) || []).length).toBe(1);
    expect((out.match(/y: boxSpeedY/g) || []).length).toBe(1);
    expect(out).toContain('v * (1 - 40 / 100)');
  });
  it('remove clears hooks + binding', () => {
    let out = updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 110 });
    out = removeScrollSpeedFromCode(out, 'box');
    expect(out).not.toContain('boxSpeed');
    expect(parseJSX(out)).not.toBeNull();
  });
});

import { parseScrollSpeed, parseScrollHooks, getScrollDataForNode } from '@/code/parsing/scroll-parser';
describe('Scroll Speed is NOT detected as a scroll-transform', () => {
  it('getScrollDataForNode ignores the SpeedY parallax binding', () => {
    const out = updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 110 });
    const data = getScrollDataForNode(parseScrollHooks(out), 'box');
    expect(data.bindings.length).toBe(0);  // no phantom "Scroll" entry
    expect(parseScrollSpeed(out, 'box')).toBe(110);
  });
});
describe('Scroll Speed round-trip (parse from code)', () => {
  it('gen → parse reads the % back', () => {
    expect(parseScrollSpeed(updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 140 }), 'box')).toBe(140);
    expect(parseScrollSpeed(updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 40 }), 'box')).toBe(40);
    expect(parseScrollSpeed(PAGE, 'box')).toBeNull();
  });
});

import { updateScrollDirectionAnimInCode } from './generator-motion';
describe('Scroll Speed survives a Scroll Animation edit (coexistence)', () => {
  it('editing the direction-triggered scroll keeps the SpeedY style binding', () => {
    let out = updateScrollSpeedInCode(PAGE, { nodeId: 'box', speed: 960 });
    // Now add/edit a direction-triggered scroll animation on the SAME node.
    out = updateScrollDirectionAnimInCode(out, {
      nodeId: 'box', toProps: { opacity: '0.77', rotate: '66' },
      direction: 'down', replay: true,
    });
    expect(out).toContain('y: boxSpeedY');                 // parallax binding intact
    expect(out).toContain('boxSpeedY = useTransform');     // hook intact
    expect(out).toContain('boxScrolled ?');                // scroll anim present
    // Re-editing the scroll anim again must STILL keep speed.
    out = updateScrollDirectionAnimInCode(out, {
      nodeId: 'box', toProps: { opacity: '0.5', rotate: '66', rotateX: '45' },
      direction: 'down', replay: true,
    });
    expect(out).toContain('y: boxSpeedY');
    expect(parseScrollSpeed(out, 'box')).toBe(960);
    expect(parseJSX(out)).not.toBeNull();
  });
});
