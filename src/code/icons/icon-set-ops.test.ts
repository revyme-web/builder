import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '../project/project-fs';
import { addIconToSet, removeIconFromSet, makeIconSetFromNodes } from './icon-set-ops';
import { parseIconSetConfig } from './icon-set-config';

describe('addIconToSet', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  it('appends icon to a file with the new data-id="root" template', () => {
    const filePath = 'icons/Test.tsx';
    projectFS.writeFile(filePath, `
import React from 'react';
/** @iconSet */
export default function Test() {
  const master = (
    <div data-id="root" style={{ position: 'relative' }}>
      <svg data-id="icon-1" viewBox="0 0 100 100"></svg>
    </div>
  );
  return master;
}
`);
    const result = addIconToSet(filePath);
    expect(result?.iconId).toBe('icon-2');
    const code = projectFS.readFile(filePath)!;
    // Current template wraps each icon in a <div> container (not bare svg).
    expect(code).toMatch(/<div[^>]*data-id="icon-2"/);
  });

  it('writes the source variant size into iconConfig (size option)', () => {
    // Regression — "+ Vector" used to land a 240×240 card next to a
    // 600×400 source variant, leaving the row visibly staggered. The
    // `size` option lets the UI pass the source vector's intrinsic
    // dims so the new card matches.
    const filePath = 'icons/Sized.tsx';
    projectFS.writeFile(filePath, `
import React from 'react';
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 600, height: 400, isPrimary: true },
];
export default function Sized() {
  return <div data-id="root"><div data-id="icon-1"></div></div>;
}
`);
    const result = addIconToSet(filePath, { size: { width: 600, height: 400 } });
    expect(result?.iconId).toBe('icon-2');
    const cfg = parseIconSetConfig(projectFS.readFile(filePath)!);
    const newEntry = cfg.find(c => c.name === 'icon-2')!;
    expect(newEntry.width).toBe(600);
    expect(newEntry.height).toBe(400);
  });

  it('falls back to ICON_DEFAULT_W/H when size is omitted', () => {
    const filePath = 'icons/Default.tsx';
    projectFS.writeFile(filePath, `
import React from 'react';
/** @iconSet */
export default function Default() {
  return <div data-id="root"><svg data-id="icon-1" /></div>;
}
`);
    addIconToSet(filePath);
    const cfg = parseIconSetConfig(projectFS.readFile(filePath)!);
    const newEntry = cfg.find(c => c.name === 'icon-2')!;
    expect(newEntry.width).toBe(240);
    expect(newEntry.height).toBe(240);
  });

  it('seeds an empty card by default (no placeholder rect)', () => {
    // Regression — the default content used to be a positioned wrapper
    // SVG with `<rect fill="#3b82f6" />` inside, which forced the user
    // to delete the blue rectangle before drawing. Empty default lets
    // them start drawing immediately.
    const filePath = 'icons/Empty.tsx';
    projectFS.writeFile(filePath, `
import React from 'react';
/** @iconSet */
export default function Empty() {
  return <div data-id="root"><div data-id="icon-1"></div></div>;
}
`);
    const result = addIconToSet(filePath);
    const code = projectFS.readFile(filePath)!;
    // Outer wrapper must still be there (drop target / selectable).
    expect(code).toMatch(new RegExp(`<div[^>]*data-id="${result!.iconId}"`));
    // No default rect / blue fill for the new entry.
    const blockStart = code.indexOf(`data-id="${result!.iconId}"`);
    const blockEnd = code.indexOf('</div>', blockStart);
    const block = code.slice(blockStart, blockEnd);
    expect(block).not.toContain('#3b82f6');
    expect(block).not.toContain('<rect');
  });

  it('still works with legacy data-id="iconset-master" files', () => {
    const filePath = 'icons/Legacy.tsx';
    projectFS.writeFile(filePath, `
import React from 'react';
/** @iconSet */
export default function Legacy() {
  const master = (
    <div data-id="iconset-master" style={{ position: 'relative' }}>
      <svg data-id="icon-1" viewBox="0 0 100 100"></svg>
    </div>
  );
  return master;
}
`);
    const result = addIconToSet(filePath);
    expect(result?.iconId).toBe('icon-2');
  });
});

