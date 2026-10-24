import { describe, it, expect } from 'vitest';
import {
  setTickerInCode, readTicker, parseTickerOpenTag, tickerOpenTag, liftTickers, restoreTickers,
  normalizeTicker, TICKER_DEFAULTS,
} from './ticker-gen';
import { findSubtreeRange } from './generator-utils';
import { setTickerScoped } from '@/shared/ticker-config';
import { rewriteAnimationBreakpoints } from '@/code/animations/animation-scope';

const page = (body: string, imports = "import { motion } from 'framer-motion';\n") => `'use client';
${imports}
export default function Page() {
  return (
    <div data-id="root">
${body}
    </div>
  );
}
`;

const frame = `      <motion.div data-id="logos" style={{ display: 'flex', gap: '24px' }}>
        <img data-id="l1" src="/a.svg" />
        <img data-id="l2" src="/b.svg" />
      </motion.div>`;

describe('ticker-gen', () => {
  it('wraps the frame and adds the runtime import', () => {
    const out = setTickerInCode(page(frame), 'logos', { ...TICKER_DEFAULTS, speed: 60 });
    expect(out).toContain("import { RevymeTicker } from '@revyme/runtime';");
    expect(out).toMatch(/<RevymeTicker speed=\{60\} direction="left"><motion\.div data-id="logos"[\s\S]*<\/motion\.div><\/RevymeTicker>/);
    expect(readTicker(out, 'logos')).toEqual({ ...TICKER_DEFAULTS, speed: 60 });
  });

  it('updates in place and removes cleanly (import included)', () => {
    const on = setTickerInCode(page(frame), 'logos', TICKER_DEFAULTS);
    const upd = setTickerInCode(on, 'logos', { speed: 120, hoverSpeed: 0, direction: 'right', draggable: true, fade: 48 });
    expect(upd.match(/<RevymeTicker/g)).toHaveLength(1);
    expect(upd).toContain('<RevymeTicker speed={120} direction="right" hoverSpeed={0} draggable fade={48}>');
    const off = setTickerInCode(upd, 'logos', null);
    expect(off).toBe(page(frame));
    expect(off).not.toContain('RevymeTicker');
  });

  it('keeps other runtime imports when adding / removing', () => {
    const src = page(frame, "import { motion } from 'framer-motion';\nimport { Override } from '@revyme/runtime';\n");
    const on = setTickerInCode(src, 'logos', TICKER_DEFAULTS);
    expect(on).toContain("import { Override, RevymeTicker } from '@revyme/runtime';");
    const off = setTickerInCode(on, 'logos', null);
    expect(off).toContain("import { Override } from '@revyme/runtime';");
  });

  it('unknown element → unchanged', () => {
    expect(setTickerInCode(page(frame), 'nope', TICKER_DEFAULTS)).toBe(page(frame));
  });

  it('a code override on the same frame stays INSIDE the ticker', () => {
    const withOverride = page(`      <Override with={withX}>${frame.trim()}</Override>`, "import { Override } from '@revyme/runtime';\nimport { withX } from '@/overrides/X';\n");
    const out = setTickerInCode(withOverride, 'logos', TICKER_DEFAULTS);
    expect(out).toMatch(/<RevymeTicker [^>]*><Override with=\{withX\}><motion\.div data-id="logos"/);
    expect(out).toMatch(/<\/motion\.div><\/Override><\/RevymeTicker>/);
  });

  it('lift / restore: a deleted frame drops its wrapper; a moved one keeps it', () => {
    const on = setTickerInCode(page(frame), 'logos', TICKER_DEFAULTS);
    const { code: plain, lifted } = liftTickers(on);
    expect(plain).not.toContain('RevymeTicker>');
    const r = findSubtreeRange(plain, 'logos')!;
    const deleted = plain.slice(0, r.start) + plain.slice(r.end);
    expect(restoreTickers(deleted, lifted)).not.toContain('<RevymeTicker');
    expect(restoreTickers(plain, lifted)).toBe(on);
  });

  it('parses every spelling of the props', () => {
    expect(parseTickerOpenTag('<RevymeTicker speed={40} direction="up" hoverSpeed={0.5} draggable={true} fade={32}>'))
      .toEqual({ speed: 40, direction: 'up', hoverSpeed: 0.5, draggable: true, fade: 32 });
    expect(parseTickerOpenTag("<RevymeTicker direction={'down'} draggable={false}>"))
      .toEqual({ ...TICKER_DEFAULTS, direction: 'down' });
    expect(parseTickerOpenTag('<RevymeTicker>')).toEqual(TICKER_DEFAULTS);
  });

  it('normalizes bad values', () => {
    expect(normalizeTicker({ speed: -5, hoverSpeed: 9, direction: 'sideways' as never, fade: Number.NaN }))
      .toEqual({ speed: 0, hoverSpeed: 4, direction: 'left', draggable: false, fade: 0 });
    expect(tickerOpenTag({ ...TICKER_DEFAULTS, speed: 33.33333 })).toBe('<RevymeTicker speed={33.333} direction="left">');
  });

  describe('per breakpoint / per variant (responsive)', () => {
    const TABLET = '(max-width: 1199px) and (min-width: 767.02px)';
    const MOBILE = '(max-width: 767px)';

    it('writes overrides as one responsive literal and reads them back', () => {
      let cfg = setTickerScoped(TICKER_DEFAULTS, { speed: 120 }, { query: TABLET });
      cfg = setTickerScoped(cfg, { draggable: true, fade: 24 }, { query: TABLET });
      cfg = setTickerScoped(cfg, { disabled: true }, { query: MOBILE });
      const out = setTickerInCode(page(frame), 'logos', cfg);
      expect(out).toContain(`<RevymeTicker speed={80} direction="left" responsive={[{ scope: { query: "${TABLET}" }, speed: 120, draggable: true, fade: 24 }, { scope: { query: "${MOBILE}" }, disabled: true }]}><motion.div data-id="logos"`);
      expect(readTicker(out, 'logos')).toEqual(cfg);
      // No hooks or gates — the runtime resolves the bands itself.
      expect(out).not.toContain('useMediaQuery');
    });

    it('a ticker added on one tile only: base disabled, that tile on', () => {
      const cfg = { ...TICKER_DEFAULTS, disabled: true, responsive: [{ scope: { query: MOBILE }, disabled: false }] };
      const out = setTickerInCode(page(frame), 'logos', cfg);
      expect(out).toContain(`<RevymeTicker speed={80} direction="left" disabled responsive={[{ scope: { query: "${MOBILE}" }, disabled: false }]}>`);
      expect(readTicker(out, 'logos')).toEqual(cfg);
    });

    it('variant scopes pass the active variant (state when the component has one, else the prop)', () => {
      const cfg = setTickerScoped(TICKER_DEFAULTS, { speed: 20 }, { variant: 'Compact' });
      const withState = page(`      const [variant, setVariant] = React.useState('default');
${frame}`);
      expect(setTickerInCode(withState, 'logos', cfg)).toContain('responsive={[{ scope: { variant: "Compact" }, speed: 20 }]} variant={variant}>');
      expect(setTickerInCode(page(frame), 'logos', cfg)).toContain('variant={initialVariant}>');
      expect(readTicker(setTickerInCode(page(frame), 'logos', cfg), 'logos')).toEqual(cfg);
    });

    it('survives lift / restore byte for byte, and the breakpoint resize pass re-stamps its query', () => {
      const cfg = setTickerScoped(TICKER_DEFAULTS, { speed: 120 }, { query: TABLET });
      const on = setTickerInCode(page(frame), 'logos', cfg);
      const { code: plain, lifted } = liftTickers(on);
      expect(restoreTickers(plain, lifted)).toBe(on);
      // Tablet 1199 → 1100 (desktop 1440, mobile 767): the band follows.
      const resized = rewriteAnimationBreakpoints(on, 1199, 1100, [1440, 1100, 767]);
      expect(readTicker(resized, 'logos')?.responsive?.[0].scope).toEqual({ query: '(max-width: 1100px) and (min-width: 767.02px)' });
    });
  });
});

