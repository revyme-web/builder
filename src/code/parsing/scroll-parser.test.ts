import { describe, test, expect } from 'vitest';
import { parseScrollHooks, getScrollDataForNode, getMultiSectionForNode, parseRange } from './scroll-parser';

const AI_CODE_1 = `
export default function GalleryPage() {
  const sec1Ref = useRef(null);
  const { scrollYProgress: p1 } = useScroll({
    target: sec1Ref,
    offset: ["start end", "end start"],
  });
  const y1a = useSpring(useTransform(p1, [0, 1], [200, -200]), { stiffness: 50, damping: 20 });
  const y1b = useSpring(useTransform(p1, [0, 1], [-150, 250]), { stiffness: 50, damping: 20 });

  const sec2Ref = useRef(null);
  const { scrollYProgress: p2 } = useScroll({
    target: sec2Ref,
    offset: ["start end", "end start"],
  });
  const scale2 = useTransform(p2, [0, 0.5, 1], [0.8, 1, 0.8]);
  const opacity2 = useTransform(p2, [0, 0.3, 0.7, 1], [0.3, 1, 1, 0.3]);

  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div ref={sec1Ref} data-id="section1" style={{ height: '100vh' }}>
        <motion.img data-id="img1" style={{ y: y1a, position: 'absolute' }} />
        <motion.img data-id="img2" style={{ y: y1b, position: 'absolute' }} />
      </div>
      <div ref={sec2Ref} data-id="section2" style={{ height: '100vh' }}>
        <motion.div data-id="card1" style={{ scale: scale2, opacity: opacity2 }} />
      </div>
    </div>
  );
}`;

const AI_CODE_2 = `
export default function Page() {
  const { scrollYProgress } = useScroll();
  const progressSpring = useSpring(scrollYProgress, { stiffness: 80, damping: 20, restDelta: 0.001 });
  const heroRef = useRef(null);
  const { scrollYProgress: heroScroll } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const heroOpacity = useTransform(heroScroll, [0, 1], [1, 0]);
  const heroScale = useTransform(heroScroll, [0, 1], [1, 0.9]);
  const heroY = useTransform(heroScroll, [0, 1], ["0%", "40%"]);

  return (
    <div data-id="root">
      <motion.div style={{ scaleX: progressSpring }} data-id="progress-bar" />
      <motion.div ref={heroRef} data-id="hero" style={{
        opacity: heroOpacity, scale: heroScale, y: heroY
      }} />
    </div>
  );
}`;

describe('parseScrollHooks', () => {
  test('parses refs', () => {
    const data = parseScrollHooks(AI_CODE_1);
    expect(data.refs).toHaveLength(2);
    expect(data.refs[0].varName).toBe('sec1Ref');
    expect(data.refs[1].varName).toBe('sec2Ref');
  });

  test('parses scroll sources with target and offset', () => {
    const data = parseScrollHooks(AI_CODE_1);
    expect(data.sources).toHaveLength(2);
    expect(data.sources[0].progressVar).toBe('p1');
    expect(data.sources[0].refVar).toBe('sec1Ref');
    expect(data.sources[0].offset).toContain('start end');
  });

  test('parses useTransform with spring wrapping', () => {
    const data = parseScrollHooks(AI_CODE_1);
    const springTransforms = data.transforms.filter(t => t.isSpring);
    expect(springTransforms.length).toBeGreaterThanOrEqual(2);
    expect(springTransforms[0].varName).toBe('y1a');
    expect(springTransforms[0].sourceVar).toBe('p1');
    expect(springTransforms[0].isSpring).toBe(true);
  });

  test('parses plain useTransform (no spring)', () => {
    const data = parseScrollHooks(AI_CODE_1);
    const plain = data.transforms.filter(t => !t.isSpring && t.varName === 'scale2');
    expect(plain).toHaveLength(1);
    expect(plain[0].inputRange).toBe('[0, 0.5, 1]');
    expect(plain[0].outputRange).toBe('[0.8, 1, 0.8]');
  });

  test('parses multi-stop transform', () => {
    const data = parseScrollHooks(AI_CODE_1);
    const opacity = data.transforms.find(t => t.varName === 'opacity2');
    expect(opacity).toBeDefined();
    expect(opacity!.inputRange).toBe('[0, 0.3, 0.7, 1]');
    expect(opacity!.outputRange).toBe('[0.3, 1, 1, 0.3]');
  });

  test('parses style bindings', () => {
    const data = parseScrollHooks(AI_CODE_1);
    const img1Bindings = data.bindings.filter(b => b.nodeId === 'img1');
    expect(img1Bindings).toHaveLength(1);
    expect(img1Bindings[0].property).toBe('y');
    expect(img1Bindings[0].transformVar).toBe('y1a');

    const card1Bindings = data.bindings.filter(b => b.nodeId === 'card1');
    expect(card1Bindings).toHaveLength(2);
    expect(card1Bindings.map(b => b.property).sort()).toEqual(['opacity', 'scale']);
  });

  test('parses page-level scroll (no target)', () => {
    const data = parseScrollHooks(AI_CODE_2);
    const pageSource = data.sources.find(s => s.refVar === null);
    expect(pageSource).toBeDefined();
    expect(pageSource!.progressVar).toBe('scrollYProgress');
  });

  test('parses element-level scroll with target', () => {
    const data = parseScrollHooks(AI_CODE_2);
    const heroSource = data.sources.find(s => s.progressVar === 'heroScroll');
    expect(heroSource).toBeDefined();
    expect(heroSource!.refVar).toBe('heroRef');
  });

  test('parses string output ranges', () => {
    const data = parseScrollHooks(AI_CODE_2);
    const heroY = data.transforms.find(t => t.varName === 'heroY');
    expect(heroY).toBeDefined();
    expect(heroY!.outputRange).toContain('0%');
    expect(heroY!.outputRange).toContain('40%');
  });

  test('returns empty for code without useScroll', () => {
    const data = parseScrollHooks('export default function Page() { return <div>Hello</div>; }');
    expect(data.refs).toHaveLength(0);
    expect(data.sources).toHaveLength(0);
  });
});

