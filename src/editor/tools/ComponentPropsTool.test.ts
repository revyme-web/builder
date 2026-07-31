// Tests for `detectPropCSSMapping` — the function that figures out which CSS
// property a component-instance prop should render the editor for.
//
// The interesting case (and what this test file exists to lock down) is the
// HOISTED variable: the parent component file has no direct `cssProp: var`
// pattern — only a `<Child cprop={parentVar} />` forward. The detector has
// to follow that hop into the child file and recover the CSS mapping from
// the child's own usage.

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { detectPropCSSMapping, detectPropAsVariantBinding, detectPropAsComponentCursor, detectPropAsCodeComponentControl, removeInstanceProp, setInstanceProp } from './ComponentPropsTool';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { parseJSX } from '@/code/parsing/ast-utils';

// buildComponentRegistry only scans `components/`-prefixed paths — keep the
// fixture in that namespace so the recursive lookup can find the child.
const CHILD_FILE = 'components/RoHuVu.tsx';
const PARENT_FILE = 'components/UxTaPa.tsx';

const CHILD_CODE = `
import { motion } from 'framer-motion';

/** @pageVariables { "variables": [{"name":"poon","type":"color","default":"#4e4e2b"}] } */
export default function RoHuVu({ style, poon = '#4e4e2b' }) {
  return (
    <motion.div data-id="auto_0" style={{ backgroundColor: poon, ...style }} />
  );
}
`;

// Parent file AFTER hoisting RoHuVu's \`poon\` prop up as \`poon2\`. Note:
//   - no direct \`backgroundColor: poon2\` usage in this file
//   - only the JSX forward \`<RoHuVu poon={poon2} />\`
// The detector has to chase the hop into RoHuVu.tsx to recover the mapping.
const PARENT_CODE = `
import RoHuVu from './RoHuVu';

/** @pageVariables { "variables": [{"name":"poon2","type":"color","default":"#FF5F93"}] } */
export default function UxTaPa({ style, poon2 = '#FF5F93' }) {
  return (
    <RoHuVu data-id="auto_1" poon={poon2} />
  );
}
`;

