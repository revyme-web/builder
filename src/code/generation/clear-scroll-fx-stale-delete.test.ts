import { describe, it, expect } from 'vitest';
import { removeNodeInCode } from './generator-crud';

// Deleting a node must not leave a STALE/secondary scroll-variant block (`<cn>BarSv…`) half-removed: the const
// sweep drops its decls, so its multi-line useEffect/useMotionValueEvent must go too — else they reference
// now-undefined identifiers and the oracle blocks the whole delete ("References undefined identifier …").
describe('removeNodeInCode — completes stale scroll-variant hook removal', () => {
  const CODE = `export default function LayoutClient() {
  const { scrollY: HeaderMqebrhuj_29BarSvScrollY } = useScroll();
  const [HeaderMqebrhuj_29BarSv, setHeaderMqebrhuj_29BarSv] = useState('default');
  const HeaderMqebrhuj_29BarSvSec0Ref = useRef(null);
  useEffect(() => {
    HeaderMqebrhuj_29BarSvSec0Ref.current = document.getElementById('');
  }, []);
  useMotionValueEvent(HeaderMqebrhuj_29BarSvScrollY, "change", () => {
    let v = 'default';
    if (HeaderMqebrhuj_29BarSvSec0Ref.current) v = '';
    setHeaderMqebrhuj_29BarSv(v);
  });
  const KeepMeOtherRef = useRef(null);
  useEffect(() => { KeepMeOtherRef.current = 1; }, []);
  return <div><Header data-id="Header-mqebrhuj-29" initialVariant={HeaderMqebrhuj_29BarSv}></Header></div>;
}`;
  it('leaves NO dangling reference to the swept BarSv identifiers + keeps unrelated hooks', () => {
    const out = removeNodeInCode(CODE, 'Header-mqebrhuj-29');
    expect(/HeaderMqebrhuj_29BarSvSec0Ref/.test(out)).toBe(false);   // ref gone (decl + useEffect)
    expect(/setHeaderMqebrhuj_29BarSv\(/.test(out)).toBe(false);     // setter ref gone (useMotionValueEvent)
    expect(/HeaderMqebrhuj_29BarSvScrollY/.test(out)).toBe(false);   // scroll destructure gone
    expect(out.includes('KeepMeOtherRef')).toBe(true);              // unrelated hook untouched
  });
});

// Deleting a section around a COMBINED appear+transform child whose hooks were
// REFORMATTED MULTI-LINE (an AST-path mutation ran babel generate on the page):
// the exact-spacing effect regex missed `useEffect(() => {\n if (<cn>InView)…`,
// so decompose removed the InView/Appear DECLS but left the effect referencing
// them — the oracle blocked the whole delete with "References undefined
// identifiers: …InView, …Appear" ("can't delete the whole page", 2026-08-07).
describe('removeNodeInCode — multi-line (reformatted) appear-reveal hooks', () => {
  const CODE = `export default function Page() {
  const {
    scrollYProgress: pMsg1yto4_18Progress
  } = useScroll({
    target: pMsg1yto4_18Ref,
    offset: ["start end", "end start"]
  });
  const pMsg1yto4_18Smooth = useSpring(pMsg1yto4_18Progress, {
    duration: 0.5,
    bounce: 0.25
  });
  const pMsg1yto4_18Opacity = useTransform(pMsg1yto4_18Smooth, [0, 1], [0.5, 1]);
  const pMsg1yto4_18Scale = useTransform(pMsg1yto4_18Smooth, [0, 1], [0.5, 1]);
  const pMsg1yto4_18Ref = useRef(null);
  const pMsg1yto4_18InView = useInView(pMsg1yto4_18Ref, {
    once: true
  });
  const pMsg1yto4_18Appear = useMotionValue(0);
  useEffect(() => {
    if (pMsg1yto4_18InView) {
      const _c = animate(pMsg1yto4_18Appear, 1, {
        type: 'spring',
        duration: 1,
        bounce: 0.25,
        delay: 1
      });
      return () => _c.stop();
    }
  }, [pMsg1yto4_18InView]);
  const pMsg1yto4_18OpacityC = useTransform([pMsg1yto4_18Appear, pMsg1yto4_18Opacity], ([a, t]) => a * t);
  const pMsg1yto4_18YA = useTransform(pMsg1yto4_18Appear, [0, 1], [30, 0]);
  const KeepMeOtherRef = useRef(null);
  return <div data-id="root">
    <div data-id="div-msg1yto4-11" data-name="Hero">
      <motion.p data-scroll-fx='{"appear":{"initial":{"opacity":"0","y":"30"},"once":true},"transform":{"trigger":"layerInView","from":{"scale":"0.5","opacity":"0.5"},"to":{"scale":"1","opacity":"1"}}}' ref={pMsg1yto4_18Ref} data-id="p-msg1yto4-18" data-name="Body" style={{
        width: '544px',
        scale: pMsg1yto4_18Scale,
        opacity: pMsg1yto4_18OpacityC,
        y: pMsg1yto4_18YA
      }}>Elevate your site</motion.p>
    </div>
  </div>;
}`;
  it('deleting the SECTION strips every appear/scroll identifier of the animated child', () => {
    const out = removeNodeInCode(CODE, 'div-msg1yto4-11');
    // The reveal effect must go WITH the decls it references — a surviving
    // effect on removed consts is exactly what the oracle blocks.
    expect(/pMsg1yto4_18InView/.test(out)).toBe(false);
    expect(/pMsg1yto4_18Appear/.test(out)).toBe(false);
    expect(/pMsg1yto4_18Ref/.test(out)).toBe(false);
    expect(/pMsg1yto4_18Opacity/.test(out)).toBe(false);
    expect(/pMsg1yto4_18Scale/.test(out)).toBe(false);
    expect(/pMsg1yto4_18YA/.test(out)).toBe(false);
    expect(out.includes('KeepMeOtherRef')).toBe(true); // unrelated hook untouched
    expect(out.includes('data-id="p-msg1yto4-18"')).toBe(false); // node itself gone
  });
});