describe('makeIconSetFromNodes', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  const PAGE = 'app/page.tsx';
  function writeThreeShapePage() {
    projectFS.writeFile(PAGE, `
import React from 'react';
export default function Page() {
  return (
    <div data-id="root">
      <svg data-id="tri" data-name="Triangle" style={{ position: 'absolute', left: '0px', top: '0px', width: '300px', height: '320px' }} viewBox="0 0 300 320"><polygon points="150,0 300,320 0,320" /></svg>
      <svg data-id="sk" data-name="Sketch" style={{ position: 'absolute', left: '400px', top: '0px', width: '200px', height: '560px' }} viewBox="0 0 200 560"><path d="M10 10 L 190 550" /></svg>
      <svg data-id="el" data-name="Ellipse" style={{ position: 'absolute', left: '700px', top: '0px', width: '260px', height: '260px' }} viewBox="0 0 260 260"><ellipse cx="130" cy="130" rx="120" ry="120" /></svg>
    </div>
  );
}
`);
  }

  it('creates one variant per selected node, each sized to its own shape', () => {
    writeThreeShapePage();
    const r = makeIconSetFromNodes(PAGE, ['tri', 'sk', 'el'], 'My Set');
    expect(r).toBeTruthy();
    expect(r!.iconSetFilePath).toMatch(/^icons\/.+\.tsx$/);
    expect(r!.initialIconId).toBe('icon-1');

    const cfg = parseIconSetConfig(projectFS.readFile(r!.iconSetFilePath)!);
    expect(cfg.map(c => c.name)).toEqual(['icon-1', 'icon-2', 'icon-3']);
    // Per-variant width/height matches each source shape.
    expect(cfg[0]).toMatchObject({ label: 'Triangle', width: 300, height: 320 });
    expect(cfg[1]).toMatchObject({ label: 'Sketch', width: 200, height: 560 });
    expect(cfg[2]).toMatchObject({ label: 'Ellipse', width: 260, height: 260 });
    // Cards laid out left-to-right using each variant's OWN width (+40 gap).
    expect(cfg[0].x).toBe(0);
    expect(cfg[1].x).toBe(300 + 40);
    expect(cfg[2].x).toBe(300 + 40 + 200 + 40);
  });

  it('keeps the first node as the on-page instance and removes the rest', () => {
    writeThreeShapePage();
    const r = makeIconSetFromNodes(PAGE, ['tri', 'sk', 'el'], 'My Set')!;
    const page = r.updatedPageCode;
    // First node becomes the set instance (data-id preserved, shows icon-1).
    expect(page).toMatch(/<\w+ data-id="tri"[^>]*name="icon-1"/);
    // The other two shapes are gone from the page.
    expect(page).not.toContain('data-id="sk"');
    expect(page).not.toContain('data-id="el"');
    // Import for the new set was added.
    expect(page).toMatch(/^import \w+ from '@\/icons\//m);
  });

  it('bundles a selected group (svg with nested svgs) into ONE variant', () => {
    projectFS.writeFile(PAGE, `
import React from 'react';
export default function Page() {
  return (
    <div data-id="root">
      <svg data-id="grp" data-name="Pair" style={{ position: 'absolute', left: '0px', top: '0px', width: '400px', height: '200px' }}>
        <svg data-id="g1" style={{ position: 'absolute', left: '0px', top: '0px', width: '100px', height: '100px' }} viewBox="0 0 100 100"><rect width="100" height="100" /></svg>
        <svg data-id="g2" style={{ position: 'absolute', left: '200px', top: '0px', width: '100px', height: '100px' }} viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" /></svg>
      </svg>
      <svg data-id="solo" data-name="Solo" style={{ position: 'absolute', left: '600px', top: '0px', width: '100px', height: '100px' }} viewBox="0 0 100 100"><rect width="100" height="100" /></svg>
    </div>
  );
}
`);
    const r = makeIconSetFromNodes(PAGE, ['grp', 'solo'], 'Group Set')!;
    const cfg = parseIconSetConfig(projectFS.readFile(r.iconSetFilePath)!);
    // Group + solo = 2 variants (the group's two shapes do NOT split out).
    expect(cfg.map(c => c.name)).toEqual(['icon-1', 'icon-2']);
    expect(cfg[0]).toMatchObject({ label: 'Pair', width: 400, height: 200 });
    expect(cfg[1]).toMatchObject({ label: 'Solo', width: 100, height: 100 });
    // Both of the group's nested shapes live inside the first variant.
    const setCode = projectFS.readFile(r.iconSetFilePath)!;
    expect(setCode).toContain('data-id="g1"');
    expect(setCode).toContain('data-id="g2"');
  });

  it('returns null when no nodes are given', () => {
    writeThreeShapePage();
    expect(makeIconSetFromNodes(PAGE, [], 'X')).toBeNull();
  });
});

