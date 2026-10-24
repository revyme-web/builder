import { describe, it, expect } from 'vitest';
import {
  TICKER_DEFAULTS, normalizeTicker, resolveTickerForScope, resolveTickerWhere, setTickerScoped,
  resetTickerScope, hasTickerScope, tickerPresentOn, tickerOverrideFor, tickerCanvasMask,
} from './ticker-config';

const TABLET = { query: '(max-width: 1199px) and (min-width: 767.02px)' };
const MOBILE = { query: '(max-width: 767px)' };

describe('ticker-config: per breakpoint / per variant', () => {
  it('a replica write keeps only the fields set there; the base is untouched', () => {
    const cfg = setTickerScoped({ ...TICKER_DEFAULTS, fade: 32 }, { speed: 140 }, TABLET);
    expect(cfg.speed).toBe(80);
    expect(cfg.responsive).toEqual([{ scope: TABLET, speed: 140 }]);
    expect(resolveTickerForScope(cfg, TABLET)).toMatchObject({ speed: 140, fade: 32 });
    expect(resolveTickerForScope(cfg, MOBILE)).toMatchObject({ speed: 80, fade: 32 });
    expect(resolveTickerForScope(cfg, null).speed).toBe(80);
    expect(hasTickerScope(cfg, TABLET)).toBe(true);
    expect(hasTickerScope(cfg, MOBILE)).toBe(false);
    expect(hasTickerScope(cfg, null)).toBe(false);
  });

  it('direction is global: a replica write moves the base', () => {
    const cfg = setTickerScoped(TICKER_DEFAULTS, { direction: 'right' }, TABLET);
    expect(cfg.direction).toBe('right');
    expect(cfg.responsive).toBeUndefined();
  });

  it('the primary write changes the base and keeps every override', () => {
    const cfg = setTickerScoped(setTickerScoped(TICKER_DEFAULTS, { speed: 140 }, TABLET), { speed: 60, draggable: true }, null);
    expect(cfg).toMatchObject({ speed: 60, draggable: true, responsive: [{ scope: TABLET, speed: 140 }] });
  });

  it('reset drops one field, then the whole override when nothing is left', () => {
    let cfg = setTickerScoped(TICKER_DEFAULTS, { speed: 140, fade: 10 }, TABLET);
    cfg = resetTickerScope(cfg, TABLET, 'speed');
    expect(tickerOverrideFor(cfg, TABLET)).toEqual({ scope: TABLET, fade: 10 });
    cfg = resetTickerScope(cfg, TABLET, 'fade');
    expect(cfg.responsive).toBeUndefined();
    const whole = resetTickerScope(setTickerScoped(TICKER_DEFAULTS, { speed: 1, draggable: true }, TABLET), TABLET);
    expect(whole).toEqual(TICKER_DEFAULTS);
  });

  it('presence: off on one tile, or only on one tile', () => {
    const offOnMobile = setTickerScoped(TICKER_DEFAULTS, { disabled: true }, MOBILE);
    expect(tickerPresentOn(offOnMobile, MOBILE)).toBe(false);
    expect(tickerPresentOn(offOnMobile, null)).toBe(true);
    const onlyMobile = normalizeTicker({ ...TICKER_DEFAULTS, disabled: true, responsive: [{ scope: MOBILE, disabled: false }] });
    expect(tickerPresentOn(onlyMobile, MOBILE)).toBe(true);
    expect(tickerPresentOn(onlyMobile, TABLET)).toBe(false);
    expect(tickerPresentOn(onlyMobile, null)).toBe(false);
    // Turning a tile back on keeps its other overrides.
    const back = setTickerScoped(setTickerScoped(offOnMobile, { speed: 10 }, MOBILE), { disabled: false }, MOBILE);
    expect(tickerOverrideFor(back, MOBILE)).toEqual({ scope: MOBILE, speed: 10, disabled: false });
  });

  it('the canvas resolves a tile by predicate (first match wins)', () => {
    const cfg = setTickerScoped(setTickerScoped(TICKER_DEFAULTS, { fade: 10 }, TABLET), { fade: 0, disabled: true }, MOBILE);
    expect(resolveTickerWhere(cfg, (s) => 'query' in s && s.query === MOBILE.query)).toMatchObject({ disabled: true, fade: 0 });
    expect(resolveTickerWhere(cfg, () => false)).toMatchObject({ fade: 0 });
    expect(resolveTickerWhere(cfg, () => false).disabled).toBeUndefined();
  });

  it('normalizes overrides: clamps, drops empty or scope-less entries, one per scope', () => {
    const cfg = normalizeTicker({
      ...TICKER_DEFAULTS,
      responsive: [
        { scope: TABLET, speed: 9999 },
        { scope: { query: '' }, speed: 1 } as never,
        { scope: MOBILE } as never,
        { scope: TABLET, hoverSpeed: 0 },
      ],
    });
    expect(cfg.responsive).toEqual([{ scope: TABLET, hoverSpeed: 0 }]);
    expect(normalizeTicker({ ...TICKER_DEFAULTS, responsive: [{ scope: TABLET, speed: 9999 }] }).responsive)
      .toEqual([{ scope: TABLET, speed: 2000 }]);
  });

  it('canvas fade mask: none at 0, along the ticker axis otherwise (the Renderer stamp and the slider preview)', () => {
    expect(tickerCanvasMask({ fade: 0, direction: 'left' })).toBeNull();
    expect(tickerCanvasMask({ fade: 24, direction: 'left' }))
      .toBe('linear-gradient(to right, transparent, #000 min(24px, calc(50% - 1px)), #000 calc(100% - min(24px, calc(50% - 1px))), transparent)');
    expect(tickerCanvasMask({ fade: 24, direction: 'up' })).toMatch(/^linear-gradient\(to bottom,/);
  });
});
