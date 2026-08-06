import { describe, test, expect, it } from 'vitest';
import { parseConnections, serializeConnections, addConnection, removeConnection, removeConnectionEntry, removeDanglingConnectionsInCode, removeConnectionsForVariantInCode, generateConnectionCode, type Connection } from './connection-config';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';

// ─── parseConnections ───────────────────────────────────────────────────────

describe('parseConnections', () => {
  test('parses single connection', () => {
    const code = `const connections = [
  { from: 'default', to: 'open', trigger: 'click' },
];`;
    const result = parseConnections(code);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 'default', to: 'open', trigger: 'click' });
  });

  test('parses multiple connections', () => {
    const code = `const connections = [
  { from: 'default', to: 'hover', trigger: 'mouseEnter' },
  { from: 'hover', to: 'default', trigger: 'mouseLeave' },
  { from: 'default', to: 'open', trigger: 'click' },
];`;
    const result = parseConnections(code);
    expect(result).toHaveLength(3);
    expect(result[0].trigger).toBe('mouseEnter');
    expect(result[1].trigger).toBe('mouseLeave');
    expect(result[2].trigger).toBe('click');
  });

  test('parses connection with delay', () => {
    const code = `const connections = [
  { from: 'default', to: 'open', trigger: 'click', delay: 0.5 },
];`;
    const result = parseConnections(code);
    expect(result).toHaveLength(1);
    expect(result[0].delay).toBe(0.5);
  });

  test('returns empty array when no connections block found', () => {
    const code = `export default function Foo() { return <div />; }`;
    const result = parseConnections(code);
    expect(result).toEqual([]);
  });

  test('returns empty array for empty connections array', () => {
    const code = `const connections = [];`;
    const result = parseConnections(code);
    expect(result).toEqual([]);
  });

  test('handles double-quoted values', () => {
    const code = `const connections = [
  { from: "default", to: "open", trigger: "click" },
];`;
    const result = parseConnections(code);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe('default');
    expect(result[0].to).toBe('open');
  });

  test('handles connections surrounded by other code', () => {
    const code = `import React from 'react';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

const connections = [
  { from: 'default', to: 'hover', trigger: 'mouseEnter' },
];

export default function Card() {
  return <div />;
}`;
    const result = parseConnections(code);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe('default');
    expect(result[0].to).toBe('hover');
  });

  test('handles inView trigger', () => {
    const code = `const connections = [
  { from: 'default', to: 'visible', trigger: 'inView' },
];`;
    const result = parseConnections(code);
    expect(result).toHaveLength(1);
    expect(result[0].trigger).toBe('inView');
  });

  test('returns empty array for malformed JSON', () => {
    const code = `const connections = [{ broken :::}];`;
    const result = parseConnections(code);
    expect(result).toEqual([]);
  });
});

// ─── serializeConnections ───────────────────────────────────────────────────

describe('serializeConnections', () => {
  test('serializes single connection', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'open', trigger: 'click' },
    ];
    const result = serializeConnections(connections);
    expect(result).toContain('const connections');
    expect(result).toContain("from: 'default'");
    expect(result).toContain("to: 'open'");
    expect(result).toContain("trigger: 'click'");
  });

  test('serializes multiple connections', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'hover', trigger: 'mouseEnter' },
      { from: 'hover', to: 'default', trigger: 'mouseLeave' },
    ];
    const result = serializeConnections(connections);
    expect(result).toContain("from: 'default'");
    expect(result).toContain("to: 'hover'");
    expect(result).toContain("from: 'hover'");
    expect(result).toContain("to: 'default'");
  });

  test('includes delay when present', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'open', trigger: 'click', delay: 1.5 },
    ];
    const result = serializeConnections(connections);
    expect(result).toContain('delay: 1.5');
  });

  test('omits delay when falsy (0 or undefined)', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'open', trigger: 'click', delay: 0 },
    ];
    const result = serializeConnections(connections);
    // delay: 0 is falsy, so `if (c.delay)` is false → should not be included
    expect(result).not.toContain('delay');
  });

  test('returns empty string for empty array', () => {
    const result = serializeConnections([]);
    expect(result).toBe('');
  });

  test('output format is a valid const declaration', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'open', trigger: 'click' },
    ];
    const result = serializeConnections(connections);
    expect(result).toMatch(/^const connections = \[/);
    expect(result).toMatch(/\];$/);
  });
});

// ─── Round-trip: parse → serialize → parse ──────────────────────────────────

describe('round-trip', () => {
  test('parse → serialize → parse is stable for single connection', () => {
    const original = `const connections = [
  { from: 'default', to: 'open', trigger: 'click' },
];`;
    const parsed1 = parseConnections(original);
    const serialized = serializeConnections(parsed1);
    const parsed2 = parseConnections(serialized);

    expect(parsed2).toEqual(parsed1);
  });

  test('parse → serialize → parse is stable for multiple connections', () => {
    const original = `const connections = [
  { from: 'default', to: 'hover', trigger: 'mouseEnter' },
  { from: 'hover', to: 'default', trigger: 'mouseLeave' },
  { from: 'default', to: 'pressed', trigger: 'click', delay: 0.3 },
];`;
    const parsed1 = parseConnections(original);
    const serialized = serializeConnections(parsed1);
    const parsed2 = parseConnections(serialized);

    expect(parsed2).toEqual(parsed1);
  });

  test('double round-trip is stable', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'hover', trigger: 'mouseEnter' },
      { from: 'hover', to: 'default', trigger: 'mouseLeave' },
    ];
    const s1 = serializeConnections(connections);
    const p1 = parseConnections(s1);
    const s2 = serializeConnections(p1);
    const p2 = parseConnections(s2);

    expect(s2).toBe(s1);
    expect(p2).toEqual(p1);
  });

  test('round-trip preserves delay', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'visible', trigger: 'inView', delay: 2 },
    ];
    const serialized = serializeConnections(connections);
    const parsed = parseConnections(serialized);
    expect(parsed[0].delay).toBe(2);
  });

  test('round-trip with all trigger types', () => {
    const connections: Connection[] = [
      { from: 'default', to: 'a', trigger: 'click' },
      { from: 'default', to: 'b', trigger: 'mouseEnter' },
      { from: 'b', to: 'default', trigger: 'mouseLeave' },
      { from: 'default', to: 'c', trigger: 'inView' },
    ];
    const serialized = serializeConnections(connections);
    const parsed = parseConnections(serialized);
    expect(parsed).toEqual(connections);
  });
});

