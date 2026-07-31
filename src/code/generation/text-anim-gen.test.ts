// text-anim-gen.test.ts — Text effect codegen: the RUNTIME `<RevymeSplitText>` form.
//
// The generator used to split text into N `<motion.span>`s at build time. It now writes a
// spec and a wrapper; the split happens in the browser. These tests pin the emitted shape,
// the expression passthrough that fixes CMS bindings, and the legacy upgrade path.

import { describe, it, expect } from 'vitest';
import {
  collapseMotionSpans,
  addTextAnimInCode,
  updateTextAnimInCode,
  removeTextAnimFromCode,
  stripScrollTextHooks,
  nodeHasTextAnim,
  readTextAnimConfig,
  buildSplitTextSpecSource,
} from './text-anim-gen';
import { validateGeneratedCode } from '@/code/mutation/mutation-queue';
import {
  resolveTextAnimForScope, setTextAnimScoped, hasTextAnimScope, resetTextAnimScope,
} from '@/editor/tools/AnimationTool/motion/text-anim-presets';
import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';

const DEFAULT_CONFIG: TextAnimConfig = {
  animationType: 'character',
  opacity: 0,
  y: 20,
  delay: 0.05,
  transition: { type: 'spring', stiffness: 300, damping: 30 },
};

const PAGE = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root">
    <h1 data-id="hero" style={{ fontSize: '48px' }}>Hello World</h1>
  </div>;
}`;

const inner = (code: string, id = 'hero') => {
  const i = code.indexOf(`data-id="${id}"`);
  const open = code.indexOf('>', i) + 1;
  const close = code.indexOf('</', open);
  return code.slice(open, close);
};

// ─── Emitted shape ───────────────────────────────────────────────────────────

describe('addTextAnimInCode — runtime wrapper', () => {
  it('wraps the children and records the spec on the data-id tag', () => {
    const out = addTextAnimInCode(PAGE, 'hero', DEFAULT_CONFIG);
    expect(out).toContain('data-text-anim=');
    expect(out).toContain('<RevymeSplitText spec={{');
    expect(out).toContain('Hello World</RevymeSplitText>');
    expect(out).toContain(`import { RevymeSplitText } from '@revyme/runtime';`);
    expect(validateGeneratedCode(out)).toBeNull();
  });

  it('emits NO motion.span and NO body hooks — that was the whole point', () => {
    const out = addTextAnimInCode(PAGE, 'hero', { ...DEFAULT_CONFIG, trigger: 'scroll' });
    expect(out).not.toContain('<motion.span');
    expect(out).not.toContain('useScroll');
    expect(out).not.toContain('useTransform');
    expect(out).not.toContain('querySelector');
    expect(out).not.toContain('__mq');
  });

  it('is idempotent — re-applying does not nest wrappers', () => {
    const once = addTextAnimInCode(PAGE, 'hero', DEFAULT_CONFIG);
    const twice = addTextAnimInCode(once, 'hero', DEFAULT_CONFIG);
    expect((twice.match(/<RevymeSplitText/g) || []).length).toBe(1);
    expect(twice).toContain('Hello World');
    expect(validateGeneratedCode(twice)).toBeNull();
  });

  it('a node parked in canvasNodes emits the SAME markup as one in a viewport', () => {
    const canvas = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() { return <div data-id="root"></div>; }

const canvasNodes = (<>
  <p data-id="hero">Hello World</p>
</>);`;
    const a = inner(addTextAnimInCode(PAGE, 'hero', DEFAULT_CONFIG));
    const b = inner(addTextAnimInCode(canvas, 'hero', DEFAULT_CONFIG));
    expect(b).toBe(a);   // no dormant/rehydrate split any more — the wrapper holds no hooks
  });

  it('stores the config verbatim in data-text-anim', () => {
    const out = addTextAnimInCode(PAGE, 'hero', DEFAULT_CONFIG);
    expect(readTextAnimConfig(out, 'hero')).toEqual(DEFAULT_CONFIG);
    expect(nodeHasTextAnim(out, 'hero')).toBe(true);
  });
});

// ─── The CMS fix ─────────────────────────────────────────────────────────────

