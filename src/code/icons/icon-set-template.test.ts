import { describe, it, expect } from 'vitest';
import { buildIconSetFile, buildIconJSXBlock, upgradeVectorSetInstanceBranch, stripMotionFromIconSvgMarkup } from './icon-set-template';

describe('buildIconSetFile', () => {
  it('emits data-id="root" on the master container', () => {
    const code = buildIconSetFile('TestSet', 'My Set', [
      { id: 'icon-1', displayName: 'Vector', svgJSX: '<svg viewBox="0 0 100 100"></svg>', leftPx: 0 },
    ]);
    expect(code).toContain('data-id="root"');
    expect(code).not.toContain('data-id="iconset-master"');
  });

  it('keeps cloneElement runtime branch intact', () => {
    const code = buildIconSetFile('TestSet', 'My Set', [
      { id: 'icon-1', displayName: 'Vector', svgJSX: '<svg viewBox="0 0 100 100"></svg>', leftPx: 0 },
    ]);
    expect(code).toContain('React.cloneElement');
    // Runtime branch is plain JS (no TS type annotations) so the bundled file
    // never trips a JS-context validator on the bare `Record` type identifier.
    expect(code).toContain("c.props['data-id'] === name");
    expect(code).not.toContain('Record<string, unknown>');
  });

  it('instance is a forwardRef motion.div that scales the vector to its card', () => {
    const code = buildIconSetFile('TestSet', 'My Set', [
      { id: 'icon-1', displayName: 'Vector', svgJSX: '<svg viewBox="0 0 100 100"></svg>', leftPx: 0 },
    ]);
    // forwardRef + motion root so instance EFFECTS (ref + motion-value styles) bind.
    expect(code).toContain("import { motion } from 'framer-motion';");
    expect(code).toMatch(/const TestSet = React\.forwardRef\(function TestSet\(\{ name, style, children, \.\.\.rest \}, ref\) \{/);
    expect(code).toContain('React.createElement(motion.div, { layout: true, ...childRest, ...rest, ...animExtra, ref: safeRef, style: safeStyle }, filledKids)');
    // Motion transform props ride on `animate` so per-variant rotation springs.
    expect(code).toContain('const animExtra = Object.keys(animateProps).length > 0 ? { animate: animateProps } : {};');
    // Guards against canvas `var:` placeholders (string ref / motion-value styles).
    expect(code).toContain("const safeRef = ref && typeof ref !== 'string' ? ref : undefined;");
    expect(code).toContain("v.slice(0, 4) === 'var:'");
    // Wrapped in withResponsiveProps so per-viewport prop overrides (e.g. the
    // icon `name`) resolve, like a design component.
    expect(code).toContain("import { withResponsiveProps } from '@revyme/runtime';");
    expect(code).toContain('export default withResponsiveProps(TestSet);');
    // Still scales each inner svg by its share of the card (NOT 100%).
    expect(code).toContain('sw / config.width');
    expect(code).toContain('sh / config.height');
    // Old plain-function / fixed-px shapes are gone.
    expect(code).not.toContain('export default function TestSet');
    expect(code).not.toContain('return React.cloneElement(child, { style: mergedStyle });');
  });
});

describe('upgradeVectorSetInstanceBranch (migration to forwardRef + motion)', () => {
  // A realistic prior-version file: plain function, proportional return.
  const priorFile = (ret: string) =>
    "import React from 'react';\n\n" +
    '/** @iconSet */\n\n' +
    'const iconConfig = [{ name: "icon-1", width: 100, height: 100 }];\n\n' +
    'export default function Foo({ name, style }) {\n' +
    '  const master = (<div data-id="root"><div data-id="icon-1"/></div>);\n' +
    '  if (!name) return master;\n' +
    '  const child = master.props.children;\n' +
    '  const config = iconConfig.find((c) => c.name === name);\n' +
    '  const mergedStyle = {};\n' +
    ret + '\n' +
    '}\n';
  const OLD_FILE = priorFile('  return React.cloneElement(child, { style: mergedStyle });');
  const V2_FILE = priorFile(
    '  const filledKids = React.Children.map(child.props.children, (gc) => gc);\n' +
    '  return React.cloneElement(child, { style: mergedStyle }, filledKids);');
  // An EARLIER forwardRef+motion version (no var: guards) — ends with `export
  // default Foo;`, so the migration must re-apply (add the guards).
  const MOTION_NOGUARD_FILE =
    "import React from 'react';\nimport { motion } from 'framer-motion';\n\n" +
    'const iconConfig = [{ name: "icon-1", width: 100, height: 100 }];\n\n' +
    'const Foo = React.forwardRef(function Foo({ name, style, children, ...rest }, ref) {\n' +
    '  const master = (<div data-id="root"><div data-id="icon-1"/></div>);\n' +
    '  if (!name) return master;\n' +
    '  const child = master.props.children;\n' +
    '  const config = iconConfig.find((c) => c.name === name);\n' +
    '  const mergedStyle = {};\n' +
    '  const filledKids = [];\n' +
    '  const { style: _cs, children: _cc, ...childRest } = child.props;\n' +
    '  return React.createElement(motion.div, { ...childRest, ...rest, ref, style: mergedStyle }, filledKids);\n' +
    '});\n\nexport default Foo;\n';

  for (const [name, f] of [['fixed-px', OLD_FILE], ['proportional', V2_FILE], ['motion-no-guard', MOTION_NOGUARD_FILE]] as const) {
    it(`upgrades a ${name} file to the guarded forwardRef + motion render`, () => {
      const out = upgradeVectorSetInstanceBranch(f);
      expect(out).toContain('const Foo = React.forwardRef(function Foo({ name, style, children, ...rest }, ref) {');
      expect(out).toContain('React.createElement(motion.div, { layout: true, ...childRest, ...rest, ...animExtra, ref: safeRef, style: safeStyle }, filledKids)');
      expect(out).toContain('const safeRef =');
      // Migration also wraps the export in withResponsiveProps + adds the import.
      expect(out).toContain('export default withResponsiveProps(Foo);');
      expect(out).toContain("import { withResponsiveProps } from '@revyme/runtime';");
      // The master JSX + iconConfig are preserved; the old export shape is gone.
      expect(out).toContain('const iconConfig =');
      expect(out).toContain('<div data-id="root">');
      expect(out).not.toContain('export default function Foo');
      // Exactly one default export.
      expect(out.match(/export default/g)?.length).toBe(1);
    });
  }

  it('is idempotent', () => {
    for (const f of [OLD_FILE, V2_FILE, MOTION_NOGUARD_FILE]) {
      const once = upgradeVectorSetInstanceBranch(f);
      expect(upgradeVectorSetInstanceBranch(once)).toBe(once);
    }
  });

  it('is a no-op on unrelated code', () => {
    const other = 'export default function Bar() { return <div/>; }';
    expect(upgradeVectorSetInstanceBranch(other)).toBe(other);
  });

  it('a freshly-built file is already upgraded (migration no-ops)', () => {
    const fresh = buildIconSetFile('TestSet', 'My Set', [
      { id: 'icon-1', displayName: 'Vector', svgJSX: '<svg viewBox="0 0 100 100"></svg>', leftPx: 0 },
    ]);
    expect(upgradeVectorSetInstanceBranch(fresh)).toBe(fresh);
  });
});

describe('buildIconJSXBlock', () => {
  it('wraps the icon in a <div> container (not an <svg>)', () => {
    const block = buildIconJSXBlock({
      id: 'icon-1', displayName: 'Vector', leftPx: 0,
      svgJSX: '<svg viewBox="0 0 100 100"><rect x="35" y="35" width="30" height="30" fill="#3b82f6" /></svg>',
    });
    expect(block).toMatch(/^<div[^>]*data-id="icon-1"/);
    expect(block).toContain('backgroundColor: \'#ffffff\'');
  });

  it('passes the supplied svgJSX through verbatim as a child of the div', () => {
    const block = buildIconJSXBlock({
      id: 'icon-1', displayName: 'Vector', leftPx: 0,
      svgJSX: '<svg data-name="Rectangle" viewBox="0 0 80 80" style={{ position: "absolute", width: "80px", height: "80px", left: "80px", top: "80px" }}><rect width="100%" height="100%" fill="#3b82f6" /></svg>',
    });
    // The wrapper SVG's positioning ride-through is what makes the
    // default shape drag-able via the standard CSS-position drag flow.
    expect(block).toContain('position: "absolute"');
    expect(block).toContain('left: "80px"');
    expect(block).toContain('<rect width="100%" height="100%"');
  });
});

describe('stripMotionFromIconSvgMarkup + master normalisation', () => {
  // A vector that was promoted to <motion.svg> with variant bindings while it lived
  // in a component/variant — those page vars crash inside the icon file.
  const PROMOTED = '<motion.svg data-id="v" variants={vVariants} initial={initialVariant} animate={initialVariant} layout={true} data-name="Group" viewBox="0 0 10 10" style={{width:"10px"}}><svg data-id="s" viewBox="0 0 5 5"><polygon points="0,0 5,5 0,5"/></svg></motion.svg>';

  it('demotes motion.svg → svg and strips variant/effect props', () => {
    const out = stripMotionFromIconSvgMarkup(PROMOTED);
    expect(out).not.toContain('motion.svg');
    expect(out).not.toContain('variants=');
    expect(out).not.toContain('initial=');
    expect(out).not.toContain('animate=');
    expect(out).not.toContain('layout=');
    // The geometry + data-id survive.
    expect(out).toContain('<svg data-id="v"');
    expect(out).toContain('<polygon points="0,0 5,5 0,5"/>');
    expect(out).toContain('</svg>');
    // Idempotent.
    expect(stripMotionFromIconSvgMarkup(out)).toBe(out);
  });

  it('leaves a clean svg untouched', () => {
    const clean = '<svg data-id="v" viewBox="0 0 10 10"><polygon/></svg>';
    expect(stripMotionFromIconSvgMarkup(clean)).toBe(clean);
  });

  it('migration normalises a stray motion.svg master (ReferenceError fix) and keeps motion.div instance', () => {
    // A current (guarded) icon file whose MASTER vector got a stray motion.svg.
    const file =
      "'use client';\nimport React from 'react';\nimport { motion } from 'framer-motion';\n\n/** @iconSet */\n\n" +
      'const iconConfig = [{ name: "icon-1", width: 10, height: 10 }];\n\n' +
      'const Foo = React.forwardRef(function Foo({ name, style, children, ...rest }, ref) {\n' +
      '  const master = (\n    <div data-id="root"><div data-id="icon-1"><motion.svg data-id="v" variants={vVariants} initial={initialVariant} animate={initialVariant} viewBox="0 0 10 10"><polygon/></motion.svg></div></div>\n  );\n' +
      '  if (!name) return master;\n' +
      '  const safeRef = ref && typeof ref !== "string" ? ref : undefined;\n' +
      '  return React.createElement(motion.div, { ref: safeRef }, []);\n' +
      '});\n\nexport default Foo;\n';
    const out = upgradeVectorSetInstanceBranch(file);
    // Master vector demoted to plain <svg>, stray bindings gone.
    expect(out).not.toContain('<motion.svg');
    expect(out).not.toContain('vVariants');
    expect(out).not.toContain('initialVariant');
    // The instance's motion.div root is preserved.
    expect(out).toContain('React.createElement(motion.div');
    // Idempotent.
    expect(upgradeVectorSetInstanceBranch(out)).toBe(out);
  });
});