// ─── ternary identifier rewrite (`initialVariant ===` ↔ `variant ===`) ──────
// When connections are added, the runtime variant is the useState-driven
// `variant`. Inline-style/prop ternaries that test against `initialVariant`
// would freeze at the initial render, so they must be rewritten to `variant`.
// On removal the rewrite is reversed.

describe('removeDanglingConnectionsInCode — drop connections whose trigger element is gone', () => {
  test('removes connections of the deleted (absent) node, keeps those still present', () => {
    // frame-A is gone from the JSX (deleted); frame-B still present.
    const code = `const connections = [
  { from: 'variant-1', to: 'variant-2', trigger: 'click', sourceNode: 'frame-A' },
  { from: 'variant-2', to: 'variant-1', trigger: 'click', sourceNode: 'frame-A' },
  { from: 'variant-1', to: 'variant-2', trigger: 'click', sourceNode: 'frame-B' },
];
function Foo() { return <div data-id="root" animate={variant}><div data-id="frame-B" /></div>; }
export default withResponsiveProps(Foo);`;
    const result = removeDanglingConnectionsInCode(code);
    const conns = parseConnections(result);
    expect(conns).toHaveLength(1);
    expect(conns[0].sourceNode).toBe('frame-B');
  });

  test('stripping the LAST connection removes the scaffolding (animate→initialVariant)', () => {
    // No `data-id="frame-A"` anywhere → its connection is dangling.
    const code = `const connections = [
  { from: 'variant-1', to: 'variant-2', trigger: 'click', sourceNode: 'frame-A' },
];
function Foo() {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <div data-id="root" animate={variant} />;
}
export default withResponsiveProps(Foo);`;
    const result = removeDanglingConnectionsInCode(code);
    expect(parseConnections(result)).toHaveLength(0);
    expect(result).not.toContain('const [variant, setVariant]');
    // The PAIRED sync effect must go with the useState — leaving it dangled
    // `setVariant` (ReferenceError at runtime + every later mutation on the
    // file bounced by validation). Live find 2026-07-05: deleting the target
    // variant of a click connection left `useEffect(() => { setVariant(...) })`
    // behind because the old removal regex was anchored on the inView deps.
    expect(result).not.toContain('setVariant');
    expect(result).toContain("animate={['default', initialVariant]}");
    expect(result).not.toContain("animate={['default', variant]}");
  });

  test('deleting the TARGET variant of a connection strips the sync useEffect too (the RoTaWe crash)', () => {
    // Mirrors the user repro: default → variant-1 on click; variant-1 gets deleted.
    const code = `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'click', sourceNode: 'contact' },
];
function Foo() {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <div data-id="root" animate={['default', variant]}>
    <div data-id="contact" onTap={() => setVariant(variant === 'default' ? 'variant-1' : variant)} />
  </div>;
}
export default withResponsiveProps(Foo);`;
    const result = removeConnectionsForVariantInCode(code, 'variant-1');
    expect(parseConnections(result)).toHaveLength(0);
    expect(result).not.toContain('setVariant');   // useState + sync effect + onTap all gone
    expect(result).toContain("animate={['default', initialVariant]}");
  });

  test('sync-effect removal survives reformatting and hooks sharing the line', () => {
    // Babel reformat (multiline body) + another hook concatenated before the
    // effect (the Form State hook case) — the removal is whitespace-flexible
    // and keyed on setVariant(initialVariant), so both shapes are stripped.
    const code = `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'click', sourceNode: 'contact' },
];
function Foo() {
  const [variant, setVariant] = useState(initialVariant);
  const [formState, setFormState] = useState('idle');  useEffect(() => {
    setVariant(initialVariant);
  }, [initialVariant]);
  return <div data-id="root" animate={['default', variant]}>
    <div data-id="contact" onTap={() => setVariant(variant === 'default' ? 'variant-1' : variant)} />
  </div>;
}
export default withResponsiveProps(Foo);`;
    const result = removeConnectionsForVariantInCode(code, 'variant-1');
    expect(result).not.toContain('setVariant');
    // The unrelated hook on the same line SURVIVES.
    expect(result).toContain("const [formState, setFormState] = useState('idle');");
  });

  test('no-op when every sourceNode is still present (or no connections array)', () => {
    const withConns = `const connections = [
  { from: 'variant-1', to: 'variant-2', trigger: 'click', sourceNode: 'frame-A' },
];
function Foo() { return <div data-id="root"><div data-id="frame-A" /></div>; }`;
    expect(removeDanglingConnectionsInCode(withConns)).toBe(withConns);
    const noConns = `function Bar() { return <div data-id="root" />; }`;
    expect(removeDanglingConnectionsInCode(noConns)).toBe(noConns);
  });

  test('keeps variant-level connections that have no sourceNode', () => {
    const code = `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'click' },
];
function Foo() { return <div data-id="root" />; }`;
    expect(removeDanglingConnectionsInCode(code)).toBe(code);
  });
});

describe('generateConnectionCode — no duplicate handlers on one tag', () => {
  const FILE = 'components/Auto.tsx';
  const BASE = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'One', x: 0, y: 0, isPrimary: true }, { name: 't2', label: 'Two', x: 100, y: 0 }];

const connections = [
{ from: 'default', to: 't2', trigger: 'inView' },
];