describe('expression children survive verbatim', () => {
  // The identifiers must exist or validateGeneratedCode rightly flags them; a real page has
  // them from a .map() iterator / useTranslations / props.
  const withInner = (body: string) => `import React from 'react';
import { motion } from 'framer-motion';
export default function Page({ propName }) {
  const item = { title: 'x' };
  const t = (k) => k;
  const variant = 'a';
  return <div data-id="root"><p data-id="hero">${body}</p></div>;
}`;

  // The build-time splitter escaped `{`/`}` per character, so a CMS binding rendered as the
  // literal text `{item.title}` on every row. Live find 2026-07-30.
  it.each([
    ['CMS binding', '{item.title}'],
    ['i18n call', "{t('hero')}"],
    ['component variable', '{propName}'],
    ['per-variant ternary', "{variant === 'a' ? 'A' : 'B'}"],
  ])('%s is passed through untouched', (_label, expr) => {
    const out = addTextAnimInCode(withInner(expr), 'hero', DEFAULT_CONFIG);
    expect(out).toContain(expr);
    expect(out).not.toContain('&#123;');
    expect(out).not.toContain('&#125;');
    expect(validateGeneratedCode(out)).toBeNull();
  });

  it('round-trips: remove restores the original expression exactly', () => {
    const src = withInner('{item.title}');
    const added = addTextAnimInCode(src, 'hero', DEFAULT_CONFIG);
    expect(inner(removeTextAnimFromCode(added, 'hero'))).toBe('{item.title}');
  });

  it('a literal-string expression passes through — the runtime resolves it', () => {
    const out = addTextAnimInCode(withInner('{"Hello"}'), 'hero', DEFAULT_CONFIG);
    expect(out).toContain('<RevymeSplitText');
    expect(out).not.toContain('&#123;');       // never escaped per character
    expect(validateGeneratedCode(out)).toBeNull();
  });
});

// ─── Spec serialisation ──────────────────────────────────────────────────────

describe('buildSplitTextSpecSource', () => {
  it('omits resting values so a minimal config stays small', () => {
    expect(buildSplitTextSpecSource({ animationType: 'character', opacity: 1, scale: 1, y: 0 } as TextAnimConfig))
      .toBe('{ animationType: "character" }');
  });

  it('keeps a percentage offset as a string', () => {
    expect(buildSplitTextSpecSource({ animationType: 'character', y: '100%' } as TextAnimConfig))
      .toContain('y: "100%"');
  });

  it('normalises a stored bezier string into a real array', () => {
    const src = buildSplitTextSpecSource({
      animationType: 'character',
      transition: { type: 'tween', ease: '[0.22, 1, 0.36, 1]', duration: 1.15 },
    } as TextAnimConfig);
    expect(src).toContain('ease: [0.22, 1, 0.36, 1]');
    expect(src).not.toContain('ease: "[');
  });

  it('quotes a named curve', () => {
    expect(buildSplitTextSpecSource({
      animationType: 'character', transition: { type: 'tween', ease: 'easeOut' },
    } as TextAnimConfig)).toContain('ease: "easeOut"');
  });

  it('serialises responsive scopes', () => {
    const src = buildSplitTextSpecSource({
      animationType: 'character', opacity: 0,
      responsive: [{ scope: { query: '(max-width: 768px)' }, config: { opacity: 0.5 } }],
    } as TextAnimConfig);
    expect(src).toContain('responsive: [{ scope: { query: "(max-width: 768px)" }');
    expect(src).toContain('config: { opacity: 0.5 }');
  });
});

describe('variant prop', () => {
  it('is emitted only when a {variant} scope exists', () => {
    const withQuery = addTextAnimInCode(PAGE, 'hero', {
      ...DEFAULT_CONFIG, responsive: [{ scope: { query: '(max-width: 768px)' }, config: { opacity: 0.5 } }],
    } as TextAnimConfig);
    expect(withQuery).not.toContain('variant={variant}');

    const withVariant = addTextAnimInCode(PAGE, 'hero', {
      ...DEFAULT_CONFIG, responsive: [{ scope: { variant: 'open' }, config: { opacity: 0.5 } }],
    } as TextAnimConfig);
    expect(withVariant).toContain('variant={variant}');
  });
});

// ─── Remove / update ─────────────────────────────────────────────────────────

describe('removeTextAnimFromCode', () => {
  it('unwraps and strips the spec, leaving the original text', () => {
    const out = removeTextAnimFromCode(addTextAnimInCode(PAGE, 'hero', DEFAULT_CONFIG), 'hero');
    expect(out).not.toContain('data-text-anim');
    expect(out).not.toContain('<RevymeSplitText');   // the JSX is unwrapped; syncImports prunes the import
    expect(inner(out)).toBe('Hello World');
  });

  it('leaves the tag name alone (an element effect may still need motion.*)', () => {
    const src = PAGE.replace('<h1 data-id="hero"', '<motion.h1 data-id="hero"').replace('</h1>', '</motion.h1>');
    const out = removeTextAnimFromCode(addTextAnimInCode(src, 'hero', DEFAULT_CONFIG), 'hero');
    expect(out).toContain('<motion.h1 data-id="hero"');
  });
});

describe('updateTextAnimInCode', () => {
  it('regenerates the spec in place', () => {
    const a = addTextAnimInCode(PAGE, 'hero', DEFAULT_CONFIG);
    const b = updateTextAnimInCode(a, 'hero', { ...DEFAULT_CONFIG, animationType: 'word', mask: true });
    expect(readTextAnimConfig(b, 'hero')?.animationType).toBe('word');
    expect(b).toContain('mask: true');
    expect((b.match(/<RevymeSplitText/g) || []).length).toBe(1);
    expect(inner(b)).toContain('Hello World');
  });

  it('no-ops when the node is absent', () => {
    expect(updateTextAnimInCode(PAGE, 'nope', DEFAULT_CONFIG)).toBe(PAGE);
  });
});

