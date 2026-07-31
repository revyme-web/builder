import { describe, it, expect } from 'vitest';
import {
  parseIconSetConfig,
  serializeIconSetConfig,
  replaceIconSetConfigInCode,
  createDefaultIconSetConfig,
  iconConfigPx,
} from './icon-set-config';

describe('iconConfigPx', () => {
  it('accepts px and unitless values', () => {
    expect(iconConfigPx('840px', 0)).toBe(840);
    expect(iconConfigPx('-102px', 0)).toBe(-102);
    expect(iconConfigPx('366', 0)).toBe(366);
    expect(iconConfigPx('12.5px', 0)).toBe(12.5);
  });

  it('rejects percent anchors — the mouse-up jump bug', () => {
    // A mid-band dynamic pin once committed `left: "48.6026%"`; parseFloat
    // read it as 48.6px and the card jumped ~790px left. The guard must
    // keep the entry's current value instead.
    expect(iconConfigPx('48.6026%', 840)).toBe(840);
    expect(iconConfigPx('100%', 240)).toBe(240);
  });

  it('falls back for missing or unparseable values', () => {
    expect(iconConfigPx(undefined, 560)).toBe(560);
    expect(iconConfigPx('', 560)).toBe(560);
    expect(iconConfigPx('auto', 560)).toBe(560);
    expect(iconConfigPx('calc(50% - 10px)', 560)).toBe(560);
  });
});

describe('parseIconSetConfig', () => {
  it('parses an iconConfig array out of source', () => {
    const code = `
import React from 'react';

const iconConfig = [
  { name: 'icon-1', label: 'Star', x: 0, y: 0, width: 240, height: 240, isPrimary: true },
  { name: 'icon-2', label: 'Circle', x: 280, y: 0, width: 240, height: 240 },
];

export default function Foo() { return null; }
`;
    const configs = parseIconSetConfig(code);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ name: 'icon-1', label: 'Star', x: 0, y: 0, isPrimary: true });
    expect(configs[1]).toMatchObject({ name: 'icon-2', label: 'Circle', x: 280, y: 0 });
  });

  it('returns [] when iconConfig is missing (legacy files)', () => {
    expect(parseIconSetConfig('export default function Foo() {}')).toEqual([]);
  });
});

describe('serializeIconSetConfig', () => {
  it('round-trips a config array through serialize → parse', () => {
    const original = [
      { name: 'icon-1', label: 'A', x: 0, y: 0, width: 240, height: 240, isPrimary: true },
      { name: 'icon-2', label: 'B', x: 280, y: 100, width: 240, height: 240 },
    ];
    const serialized = serializeIconSetConfig(original);
    const reparsed = parseIconSetConfig(serialized + '\nexport default function F() {}');
    // Parser fills isPrimary from positional default (first = true, rest = false)
    expect(reparsed[0]).toMatchObject({ name: 'icon-1', isPrimary: true });
    expect(reparsed[1]).toMatchObject({ name: 'icon-2', isPrimary: false });
    expect(reparsed.map(c => ({ x: c.x, y: c.y, width: c.width, height: c.height })))
      .toEqual(original.map(c => ({ x: c.x, y: c.y, width: c.width, height: c.height })));
  });

  it('rounds floats — drag math leaves sub-pixel positions and we want clean source', () => {
    const out = serializeIconSetConfig([
      { name: 'icon-1', label: 'V', x: 12.7, y: 33.4, width: 240.9, height: 240.1 },
    ]);
    expect(out).toContain('x: 13');
    expect(out).toContain('y: 33');
    expect(out).toContain('width: 241');
  });
});

describe('replaceIconSetConfigInCode', () => {
  it('replaces an existing iconConfig block in place', () => {
    const before = `import React from 'react';\n\nconst iconConfig = [\n  { name: 'icon-1', label: 'V', x: 0, y: 0, width: 240, height: 240, isPrimary: true },\n];\n\nexport default function F() {}`;
    const after = replaceIconSetConfigInCode(before, [
      { name: 'icon-1', label: 'V', x: 100, y: 0, width: 240, height: 240, isPrimary: true },
    ]);
    expect(after).toContain('x: 100');
    expect(after).not.toContain('x: 0');
    // Surrounding code untouched
    expect(after).toContain("import React from 'react'");
    expect(after).toContain('export default function F');
  });

  it('injects iconConfig after the last import when source has none yet', () => {
    const before = `import React from 'react';\nimport other from './other';\n\nexport default function F() {}`;
    const after = replaceIconSetConfigInCode(before, createDefaultIconSetConfig());
    expect(after).toContain('const iconConfig = [');
    // Imports preserved + still come first
    expect(after.indexOf("import React")).toBeLessThan(after.indexOf('const iconConfig'));
    expect(after.indexOf("import other")).toBeLessThan(after.indexOf('const iconConfig'));
  });
});
