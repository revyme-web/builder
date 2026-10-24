import { describe, it, expect } from 'vitest';
import { checkFile } from '../check-file';
import { PUBLISH_FATAL_CODES } from '../publish-preflight';
import { setTickerInCode, TICKER_DEFAULTS } from '@/code/generation/ticker-gen';
import { setTickerScoped } from '@/shared/ticker-config';
import { setCodeOverridesInCode } from '@/code/generation/code-override-gen';

const CANVAS = `/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */`;

const LOGO = (n: number) => `        <div data-id="logo-${n}" data-name="Logo" style={{ position: 'relative', width: '120px', height: '40px', backgroundImage: 'url(https://images.unsplash.com/photo-${n}?w=240)', backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', flex: '0 0 auto', order: '${n - 1}' }}></div>`;

/** An oracle-clean page with a flex row of logos — the builder's own shape. */
const CLEAN_PAGE = `'use client';

${CANVAS}

import React from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}>
      <motion.div data-id="logos" data-name="Logos" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '48px', paddingTop: '32px', paddingBottom: '32px', flex: '0 0 auto', order: '0' }}>
${[1, 2, 3, 4].map(LOGO).join('\n')}
      </motion.div>
    </div>
  );
}
`;

/** A hand-written page around one `<RevymeTicker>` usage. */
const page = (jsx: string, imports = "import { RevymeTicker } from '@revyme/runtime';") => `'use client';
import { motion } from 'framer-motion';
${imports}

export default function Page() {
  return (
    <div data-id="root">
      ${jsx}
    </div>
  );
}
`;

const FRAME = `<motion.div data-id="logos" style={{ display: 'flex', gap: '24px' }}><img data-id="l1" src="/a.svg" /><img data-id="l2" src="/b.svg" /></motion.div>`;

const all = (code: string) => checkFile(code, { kind: 'page', path: 'app/page.client.tsx' });
const codes = (code: string) => all(code).map((x) => x.code).filter((c) => c.startsWith('TICKER_'));