describe('detectPropCSSMapping', () => {
  beforeEach(() => {
    for (const p of projectFS.listFiles()) projectFS.deleteFile(p);
    projectFS.writeFile(CHILD_FILE, CHILD_CODE);
    projectFS.writeFile(PARENT_FILE, PARENT_CODE);
  });

  it('resolves a direct CSS mapping (cssProp: propName)', () => {
    const map = detectPropCSSMapping([{ name: 'poon' }], CHILD_CODE, CHILD_FILE);
    expect(map.get('poon')).toBe('backgroundColor');
  });

  it('resolves a hoisted variable through a child-component forward', () => {
    // Sanity check: registry must see both files, otherwise the recursion
    // can't resolve the child. Catches a misconfigured projectFS fixture.
    const registry = buildComponentRegistry(projectFS);
    expect(registry.size).toBe(2);

    const map = detectPropCSSMapping([{ name: 'poon2' }], PARENT_CODE, PARENT_FILE);
    expect(map.get('poon2')).toBe('backgroundColor');
  });

  it('resolves an OVERLAY border variable bound via a CSS custom property', () => {
    // The border variable feeds a `--X` custom property that the ::after consumes via
    // `border: var(--X)`. The prop must map to `border` (→ Border control, not a text input).
    const code = `function SuBiBa({ style, borda = "" }) {
  return (
    <div data-id="n" style={{ position: 'absolute', overflow: 'hidden', ...style, "--borda": borda }}>
  <style>{\`
    [data-node-id="n"]::after {
  content: '';
  inset: 0;
  border: var(--borda);
    }
  \`}</style>
    </div>
  );
}`;
    const map = detectPropCSSMapping([{ name: 'borda' }], code, 'components/SuBiBa.tsx');
    expect(map.get('borda')).toBe('border');
  });

  it('returns no mapping when neither path matches', () => {
    const code = `function X({ unused = 'x' }) { return <div />; }`;
    const map = detectPropCSSMapping([{ name: 'unused' }], code, 'components/X.tsx');
    expect(map.has('unused')).toBe(false);
  });

  it('does not follow forwards when no filePath is provided (test-fixture mode)', () => {
    // Without a filePath the forward-resolver can't read imports, so the
    // hoisted-variable hop is skipped. Direct mapping still works.
    const map = detectPropCSSMapping([{ name: 'poon2' }], PARENT_CODE);
    expect(map.has('poon2')).toBe(false);
  });

  it('resolves MULTIPLE hoisted props that all forward into the same child', () => {
    // Regression: the `visited` cycle-guard set was being mutated across
    // sibling prop iterations. After the first prop hopped into RoHuVu,
    // every subsequent prop on the same parent that ALSO forwarded into
    // RoHuVu silently bailed at `visited.has(childFile)` and fell back to
    // a plain text input. Visible bug: a hoisted border variable rendered
    // as a text input next to a working hoisted color variable, even
    // though both forwarded through the same child component.
    const CHILD_TWO_PROPS = `
      import { motion } from 'framer-motion';
      export default function RoHuVu({ style, poon = '#4e4e2b', azefazefazef = '' }) {
        return (
          <motion.div data-id="auto_0" style={{ backgroundColor: poon, ...style, border: azefazefazef }} />
        );
      }
    `;
    const PARENT_TWO_HOISTS = `
      import RoHuVu from './RoHuVu';
      export default function UxTaPa({ style, poon2 = '#FF5F93', ezefzefzefzefzef = '16px solid #bd5252' }) {
        return (
          <RoHuVu data-id="auto_1" poon={poon2} azefazefazef={ezefzefzefzefzef} />
        );
      }
    `;
    for (const p of projectFS.listFiles()) projectFS.deleteFile(p);
    projectFS.writeFile(CHILD_FILE, CHILD_TWO_PROPS);
    projectFS.writeFile(PARENT_FILE, PARENT_TWO_HOISTS);

    const map = detectPropCSSMapping(
      [{ name: 'poon2' }, { name: 'ezefzefzefzefzef' }],
      PARENT_TWO_HOISTS,
      PARENT_FILE,
    );
    expect(map.get('poon2')).toBe('backgroundColor');
    expect(map.get('ezefzefzefzefzef')).toBe('border');
  });
});