describe('getScrollDataForNode', () => {
  test('returns transforms for a specific node', () => {
    const data = parseScrollHooks(AI_CODE_1);
    const cardData = getScrollDataForNode(data, 'card1');
    expect(cardData.bindings).toHaveLength(2);
    expect(cardData.transforms).toHaveLength(2);
    expect(cardData.source?.progressVar).toBe('p2');
  });

  test('returns empty for nodes without scroll', () => {
    const data = parseScrollHooks(AI_CODE_1);
    const rootData = getScrollDataForNode(data, 'root');
    expect(rootData.bindings).toHaveLength(0);
  });
});

// Multi-section pattern emitted by `updateMultiSectionScrollAnimInCode`. Two
// section milestones (Sec0Ref + Sec1Ref), page-level useScroll (no target),
// and a useTransform with input range [0, positions[0], positions[1], 1] and
// output range [from, s0, s1, s1].
const MULTI_SECTION_CODE = `
export default function Page() {
  const heroSec0Ref = useRef(null);
  const heroSec1Ref = useRef(null);
  const [heroSecPositions, setHeroSecPositions] = useState(() => Array(2).fill(0));
  useEffect(() => {
    heroSec0Ref.current = document.getElementById('about');
    heroSec1Ref.current = document.getElementById('contact');
    const compute = () => {
      const pageH = document.documentElement.scrollHeight - window.innerHeight;
      if (pageH <= 0) return;
      const offsetPx = window.innerHeight / 2;
      setHeroSecPositions([
        heroSec0Ref.current ? Math.max(0, Math.min(1, (heroSec0Ref.current.offsetTop - offsetPx) / pageH)) : 0,
        heroSec1Ref.current ? Math.max(0, Math.min(1, (heroSec1Ref.current.offsetTop - offsetPx) / pageH)) : 0
      ]);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);
  const { scrollYProgress: heroProgress } = useScroll();
  const heroOpacity = useTransform(heroProgress, [0, heroSecPositions[0], heroSecPositions[1], 1], [0, 0.5, 1, 1]);
  const heroRotate = useTransform(heroProgress, [0, heroSecPositions[0], heroSecPositions[1], 1], [0, 45, 90, 90]);
  return (
    <div data-id="hero" style={{ opacity: heroOpacity, rotate: heroRotate }} />
  );
}
`;

describe('parseScrollHooks – multi-section', () => {
  test('detects multi-section block with section ids + viewport', () => {
    const data = parseScrollHooks(MULTI_SECTION_CODE);
    expect(data.multiSection).toBeDefined();
    expect(data.multiSection).toHaveLength(1);
    const block = data.multiSection![0];
    expect(block.nodeId).toBe('hero');
    expect(block.sectionViewport).toBe('middle');
    expect(block.sections).toHaveLength(2);
    expect(block.sections[0].sectionId).toBe('about');
    expect(block.sections[1].sectionId).toBe('contact');
  });

  test('decodes fromProps + per-section values', () => {
    const data = parseScrollHooks(MULTI_SECTION_CODE);
    const block = getMultiSectionForNode(data, 'hero')!;
    expect(block.fromProps.opacity).toBe('0');
    expect(block.fromProps.rotate).toBe('0');
    expect(block.sections[0].props.opacity).toBe('0.5');
    expect(block.sections[0].props.rotate).toBe('45');
    expect(block.sections[1].props.opacity).toBe('1');
    expect(block.sections[1].props.rotate).toBe('90');
  });

  test('detects top viewport variant from offsetPx = 0', () => {
    const code = MULTI_SECTION_CODE.replace('const offsetPx = window.innerHeight / 2;', 'const offsetPx = 0;');
    const data = parseScrollHooks(code);
    expect(data.multiSection![0].sectionViewport).toBe('top');
  });

  test('detects bottom viewport variant from offsetPx = innerHeight', () => {
    const code = MULTI_SECTION_CODE.replace('const offsetPx = window.innerHeight / 2;', 'const offsetPx = window.innerHeight;');
    const data = parseScrollHooks(code);
    expect(data.multiSection![0].sectionViewport).toBe('bottom');
  });

  test('returns null when node has no multi-section block', () => {
    const data = parseScrollHooks(MULTI_SECTION_CODE);
    expect(getMultiSectionForNode(data, 'unknown')).toBeNull();
  });
});

