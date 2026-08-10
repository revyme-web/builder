// conditional-render-dialect.test.ts — only the builder's own gates may mount.
//
// A real customer page (2026-08-10) gated its nav burger on a breakpoint
// boolean: `<AnimatePresence>{isCompact && (<motion.button data-id="nav-burger"…`
// with `isCompact` a hand-written useState + window.matchMedia. It renders, so
// nothing crashed and no rule fired — but the canvas paints from the parsed
// source, so the burger showed in EVERY viewport while the live site mounted it
// only below 768px, and no control could fix it.
//
// The generator dialect ALREADY taught the native way ("Hide-on-viewport =
// display: none inside that viewport's rule" + the three-variant nav recipe),
// and the AI had used @media for ~40 other elements in the same file. Prose in a
// prompt is not a gate.

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codesOf = (code: string, kind: 'page' | 'component' | 'code-component' = 'page') =>
  checkFile(code, { kind }).map((x) => x.code);

const page = (body: string, head = '') => `'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
${head}
export default function Page() {
${body}
}
`;

const ROOT_OPEN = `  return (
    <div data-id="root" data-name="Root" style={{ position: 'relative', width: '100%' }}>`;
const ROOT_CLOSE = `    </div>
  );`;

describe('CONDITIONAL_RENDER_UNSUPPORTED', () => {
  it('REJECTS the breakpoint-gated mount that shipped', () => {
    const code = page(`  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setIsCompact(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
${ROOT_OPEN}
      <AnimatePresence>{isCompact && (
        <motion.button data-id="nav-burger" data-name="Menu Button" style={{ position: 'relative', width: '48px', height: '48px' }} />
      )}</AnimatePresence>
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('names the element and teaches the @media fix', () => {
    const code = page(`  const [isCompact] = useState(false);
${ROOT_OPEN}
      <AnimatePresence>{isCompact && (<motion.button data-id="nav-burger" style={{ width: '48px', height: '48px' }} />)}</AnimatePresence>
${ROOT_CLOSE}`);
    const msg = checkFile(code, { kind: 'page' }).find((x) => x.code === 'CONDITIONAL_RENDER_UNSUPPORTED')!.message;
    expect(msg).toContain('nav-burger');
    expect(msg).toContain('display: none');
    expect(msg).toContain('@media');
    expect(msg).toContain('mobile-open');
  });

  it('rejects it WITHOUT an AnimatePresence wrapper too', () => {
    const code = page(`  const [isCompact] = useState(false);
${ROOT_OPEN}
      {isCompact && (<div data-id="burger" style={{ width: '48px', height: '48px' }} />)}
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('rejects a MIXED chain — half-variant is still unreadable', () => {
    const code = page(`  const [isCompact] = useState(false);
${ROOT_OPEN}
      <AnimatePresence>{initialVariant !== 'mobile' && isCompact && (<div data-id="x" style={{ width: '10px', height: '10px' }} />)}</AnimatePresence>
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });
});

describe('the three supported shapes still pass', () => {
  it('OVERLAY — recognised by data-overlay on the element', () => {
    const code = page(`  const [navMenuOpen, setNavMenuOpen] = useState(false);
${ROOT_OPEN}
      <AnimatePresence>{navMenuOpen && (
        <motion.div key="ov" data-id="overlay-nav" data-name="Overlay" data-overlay='{"type":"modal"}' style={{ position: 'fixed', width: '100%', height: '100%' }} />
      )}</AnimatePresence>
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('VARIANT visibility — what the Hide control and the layers eye write', () => {
    const code = `'use client';
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Card({ initialVariant = 'default' }: { initialVariant?: string }) {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <AnimatePresence mode="popLayout">{initialVariant !== 'variant-4' && initialVariant !== 'variant-5' && (
        <motion.div data-id="badge" style={{ width: '20px', height: '20px' }} />
      )}</AnimatePresence>
    </div>
  );
}
`;
    expect(codesOf(code, 'component')).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('CMS pagination — the Load More guard', () => {
    const code = page(`  const [visRow, setVisRow] = useState(6);
${ROOT_OPEN}
      {visRow < items.length && <LoadMore data-id="loadmore-row" data-pagination-ui="true" onLoadMore={() => setVisRow((c) => c + 6)} />}
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('a CODE COMPONENT is a black box — ordinary React conditionals are fine', () => {
    const code = `/** @controls { "open": { "type": "boolean" } } */
import React from 'react';
export default function Widget({ open }: { open?: boolean }) {
  return <div>{open && <span>hi</span>}</div>;
}
`;
    expect(codesOf(code, 'code-component')).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });
});

describe('does not fire on things that are not conditional renders', () => {
  it('ignores a boolean && used for a non-JSX value', () => {
    const code = page(`  const ready = true;
  const label = ready && 'yes';
${ROOT_OPEN}
      <p data-id="t" style={{ fontSize: '12px' }}>{label}</p>
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('ignores a plain page with no conditionals at all', () => {
    const code = page(`${ROOT_OPEN}
      <p data-id="t" style={{ fontSize: '12px' }}>hello</p>
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('reports each offending line once, not per traversal', () => {
    const code = page(`  const [isCompact] = useState(false);
${ROOT_OPEN}
      <AnimatePresence>{isCompact && (<div data-id="a" style={{ width: '10px', height: '10px' }} />)}</AnimatePresence>
      <AnimatePresence>{isCompact && (<div data-id="b" style={{ width: '10px', height: '10px' }} />)}</AnimatePresence>
${ROOT_CLOSE}`);
    const hits = checkFile(code, { kind: 'page' }).filter((x) => x.code === 'CONDITIONAL_RENDER_UNSUPPORTED');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.elementId).sort()).toEqual(['a', 'b']);
  });
});

// ─── The SOURCE of the boolean ──────────────────────────────────────────────
//
// The mount rule above is not enough on its own: the same hand-rolled
// breakpoint boolean escapes through a JSX ternary and through a prop (measured
// 2026-08-10 — only the `&&` mount and the style ternary were caught). Rejecting
// the listener itself closes every downstream shape at once.
//
// The builder's OWN injected helpers contain window.matchMedia /
// window.innerWidth and must never trip this — that exemption is the load-
// bearing half of the rule.

const HANDWRITTEN = `  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setIsCompact(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
`;

describe('RESPONSIVE_JS_HANDWRITTEN', () => {
  it('rejects a hand-written matchMedia listener', () => {
    const code = page(`${HANDWRITTEN}${ROOT_OPEN}
      <div data-id="x" style={{ width: '10px', height: '10px' }} />
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('RESPONSIVE_JS_HANDWRITTEN');
  });

  it('catches the boolean however it is SPENT — ternary and prop included', () => {
    const shapes: Record<string, string> = {
      ternary: `{isCompact ? (<div data-id="a" style={{ width: '10px', height: '10px' }} />) : (<div data-id="b" style={{ width: '10px', height: '10px' }} />)}`,
      prop: `<div data-id="a" data-x={isCompact} style={{ width: '10px', height: '10px' }} />`,
      mount: `{isCompact && (<div data-id="a" style={{ width: '10px', height: '10px' }} />)}`,
    };
    for (const [name, body] of Object.entries(shapes)) {
      const code = page(`${HANDWRITTEN}${ROOT_OPEN}\n      ${body}\n${ROOT_CLOSE}`);
      expect(codesOf(code), `${name} must be rejected`).toContain('RESPONSIVE_JS_HANDWRITTEN');
    }
  });

  it('rejects a hand-rolled window.innerWidth listener too', () => {
    const code = page(`  const [w, setW] = useState(0);
  useEffect(() => { setW(window.innerWidth); }, []);
${ROOT_OPEN}
      <div data-id="x" style={{ width: '10px', height: '10px' }} />
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('RESPONSIVE_JS_HANDWRITTEN');
  });

  it('teaches @media and the nav recipe', () => {
    const code = page(`${HANDWRITTEN}${ROOT_OPEN}\n      <div data-id="x" style={{ width: '10px', height: '10px' }} />\n${ROOT_CLOSE}`);
    const msg = checkFile(code, { kind: 'page' }).find((x) => x.code === 'RESPONSIVE_JS_HANDWRITTEN')!.message;
    expect(msg).toContain('@media');
    expect(msg).toContain('display: none');
    expect(msg).toContain('__mq');
    expect(msg).toContain('mobile-open');
  });
});

describe("the builder's OWN injected helpers are exempt", () => {
  // These are generator output. Flagging them would bounce every MCP submit on
  // any page that ever used a responsive text override or an __mq gate.
  const MQ_HOOK = `function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}`;

  it('does NOT flag the injected useMediaQuery helper', () => {
    const code = `'use client';
import React, { useState, useEffect } from 'react';
${MQ_HOOK}
export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px)');
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <div data-id="x" style={{ width: __mq0 ? '10px' : '20px', height: '10px' }} />
  </div>);
}
`;
    expect(codesOf(code)).not.toContain('RESPONSIVE_JS_HANDWRITTEN');
  });

  it('does NOT flag the injected useResponsiveText helper', () => {
    const code = `'use client';
import React, { useState, useLayoutEffect, useRef } from 'react';
// @useResponsiveText-begin
function useResponsiveText(primary, overrides, vpWidths) {
  const ref = useRef(null);
  const [w, setW] = useState(() => typeof window !== 'undefined' ? window.innerWidth : Infinity);
  useLayoutEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return primary;
}
// @useResponsiveText-end
export default function Page() {
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <p data-id="t" style={{ fontSize: '12px' }}>{useResponsiveText('hi', {}, [375])}</p>
  </div>);
}
`;
    expect(codesOf(code)).not.toContain('RESPONSIVE_JS_HANDWRITTEN');
  });

  it('STILL flags a hand-written listener in a file that also has the helper', () => {
    // The exemption is by byte range, not a whole-file pass.
    const code = `'use client';
import React, { useState, useEffect } from 'react';
${MQ_HOOK}
export default function Page() {
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => { setIsCompact(window.matchMedia('(max-width: 768px)').matches); }, []);
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <div data-id="x" style={{ width: '10px', height: '10px' }} />
  </div>);
}
`;
    expect(codesOf(code)).toContain('RESPONSIVE_JS_HANDWRITTEN');
  });

  it('a CODE COMPONENT may do whatever it likes', () => {
    const code = `/** @controls { "n": { "type": "number" } } */
import React, { useState, useEffect } from 'react';
export default function W() {
  const [c, setC] = useState(false);
  useEffect(() => { setC(window.matchMedia('(max-width: 768px)').matches); }, []);
  return <div>{c ? 'a' : 'b'}</div>;
}
`;
    expect(codesOf(code, 'code-component')).not.toContain('RESPONSIVE_JS_HANDWRITTEN');
  });
});
