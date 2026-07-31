import { describe, test, expect } from 'vitest';
import { parseCanvasConfig, serializeCanvasConfig, updateCanvasConfigInCode, stripCanvasConfig } from './canvas-config';

const CODE_WITH_CONFIG = `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 }
  ],
  "positions": {
    "desktop": { "x": 100, "y": 200 },
    "tablet": { "x": 1700, "y": 0 }
  }
} */

import React from 'react';
export default function Page() { return <div data-id="root">Hello</div>; }
`;

const CODE_WITHOUT_CONFIG = `'use client';

import React from 'react';
export default function Page() { return <div data-id="root">Hello</div>; }
`;

const CODE_NO_USE_CLIENT = `import React from 'react';
export default function Page() { return <div data-id="root">Hello</div>; }
`;

describe('parseCanvasConfig', () => {
  test('parses config from code with @canvas block', () => {
    const config = parseCanvasConfig(CODE_WITH_CONFIG);
    expect(config).not.toBeNull();
    expect(config!.viewports).toHaveLength(2);
    expect(config!.viewports[0].id).toBe('desktop');
    expect(config!.viewports[0].width).toBe(1440);
    expect(config!.viewports[0].isPrimary).toBe(true);
    expect(config!.positions.desktop).toEqual({ x: 100, y: 200 });
    expect(config!.positions.tablet).toEqual({ x: 1700, y: 0 });
  });

  test('returns null when no @canvas block', () => {
    expect(parseCanvasConfig(CODE_WITHOUT_CONFIG)).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    const bad = `/** @canvas { not valid json } */\nexport default function Page() {}`;
    expect(parseCanvasConfig(bad)).toBeNull();
  });
});

describe('serializeCanvasConfig', () => {
  test('serializes config to comment block', () => {
    const result = serializeCanvasConfig({
      viewports: [{ id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 0, y: 0 }],
      positions: { desktop: { x: 0, y: 0 } },
    });
    expect(result).toContain('/** @canvas');
    expect(result).toContain('"desktop"');
    expect(result).toContain('*/');
  });

  test('does not include x, y in viewport entries', () => {
    const result = serializeCanvasConfig({
      viewports: [{ id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 100, y: 200 }],
      positions: { desktop: { x: 100, y: 200 } },
    });
    // The viewport entry should only have id, label, width, isPrimary, order
    const parsed = JSON.parse(result.replace(/\/\*\*\s*@canvas\s*/, '').replace(/\s*\*\/\s*$/, ''));
    const vp = parsed.viewports[0];
    expect(vp).toEqual({ id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0 });
    expect(vp.x).toBeUndefined();
    expect(vp.y).toBeUndefined();
  });
});

describe('updateCanvasConfigInCode', () => {
  test('replaces existing @canvas block', () => {
    const config = {
      viewports: [{ id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 0, y: 0 }],
      positions: { desktop: { x: 999, y: 888 } },
    };
    const result = updateCanvasConfigInCode(CODE_WITH_CONFIG, config);
    expect(result).toContain('"x": 999');
    expect(result).toContain('"y": 888');
    expect(result).not.toContain('"x": 100');
    expect(result).toContain("import React from 'react'");
  });

  test('inserts after use client when no existing block', () => {
    const config = {
      viewports: [{ id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 0, y: 0 }],
      positions: { desktop: { x: 0, y: 0 } },
    };
    const result = updateCanvasConfigInCode(CODE_WITHOUT_CONFIG, config);
    expect(result).toContain("'use client'");
    expect(result).toContain('/** @canvas');
    const canvasIdx = result.indexOf('/** @canvas');
    const importIdx = result.indexOf('import React');
    const useClientIdx = result.indexOf("'use client'");
    expect(canvasIdx).toBeGreaterThan(useClientIdx);
    expect(canvasIdx).toBeLessThan(importIdx);
  });

  test('inserts at top when no use client', () => {
    const config = {
      viewports: [{ id: 'desktop', label: 'Desktop', width: 1440, isPrimary: true, order: 0, x: 0, y: 0 }],
      positions: { desktop: { x: 0, y: 0 } },
    };
    const result = updateCanvasConfigInCode(CODE_NO_USE_CLIENT, config);
    expect(result.indexOf('/** @canvas')).toBe(0);
  });
});

describe('stripCanvasConfig', () => {
  test('removes the @canvas comment block', () => {
    const result = stripCanvasConfig(CODE_WITH_CONFIG);
    expect(result).not.toContain('/** @canvas');
    expect(result).not.toContain('"viewports"');
    expect(result).toContain("import React from 'react'");
    expect(result).toContain("'use client'");
  });

  test('returns code unchanged when no @canvas block', () => {
    expect(stripCanvasConfig(CODE_WITHOUT_CONFIG)).toBe(CODE_WITHOUT_CONFIG);
  });
});
