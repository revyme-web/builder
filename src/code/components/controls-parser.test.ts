import { describe, test, expect } from 'vitest';
import { parseComponentControlsMeta, hasComponentControls, parseCodeComponentDefaultSize } from './controls-parser';

const CODE_COMPONENT_CODE = `'use client';

/** @label "Animated Counter" */
/** @comment "Counts up to a target value with easing" */
/** @controls {
  "endValue": { "type": "slider", "label": "End Value", "min": 0, "max": 10000, "default": 100, "step": 1 },
  "duration": { "type": "slider", "label": "Duration (ms)", "min": 100, "max": 5000, "default": 2000, "step": 100 },
  "suffix": { "type": "text", "label": "Suffix", "default": "" },
  "color": { "type": "color", "label": "Color", "default": "#ffffff" }
} */

import { useState, useEffect } from 'react';

export default function AnimatedCounter({ endValue = 100, duration = 2000, suffix = '', color = '#ffffff' }: {
  endValue?: number; duration?: number; suffix?: string; color?: string;
}) {
  return <span style={{ color }}>{endValue}{suffix}</span>;
}
`;

const REGULAR_COMPONENT = `'use client';

export default function Button({ label = 'Click me', size = 'md' }: { label?: string; size?: string }) {
  return <button>{label}</button>;
}
`;

describe('parseComponentControlsMeta', () => {
  test('parses all annotations from a component file', () => {
    const meta = parseComponentControlsMeta(CODE_COMPONENT_CODE);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('Animated Counter');
    expect(meta!.comment).toBe('Counts up to a target value with easing');
    expect(Object.keys(meta!.controls)).toHaveLength(4);
  });

  test('parses slider control correctly', () => {
    const meta = parseComponentControlsMeta(CODE_COMPONENT_CODE)!;
    const ctrl = meta.controls.endValue;
    expect(ctrl.type).toBe('slider');
    expect(ctrl.label).toBe('End Value');
    expect(ctrl.min).toBe(0);
    expect(ctrl.max).toBe(10000);
    expect(ctrl.default).toBe(100);
    expect(ctrl.step).toBe(1);
  });

  test('parses text control correctly', () => {
    const meta = parseComponentControlsMeta(CODE_COMPONENT_CODE)!;
    const ctrl = meta.controls.suffix;
    expect(ctrl.type).toBe('text');
    expect(ctrl.default).toBe('');
  });

  test('parses color control correctly', () => {
    const meta = parseComponentControlsMeta(CODE_COMPONENT_CODE)!;
    const ctrl = meta.controls.color;
    expect(ctrl.type).toBe('color');
    expect(ctrl.default).toBe('#ffffff');
  });

  test('returns null for regular component (no @controls)', () => {
    expect(parseComponentControlsMeta(REGULAR_COMPONENT)).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    const bad = `/** @controls { not valid json } */\nexport default function X() {}`;
    expect(parseComponentControlsMeta(bad)).toBeNull();
  });

  test('handles missing @label and @comment', () => {
    const code = `/** @controls { "x": { "type": "slider", "label": "X", "default": 0, "min": 0, "max": 100 } } */\nexport default function X() {}`;
    const meta = parseComponentControlsMeta(code);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBeNull();
    expect(meta!.comment).toBeNull();
    expect(meta!.controls.x).toBeDefined();
  });
});

describe('group + transition control types', () => {
  const RICH_CODE = `/** @controls {
  "speed": { "type": "slider", "label": "Speed", "min": 0, "max": 100, "default": 50 },
  "transitionConfig": { "type": "transition", "label": "Transition", "default": { "type": "spring", "stiffness": "200" } },
  "arrows": { "type": "group", "label": "Arrows", "controls": {
    "arrowsShow": { "type": "toggle", "label": "Show", "default": true },
    "arrowsSize": { "type": "slider", "label": "Size", "min": 10, "max": 80, "default": 40 }
  }}
} */
export default function X() {}`;

  test('parses a transition control with an object default', () => {
    const meta = parseComponentControlsMeta(RICH_CODE)!;
    const ctrl = meta.controls.transitionConfig;
    expect(ctrl.type).toBe('transition');
    expect(typeof ctrl.default).toBe('object');
    expect((ctrl.default as Record<string, unknown>).type).toBe('spring');
  });

  test('parses a group control with nested controls', () => {
    const meta = parseComponentControlsMeta(RICH_CODE)!;
    const group = meta.controls.arrows;
    expect(group.type).toBe('group');
    expect(group.controls).toBeDefined();
    expect(Object.keys(group.controls!)).toEqual(['arrowsShow', 'arrowsSize']);
    expect(group.controls!.arrowsShow.type).toBe('toggle');
    expect(group.controls!.arrowsSize.type).toBe('slider');
  });
});

describe('hasComponentControls', () => {
  test('returns true for code component files', () => {
    expect(hasComponentControls(CODE_COMPONENT_CODE)).toBe(true);
  });

  test('returns false for regular components', () => {
    expect(hasComponentControls(REGULAR_COMPONENT)).toBe(false);
  });
});

describe('parseCodeComponentDefaultSize', () => {
  test('parses @defaultWidth + @defaultHeight annotations', () => {
    const code = `'use client';
/** @label "Deck" */
/** @defaultWidth 900 */
/** @defaultHeight 560 */
/** @controls { "spacing": { "type": "number", "label": "Spacing", "default": 120 } } */
export default function X() {}`;
    expect(parseCodeComponentDefaultSize(code)).toEqual({ width: 900, height: 560 });
  });

  test('accepts fractional values', () => {
    const code = `/** @defaultWidth 320.5 */\n/** @defaultHeight 240.25 */`;
    expect(parseCodeComponentDefaultSize(code)).toEqual({ width: 320.5, height: 240.25 });
  });

  test('null per missing axis', () => {
    expect(parseCodeComponentDefaultSize('/** @defaultWidth 600 */')).toEqual({ width: 600, height: null });
    expect(parseCodeComponentDefaultSize(CODE_COMPONENT_CODE)).toEqual({ width: null, height: null });
  });
});