// ─── Line breaks ─────────────────────────────────────────────────────────────

describe('line breaks', () => {
  const BR = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root"><h1 data-id="hero">aa<br /><br />bb</h1></div>;
}`;

  it('preserves <br /> through add and remove', () => {
    const added = addTextAnimInCode(BR, 'hero', DEFAULT_CONFIG);
    expect(added).toContain('<br />');
    expect(added).not.toContain('&lt;br');
    expect(inner(removeTextAnimFromCode(added, 'hero'))).toBe('aa<br /><br />bb');
  });
});

// ─── Legacy upgrade path (no migration pass — editing upgrades in place) ─────

describe('legacy build-time span form', () => {
  const LEGACY = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root"><motion.h1 data-id="hero" data-text-anim='{"animationType":"character","opacity":0,"y":20}'><span style={{ whiteSpace: "nowrap" }}><motion.span initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0 }} style={{ display: "inline-block" }}>H</motion.span><motion.span initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0 }} style={{ display: "inline-block" }}>i</motion.span></span></motion.h1></div>;
}`;

  it('collapses to the wrapper form on update', () => {
    const cfg = readTextAnimConfig(LEGACY, 'hero')!;
    const out = updateTextAnimInCode(LEGACY, 'hero', cfg);
    expect(out).not.toContain('<motion.span');
    expect(out).toContain('<RevymeSplitText');
    expect(inner(out)).toContain('Hi');
    expect(validateGeneratedCode(out)).toBeNull();
  });

  it('remove collapses spans back to plain text', () => {
    const out = removeTextAnimFromCode(LEGACY, 'hero');
    expect(out).not.toContain('motion.span');
    expect(out).not.toContain('data-text-anim');
    expect(inner(out)).toBe('Hi');
  });

  it('collapseMotionSpans still works standalone', () => {
    expect(collapseMotionSpans('<span style={{ whiteSpace: "nowrap" }}><motion.span style={{ display: "inline-block" }}>A</motion.span></span>')).toBe('A');
  });

  it('stripScrollTextHooks still sweeps legacy body hooks', () => {
    const withHooks = `export default function Page() {
  const heroTeRef = useRef(null);
  useEffect(() => { heroTeRef.current = document.querySelector("[data-id='hero']") || document.body; }, []);
  const { scrollYProgress: heroTeSP } = useScroll({ target: heroTeRef, offset: ["start 0.9", "start 0.35"] });
  const heroTe0Opacity = useTransform(heroTeSP, [0, 0.4], [0, 1]);
  return null;
}`;
    const out = stripScrollTextHooks(withHooks, 'hero');
    expect(out).not.toContain('heroTeRef');
    expect(out).not.toContain('heroTeSP');
    expect(out).not.toContain('heroTe0Opacity');
  });
});

// ─── Scope helpers (pure — unchanged by the runtime move) ────────────────────

describe('per-viewport / per-variant scope helpers', () => {
  const scope = { query: '(max-width: 768px)' } as const;

  it('resolves base ⊕ override', () => {
    const cfg: TextAnimConfig = { ...DEFAULT_CONFIG, responsive: [{ scope, config: { opacity: 0.5 } }] };
    expect(resolveTextAnimForScope(cfg, scope).opacity).toBe(0.5);
    expect(resolveTextAnimForScope(cfg, null).opacity).toBe(0);
  });

  it('mask is a BASE field — never demoted to a scope override', () => {
    const base: TextAnimConfig = { ...DEFAULT_CONFIG, mask: true };
    const scoped = setTextAnimScoped(base, { ...base, opacity: 0.5 }, scope);
    expect(scoped.mask).toBe(true);
    expect(scoped.responsive?.[0].config).not.toHaveProperty('mask');
  });

  it('tracks and resets an override', () => {
    const cfg: TextAnimConfig = { ...DEFAULT_CONFIG, responsive: [{ scope, config: { opacity: 0.5 } }] };
    expect(hasTextAnimScope(cfg, scope)).toBe(true);
    expect(hasTextAnimScope(resetTextAnimScope(cfg, scope), scope)).toBe(false);
  });
});

// ─── data-id targeting (guards findJSXDataIdIndex against <style> blocks) ────

describe('[data-id] inside a <style> block is never the target', () => {
  const WITH_STYLE = `import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root">
    <style>{\`@media (max-width: 768px) { [data-id="hero"] { width: 100% !important; } }\`}</style>
    <h1 data-id="hero">Hello</h1>
  </div>;
}`;

  it('targets the JSX element, not the CSS rule', () => {
    const out = addTextAnimInCode(WITH_STYLE, 'hero', DEFAULT_CONFIG);
    expect(out).toContain('[data-id="hero"] { width: 100% !important; }');   // CSS intact
    expect(out).toContain('<RevymeSplitText');
    expect(validateGeneratedCode(out)).toBeNull();
  });
});
