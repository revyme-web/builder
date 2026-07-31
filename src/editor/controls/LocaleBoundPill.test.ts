// Band-reset state for :lang rules — the stuck-blue Reset Override find
// (2026-07-23): a replica band holding a removal marker (or marker+value
// residue) zeroes `locales`, and with no global rules baseLocales∪locales was
// EMPTY, so Reset Override queued zero mutations. `bandLocales` is the exact
// set of locales a band reset must clear.
import { describe, it, expect } from 'vitest';
import { getLocaleStyleState } from './LocaleBoundPill';

const VPW = { desktop: 1440, tablet: 768, mobile: 375 };
const PAGE = 'app/page.client.tsx';

const codeWith = (rules: string) => `export default function Page() {
  return <div>
    <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      ${rules}
    }
  \`}</style>
  <div data-id="inst-1" style={{ opacity: '1' }} />
  </div>;
}`;

describe('getLocaleStyleState bandLocales', () => {
  it('marker-only band (replica opt-out residue): bandLocales carries the locale even though locales is []', () => {
    const code = codeWith(`:lang(fr) [data-id="inst-1"] { opacity: 0.97 !important; --locale-off-opacity: 1 !important; }`);
    const st = getLocaleStyleState(code, 'inst-1', 'opacity', 'tablet', VPW, PAGE);
    expect(st.hasBandRules).toBe(true);
    expect(st.removed).toBe(true);
    expect(st.locales).toEqual([]);            // removal zeroes the effective set…
    expect(st.baseLocales).toEqual([]);         // …and no global rules exist…
    expect(st.bandLocales).toEqual(['fr']);     // …but the reset target set is NOT empty
    expect(st.vpWidth).toBe(768);
  });

  it('value-only band: bandLocales matches the effective locale', () => {
    const code = codeWith(`:lang(it) [data-id="inst-1"] { opacity: 0.5 !important; }`);
    const st = getLocaleStyleState(code, 'inst-1', 'opacity', 'tablet', VPW, PAGE);
    expect(st.bandLocales).toEqual(['it']);
    expect(st.locales).toEqual(['it']);
  });

  it('other artboards see no band rules for this width', () => {
    const code = codeWith(`:lang(fr) [data-id="inst-1"] { opacity: 0.97 !important; }`);
    const st = getLocaleStyleState(code, 'inst-1', 'opacity', 'mobile', VPW, PAGE);
    expect(st.hasBandRules).toBe(false);
    expect(st.bandLocales).toEqual([]);
  });
});
