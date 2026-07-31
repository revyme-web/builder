import { describe, it, expect } from 'vitest';
import { updateScrollDirectionAnimInCode } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';

const PAGE = `import { motion } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root">
      <motion.div data-id="box" style={{ opacity: 1 }}></motion.div>
    </div>
  );
}`;
const cfg = (e: any) => ({ nodeId: 'box', toProps: { opacity: '0', rotate: '90' }, direction: 'down' as const, replay: true, ...e });

describe('direction-triggered On Scroll gen', () => {
  it('emits useState + useScroll().scrollY + useMotionValueEvent + animate ternary', () => {
    const out = updateScrollDirectionAnimInCode(PAGE, cfg({}));
    expect(out).toContain('const [boxScrolled, setBoxScrolled] = useState(false);');
    expect(out).toContain('const { scrollY: boxScrollY } = useScroll();');
    expect(out).toContain('useMotionValueEvent(boxScrollY, "change", (y) =>');
    expect(out).toContain('animate={boxScrolled ? { opacity: 0, rotate: 90 } : { opacity: 1, rotate: 0 }}');
    expect(out).not.toContain('useTransform');     // NOT scrubbed
    expect(parseJSX(out)).not.toBeNull();          // valid JSX
  });
  it('direction down: scroll down triggers, scroll up reverts (replay)', () => {
    const out = updateScrollDirectionAnimInCode(PAGE, cfg({ direction: 'down', replay: true }));
    expect(out).toContain('if (y > prev) setBoxScrolled(true);');
    expect(out).toContain('if (y < prev) setBoxScrolled(false);');
  });
  it('direction up: scroll up triggers', () => {
    const out = updateScrollDirectionAnimInCode(PAGE, cfg({ direction: 'up', replay: true }));
    expect(out).toContain('if (y < prev) setBoxScrolled(true);');
    expect(out).toContain('if (y > prev) setBoxScrolled(false);');
  });
  it('replay no: no revert', () => {
    const out = updateScrollDirectionAnimInCode(PAGE, cfg({ direction: 'down', replay: false }));
    expect(out).toContain('if (y > prev) setBoxScrolled(true);');
    expect(out).not.toContain('setBoxScrolled(false)');
  });
  it('re-gen does not duplicate', () => {
    let out = updateScrollDirectionAnimInCode(PAGE, cfg({ direction: 'down' }));
    out = updateScrollDirectionAnimInCode(out, cfg({ direction: 'up' }));
    expect((out.match(/const \[boxScrolled/g) || []).length).toBe(1);
    expect((out.match(/scrollY: boxScrollY/g) || []).length).toBe(1);
  });
});

describe('preset To props produce valid animate ternaries', () => {
  it('slide out top (negative y) + flip (rotateY)', () => {
    const a = updateScrollDirectionAnimInCode(PAGE, cfg({ toProps: { opacity: '0', y: '-100' } }));
    expect(a).toContain('animate={boxScrolled ? { opacity: 0, y: -100 } : { opacity: 1, y: 0 }}');
    expect(parseJSX(a)).not.toBeNull();
    const b = updateScrollDirectionAnimInCode(PAGE, cfg({ toProps: { opacity: '0', rotateY: '90' } }));
    expect(b).toContain('animate={boxScrolled ? { opacity: 0, rotateY: 90 } : { opacity: 1, rotateY: 0 }}');
    expect(parseJSX(b)).not.toBeNull();
  });
});