describe('detectPropAsVariantBinding', () => {
  beforeEach(() => {
    for (const p of projectFS.listFiles()) projectFS.deleteFile(p);
  });

  it('resolves a forward `<Child initialVariant={parentProp} />` to the child file path', () => {
    const CHILD_FILE = 'components/GoRoCe.tsx';
    const PARENT_FILE = 'components/UxTaPa.tsx';
    projectFS.writeFile(CHILD_FILE, `function GoRoCe(){return null}`);
    const parentCode = `
      import GoRoCe from './GoRoCe';
      function UxTaPa({ davairant = 'default' }) {
        return (
          <div data-id="root">
            <GoRoCe data-id="goroce-1" initialVariant={davairant} />
          </div>
        );
      }
    `;
    projectFS.writeFile(PARENT_FILE, parentCode);
    const resolved = detectPropAsVariantBinding('davairant', parentCode, PARENT_FILE);
    expect(resolved).toBe('components/GoRoCe.tsx');
  });

  it('returns null when the prop is not forwarded as initialVariant', () => {
    const PARENT_FILE = 'components/X.tsx';
    const code = `function X({ unused }) { return <div data-id="a" />; }`;
    expect(detectPropAsVariantBinding('unused', code, PARENT_FILE)).toBeNull();
  });

  it('resolves a FORWARDED chain (template → Header via baPoWeVariant → Logo Mark initialVariant)', () => {
    projectFS.writeFile('components/LogoMark.tsx', `function LogoMark(){return null}`);
    projectFS.writeFile('components/Header.tsx', `
      import LogoMark from './LogoMark';
      function Header({ baPoWeVariant = 'default' }) {
        return <div data-id="h-root"><LogoMark data-id="lm-1" initialVariant={baPoWeVariant} /></div>;
      }
    `);
    const templateCode = `
      import Header from './Header';
      function LayoutClient({ baPoWeVariant = 'variant-4' }) {
        return <div data-id="root"><Header data-id="hdr-1" baPoWeVariant={baPoWeVariant} /></div>;
      }
    `;
    projectFS.writeFile('components/LayoutClient.tsx', templateCode);
    expect(detectPropAsVariantBinding('baPoWeVariant', templateCode, 'components/LayoutClient.tsx')).toBe('components/LogoMark.tsx');
  });

  it('resolves a forwarded chain even when the tag has an ARROW-handler attr (`=>` breaks a [^<>] regex)', () => {
    projectFS.writeFile('components/LogoMark.tsx', `function LogoMark(){return null}`);
    projectFS.writeFile('components/Header.tsx', `
      import LogoMark from './LogoMark';
      function Header({ baPoWeVariant = 'default' }) {
        return <div data-id="h-root"><LogoMark data-id="lm-1" initialVariant={baPoWeVariant} /></div>;
      }
    `);
    // event1 arrow handler sits BEFORE baPoWeVariant — its `>` aborted the old regex scan.
    const templateCode = `
      import Header from './Header';
      function LayoutClient({ baPoWeVariant = 'variant-4' }) {
        return <div data-id="root"><Header data-id="hdr-1" event1={() => setOpen(true)} baPoWeVariant={baPoWeVariant} /></div>;
      }
    `;
    projectFS.writeFile('components/LayoutClient.tsx', templateCode);
    expect(detectPropAsVariantBinding('baPoWeVariant', templateCode, 'components/LayoutClient.tsx')).toBe('components/LogoMark.tsx');
  });

  it('resolves a forwarded chain whose DEEP binding is a per-variant conditional', () => {
    projectFS.writeFile('components/LogoMark.tsx', `function LogoMark(){return null}`);
    // The hoisted Header carries baPoWeVariant in @pageVariables (so the parser resolves the var branch
    // into attrConditionalVarRefs) — as a real hoisted master always does.
    projectFS.writeFile('components/Header.tsx', `
      /** @pageVariables { "variables": [ { "name": "baPoWeVariant", "type": "text", "default": "default" } ] } */
      import LogoMark from './LogoMark';
      function Header({ baPoWeVariant = 'default', initialVariant = 'default' }) {
        return <div data-id="h-root"><LogoMark data-id="lm-1" initialVariant={initialVariant === 'variant-6' ? baPoWeVariant : 'default'} /></div>;
      }
    `);
    const templateCode = `
      import Header from './Header';
      function LayoutClient({ baPoWeVariant = 'variant-4' }) {
        return <div data-id="root"><Header data-id="hdr-1" baPoWeVariant={baPoWeVariant} /></div>;
      }
    `;
    projectFS.writeFile('components/LayoutClient.tsx', templateCode);
    expect(detectPropAsVariantBinding('baPoWeVariant', templateCode, 'components/LayoutClient.tsx')).toBe('components/LogoMark.tsx');
  });
});