describe('oracle: ticker effect', () => {
  it('the fixture page is clean before the ticker', () => {
    expect(all(CLEAN_PAGE).map((x) => `${x.code}: ${x.message.slice(0, 120)}`)).toEqual([]);
  });

  it('a ticker the builder writes passes the whole oracle — defaults and every setting', () => {
    const plain = setTickerInCode(CLEAN_PAGE, 'logos', TICKER_DEFAULTS);
    expect(plain).toContain('<RevymeTicker speed={80} direction="left"><motion.div data-id="logos"');
    expect(all(plain).map((x) => `${x.code}: ${x.message.slice(0, 120)}`)).toEqual([]);
    const full = setTickerInCode(CLEAN_PAGE, 'logos', { speed: 120, hoverSpeed: 0, direction: 'right', draggable: true, fade: 48 });
    expect(full).toContain('<RevymeTicker speed={120} direction="right" hoverSpeed={0} draggable fade={48}>');
    expect(all(full).map((x) => `${x.code}: ${x.message.slice(0, 120)}`)).toEqual([]);
  });

  it('per-breakpoint overrides the panel writes pass — values, off on one tile, on one tile only', () => {
    const TABLET = { query: '(max-width: 1199px) and (min-width: 767.02px)' };
    const MOBILE = { query: '(max-width: 767px)' };
    let cfg = setTickerScoped(TICKER_DEFAULTS, { speed: 140, draggable: true, fade: 24 }, TABLET);
    cfg = setTickerScoped(cfg, { disabled: true }, MOBILE);
    const out = setTickerInCode(CLEAN_PAGE, 'logos', cfg);
    expect(out).toContain('responsive={[');
    expect(all(out).map((x) => `${x.code}: ${x.message.slice(0, 120)}`)).toEqual([]);
    const onlyMobile = setTickerInCode(CLEAN_PAGE, 'logos', { ...TICKER_DEFAULTS, disabled: true, responsive: [{ scope: MOBILE, disabled: false }] });
    expect(all(onlyMobile).map((x) => `${x.code}: ${x.message.slice(0, 120)}`)).toEqual([]);
  });

  it('flags responsive overrides the panel cannot read back', () => {
    const bad = (attrs: string) => codes(page(`<RevymeTicker ${attrs}>${FRAME}</RevymeTicker>`));
    expect(bad('responsive={[{ scope: { query: "(max-width: 767px)" }, speed: 40 }]}')).toEqual([]);
    expect(bad('responsive={overrides}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ speed: 40 }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { query: q }, speed: 40 }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { width: 767 }, speed: 40 }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { query: "(max-width: 767px)" }, speed: "40" }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { query: "(max-width: 767px)" }, speed: 4000 }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { query: "(max-width: 767px)" }, direction: "right" }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { query: "(max-width: 767px)" }, disabled: 1 }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { query: "(max-width: 767px)" }, speed: 1 }, { scope: { query: "(max-width: 767px)" }, fade: 2 }]}')).toContain('TICKER_PROP_INVALID');
    // A variant scope needs the variant prop.
    expect(bad('responsive={[{ scope: { variant: "Small" }, speed: 40 }]}')).toContain('TICKER_PROP_INVALID');
    expect(bad('responsive={[{ scope: { variant: "Small" }, speed: 40 }]} variant={variant}')).toEqual([]);
    expect(bad('variant="Small"')).toContain('TICKER_PROP_INVALID');
    expect(bad('disabled')).toEqual([]);
    expect(bad('disabled="yes"')).toContain('TICKER_PROP_INVALID');
  });

  it('a ticker over a frame with a code override (ticker outside) passes', () => {
    const withOverride = setCodeOverridesInCode(CLEAN_PAGE, 'logos', [{ file: 'overrides/Fx.tsx', name: 'withA' }]);
    const out = setTickerInCode(withOverride, 'logos', { ...TICKER_DEFAULTS, hoverSpeed: 0.5 });
    expect(out).toMatch(/<RevymeTicker speed=\{80\} direction="left" hoverSpeed=\{0\.5\}><Override with=\{withA\}><motion\.div data-id="logos"/);
    const found = all(out).map((x) => x.code);
    expect(found.filter((c) => c.startsWith('TICKER_') || c.startsWith('OVERRIDE_'))).toEqual([]);
    // Nothing beyond what the override alone already reports.
    expect(found).toEqual(all(withOverride).map((x) => x.code));
  });

  it('accepts every literal spelling the panel reads back', () => {
    expect(codes(page(`<RevymeTicker speed={0} direction={'up'} hoverSpeed={4} draggable={false} fade={0}>${FRAME}</RevymeTicker>`))).toEqual([]);
    expect(codes(page(`<RevymeTicker>${FRAME}</RevymeTicker>`))).toEqual([]);
    expect(codes(page(`<RevymeTicker speed={80} direction="left">
        {/* the strip */}
        ${FRAME}
      </RevymeTicker>`))).toEqual([]);
  });

  it('flags zero, several or non-element children (tier 3, but not publish-fatal: the runtime renders them still)', () => {
    expect(codes(page('<RevymeTicker speed={80} />'))).toContain('TICKER_CHILD_COUNT');
    expect(codes(page(`<RevymeTicker speed={80}>${FRAME}${FRAME.replace(/logos/, 'logos-2').replace(/l1/, 'l3').replace(/l2/, 'l4')}</RevymeTicker>`))).toContain('TICKER_CHILD_COUNT');
    expect(codes(page(`<RevymeTicker speed={80}>{true && ${FRAME}}</RevymeTicker>`))).toContain('TICKER_CHILD_COUNT');
    expect(codes(page(`<RevymeTicker speed={80}>Logos ${FRAME}</RevymeTicker>`))).toContain('TICKER_CHILD_COUNT');
    const v = all(page('<RevymeTicker speed={80} />')).find((x) => x.code === 'TICKER_CHILD_COUNT');
    expect(v?.tier).toBe(3);
    expect(PUBLISH_FATAL_CODES.has('TICKER_CHILD_COUNT')).toBe(false);
    expect(PUBLISH_FATAL_CODES.has('TICKER_NOT_IMPORTED')).toBe(true);
  });

  it('flags a frame without a data-id, also through an override', () => {
    expect(codes(page(`<RevymeTicker speed={80}><motion.div style={{ display: 'flex' }}><img data-id="l1" src="/a.svg" /></motion.div></RevymeTicker>`))).toContain('TICKER_FRAME_NO_DATA_ID');
    expect(codes(page(`<RevymeTicker speed={80}><Override with={withA}><motion.div style={{ display: 'flex' }}><img data-id="l1" src="/a.svg" /></motion.div></Override></RevymeTicker>`,
      "import { RevymeTicker, Override } from '@revyme/runtime';\nimport { withA } from '@/overrides/Fx';"))).toContain('TICKER_FRAME_NO_DATA_ID');
  });

  it('flags settings the panel cannot read back', () => {
    const bad = (attrs: string) => codes(page(`<RevymeTicker ${attrs}>${FRAME}</RevymeTicker>`));
    expect(bad('speed="80"')).toContain('TICKER_PROP_INVALID');
    expect(bad('speed={base * 2}')).toContain('TICKER_PROP_INVALID');
    expect(bad('speed={-20}')).toContain('TICKER_PROP_INVALID');
    expect(bad('hoverSpeed={9}')).toContain('TICKER_PROP_INVALID');
    expect(bad('direction="sideways"')).toContain('TICKER_PROP_INVALID');
    expect(bad('direction={dir}')).toContain('TICKER_PROP_INVALID');
    expect(bad('draggable="true"')).toContain('TICKER_PROP_INVALID');
    expect(bad('fade')).toContain('TICKER_PROP_INVALID');
    expect(bad('speed={80} gap={24}')).toContain('TICKER_PROP_UNKNOWN');
    expect(bad('data-id="t" speed={80}')).toContain('TICKER_PROP_UNKNOWN');
    expect(bad('{...tickerProps}')).toContain('TICKER_PROP_UNKNOWN');
  });

  it('flags a RevymeTicker that is not the runtime one', () => {
    expect(codes(page(`<RevymeTicker speed={80}>${FRAME}</RevymeTicker>`, ''))).toContain('TICKER_NOT_IMPORTED');
    expect(codes(page(`<RevymeTicker speed={80}>${FRAME}</RevymeTicker>`, "import RevymeTicker from '@/components/RevymeTicker';"))).toContain('TICKER_NOT_IMPORTED');
    expect(codes(page(`<RevymeTicker speed={80}>${FRAME}</RevymeTicker>`, "import { Marquee as RevymeTicker } from '@revyme/runtime';"))).toContain('TICKER_NOT_IMPORTED');
    // Reported once per file, not once per use.
    const twice = codes(page(`<RevymeTicker speed={80}>${FRAME}</RevymeTicker><RevymeTicker speed={40}>${FRAME.replace(/logos/, 'logos-2').replace(/l1/, 'l3').replace(/l2/, 'l4')}</RevymeTicker>`, ''));
    expect(twice.filter((c) => c === 'TICKER_NOT_IMPORTED')).toHaveLength(1);
    expect(PUBLISH_FATAL_CODES.has('TICKER_NOT_IMPORTED')).toBe(true);
  });

  it('flags a frame that is not a flex layout (dialect, not crash)', () => {
    const notFlex = (frame: string) => all(page(`<RevymeTicker speed={80}>${frame}</RevymeTicker>`)).filter((x) => x.code === 'TICKER_FRAME_NOT_FLEX');
    expect(notFlex(`<motion.div data-id="logos" style={{ display: 'grid' }}><img data-id="l1" src="/a.svg" /></motion.div>`)).toHaveLength(1);
    expect(notFlex(`<motion.div data-id="logos" style={{ gap: '24px' }}><img data-id="l1" src="/a.svg" /></motion.div>`)).toHaveLength(1);
    expect(notFlex(`<div data-id="logos"><img data-id="l1" src="/a.svg" /></div>`)).toHaveLength(1);
    expect(notFlex(`<LogoRow data-id="logos" />`)[0]?.message).toMatch(/component instance/);
    expect(notFlex(`<motion.div data-id="logos" style={{ display: 'flex' }}><img data-id="l1" src="/a.svg" /></motion.div>`)).toHaveLength(0);
    expect(notFlex(`<motion.div data-id="logos" style={{ display: 'inline-flex' }}><img data-id="l1" src="/a.svg" /></motion.div>`)).toHaveLength(0);
    // A style the oracle can't read statically is not judged.
    expect(notFlex(`<motion.div data-id="logos" style={rowStyle}><img data-id="l1" src="/a.svg" /></motion.div>`)).toHaveLength(0);
    expect(notFlex(`<motion.div data-id="logos" style={{ display: 'grid' }}><img data-id="l1" src="/a.svg" /></motion.div>`)[0]?.tier).toBe(2);
    expect(PUBLISH_FATAL_CODES.has('TICKER_FRAME_NOT_FLEX')).toBe(false);
  });

  it('a code component is a black box — its own RevymeTicker use is not judged', () => {
    const cc = `'use client';
/** @controls { "speed": { "type": "number", "default": 80 } } */
import React from 'react';
import { RevymeTicker, withResponsiveProps } from '@revyme/runtime';
function Strip({ speed = 80, style }) {
  return <div style={style}><RevymeTicker speed={speed} {...{}}><div style={{ display: 'flex' }}><span>A</span><span>B</span></div></RevymeTicker></div>;
}
export default withResponsiveProps(Strip);
`;
    expect(checkFile(cc, { kind: 'code-component', path: 'components/Strip.tsx' }).map((x) => x.code).filter((c) => c.startsWith('TICKER_'))).toEqual([]);
  });
});
