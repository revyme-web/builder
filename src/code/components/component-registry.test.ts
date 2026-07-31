// component-registry.test.ts — Tests for parseComponentFile extraction and buildComponentRegistry.

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { buildComponentRegistry, clearComponentCache, getCodeComponentInsertSize } from './component-registry';
import type { ProjectFS } from '../project/project-fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockFS(files: Record<string, string>): ProjectFS {
  const map = new Map(Object.entries(files));
  return {
    readFile: (path: string) => map.get(path) ?? null,
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    listFiles: (dir?: string) => {
      const prefix = dir ? (dir.endsWith('/') ? dir : dir + '/') : '';
      return [...map.keys()].filter(p => !prefix || p.startsWith(prefix)).sort();
    },
    exists: (path: string) => map.has(path),
  };
}

// ─── buildComponentRegistry + parseComponentFile ────────────────────────────

describe('buildComponentRegistry', () => {
  beforeEach(() => {
    clearComponentCache();
  });

  test('parses export default function with destructured props', () => {
    const fs = makeMockFS({
      'components/Hero.tsx': `import { motion } from 'framer-motion';

export default function Hero({ title = 'Hello', bgColor = '#111', padding }: Props) {
  return (
    <motion.div style={{ background: bgColor, padding }}>
      <h1>{title}</h1>
    </motion.div>
  );
}`,
    });

    const registry = buildComponentRegistry(fs);
    expect(registry.size).toBe(1);

    const hero = registry.get('Hero');
    expect(hero).toBeDefined();
    expect(hero!.name).toBe('Hero');
    expect(hero!.filePath).toBe('components/Hero.tsx');
    expect(hero!.props).toEqual([
      { name: 'title', defaultValue: 'Hello' },
      { name: 'bgColor', defaultValue: '#111' },
      { name: 'padding', defaultValue: null },
    ]);
  });

  test('captures numeric and boolean literal defaults (Number/Toggle variables)', () => {
    const fs = makeMockFS({
      'components/N.tsx': `export default function N({ fontSize = 16, opacity = 0.5, wrap = true, cb = () => null, title = 'x' }) {
  return <div />;
}`,
    });
    const props = buildComponentRegistry(fs).get('N')!.props;
    const def = (name: string) => props.find(p => p.name === name)?.defaultValue;
    expect(def('fontSize')).toBe('16');   // numeric → captured (so the modal Default isn't empty)
    expect(def('opacity')).toBe('0.5');
    expect(def('wrap')).toBe('true');     // boolean → captured
    expect(def('title')).toBe('x');       // string still works
    expect(def('cb')).toBeNull();         // function default → null (not evaluated)
  });

  test('attaches prop descriptions from the @propMeta block', () => {
    const fs = makeMockFS({
      'components/Card.tsx': `'use client';
/** @propMeta {"bgColor":"Card background"} */
export default function Card({ title = 'Hi', bgColor = '#111' }) {
  return <div style={{ background: bgColor }}>{title}</div>;
}`,
    });
    const card = buildComponentRegistry(fs).get('Card');
    expect(card!.props.find(p => p.name === 'bgColor')?.description).toBe('Card background');
    // Props without a meta entry have no description.
    expect(card!.props.find(p => p.name === 'title')?.description).toBeUndefined();
  });

  test('falls back to @pageVariables type when @propMeta omits it (number var from a code control)', () => {
    const fs = makeMockFS({
      'components/Frame.tsx': `'use client';
/** @propMeta {"speed":{"min":0,"max":4,"step":0.05,"control":"slider"}} */
/** @pageVariables { "variables": [ { "name": "speed", "type": "number", "default": "0.8" } ] } */
export default function Frame({ style, speed = "0.8" }) {
  return <div style={style}>{speed}</div>;
}`,
    });
    const frame = buildComponentRegistry(fs).get('Frame');
    // @propMeta has no `type`, but @pageVariables says number → registry must classify it as number so
    // it appears in other number controls' "Set Variable" (Opacity, Gap, …).
    expect(frame!.props.find(p => p.name === 'speed')?.varType).toBe('number');
  });

  test('classifies a HOISTED transition variable as transition (@propMeta type wins over text @pageVariables)', () => {
    // 'transition' is NOT a valid @pageVariables type, so a hoisted transition is stored with a 'text'
    // @pageVariables type + the REAL type in @propMeta. Registry must classify it 'transition' (from @propMeta,
    // not the text fallback) so the variable modal shows the transition icon and the curve-picker control.
    const fs = makeMockFS({
      'components/Frame.tsx': `'use client';
/** @propMeta {"transition1":{"type":"transition","label":"HOISTEDTRANS"}} */
/** @pageVariables { "variables": [ { "name": "transition1", "type": "text", "default": "" } ] } */
export default function Frame({ style, transition1 = "" }) {
  return <div style={style}>{transition1}</div>;
}`,
    });
    const frame = buildComponentRegistry(fs).get('Frame');
    expect(frame!.props.find(p => p.name === 'transition1')?.varType).toBe('transition');
    expect(frame!.props.find(p => p.name === 'transition1')?.label).toBe('HOISTEDTRANS');
  });

  test('parses named function + export default', () => {
    const fs = makeMockFS({
      'components/Navbar.tsx': `function Navbar({ links, logo = 'logo.svg' }) {
  return <nav><img src={logo} /></nav>;
}

export default Navbar;`,
    });

    const registry = buildComponentRegistry(fs);
    const nav = registry.get('Navbar');
    expect(nav).toBeDefined();
    expect(nav!.name).toBe('Navbar');
    expect(nav!.props).toEqual([
      { name: 'links', defaultValue: null },
      { name: 'logo', defaultValue: 'logo.svg' },
    ]);
  });

  test('parses arrow function with export default', () => {
    const fs = makeMockFS({
      'components/Card.tsx': `const Card = ({ title = 'Untitled', image }: CardProps) => {
  return <div>{title}</div>;
};

export default Card;`,
    });

    const registry = buildComponentRegistry(fs);
    const card = registry.get('Card');
    expect(card).toBeDefined();
    expect(card!.name).toBe('Card');
    expect(card!.props).toEqual([
      { name: 'title', defaultValue: 'Untitled' },
      { name: 'image', defaultValue: null },
    ]);
  });

  test('handles component with no props (no destructured params)', () => {
    const fs = makeMockFS({
      'components/Divider.tsx': `export default function Divider() {
  return <hr />;
}`,
    });

    const registry = buildComponentRegistry(fs);
    const divider = registry.get('Divider');
    expect(divider).toBeDefined();
    expect(divider!.props).toEqual([]);
  });

  test('fallback: uses file name when only export default exists', () => {
    const fs = makeMockFS({
      'components/Logo.tsx': `const jsx = <svg />;
export default jsx;`,
    });

    const registry = buildComponentRegistry(fs);
    const logo = registry.get('Logo');
    expect(logo).toBeDefined();
    expect(logo!.name).toBe('Logo');
    expect(logo!.props).toEqual([]);
  });

  test('picks the EXPORTED component when helpers come earlier in the file', () => {
    // Regression: WaveDistortion.tsx style — a helper function (`hexToVec3Wave`)
    // is declared before the actual exported component. The old code matched
    // the FIRST `function ...` and returned the helper's name, which made
    // ComponentPropsTool insert props one char too early in the JSX.
    const fs = makeMockFS({
      'components/WaveDistortion.tsx': `
        function hexToVec3(hex) { return [0, 0, 0]; }
        function WaveDistortion({ speed = 0.8 }) { return <div/>; }
        export default withResponsiveProps(WaveDistortion);
      `,
    });

    const registry = buildComponentRegistry(fs);
    const comp = registry.get('WaveDistortion');
    expect(comp).toBeDefined();
    expect(comp!.name).toBe('WaveDistortion');
    expect(comp!.props.find(p => p.name === 'speed')).toBeDefined();
  });

  test('handles bare `export default Name;` after a function declaration', () => {
    const fs = makeMockFS({
      'components/Card.tsx': `
        function helper() { return null; }
        function Card({ title }) { return <div>{title}</div>; }
        export default Card;
      `,
    });

    const comp = buildComponentRegistry(fs).get('Card');
    expect(comp?.name).toBe('Card');
    expect(comp?.props.find(p => p.name === 'title')).toBeDefined();
  });

  test('returns null for files without export default', () => {
    const fs = makeMockFS({
      'components/Helper.tsx': `export function helper() { return 42; }`,
    });

    const registry = buildComponentRegistry(fs);
    expect(registry.size).toBe(0);
  });

  test('skips non-.tsx files', () => {
    const fs = makeMockFS({
      'components/readme.md': '# Components',
      'components/Hero.tsx': `export default function Hero() { return <div />; }`,
    });

    const registry = buildComponentRegistry(fs);
    expect(registry.size).toBe(1);
    expect(registry.has('Hero')).toBe(true);
  });

  test('builds registry from multiple component files', () => {
    const fs = makeMockFS({
      'components/Hero.tsx': `export default function Hero({ title = 'Hi' }) {
  return <div>{title}</div>;
}`,
      'components/Footer.tsx': `export default function Footer({ year = '2025' }) {
  return <footer>{year}</footer>;
}`,
      'components/Nav.tsx': `export default function Nav() { return <nav />; }`,
    });

    const registry = buildComponentRegistry(fs);
    expect(registry.size).toBe(3);
    expect(registry.has('Hero')).toBe(true);
    expect(registry.has('Footer')).toBe(true);
    expect(registry.has('Nav')).toBe(true);
  });

  test('cache hit: same content returns same info without re-parsing', () => {
    const code = `export default function Cached({ val = 'x' }) { return <div />; }`;
    const fs = makeMockFS({ 'components/Cached.tsx': code });

    // First build
    const reg1 = buildComponentRegistry(fs);
    const info1 = reg1.get('Cached');

    // Second build with same content
    const reg2 = buildComponentRegistry(fs);
    const info2 = reg2.get('Cached');

    // Should be the exact same object (cache hit)
    expect(info1).toBe(info2);
  });

  test('cache invalidation: changed content re-parses', () => {
    const code1 = `export default function Evolve({ a = '1' }) { return <div />; }`;
    const code2 = `export default function Evolve({ a = '1', b = '2' }) { return <div />; }`;

    const fs1 = makeMockFS({ 'components/Evolve.tsx': code1 });
    const reg1 = buildComponentRegistry(fs1);
    const info1 = reg1.get('Evolve');
    expect(info1!.props.length).toBe(1);

    // Change the file content
    const fs2 = makeMockFS({ 'components/Evolve.tsx': code2 });
    const reg2 = buildComponentRegistry(fs2);
    const info2 = reg2.get('Evolve');
    expect(info2!.props.length).toBe(2);
    expect(info2).not.toBe(info1);
  });

  test('handles props with type annotation after closing brace', () => {
    const fs = makeMockFS({
      'components/Typed.tsx': `export default function Typed({ size = '16px', color }: { size: string; color: string }) {
  return <div />;
}`,
    });

    const registry = buildComponentRegistry(fs);
    const typed = registry.get('Typed');
    expect(typed).toBeDefined();
    expect(typed!.props).toEqual([
      { name: 'size', defaultValue: '16px' },
      { name: 'color', defaultValue: null },
    ]);
  });

  test('handles empty components directory', () => {
    const fs = makeMockFS({});
    const registry = buildComponentRegistry(fs);
    expect(registry.size).toBe(0);
  });

  test('controlsMeta is null for regular components', () => {
    const fs = makeMockFS({
      'components/Hero.tsx': `export default function Hero({ title = 'Hi' }) {
  return <div>{title}</div>;
}`,
    });

    const registry = buildComponentRegistry(fs);
    const hero = registry.get('Hero');
    expect(hero).toBeDefined();
    expect(hero!.controlsMeta).toBeNull();
  });

  test('scans components/ directory alongside components/', () => {
    const fs = makeMockFS({
      'components/Hero.tsx': `export default function Hero() { return <div />; }`,
      'components/Counter.tsx': `/** @controls {"count":{"type":"number","label":"Count","default":0}} */
export default function Counter({ count = 0 }) {
  return <div>{count}</div>;
}`,
    });

    const registry = buildComponentRegistry(fs);
    expect(registry.size).toBe(2);
    expect(registry.has('Hero')).toBe(true);
    expect(registry.has('Counter')).toBe(true);

    const counter = registry.get('Counter')!;
    expect(counter.filePath).toBe('components/Counter.tsx');
    expect(counter.controlsMeta).not.toBeNull();
    expect(counter.controlsMeta!.controls).toHaveProperty('count');
    expect(counter.controlsMeta!.controls.count.type).toBe('number');
  });

  test('controlsMeta populated for code component files with @controls', () => {
    const fs = makeMockFS({
      'components/Slider.tsx': `/** @label "Image Slider" */
/** @comment "A responsive image slider" */
/** @controls {"speed":{"type":"slider","label":"Speed","default":500,"min":100,"max":2000,"step":100,"unit":"ms"}} */
export default function Slider({ speed = 500 }) {
  return <div style={{ animationDuration: speed + 'ms' }} />;
}`,
    });

    const registry = buildComponentRegistry(fs);
    const slider = registry.get('Slider')!;
    expect(slider.controlsMeta).not.toBeNull();
    expect(slider.controlsMeta!.label).toBe('Image Slider');
    expect(slider.controlsMeta!.comment).toBe('A responsive image slider');
    expect(slider.controlsMeta!.controls.speed).toEqual({
      type: 'slider',
      label: 'Speed',
      default: 500,
      min: 100,
      max: 2000,
      step: 100,
      unit: 'ms',
    });
  });

  test('component file without @controls has null controlsMeta', () => {
    const fs = makeMockFS({
      'components/Plain.tsx': `export default function Plain() { return <div />; }`,
    });

    const registry = buildComponentRegistry(fs);
    const plain = registry.get('Plain')!;
    expect(plain.filePath).toBe('components/Plain.tsx');
    expect(plain.controlsMeta).toBeNull();
  });

  test('parses a default value that contains the OTHER quote style', () => {
    // Regression: `parseProps` used to use `[^'"]*` for the inner default,
    // which rejected any embedded quote and silently dropped the whole prop.
    // Image variables write `url('...')` strings that exercise this path.
    const fs = makeMockFS({
      'components/Card.tsx': `
        export default function Card({ bgImage = "url('https://example.com/x.jpg')" }) {
          return <div style={{ backgroundImage: bgImage }} />;
        }
      `,
    });
    const registry = buildComponentRegistry(fs);
    const card = registry.get('Card')!;
    const bgImage = card.props.find(p => p.name === 'bgImage');
    expect(bgImage).toBeDefined();
    expect(bgImage!.defaultValue).toBe("url('https://example.com/x.jpg')");
  });

  test('parses a backtick-default and a no-default prop alongside string defaults', () => {
    const fs = makeMockFS({
      'components/Mix.tsx': `
        export default function Mix({ a = 'one', b, c = \`two\` }) {
          return <div data-id="r">{a}</div>;
        }
      `,
    });
    const registry = buildComponentRegistry(fs);
    const mix = registry.get('Mix')!;
    expect(mix.props.find(p => p.name === 'a')?.defaultValue).toBe('one');
    expect(mix.props.find(p => p.name === 'b')?.defaultValue).toBeNull();
    expect(mix.props.find(p => p.name === 'c')?.defaultValue).toBe('two');
  });

  test('excludes the reserved `ref` prop (Scroll Variant injects it for ref forwarding)', () => {
    const fs = makeMockFS({
      'components/Hero.tsx': `
        export default function Hero({ style, initialVariant = 'default', ref, title = 'Hi' }) {
          return <div ref={ref} data-id="r">{title}</div>;
        }
      `,
    });
    const registry = buildComponentRegistry(fs);
    const hero = registry.get('Hero')!;
    expect(hero.props.find(p => p.name === 'ref')).toBeUndefined();      // ref hidden
    expect(hero.props.find(p => p.name === 'title')).toBeDefined();      // real props kept
    expect(hero.props.find(p => p.name === 'initialVariant')).toBeDefined();
  });
});

