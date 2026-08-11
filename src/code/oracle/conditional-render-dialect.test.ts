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
import { execSync } from 'node:child_process';

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

// ─── Handlers no control can read back ──────────────────────────────────────
//
// A close button on a real customer page (2026-08-10) carried BOTH `onClick`
// (the Close Overlay interaction, visible in the panel) and `onPointerDown`
// doing the same thing — invisible to every control, so the user could not see,
// change or remove it.

describe('INTERACTION_HANDLER_UNREADABLE', () => {
  it('rejects onPointerDown', () => {
    const code = page(`${ROOT_OPEN}
      <button data-id="x" onPointerDown={() => {}} onClick={() => {}} style={{ width: '10px', height: '10px' }} />
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('INTERACTION_HANDLER_UNREADABLE');
  });

  it('accepts every handler the builder itself emits', () => {
    for (const h of ['onClick', 'onMouseEnter', 'onMouseLeave', 'onSubmit', 'onChange', 'onTap', 'onHoverStart']) {
      const code = page(`${ROOT_OPEN}
      <button data-id="x" ${h}={() => {}} style={{ width: '10px', height: '10px' }} />
${ROOT_CLOSE}`);
      expect(codesOf(code), `${h} must be accepted`).not.toContain('INTERACTION_HANDLER_UNREADABLE');
    }
  });

  it('does NOT touch a component instance — its props are the component\'s business', () => {
    const code = page(`${ROOT_OPEN}
      <MyWidget data-id="w" onPointerDown={() => {}} style={{ width: '10px', height: '10px' }} />
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('INTERACTION_HANDLER_UNREADABLE');
  });

  it('a CODE COMPONENT may use any handler', () => {
    const code = `/** @controls { "n": { "type": "number" } } */
import React from 'react';
export default function W() { return <div onPointerDown={() => {}} />; }
`;
    expect(codesOf(code, 'code-component')).not.toContain('INTERACTION_HANDLER_UNREADABLE');
  });

  it('points at the touchAction alternative', () => {
    const code = page(`${ROOT_OPEN}
      <button data-id="x" onPointerDown={() => {}} style={{ width: '10px', height: '10px' }} />
${ROOT_CLOSE}`);
    const msg = checkFile(code, { kind: 'page' }).find((x) => x.code === 'INTERACTION_HANDLER_UNREADABLE')!.message;
    expect(msg).toContain('onPointerDown');
    expect(msg).toContain("touchAction: 'manipulation'");
  });
});

// The allowlist above is DERIVED (motion-tag.ts) plus a short hand-written tail
// for the panel/form/instance handlers. A hand-curated set rots: the first
// version of this rule missed `onTapCancel` — emitted by the composed-fx press
// generator — and flagged the builder's own canonical fixture. This test fails
// the moment a generator starts emitting a handler the rule would reject.
describe('the readable-handler allowlist tracks the generators', () => {
  it('accepts every on*= attribute the generators actually emit', () => {
    const roots = ['src/code/generation', 'src/code/features', 'src/code/animations', 'src/code/components'];
    const emitted = new Set<string>();
    for (const root of roots) {
      let out = '';
      try { out = execSync(`grep -rhoE "\\bon[A-Z][a-zA-Z]+=\\{" ${root} 2>/dev/null || true`).toString(); } catch { /* none */ }
      for (const m of out.split('\n')) { const n = m.replace('={', '').trim(); if (n) emitted.add(n); }
    }
    expect(emitted.size, 'grep found no handlers — the probe broke').toBeGreaterThan(5);
    const rejected = [...emitted].filter((h) => {
      const code = `'use client';
export default function Page() {
  return (<div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <button data-id="x" ${h}={() => {}} style={{ width: '10px', height: '10px' }} />
  </div>);
}`;
      return checkFile(code, { kind: 'page' }).some((v) => v.code === 'INTERACTION_HANDLER_UNREADABLE');
    });
    expect(rejected, `generators emit these but the rule rejects them: ${rejected.join(', ')}`).toEqual([]);
  });
});

// ─── Ternary render — the missing twin (2026-08-11) ─────────────────────────
// Bouncing `{cond && <X/>}` while accepting `{cond ? <X/> : null}` TEACHES the
// rewrite; both branches parse into permanent always-visible nodes.
describe('CONDITIONAL_RENDER_UNSUPPORTED — ternary spelling', () => {
  it('rejects the null-branch ternary mount', () => {
    const code = page(`  const [mounted] = useState(true);
${ROOT_OPEN}
      {mounted ? <div data-id="popup" style={{ position: 'relative', width: '100%', height: 'auto' }}>hi</div> : null}
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('rejects the two-branch swap', () => {
    const code = page(`  const [dark] = useState(false);
${ROOT_OPEN}
      {dark ? <div data-id="moon" style={{ width: '10px', height: '10px' }} /> : <div data-id="sun" style={{ width: '10px', height: '10px' }} />}
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });

  it('leaves TEXT ternaries alone — a supported dialect', () => {
    const code = page(`${ROOT_OPEN}
      <p data-id="price" style={{ position: 'relative', width: '100%', height: 'auto' }}>{initialVariant === 'annual' ? '$470' : '$49'}</p>
${ROOT_CLOSE}`, '');
    expect(codesOf(code, 'component')).not.toContain('CONDITIONAL_RENDER_UNSUPPORTED');
  });
});

// ─── PAGE_HOOK_UNRESOLVED — the free-JS fence (2026-08-11) ──────────────────
describe('PAGE_HOOK_UNRESOLVED', () => {
  it('rejects a setInterval countdown effect', () => {
    const code = page(`  const [secs, setSecs] = useState(60);
  useEffect(() => { const t = setInterval(() => setSecs((s) => s - 1), 1000); return () => clearInterval(t); }, []);
${ROOT_OPEN}
      <p data-id="cd" style={{ position: 'relative', width: '100%', height: 'auto' }}>{secs}</p>
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('PAGE_HOOK_UNRESOLVED');
  });

  it('rejects a hand-rolled scroll listener', () => {
    const code = page(`  useEffect(() => { const on = () => document.body.classList.toggle('scrolled', window.scrollY > 40); window.addEventListener('scroll', on); return () => window.removeEventListener('scroll', on); }, []);
${ROOT_OPEN}
      <div data-id="nav" style={{ position: 'relative', width: '100%', height: '96px' }}>nav</div>
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('PAGE_HOOK_UNRESOLVED');
  });

  it('rejects a custom hook call', () => {
    const code = page(`  const size = useWindowSize();
${ROOT_OPEN}
      <div data-id="a" style={{ position: 'relative', width: '100%', height: 'auto' }}>x</div>
${ROOT_CLOSE}`, 'function useWindowSize() { return { w: 0 }; }');
    expect(codesOf(code)).toContain('PAGE_HOOK_UNRESOLVED');
  });

  it('accepts the generated variant-sync effect and literal useState', () => {
    const code = page(`  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
${ROOT_OPEN}
      <div data-id="a" style={{ position: 'relative', width: '100%', height: 'auto' }}>x</div>
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('PAGE_HOOK_UNRESOLVED');
  });

  it('accepts the pagination IntersectionObserver sentinel effect', () => {
    const code = page(`  const [visGrid, setVisGrid] = useState(6);
  const sentinelRef = useRef(null);
  useEffect(() => {
    const el = sentinelRef.current; if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) setVisGrid((c) => c + 6); });
    io.observe(el); return () => io.disconnect();
  }, []);
${ROOT_OPEN}
      <div data-id="a" style={{ position: 'relative', width: '100%', height: 'auto' }}>x</div>
${ROOT_CLOSE}`, "import { useRef } from 'react';");
    expect(codesOf(code)).not.toContain('PAGE_HOOK_UNRESOLVED');
  });
});

// ─── INTERACTION_HANDLER_BODY_UNREADABLE (2026-08-11) ───────────────────────
describe('INTERACTION_HANDLER_BODY_UNREADABLE', () => {
  it('rejects a clipboard/classList onClick body', () => {
    const code = page(`${ROOT_OPEN}
      <div data-id="copy" onClick={() => { navigator.clipboard.writeText('hi'); document.documentElement.classList.toggle('copied'); }} style={{ width: '120px', height: '40px' }}>Copy</div>
${ROOT_CLOSE}`);
    expect(codesOf(code)).toContain('INTERACTION_HANDLER_BODY_UNREADABLE');
  });

  it('accepts Set Variable multi-setter bodies', () => {
    const code = page(`  const [fade, setFade] = useState(1);
  const [brand, setBrand] = useState('#fff');
${ROOT_OPEN}
      <div data-id="b" onClick={() => { setFade(0.5); setBrand('#ff0'); }} style={{ width: '10px', height: '10px' }}>x</div>
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('INTERACTION_HANDLER_BODY_UNREADABLE');
  });

  it('accepts the connection chain and delayed overlay close', () => {
    const code = page(`  const [variant, setVariant] = useState('default');
  const [overlayXOpen, setOverlayXOpen] = useState(false);
${ROOT_OPEN}
      <motion.div data-id="t" onTap={() => { const _n = variant === 'default' ? 'open' : null; if (_n) setVariant(_n); }} style={{ width: '10px', height: '10px' }} />
      <div data-id="c" onClick={() => setTimeout(() => setOverlayXOpen(false), 300)} style={{ width: '10px', height: '10px' }}>x</div>
${ROOT_CLOSE}`);
    expect(codesOf(code)).not.toContain('INTERACTION_HANDLER_BODY_UNREADABLE');
  });
});