function Auto({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <motion.div data-id="auto-root" style={{ position: 'absolute', ...style }} animate={variant}>
        <motion.p data-id="label" style={{ position: 'relative' }}>Hi</motion.p>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Auto);
`;

  const countOccurrences = (code: string, needle: string) => code.split(needle).length - 1;

  test('a root-bucket inView + a sourceNode-on-root inView emit ONE onViewportEnter', () => {
    resetProjectFS(new Map([[FILE, BASE]]));
    // second connection explicitly sources the root's own data-id — the
    // collision that produced 14 stacked onViewportEnter attributes.
    addConnection(FILE, 't2', 'default', 'inView', undefined, 'auto-root');
    const updated = projectFS.readFile(FILE)!;
    expect(countOccurrences(updated, 'onViewportEnter')).toBe(1);
  });

  test('regeneration heals PRE-EXISTING duplicate handlers (strip removes every copy)', () => {
    const dirty = BASE.replace(
      '<motion.div data-id="auto-root"',
      '<motion.div\n      onViewportEnter={() => setIsInView(true)}\n      onViewportEnter={() => setIsInView(true)}\n      onViewportEnter={() => setIsInView(true)} data-id="auto-root"',
    );
    resetProjectFS(new Map([[FILE, dirty]]));
    addConnection(FILE, 't2', 'default', 'inView');
    const updated = projectFS.readFile(FILE)!;
    expect(countOccurrences(updated, 'onViewportEnter')).toBe(1);
  });
});

describe('removeConnection — precise identity (same variant pair, multiple sources)', () => {
  const FILE = 'components/Slider.tsx';
  const CODE = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'One', x: 0, y: 0, isPrimary: true }, { name: 't2', label: 'Two', x: 100, y: 0 }];

const connections = [
{ from: 'default', to: 't2', trigger: 'click', sourceNode: 'next-btn' },
{ from: 'default', to: 't2', trigger: 'inView' },
];

function Slider({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ position: 'absolute', ...style }} animate={variant}>
        <motion.div data-id="next-btn" onTap={() => setVariant(variant === 'default' ? 't2' : variant)} style={{ position: 'relative' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Slider);
`;

  test('removing the ROOT inView connection keeps the arrow click connection (the erased-arrow bug)', () => {
    resetProjectFS(new Map([[FILE, CODE]]));
    removeConnection(FILE, 'default', 't2', { trigger: 'inView', sourceNode: null });
    const remaining = parseConnections(projectFS.readFile(FILE)!);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual({ from: 'default', to: 't2', trigger: 'click', sourceNode: 'next-btn' });
  });

  test('removing the arrow click connection keeps the root inView connection', () => {
    resetProjectFS(new Map([[FILE, CODE]]));
    removeConnection(FILE, 'default', 't2', { trigger: 'click', sourceNode: 'next-btn' });
    const remaining = parseConnections(projectFS.readFile(FILE)!);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].trigger).toBe('inView');
  });

  test('pair-wide removal (no match) still removes all — legacy behaviour', () => {
    resetProjectFS(new Map([[FILE, CODE]]));
    removeConnection(FILE, 'default', 't2');
    expect(parseConnections(projectFS.readFile(FILE)!)).toHaveLength(0);
  });

  test('addConnection allows same pair + trigger on different source nodes', () => {
    resetProjectFS(new Map([[FILE, CODE]]));
    addConnection(FILE, 'default', 't2', 'click', undefined, 'other-btn');
    expect(parseConnections(projectFS.readFile(FILE)!)).toHaveLength(3);
  });
});

