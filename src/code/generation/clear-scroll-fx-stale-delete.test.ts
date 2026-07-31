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