describe('removeIconFromSet', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  const SAMPLE = `
import React from 'react';
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 100, height: 100, isPrimary: true },
  { name: 'icon-2', label: 'B', x: 200, y: 0, width: 100, height: 100 },
  { name: 'icon-3', label: 'C', x: 400, y: 0, width: 100, height: 100 },
];
export default function Foo() {
  const master = (
    <div data-id="root">
      <div data-id="icon-1"><svg viewBox="0 0 100 100"></svg></div>
      <div data-id="icon-2"><svg viewBox="0 0 100 100"></svg></div>
      <div data-id="icon-3"><svg viewBox="0 0 100 100"></svg></div>
    </div>
  );
  return master;
}
`;

  it('strips both the iconConfig entry and the JSX block', () => {
    projectFS.writeFile('icons/Foo.tsx', SAMPLE);
    expect(removeIconFromSet('icons/Foo.tsx', 'icon-2')).toBe(true);
    const code = projectFS.readFile('icons/Foo.tsx')!;
    expect(code).not.toContain(`data-id="icon-2"`);
    const cfg = parseIconSetConfig(code);
    expect(cfg.map(c => c.name)).toEqual(['icon-1', 'icon-3']);
  });

  it('refuses to remove the last icon', () => {
    projectFS.writeFile('icons/Mini.tsx', `
import React from 'react';
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 100, height: 100, isPrimary: true },
];
export default function Mini() {
  return <div data-id="root"><div data-id="icon-1"><svg /></div></div>;
}
`);
    expect(removeIconFromSet('icons/Mini.tsx', 'icon-1')).toBe(false);
    const cfg = parseIconSetConfig(projectFS.readFile('icons/Mini.tsx')!);
    expect(cfg).toHaveLength(1);
  });

  it('promotes a new primary when the removed entry was primary', () => {
    projectFS.writeFile('icons/Foo.tsx', SAMPLE);
    expect(removeIconFromSet('icons/Foo.tsx', 'icon-1')).toBe(true);
    const cfg = parseIconSetConfig(projectFS.readFile('icons/Foo.tsx')!);
    expect(cfg[0].name).toBe('icon-2');
    expect(cfg[0].isPrimary).toBe(true);
  });

  it('returns false for an unknown variant id', () => {
    projectFS.writeFile('icons/Foo.tsx', SAMPLE);
    expect(removeIconFromSet('icons/Foo.tsx', 'icon-999')).toBe(false);
    // File should be unchanged.
    const cfg = parseIconSetConfig(projectFS.readFile('icons/Foo.tsx')!);
    expect(cfg).toHaveLength(3);
  });
});