describe('addConnection / removeConnection: ternary identifier rewrite', () => {
  test('addConnection rewrites style ternaries from initialVariant to variant', () => {
    const FILE = `components/Foo.tsx`;
    const code = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';

const variantConfig = [{ name: 'default', label: 'Foo', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'Foo', x: 100, y: 0 }];

function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ position: 'absolute', ...style }}>
        <Inner data-id="inner" style={{ left: initialVariant === 'variant-1' ? '188px' : '52px' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Foo);
`;
    resetProjectFS(new Map([[FILE, code]]));
    addConnection(FILE, 'default', 'variant-1', 'click');
    const updated = projectFS.readFile(FILE)!;
    // The inline style ternary now keys off `variant` so click toggles re-render
    expect(updated).toContain("left: variant === 'variant-1' ? '188px' : '52px'");
    expect(updated).not.toContain("left: initialVariant === 'variant-1'");
    // Function param `initialVariant = 'default'` stays intact
    expect(updated).toContain("initialVariant = 'default'");
  });

  test('addConnection re-points the responsive Collection List config arg initialVariant → variant; removeConnection reverts', () => {
    // A responsive Collection List inside a design component resolves its filter/
    // sort per the LIVE variant. Before connections it reads the `initialVariant`
    // prop; once a connection adds a `[variant, setVariant]` state (which motion-
    // motion animates on), the list must read `variant` or it never re-filters as
    // the component switches variants (e.g. variant-1's rows persist on variant-2).
    const FILE = `components/AdvisorList.tsx`;
    const code = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import advisors from '@/cms/advisors.json';

const variantConfig = [{ name: 'default', label: 'D', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'T', x: 100, y: 0 }];

function AdvisorList({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const listCfgRoot = useResponsiveListConfig({}, {}, [1440, 768, 375], initialVariant, {"variant-1":{"filter":{"combinator":"and","filters":[{"field":"name","operator":"contains","value":"zzz"}]}}});
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ position: 'absolute', ...style }}>
        {__applyListConfig(advisors, listCfgRoot).map((item, idx) => <div data-id="row" key={idx} />)}
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(AdvisorList);
`;
    resetProjectFS(new Map([[FILE, code]]));
    addConnection(FILE, 'default', 'variant-1', 'click');
    let updated = projectFS.readFile(FILE)!;
    expect(updated).toMatch(/useResponsiveListConfig\([^;]*?,\s*variant,\s*\{/);
    expect(updated).not.toMatch(/useResponsiveListConfig\([^;]*?,\s*initialVariant,\s*\{/);
    // Function param default stays intact
    expect(updated).toContain("initialVariant = 'default'");

    removeConnection(FILE, 'default', 'variant-1');
    updated = projectFS.readFile(FILE)!;
    // Last connection removed → `variant` state stripped → must read initialVariant again
    expect(updated).toMatch(/useResponsiveListConfig\([^;]*?,\s*initialVariant,\s*\{/);
    expect(updated).not.toMatch(/useResponsiveListConfig\([^;]*?,\s*variant,\s*\{/);
  });

  test('addConnection migrates NESTED AnimatePresence visibility conditions (!== form) to variant', () => {
    // Regression: the old per-block regex (`<AnimatePresence…>…</AnimatePresence>`
    // with lazy [\s\S]*?) closed at the FIRST inner </AnimatePresence>, so a
    // wrapper nested inside another wrapper kept `initialVariant !== '…'` and
    // froze on the initial variant forever (the hamburger-line bug).
    const FILE = `components/Hdr2.tsx`;
    const code = `import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'desktop', label: 'Desktop', x: 0, y: 0, isPrimary: true }, { name: 'mobile', label: 'Mobile', x: 600, y: 0 }];

function Hdr2({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ display: 'flex', ...style }}>
        <AnimatePresence mode="popLayout">{initialVariant !== 'desktop' && <motion.button data-id="burger" layout key="burger" style={{ display: 'flex' }}>
          <AnimatePresence mode="popLayout">{initialVariant !== 'desktop' && <motion.span data-id="line-1" layout key="line-1" style={{ width: '22px' }} />}</AnimatePresence>
        </motion.button>}</AnimatePresence>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Hdr2);
`;
    resetProjectFS(new Map([[FILE, code]]));
    addConnection(FILE, 'desktop', 'mobile', 'click', undefined, 'burger');
    const updated = projectFS.readFile(FILE)!;
    // BOTH conditions migrated — including the nested one
    expect(updated).not.toContain("initialVariant !== 'desktop'");
    expect((updated.match(/variant !== 'desktop'/g) ?? []).length).toBe(2);
    // Function param stays intact
    expect(updated).toContain("initialVariant = 'default'");
  });

  test('injects useState into the COMPONENT function, not a helper declared above it (__applyInstanceSize)', () => {
    // Regression: when an instance-size-override added `function
    // __applyInstanceSize(...)` ABOVE the component, the useState injector's
    // fallback `/^function \w+/m` matched the helper first and put the hooks
    // there → `ReferenceError: initialVariant is not defined` + dead component.
    const FILE = `components/Hdr.tsx`;
    const code = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'D', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'T', x: 100, y: 0 }];
const hdrVariants = { default: { width: '1440px' }, 'variant-1': { width: '768px' } };

function __applyInstanceSize(variants, w, h) {
  if (w === undefined && h === undefined) return variants;
  const out = {};
  for (const k in variants) { out[k] = { ...variants[k] }; }
  return out;
}

function Hdr({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const { width: __instW, height: __instH, ...__instStyle } = style ?? {};
  return (
    <LayoutGroup>
      <motion.div data-id="root" variants={__applyInstanceSize(hdrVariants, __instW, __instH)} initial={initialVariant} animate={initialVariant} style={{ ...__instStyle }}></motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Hdr);
`;
    resetProjectFS(new Map([[FILE, code]]));
    addConnection(FILE, 'default', 'variant-1', 'click');
    const updated = projectFS.readFile(FILE)!;
    // The hooks land in Hdr, immediately after its destructure — NOT in the helper.
    const helperBody = updated.slice(updated.indexOf('function __applyInstanceSize'), updated.indexOf('function Hdr'));
    expect(helperBody).not.toContain('useState');
    expect(updated).toMatch(/function Hdr\([\s\S]*?\{[\s\S]*?const \[variant, setVariant\] = useState\(initialVariant\);/);
  });

  test('injects useState even when a param default contains parens (componentCursor `jljkjh = () => null`)', () => {
    // Regression: the naive `\\([^)]*\\)` function matcher stopped at the `)` inside `() => null`, failed
    // to find the body, and never injected the hook → `variant is not defined` at runtime.
    const FILE = `components/Cur.tsx`;
    const code = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps, withCursor } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'D', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'V', x: 100, y: 0 }];

function Cur({ style, initialVariant = 'default', jljkjh = () => null, content = 'x' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" {...withCursor(jljkjh, { mode: 'follow' })} initial={initialVariant} animate={initialVariant} style={{ ...style }}></motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Cur);
`;
    resetProjectFS(new Map([[FILE, code]]));
    addConnection(FILE, 'default', 'variant-1', 'click');
    const updated = projectFS.readFile(FILE)!;
    // The hook MUST be injected (inside Cur), so `variant`/`setVariant` are defined.
    expect(updated).toContain('const [variant, setVariant] = useState(initialVariant);');
    expect(updated).toMatch(/function Cur\([\s\S]*?\{[\s\S]*?const \[variant, setVariant\] = useState\(initialVariant\);/);
    // The cursor param default is untouched.
    expect(updated).toContain('jljkjh = () => null');
  });

  test('round-trip: adding a SECOND connection on top of an existing one keeps the JSX intact (no leftover handler tail)', () => {
    // Regression test for the bug where a second `addConnection` (the
    // "back" half of a round-trip) corrupted the JSX. The per-tag scan
    // for inserting `animate={variant}` was using a regex that stopped
    // at the first `>` it saw — including the `>` inside `=>` arrow
    // functions in an existing onTap handler. That truncated the tag,
    // mangled the attributes, and the downstream onTap replace then
    // operated on garbage, leaving stray fragments like
    // `}> setVariant('variant-1')}` floating in the source.
    const FILE = `components/Round.tsx`;
    const code = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 1017, y: 0 },
];

const innerVariants = {
  default: { left: '111px', top: '68px' },
  'variant-1': { left: '530px', top: '233px' },
};

function Round({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="root" style={{ position: 'absolute', ...style }}>
        <motion.div layout={true} data-id="inner" variants={innerVariants} initial={initialVariant} style={{ position: 'absolute', left: '111px', top: '68px' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Round);
`;
    resetProjectFS(new Map([[FILE, code]]));

    // First connection: default -> variant-1 on click
    addConnection(FILE, 'default', 'variant-1', 'click');
    const afterFirst = projectFS.readFile(FILE)!;
    // After first add, both motion elements should carry the list-form
    // animate (merges default under the live variant — sparse inheritance)
    expect(afterFirst.match(/animate=\{\['default', variant\]\}/g)?.length).toBe(2);
    // Single-direction handler — gated by the `from` variant (per-variant).
    expect(afterFirst).toContain("onTap={() => { const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n); }}");

    // Second connection: variant-1 -> default on click (the round-trip).
    // This is the call that produced the broken JSX in the user's report.
    addConnection(FILE, 'variant-1', 'default', 'click');
    const afterSecond = projectFS.readFile(FILE)!;

    // Stray fragments from a corrupted onTap replacement should NOT appear
    expect(afterSecond).not.toContain("}> setVariant(");
    expect(afterSecond).not.toContain("=>  setVariant"); // double-space artifact
    // The new ternary handler is the ONLY onTap on the file
    expect(afterSecond.match(/onTap=/g)?.length).toBe(1);
    expect(afterSecond).toContain("onTap={() => { const _n = variant === 'default' ? 'variant-1' : variant === 'variant-1' ? 'default' : null; if (_n) setVariant(_n); }}");
    // Both motion elements still have the list-form animate (no duplicates)
    expect(afterSecond.match(/animate=\{\['default', variant\]\}/g)?.length).toBe(2);
    // The variants object is still intact on the inner element
    expect(afterSecond).toContain('variants={innerVariants}');
  });

  test('removeConnection reverts style ternaries back to initialVariant', () => {
    const FILE = `components/Foo.tsx`;
    const code = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import Inner from '@/components/Inner';

const variantConfig = [{ name: 'default', label: 'Foo', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'Foo', x: 100, y: 0 }];
const connections = [{ from: 'default', to: 'variant-1', trigger: 'click' }];

function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <motion.div onTap={() => setVariant('variant-1')} initial={initialVariant} animate={variant} data-id="root" style={{ position: 'absolute', ...style }}>
        <Inner data-id="inner" style={{ left: variant === 'variant-1' ? '188px' : '52px' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Foo);
`;
    resetProjectFS(new Map([[FILE, code]]));
    removeConnection(FILE, 'default', 'variant-1');
    const updated = projectFS.readFile(FILE)!;
    // The inline ternary reverts so the (now non-existent) `variant` is no
    // longer referenced — `initialVariant` is back in scope as the prop.
    expect(updated).toContain("left: initialVariant === 'variant-1' ? '188px' : '52px'");
    expect(updated).not.toContain("variant === 'variant-1'");
  });
});

// ─── inView chain map regeneration ─────────────────────────────────────────
// Regression: when a SECOND `inView` connection is added (e.g. the
// reverse edge `variant-1 → default` to form an infinite cycle), the
// chain map inside the runtime `useEffect` must reflect BOTH entries.
// The previous codegen guarded re-insertion with `!result.includes('isInView')`
// so the chain map was frozen at the first inView connection — the
// cycle stopped at variant-1 forever.

describe('addConnection: inView chain map refresh', () => {
  const FILE = 'components/Frame.tsx';
  const baseCode = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 473, y: 0 },
];

function Frame({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ position: 'absolute', ...style }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(Frame);
`;

  test('chain map contains BOTH inView connections after second add', () => {
    resetProjectFS(new Map([[FILE, baseCode]]));
    addConnection(FILE, 'default', 'variant-1', 'inView', 0.3);
    addConnection(FILE, 'variant-1', 'default', 'inView', 0.3);
    const updated = projectFS.readFile(FILE)!;

    // Both directions must be present in the runtime chain
    expect(updated).toContain("'default': { to: 'variant-1', delay: 300 }");
    expect(updated).toContain("'variant-1': { to: 'default', delay: 300 }");
    // Only one isInView block — no duplicates from stacked codegen
    const isInViewCount = (updated.match(/const \[isInView, setIsInView\]/g) ?? []).length;
    expect(isInViewCount).toBe(1);
    const chainEffectCount = (updated.match(/\}, \[variant, isInView\]\);/g) ?? []).length;
    expect(chainEffectCount).toBe(1);
  });

  test('chain map updates delay on re-add of same edge', () => {
    resetProjectFS(new Map([[FILE, baseCode]]));
    addConnection(FILE, 'default', 'variant-1', 'inView', 0.3);
    // Simulate edit: remove + re-add with new delay
    removeConnection(FILE, 'default', 'variant-1');
    addConnection(FILE, 'default', 'variant-1', 'inView', 1.5);
    const updated = projectFS.readFile(FILE)!;

    expect(updated).toContain("'default': { to: 'variant-1', delay: 1500 }");
    expect(updated).not.toContain("delay: 300");
  });

  test('chain map shrinks when an inView edge is removed', () => {
    resetProjectFS(new Map([[FILE, baseCode]]));
    addConnection(FILE, 'default', 'variant-1', 'inView', 0.3);
    addConnection(FILE, 'variant-1', 'default', 'inView', 0.3);
    removeConnection(FILE, 'variant-1', 'default');
    const updated = projectFS.readFile(FILE)!;

    expect(updated).toContain("'default': { to: 'variant-1', delay: 300 }");
    expect(updated).not.toContain("'variant-1': { to: 'default'");
  });
});

// removeConnectionEntry — surgical (from, to, trigger) removal that does
// NOT regenerate JSX handlers. Used by `addInteractionState`'s chain
// rewrite when a single connection needs to be re-routed (e.g. pressed
// click → source becomes pressed click → hover) and we want the existing
// onTap ternary preserved while addConnection wires up the new entry.

describe('removeConnectionEntry', () => {
  const FILE = 'components/Foo.tsx';
  const baseCode = `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Default - Hover', x: 0, y: 600,
    interactionType: 'hover', parentVariant: 'default' },
  { name: 'default-pressed', label: 'Default - Pressed', x: 600, y: 600,
    interactionType: 'pressed', parentVariant: 'default' },
];
const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
  { from: 'default-pressed', to: 'default', trigger: 'click' },
];

function Foo({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <motion.div data-id="root" animate={variant} initial={initialVariant} style={{ position: 'absolute', ...style }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(Foo);
`;

  test('drops only the matching (from, to, trigger) triple', () => {
    resetProjectFS(new Map([[FILE, baseCode]]));

    removeConnectionEntry(FILE, 'default-pressed', 'default', 'click');
    const updated = projectFS.readFile(FILE)!;
    const conns = parseConnections(updated);

    // The targeted entry is gone…
    expect(conns).not.toContainEqual({
      from: 'default-pressed', to: 'default', trigger: 'click',
    });
    // …and everything else is preserved.
    expect(conns).toContainEqual({
      from: 'default', to: 'default-hover', trigger: 'mouseEnter',
    });
    expect(conns).toContainEqual({
      from: 'default-hover', to: 'default', trigger: 'mouseLeave',
    });
    expect(conns).toHaveLength(2);
  });

  test('no-op when no entry matches', () => {
    resetProjectFS(new Map([[FILE, baseCode]]));

    removeConnectionEntry(FILE, 'nonexistent', 'default', 'click');
    const updated = projectFS.readFile(FILE)!;
    const conns = parseConnections(updated);
    // Original 3 connections stay intact
    expect(conns).toHaveLength(3);
  });

  test('does NOT regenerate JSX event handlers', () => {
    // Counter-test for the reason this helper exists: removeConnection
    // (the public, coarse function) regenerates ALL handlers from the
    // remaining connection list. That's exactly what we DON'T want for
    // chain rewrites — the onTap ternary should survive across the
    // intermediate state where one entry has been removed but its
    // replacement hasn't been added yet.
    resetProjectFS(new Map([[FILE, baseCode]]));
    const before = projectFS.readFile(FILE)!;

    removeConnectionEntry(FILE, 'default-pressed', 'default', 'click');
    const after = projectFS.readFile(FILE)!;

    // Only the connections array changed. The JSX <motion.div ...>
    // body — including animate / initial / style — is untouched.
    const beforeJsxBody = before.split('return (')[1]!;
    const afterJsxBody = after.split('return (')[1]!;
    expect(afterJsxBody).toBe(beforeJsxBody);
  });

  test('matches by trigger — same (from, to) but different trigger stays', () => {
    const code = baseCode.replace(
      `{ from: 'default-pressed', to: 'default', trigger: 'click' },`,
      `{ from: 'default-pressed', to: 'default', trigger: 'click' },
  { from: 'default-pressed', to: 'default', trigger: 'mouseLeave' },`,
    );
    resetProjectFS(new Map([[FILE, code]]));

    removeConnectionEntry(FILE, 'default-pressed', 'default', 'click');
    const conns = parseConnections(projectFS.readFile(FILE)!);

    expect(conns).not.toContainEqual({
      from: 'default-pressed', to: 'default', trigger: 'click',
    });
    // The (default-pressed, default, mouseLeave) entry survives — same
    // (from, to) but different trigger.
    expect(conns).toContainEqual({
      from: 'default-pressed', to: 'default', trigger: 'mouseLeave',
    });
  });
});

// ─── sourceNode (per-child connection triggers) ────────────────────────────
//
// When a connection carries `sourceNode`, the generated event handler
// should land on the JSX tag with that `data-id`, NOT on the variant
// root. Multiple connections on the SAME `(sourceNode, trigger)` group
// into one ternary handler on that element. Different `sourceNode`s
// produce separate handlers on separate elements.

describe('sourceNode (per-child connection triggers)', () => {
  const FILE = 'components/Card.tsx';
  const codeWithChild = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 600, y: 0 },
];

const childVariants = {
  default: { color: '#000' },
  'variant-1': { color: '#fff' },
};

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ position: 'absolute', ...style }}>
        <motion.div data-id="child-button" variants={childVariants} initial={initialVariant} style={{ position: 'absolute' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

  test('serializes + parses sourceNode round-trip', () => {
    const conns: Connection[] = [
      { from: 'default', to: 'variant-1', trigger: 'click', sourceNode: 'child-button' },
    ];
    const serialized = serializeConnections(conns);
    expect(serialized).toContain("sourceNode: 'child-button'");

    const reparsed = parseConnections(serialized);
    expect(reparsed[0].sourceNode).toBe('child-button');
  });

  test('omits sourceNode field when not set', () => {
    const conns: Connection[] = [{ from: 'default', to: 'variant-1', trigger: 'click' }];
    const serialized = serializeConnections(conns);
    expect(serialized).not.toContain('sourceNode');
  });

  test('addConnection with sourceNode places onTap on the matching child JSX tag', () => {
    resetProjectFS(new Map([[FILE, codeWithChild]]));

    addConnection(FILE, 'default', 'variant-1', 'click', undefined, 'child-button');
    const updated = projectFS.readFile(FILE)!;

    const conns = parseConnections(updated);
    expect(conns).toHaveLength(1);
    expect(conns[0].sourceNode).toBe('child-button');

    // The onTap handler is on the CHILD tag, not the root.
    const childIdx = updated.indexOf('data-id="child-button"');
    expect(childIdx).toBeGreaterThan(0);
    const tagStart = updated.lastIndexOf('<motion.', childIdx);
    const tagEnd = updated.indexOf('>', childIdx);
    const childTag = updated.slice(tagStart, tagEnd + 1);
    expect(childTag).toContain('onTap=');
    // Gated by `from` (per-variant): only fires when in 'default'.
    expect(childTag).toContain("const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n);");

    // Root tag should NOT carry onTap.
    const rootIdx = updated.indexOf('data-id="root"');
    const rootTagStart = updated.lastIndexOf('<motion.', rootIdx);
    const rootTagEnd = updated.indexOf('>', rootIdx);
    const rootTag = updated.slice(rootTagStart, rootTagEnd + 1);
    expect(rootTag).not.toContain('onTap=');
  });

  test('addConnection without sourceNode places onTap on the root', () => {
    resetProjectFS(new Map([[FILE, codeWithChild]]));

    addConnection(FILE, 'default', 'variant-1', 'click');
    const updated = projectFS.readFile(FILE)!;

    const rootIdx = updated.indexOf('data-id="root"');
    const rootTagStart = updated.lastIndexOf('<motion.', rootIdx);
    const rootTagEnd = updated.indexOf('>', rootIdx);
    const rootTag = updated.slice(rootTagStart, rootTagEnd + 1);
    expect(rootTag).toContain('onTap=');
  });

  test('two click connections on the SAME sourceNode group into a ternary', () => {
    resetProjectFS(new Map([[FILE, codeWithChild]]));

    addConnection(FILE, 'default', 'variant-1', 'click', undefined, 'child-button');
    addConnection(FILE, 'variant-1', 'default', 'click', undefined, 'child-button');
    const updated = projectFS.readFile(FILE)!;

    const childIdx = updated.indexOf('data-id="child-button"');
    const tagStart = updated.lastIndexOf('<motion.', childIdx);
    const tagEnd = updated.indexOf('>', childIdx);
    const childTag = updated.slice(tagStart, tagEnd + 1);
    expect(childTag).toContain("variant === 'default' ? 'variant-1'");
    expect(childTag).toContain("variant === 'variant-1' ? 'default'");
    const onTapCount = (childTag.match(/onTap=/g) ?? []).length;
    expect(onTapCount).toBe(1);
  });

  test('mixed root + child connections — each lands on the correct tag', () => {
    resetProjectFS(new Map([[FILE, codeWithChild]]));

    addConnection(FILE, 'default', 'variant-1', 'mouseEnter');
    addConnection(FILE, 'default', 'variant-1', 'click', undefined, 'child-button');
    const updated = projectFS.readFile(FILE)!;

    const rootIdx = updated.indexOf('data-id="root"');
    const rootTagStart = updated.lastIndexOf('<motion.', rootIdx);
    const rootTagEnd = updated.indexOf('>', rootIdx);
    const rootTag = updated.slice(rootTagStart, rootTagEnd + 1);
    expect(rootTag).toContain('onHoverStart=');
    expect(rootTag).not.toContain('onTap=');

    const childIdx = updated.indexOf('data-id="child-button"');
    const childTagStart = updated.lastIndexOf('<motion.', childIdx);
    const childTagEnd = updated.indexOf('>', childIdx);
    const childTag = updated.slice(childTagStart, childTagEnd + 1);
    expect(childTag).toContain('onTap=');
    expect(childTag).not.toContain('onHoverStart=');
  });

  test('removing the only connection cleans up the handler', () => {
    resetProjectFS(new Map([[FILE, codeWithChild]]));

    addConnection(FILE, 'default', 'variant-1', 'click', undefined, 'child-button');
    let updated = projectFS.readFile(FILE)!;
    expect(updated).toContain('onTap=');

    removeConnection(FILE, 'default', 'variant-1');
    updated = projectFS.readFile(FILE)!;
    expect(updated).not.toContain('onTap=');
    expect(parseConnections(updated)).toHaveLength(0);
  });

  test('same (from, to, trigger) on different sourceNodes is NOT a duplicate', () => {
    const codeWithTwoChildren = codeWithChild.replace(
      `<motion.div data-id="child-button" variants={childVariants} initial={initialVariant} style={{ position: 'absolute' }} />`,
      `<motion.div data-id="child-a" variants={childVariants} initial={initialVariant} style={{ position: 'absolute' }} />
        <motion.div data-id="child-b" variants={childVariants} initial={initialVariant} style={{ position: 'absolute' }} />`,
    );
    resetProjectFS(new Map([[FILE, codeWithTwoChildren]]));

    addConnection(FILE, 'default', 'variant-1', 'click', undefined, 'child-a');
    addConnection(FILE, 'default', 'variant-1', 'click', undefined, 'child-b');
    const conns = parseConnections(projectFS.readFile(FILE)!);
    expect(conns).toHaveLength(2);
    expect(conns.map(c => c.sourceNode).sort()).toEqual(['child-a', 'child-b']);
  });
});

// ─── Connections on NESTED COMPONENT INSTANCES ───────────────────────────────
describe('addConnection — nested component instance source', () => {
  const PARENT = 'components/Parent.tsx';
  const CHILD = 'components/JiPoZa.tsx';

  const childCode = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Menu Button" */

const variantConfig = [
  { name: 'default', label: 'Menu Button', x: 0, y: 0, isPrimary: true },
];

function JiPoZa({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div layout={true} data-id="jp-root" data-name="Menu Button" initial={initialVariant} style={{ position: 'absolute', ...style }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(JiPoZa);
`;

  const parentCode = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import JiPoZa from '@/components/JiPoZa';

const variantConfig = [
  { name: 'default', label: 'Parent', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 600, y: 0 },
];

function Parent({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{ position: 'absolute', ...style }}>
        <JiPoZa data-id="inst-1" data-name="JiPoZa" style={{ position: 'absolute' }} />
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Parent);
`;

  test('writes onTap on the component-instance tag in the parent', () => {
    resetProjectFS(new Map([[PARENT, parentCode], [CHILD, childCode]]));

    addConnection(PARENT, 'default', 'variant-1', 'click', undefined, 'inst-1');
    const updated = projectFS.readFile(PARENT)!;

    // The handler lands on the <JiPoZa> instance tag, not the root.
    const instIdx = updated.indexOf('data-id="inst-1"');
    const tagStart = updated.lastIndexOf('<JiPoZa', instIdx);
    const tagEnd = updated.indexOf('/>', instIdx);
    const instTag = updated.slice(tagStart, tagEnd + 2);
    expect(instTag).toContain("onTap={() => { const _n = variant === 'default' ? 'variant-1' : null; if (_n) setVariant(_n); }}");

    const rootIdx = updated.indexOf('data-id="root"');
    const rootTag = updated.slice(updated.lastIndexOf('<motion.', rootIdx), updated.indexOf('>', rootIdx) + 1);
    expect(rootTag).not.toContain('onTap=');
  });

  test('patches the child component to forward event props to its root', () => {
    resetProjectFS(new Map([[PARENT, parentCode], [CHILD, childCode]]));
    expect(projectFS.readFile(CHILD)).not.toContain('...rest');

    addConnection(PARENT, 'default', 'variant-1', 'click', undefined, 'inst-1');

    const child = projectFS.readFile(CHILD)!;
    expect(child).toContain('...rest');
    // Spread onto the child's root motion element so the forwarded onTap fires.
    expect(child).toContain('<motion.div {...rest}');
  });

  test('removing the connection strips onTap from the instance tag', () => {
    resetProjectFS(new Map([[PARENT, parentCode], [CHILD, childCode]]));

    addConnection(PARENT, 'default', 'variant-1', 'click', undefined, 'inst-1');
    expect(projectFS.readFile(PARENT)!).toContain('onTap=');

    removeConnection(PARENT, 'default', 'variant-1');
    const updated = projectFS.readFile(PARENT)!;
    expect(updated).not.toContain('onTap=');
    expect(parseConnections(updated)).toHaveLength(0);
  });
});

// A root that carries an Appear effect's OBJECT initial must NOT also get the
// variant-array initial — duplicate JSX attribute: React keeps the LAST
// (appear dies), the parser reads the FIRST (variant wiring invisible). The
// live find (2026-07-03): creating a hover variant on a cursor-carrying master
// scrambled the appear + hover behavior.
describe('generateConnectionCode — appear-initial root keeps a SINGLE initial', () => {
  const MASTER = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';

const variantConfig = [
  { name: 'default', label: 'Row', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Row - Hover', x: 0, y: 176, interactionType: 'hover', parentVariant: 'default' },
];

function JiRoKu({ style, initialVariant = 'default', ...rest }: {style?: React.CSSProperties;initialVariant?: string;[key: string]: any;}) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="service-1" {...rest} data-name="Row" initial={{ opacity: 0, y: 28 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.75 }} style={{ position: 'absolute', width: '1180px', ...style }}>
      <motion.p layout={true} data-id="service-1-num" data-name="Index" style={{ position: 'relative', margin: '0' }}>x</motion.p>
    </motion.div>
    </LayoutGroup>);
}

export default JiRoKu;
`;

  test('does not emit a duplicate initial attribute', () => {
    const out = generateConnectionCode(MASTER, [
      { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
      { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
    ]);
    // the appear object initial survives, the array form is NOT added on the root
    expect(out).toContain('initial={{ opacity: 0, y: 28 }}');
    expect(out).not.toContain("initial={['default', initialVariant]}");
    // still variant-driven
    expect(out).toContain("animate={['default', variant]}");
    // exactly ONE initial on the root tag
    const rootTag = out.slice(out.indexOf('<motion.div'), out.indexOf('>', out.indexOf('data-name="Row"')));
    expect((rootTag.match(/initial=/g) ?? []).length).toBe(1);
  });
});

describe('generateConnectionCode — MotionLink root (motion.create(Link))', () => {
  // EMPIRICAL PIN, live find 2026-07-14: adding a Hover variant to the
  // "Explore CTA" master (a MotionLink root — the next/link escape hatch)
  // wrote the `connections` array but the handler/animate insertion only
  // scanned for '<motion.' tags — the root got NO onHoverStart/onHoverEnd,
  // so the hover variant never fired.
  const MASTER = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import Link from 'next/link';

const MotionLink = motion.create(Link);

const variantConfig = [
  { name: 'default', label: 'Explore CTA', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Explore CTA - Hover', x: 0, y: 60, interactionType: 'hover', parentVariant: 'default' },
];

const worksCtaVariants = {
  default: { color: '#EDEDED' },
  'default-hover': { backgroundColor: '#ffffff', color: '#000000' },
};

function WeNuKu({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <MotionLink layout={true} href="/works" data-id="works-cta" variants={worksCtaVariants} {...rest} data-name="Explore CTA" style={{ position: 'absolute', width: '202px', ...style }}>Explore all works</MotionLink>
    </LayoutGroup>
  );
}

export default WeNuKu;
`;

  test('root hover connections land onHoverStart/onHoverEnd + animate on the MotionLink', () => {
    const out = generateConnectionCode(MASTER, [
      { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
      { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
    ]);
    const rootTag = out.slice(out.indexOf('<MotionLink'), out.indexOf('>', out.indexOf('data-name="Explore CTA"')));
    expect(rootTag).toContain('onHoverStart={');
    expect(rootTag).toContain('onHoverEnd={');
    expect(rootTag).toContain("animate={['default', variant]}");
    expect(rootTag).toContain("initial={['default', initialVariant]}");
    // handlers gate on the from-variant
    expect(out).toContain("variant === 'default' ? 'default-hover'");
    expect(out).toContain("variant === 'default-hover' ? 'default'");
    // nothing landed on the LayoutGroup wrapper
    expect(out.slice(out.indexOf('<LayoutGroup'), out.indexOf('<MotionLink'))).not.toContain('onHoverStart');
  });
});

// ─── Click delay + the afterDelay auto-advance trigger ──────────────────────
// The Interactions modal has always shown a Delay field, but codegen only ever
// consumed it for `inView` — a click connection stored the value and ignored it
// (user report 2026-07-30). And a plain delay can't sequence "children out THEN
// container closes" anyway, which is what `afterDelay` (an auto-advance hop, the
// reference's After Delay trigger) is for.

describe('connection delay + afterDelay trigger', () => {
  const SRC = (conns: string) => `import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }, { name: 'open', label: 'B', x: 100, y: 0 }];

const connections = [
${conns}
];

function Menu({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return (
    <LayoutGroup>
      <motion.div data-id="menu-root" style={{ position: 'absolute', ...style }} animate={variant}>
        <motion.div data-id="burger" style={{ position: 'relative' }}></motion.div>
      </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(Menu);
`;

  it('a click connection with NO delay keeps the bare handler (unchanged)', () => {
    const out = generateConnectionCode(SRC(`{ from: 'default', to: 'open', trigger: 'click', sourceNode: 'burger' },`),
      [{ from: 'default', to: 'open', trigger: 'click', sourceNode: 'burger' }]);
    expect(out).toContain("onTap={() => { const _n = variant === 'default' ? 'open' : null; if (_n) setVariant(_n); }}");
    expect(out).not.toContain('setTimeout');
  });

  it('a click connection WITH a delay schedules the switch', () => {
    const out = generateConnectionCode(SRC(`{ from: 'open', to: 'default', trigger: 'click', delay: 0.55, sourceNode: 'burger' },`),
      [{ from: 'open', to: 'default', trigger: 'click', delay: 0.55, sourceNode: 'burger' }]);
    expect(out).toContain('setTimeout');
    expect(out).toContain('_d = variant === \'open\' ? 550');
    // matched-only set: the no-match branch is null and setVariant is guarded
    expect(out).toContain("const _n = variant === 'open' ? 'default' : null");
    expect(out).toContain('if (_n) { const _d =');
    expect(out).toContain('setTimeout(() => setVariant(_n), _d)');
  });

  it('afterDelay emits an auto-advance chain and NO event handler', () => {
    const out = generateConnectionCode(SRC(`{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 },`),
      [{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 }]);
    expect(out).toContain('__afterDelayChain');
    expect(out).toContain("'open': { to: 'default', delay: 550 }");
    expect(out).toContain('setTimeout(() => setVariant(next.to), next.delay)');
    expect(out).toContain('clearTimeout(timer)');
    // time-driven: it must not hang onTap / onViewportEnter anywhere
    expect(out).not.toContain('onTap=');
    expect(out).not.toContain('onViewportEnter=');
  });

  it('afterDelay round-trips through parse/serialize with its delay', () => {
    const out = generateConnectionCode(SRC(`{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 },`),
      [{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 }]);
    const back = parseConnections(out);
    expect(back).toEqual([{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 }]);
  });

  it('regenerating replaces the chain instead of stacking copies', () => {
    let out = generateConnectionCode(SRC(`{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 },`),
      [{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.55 }]);
    out = generateConnectionCode(out, [{ from: 'open', to: 'default', trigger: 'afterDelay', delay: 0.9 }]);
    // count DECLARATIONS — the identifier appears twice per chain (decl + lookup)
    expect(out.match(/const __afterDelayChain:/g)?.length).toBe(1);
    expect(out).toContain('delay: 900');
    expect(out).not.toContain('delay: 550');
  });
});