describe('detectPropAsComponentCursor', () => {
  beforeEach(() => {
    for (const p of projectFS.listFiles()) projectFS.deleteFile(p);
  });

  it('detects a direct `withCursor(propName, ...)` call on the master', () => {
    const FILE = 'components/Card.tsx';
    const code = `
      import { withCursor } from '@revyme/runtime';
      function Card({ myCursor }) {
        return <div data-id="root" {...withCursor(myCursor, {})} />;
      }
    `;
    projectFS.writeFile(FILE, code);
    expect(detectPropAsComponentCursor('myCursor', code, FILE)).toBe(true);
  });

  it('detects a multi-level forward through a nested child', () => {
    const INNER_FILE = 'components/Inner.tsx';
    const OUTER_FILE = 'components/Outer.tsx';
    projectFS.writeFile(INNER_FILE, `
      import { withCursor } from '@revyme/runtime';
      function Inner({ innerCursor }) {
        return <div data-id="r" {...withCursor(innerCursor, {})} />;
      }
    `);
    const outerCode = `
      import Inner from './Inner';
      function Outer({ outerCursor }) {
        return (
          <div data-id="root">
            <Inner data-id="inner-1" innerCursor={outerCursor} />
          </div>
        );
      }
    `;
    projectFS.writeFile(OUTER_FILE, outerCode);
    expect(detectPropAsComponentCursor('outerCursor', outerCode, OUTER_FILE)).toBe(true);
  });

  it('returns false when the prop is not consumed as a cursor', () => {
    const FILE = 'components/X.tsx';
    const code = `function X({ unused = 'x' }) { return <div data-id="a">{unused}</div>; }`;
    expect(detectPropAsComponentCursor('unused', code, FILE)).toBe(false);
  });

  it('does not match a longer identifier that happens to start with the prop name', () => {
    // `myCursorFoo` is a *different* identifier — must not register as a
    // positive match for `myCursor`. The boundary check in the regex is
    // what catches this.
    const FILE = 'components/X.tsx';
    const code = `
      import { withCursor } from '@revyme/runtime';
      function X({ myCursorFoo }) {
        return <div {...withCursor(myCursorFoo, {})} />;
      }
    `;
    expect(detectPropAsComponentCursor('myCursor', code, FILE)).toBe(false);
  });
});

describe('detectPropAsCodeComponentControl', () => {
  beforeEach(() => {
    for (const p of projectFS.listFiles()) projectFS.deleteFile(p);
  });

  it('resolves a prop forwarded into a Code component @control to its control def', () => {
    // A code component with @controls metadata. The parent forwards a
    // prop into one of its controls — the detector recovers the control def so
    // the page-instance editor can render the right control (color/slider).
    const CODE_COMPONENT_FILE = 'components/FilmGrain.tsx';
    projectFS.writeFile(CODE_COMPONENT_FILE, `/** @controls {
  "intensity": { "type": "slider", "label": "Intensity", "default": 0.5, "min": 0, "max": 1, "step": 0.01 },
  "accentColor": { "type": "color", "label": "Accent Color", "default": "#1A1A2E" }
} */
export default function FilmGrain({ intensity = 0.5, accentColor = '#1A1A2E' }) { return null; }
`);
    const PARENT_FILE = 'components/Frame.tsx';
    const parentCode = `
      import FilmGrain from './FilmGrain';
      function Frame({ myColor, myIntensity }) {
        return (
          <div data-id="root">
            <FilmGrain data-id="fg-1" intensity={myIntensity} accentColor={myColor} />
          </div>
        );
      }
    `;
    projectFS.writeFile(PARENT_FILE, parentCode);

    const colorDef = detectPropAsCodeComponentControl('myColor', parentCode, PARENT_FILE);
    expect(colorDef?.type).toBe('color');

    const sliderDef = detectPropAsCodeComponentControl('myIntensity', parentCode, PARENT_FILE);
    expect(sliderDef?.type).toBe('slider');
    expect(sliderDef?.max).toBe(1);
  });

  it('returns null when the prop is not forwarded into a code component control', () => {
    const FILE = 'components/X.tsx';
    const code = `function X({ unused }) { return <div data-id="a" />; }`;
    expect(detectPropAsCodeComponentControl('unused', code, FILE)).toBeNull();
  });

  it('resolves a HOISTED code component control through the forwarding chain', () => {
    // Code component with a color control.
    projectFS.writeFile('components/FilmGrain.tsx', `/** @controls {
  "accentColor": { "type": "color", "label": "Accent Color", "default": "#1A1A2E" }
} */
export default function FilmGrain({ accentColor = '#1A1A2E' }) { return null; }
`);
    // Intermediate master: forwards its own prop into the Code component's control.
    projectFS.writeFile('components/Inner.tsx', `
      import FilmGrain from './FilmGrain';
      function Inner({ innerColor }) {
        return <div data-id="r"><FilmGrain data-id="fg" accentColor={innerColor} /></div>;
      }
    `);
    // Grandparent master: hoisted prop forwarded into Inner's prop.
    const GRAND_FILE = 'components/Outer.tsx';
    const grandCode = `
      import Inner from './Inner';
      function Outer({ outerColor }) {
        return <div data-id="root"><Inner data-id="inner-1" innerColor={outerColor} /></div>;
      }
    `;
    projectFS.writeFile(GRAND_FILE, grandCode);

    // At the grandparent, the hoisted `outerColor` must still resolve to the
    // Code component's color control (recursing Outer → Inner → FilmGrain).
    const def = detectPropAsCodeComponentControl('outerColor', grandCode, GRAND_FILE);
    expect(def?.type).toBe('color');
    expect(def?.label).toBe('Accent Color');
  });
});