// Regression: when a transform reads from a `useSpring` smoothed value
// (instead of straight scrollYProgress), the source-walk must follow the
// extra hop `Opacity → Smooth → Progress`. Earlier versions of
// `getScrollDataForNode` only did one step and returned source: null —
// causing the editor to fall back to "On Scroll" / "Instant" even when
// the source clearly said Layer in View + Spring.
const SMOOTHED_LAYER_CODE = `
export default function Page() {
  const boxRef = useRef(null);
  const { scrollYProgress: boxProgress } = useScroll({ target: boxRef, offset: ["start end", "end start"] });
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0, 1]);
  const boxY = useTransform(boxSmooth, [0, 1], [50, 0]);
  return (
    <motion.div ref={boxRef} data-id="box" style={{ opacity: boxOpacity, y: boxY }} />
  );
}
`;

// Regression: a prior multi-section run left an orphan `Sec2Ref` after the
// user removed section 2, and the parser counted it toward `sectionRefs.length`.
// That made the output-range length check fail (`values.length !==
// sectionRefs.length + 2`) and the whole multi-section block silently
// disappeared from the editor — trigger fell back to "On Scroll" even
// though the source clearly held a working Section-in-View block.
const ORPHAN_REF_CODE = `
export default function Page() {
  const heroSec2Ref = useRef(null);            // orphan from previous run
  const heroSec0Ref = useRef(null);
  const heroSec1Ref = useRef(null);
  const [heroSecPositions, setHeroSecPositions] = useState(() => Array(2).fill(0));
  useEffect(() => {
    heroSec0Ref.current = document.getElementById('a');
    heroSec1Ref.current = document.getElementById('b');
    const compute = () => {
      const pageH = document.documentElement.scrollHeight - window.innerHeight;
      if (pageH <= 0) return;
      const offsetPx = window.innerHeight / 2;
      setHeroSecPositions([0, 0]);
    };
    compute();
  }, []);
  const { scrollYProgress: heroProgress } = useScroll();
  const heroOpacity = useTransform(heroProgress, [0, heroSecPositions[0], heroSecPositions[1], 1], [0, 0.5, 1, 1]);
  return (
    <div data-id="hero" style={{ opacity: heroOpacity }} />
  );
}
`;

describe('parseScrollHooks – orphan refs', () => {
  test('ignores section refs without a getElementById binding', () => {
    const data = parseScrollHooks(ORPHAN_REF_CODE);
    expect(data.multiSection).toBeDefined();
    const block = data.multiSection![0];
    // Only 2 sections — Sec2Ref is orphaned and must NOT count.
    expect(block.sections).toHaveLength(2);
    expect(block.sections.map(s => s.sectionId)).toEqual(['a', 'b']);
  });
});

describe('getScrollDataForNode – smoothed transforms', () => {
  test('follows transform → spring → progress chain to find the source', () => {
    const data = parseScrollHooks(SMOOTHED_LAYER_CODE);
    const result = getScrollDataForNode(data, 'box');
    expect(result.source).not.toBeNull();
    expect(result.source?.progressVar).toBe('boxProgress');
    expect(result.source?.offset).toBe(`["start end", "end start"]`);
    expect(result.refVar).toBe('boxRef');
  });

  test('captures the spring config string from the smoothing transform', () => {
    const data = parseScrollHooks(SMOOTHED_LAYER_CODE);
    const result = getScrollDataForNode(data, 'box');
    // The synthetic spring-pass-through transform carries the config.
    const springTransform = result.transforms.find(t => t.isSpring);
    expect(springTransform).toBeDefined();
    // Walk one hop: the actual smoothing transform is named `boxSmooth`
    // and lives in the full transforms list (not always in nodeTransforms).
    const allSpring = data.transforms.find(t => t.varName === 'boxSmooth');
    expect(allSpring?.springConfig).toMatch(/duration:\s*0\.5/);
    expect(allSpring?.springConfig).toMatch(/bounce:\s*0\.25/);
  });
});

describe('parseRange', () => {
  test('parses number range', () => {
    expect(parseRange('[0, 1]')).toEqual(['0', '1']);
    expect(parseRange('[0, 0.5, 1]')).toEqual(['0', '0.5', '1']);
  });

  test('parses string range', () => {
    expect(parseRange('["0px", "60px"]')).toEqual(['0px', '60px']);
    expect(parseRange('["0%", "40%"]')).toEqual(['0%', '40%']);
  });

  test('parses multi-stop', () => {
    expect(parseRange('[0.3, 1, 1, 0.3]')).toEqual(['0.3', '1', '1', '0.3']);
  });
});