describe('getCodeComponentInsertSize', () => {
  const wrap = (annotations: string, rootStyle: string) => `'use client';
${annotations}
/** @controls { "speed": { "type": "number", "label": "Speed", "default": 1 } } */
import { withResponsiveProps } from '@revyme/runtime';
function X(props) {
  return <div data-id="root" style={{ ${rootStyle}, ...props.style }} />;
}
export default withResponsiveProps(X);`;

  test('@defaultWidth/@defaultHeight annotations win', () => {
    const code = wrap("/** @defaultWidth 900 */\n/** @defaultHeight 560 */", "position: 'relative', width: '100px', height: '80px'");
    expect(getCodeComponentInsertSize(code)).toEqual({ width: '900px', height: '560px' });
  });

  test('falls back to the root px dims per axis', () => {
    const code = wrap('', "position: 'relative', width: '640px', height: '480px'");
    expect(getCodeComponentInsertSize(code)).toEqual({ width: '640px', height: '480px' });
  });

  test('non-px root dims (percent/auto) fall through to 200x200', () => {
    const code = wrap('', "position: 'relative', width: '100%', height: 'auto'");
    expect(getCodeComponentInsertSize(code)).toEqual({ width: '200px', height: '200px' });
  });

  test('mixed: annotation one axis, root px the other', () => {
    const code = wrap('/** @defaultWidth 900 */', "position: 'relative', height: '320px'");
    expect(getCodeComponentInsertSize(code)).toEqual({ width: '900px', height: '320px' });
  });
});