describe('removeInstanceProp — brace-depth-aware (clearing a slug/link template prop)', () => {
  it('removes a linkHref TEMPLATE prop cleanly (no stray `}` / corrupt tag — the page-crash bug)', () => {
    const code = `export default function Page() {
  return <div data-id="root">{advisors.map((item, idx) => <CoGaTa key={idx} data-id="item-1" image={item.image} name={item.name} linkHref={\`/advisors/\${item?._slug ?? ''}\`} data-name="Advisor" style={{ position: 'relative' }} />)}</div>;
}`;
    const out = removeInstanceProp(code, 'item-1', 'CoGaTa', 'linkHref');
    expect(out).not.toContain('linkHref');     // prop removed
    expect(out).not.toContain('<CoGaTa`');      // tag name NOT corrupted (the bug)
    expect(out).toContain('image={item.image}'); // sibling props intact
    expect(out).toContain('name={item.name}');
    expect(out).toContain('data-name="Advisor"');
    expect(parseJSX(out)).not.toBeNull();        // still valid JSX
  });

  it('removes a plain {member} prop and a string prop', () => {
    const code = `<X data-id="a" foo={item.bar} baz="q" />`;
    expect(removeInstanceProp(code, 'a', 'X', 'foo')).not.toContain('foo=');
    expect(removeInstanceProp(code, 'a', 'X', 'baz')).not.toContain('baz=');
  });

  it('removing `name` does NOT touch `data-name`', () => {
    const code = `<X data-id="a" name={item.n} data-name="Card" />`;
    const out = removeInstanceProp(code, 'a', 'X', 'name');
    expect(out).toContain('data-name="Card"');
    expect(out).not.toContain('name={item.n}');
  });
});

describe('setInstanceProp — brace-aware replace (slug template → plain link)', () => {
  const tpl = (link: string) => `export default function Page() {
  return <div data-id="root">{advisors.map((item, idx) => <CoGaTa key={idx} data-id="item-1" image={item.image} name={item.name} ${link} data-name="Advisor" style={{ position: 'relative' }} />)}</div>;
}`;

  it('replaces a linkHref TEMPLATE with a plain page link (no stray `}, valid JSX) — the crash bug', () => {
    const code = tpl('linkHref={`/advisors/${item?._slug ?? \'\'}`}');
    const out = setInstanceProp(code, 'item-1', 'CoGaTa', 'linkHref', '/advisors', false);
    expect(out).toContain('linkHref="/advisors"');
    expect(out).not.toContain('<CoGaTa`');     // tag name not corrupted
    expect(out).not.toContain('`}');            // no orphaned template close
    expect(out).toContain('image={item.image}'); // siblings intact
    expect(out).toContain('name={item.name}');
    expect(parseJSX(out)).not.toBeNull();
  });

  it('replaces a plain prop value', () => {
    const code = `<X data-id="a" foo="old" />`;
    expect(setInstanceProp(code, 'a', 'X', 'foo', 'new', false)).toContain('foo="new"');
  });

  it('setting `name` does NOT clip `data-name`', () => {
    const code = `<X data-id="a" name="old" data-name="Card" />`;
    const out = setInstanceProp(code, 'a', 'X', 'name', 'new', false);
    expect(out).toContain('name="new"');
    expect(out).toContain('data-name="Card"');
  });
});
