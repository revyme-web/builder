import { describe, test, expect } from 'vitest';
import {
  easeToMotion,
  parseTransitionShorthand, formatTransitionShorthand,
  parseAnimationShorthand, formatAnimationShorthand,
  parseKeyframes, formatKeyframes,
  transitionSummary, animationSummary,
} from '@/shared/animation-utils';

// ─── CSS Transition ──────────────────────────────────────────────────────────

describe('parseTransitionShorthand', () => {
  test('parses single transition', () => {
    const result = parseTransitionShorthand('all 0.3s ease');
    expect(result).toEqual([{ property: 'all', duration: 0.3, easing: 'ease', delay: 0 }]);
  });

  test('parses transition with delay', () => {
    const result = parseTransitionShorthand('opacity 0.5s ease-in-out 0.1s');
    expect(result).toEqual([{ property: 'opacity', duration: 0.5, easing: 'ease-in-out', delay: 0.1 }]);
  });

  test('parses multiple transitions', () => {
    const result = parseTransitionShorthand('transform 0.5s ease-in-out, opacity 0.3s ease 0.1s');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ property: 'transform', duration: 0.5, easing: 'ease-in-out', delay: 0 });
    expect(result[1]).toEqual({ property: 'opacity', duration: 0.3, easing: 'ease', delay: 0.1 });
  });

  test('parses cubic-bezier easing', () => {
    const result = parseTransitionShorthand('transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)');
    expect(result[0].easing).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(result[0].duration).toBe(0.4);
  });

  test('parses milliseconds', () => {
    const result = parseTransitionShorthand('all 300ms ease');
    expect(result[0].duration).toBe(0.3);
  });

  test('returns empty for none', () => {
    expect(parseTransitionShorthand('none')).toEqual([]);
    expect(parseTransitionShorthand(undefined)).toEqual([]);
    expect(parseTransitionShorthand('')).toEqual([]);
  });

  test('handles steps() easing', () => {
    const result = parseTransitionShorthand('width 2s steps(30)');
    expect(result[0].easing).toBe('steps(30)');
  });
});

describe('formatTransitionShorthand', () => {
  test('formats single transition', () => {
    const result = formatTransitionShorthand([
      { property: 'all', duration: 0.3, easing: 'ease', delay: 0 },
    ]);
    expect(result).toBe('all 0.3s');
  });

  test('formats with non-default easing', () => {
    const result = formatTransitionShorthand([
      { property: 'transform', duration: 0.5, easing: 'ease-in-out', delay: 0 },
    ]);
    expect(result).toBe('transform 0.5s ease-in-out');
  });

  test('formats with delay', () => {
    const result = formatTransitionShorthand([
      { property: 'opacity', duration: 0.3, easing: 'ease', delay: 0.1 },
    ]);
    expect(result).toBe('opacity 0.3s 0.1s');
  });

  test('formats multiple transitions', () => {
    const result = formatTransitionShorthand([
      { property: 'transform', duration: 0.5, easing: 'ease-in-out', delay: 0 },
      { property: 'opacity', duration: 0.3, easing: 'ease', delay: 0.1 },
    ]);
    expect(result).toBe('transform 0.5s ease-in-out, opacity 0.3s 0.1s');
  });

  test('returns empty string for empty array', () => {
    expect(formatTransitionShorthand([])).toBe('');
  });
});

describe('transition round-trip', () => {
  test('parse → format → parse produces same data', () => {
    const original = 'transform 0.5s ease-in-out, opacity 0.3s linear 0.1s';
    const parsed = parseTransitionShorthand(original);
    const formatted = formatTransitionShorthand(parsed);
    const reParsed = parseTransitionShorthand(formatted);
    expect(reParsed).toEqual(parsed);
  });
});

// ─── CSS Animation ──────────────────────────────────────────────────────────

describe('parseAnimationShorthand', () => {
  test('parses basic animation', () => {
    const result = parseAnimationShorthand('fadeIn 1s ease');
    expect(result).toEqual([{
      keyframeName: 'fadeIn', duration: 1, easing: 'ease',
      delay: 0, iterationCount: '1', direction: 'normal', fillMode: 'none',
    }]);
  });

  test('parses animation with infinite', () => {
    const result = parseAnimationShorthand('float-slow 3s ease-in-out infinite');
    expect(result[0].keyframeName).toBe('float-slow');
    expect(result[0].duration).toBe(3);
    expect(result[0].easing).toBe('ease-in-out');
    expect(result[0].iterationCount).toBe('infinite');
  });

  test('parses animation with direction and fill-mode', () => {
    const result = parseAnimationShorthand('slideIn 0.8s ease-out forwards');
    expect(result[0].fillMode).toBe('forwards');
  });

  test('parses animation with alternate direction', () => {
    const result = parseAnimationShorthand('pulse 2s ease-in-out infinite alternate');
    expect(result[0].direction).toBe('alternate');
    expect(result[0].iterationCount).toBe('infinite');
  });

  test('parses multiple animations (comma separated)', () => {
    const result = parseAnimationShorthand('typing 3s steps(30) forwards, blink 0.7s infinite');
    expect(result).toHaveLength(2);
    expect(result[0].keyframeName).toBe('typing');
    expect(result[0].easing).toBe('steps(30)');
    expect(result[0].fillMode).toBe('forwards');
    expect(result[1].keyframeName).toBe('blink');
    expect(result[1].iterationCount).toBe('infinite');
  });

  test('parses animation with delay', () => {
    const result = parseAnimationShorthand('fadeIn 1s ease 0.5s');
    expect(result[0].delay).toBe(0.5);
  });

  test('returns empty for none', () => {
    expect(parseAnimationShorthand('none')).toEqual([]);
    expect(parseAnimationShorthand(undefined)).toEqual([]);
  });
});

describe('formatAnimationShorthand', () => {
  test('formats basic animation', () => {
    const result = formatAnimationShorthand([{
      keyframeName: 'fadeIn', duration: 1, easing: 'ease',
      delay: 0, iterationCount: '1', direction: 'normal', fillMode: 'none',
    }]);
    expect(result).toBe('fadeIn 1s');
  });

  test('formats with infinite and alternate', () => {
    const result = formatAnimationShorthand([{
      keyframeName: 'pulse', duration: 2, easing: 'ease-in-out',
      delay: 0, iterationCount: 'infinite', direction: 'alternate', fillMode: 'none',
    }]);
    expect(result).toBe('pulse 2s ease-in-out infinite alternate');
  });

  test('formats with fill-mode', () => {
    const result = formatAnimationShorthand([{
      keyframeName: 'slideIn', duration: 0.8, easing: 'ease-out',
      delay: 0, iterationCount: '1', direction: 'normal', fillMode: 'forwards',
    }]);
    expect(result).toBe('slideIn 0.8s ease-out forwards');
  });
});

describe('animation round-trip', () => {
  test('parse → format → parse produces same data', () => {
    const original = 'float-slow 3s ease-in-out infinite alternate';
    const parsed = parseAnimationShorthand(original);
    const formatted = formatAnimationShorthand(parsed);
    const reParsed = parseAnimationShorthand(formatted);
    expect(reParsed).toEqual(parsed);
  });
});

// ─── CSS @keyframes ─────────────────────────────────────────────────────────

describe('parseKeyframes', () => {
  test('parses simple @keyframes', () => {
    const css = `
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `;
    const result = parseKeyframes(css);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('fadeIn');
    expect(result[0].stops).toHaveLength(2);
    expect(result[0].stops[0]).toEqual({ offset: 0, properties: { opacity: '0' } });
    expect(result[0].stops[1]).toEqual({ offset: 100, properties: { opacity: '1' } });
  });

  test('parses percentage stops', () => {
    const css = `
      @keyframes float-slow {
        0% { transform: translateY(0); }
        50% { transform: translateY(-20px); }
        100% { transform: translateY(0); }
      }
    `;
    const result = parseKeyframes(css);
    expect(result[0].stops).toHaveLength(3);
    expect(result[0].stops[0].offset).toBe(0);
    expect(result[0].stops[1].offset).toBe(50);
    expect(result[0].stops[2].offset).toBe(100);
  });

  test('merges comma-separated offsets', () => {
    const css = `
      @keyframes pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.7; }
      }
    `;
    const result = parseKeyframes(css);
    expect(result[0].stops).toHaveLength(3);
    // 0% and 100% have same properties
    expect(result[0].stops[0].properties).toEqual({ opacity: '0.4' });
    expect(result[0].stops[2].properties).toEqual({ opacity: '0.4' });
    expect(result[0].stops[1].properties).toEqual({ opacity: '0.7' });
  });

  test('parses multiple @keyframes', () => {
    const css = `
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateY(50px); }
        to { transform: translateY(0); }
      }
    `;
    const result = parseKeyframes(css);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('fadeIn');
    expect(result[1].name).toBe('slideUp');
  });

  test('parses multiple properties per stop', () => {
    const css = `
      @keyframes complex {
        0% { opacity: 0; transform: scale(0.5); filter: blur(10px); }
        100% { opacity: 1; transform: scale(1); filter: blur(0px); }
      }
    `;
    const result = parseKeyframes(css);
    expect(Object.keys(result[0].stops[0].properties)).toHaveLength(3);
    expect(result[0].stops[0].properties.opacity).toBe('0');
    expect(result[0].stops[0].properties.transform).toBe('scale(0.5)');
    expect(result[0].stops[0].properties.filter).toBe('blur(10px)');
  });

  test('returns empty for no keyframes', () => {
    expect(parseKeyframes('')).toEqual([]);
    expect(parseKeyframes(undefined)).toEqual([]);
    expect(parseKeyframes('@media (max-width: 768px) { }')).toEqual([]);
  });

  test('handles real AI output with @media and @keyframes mixed', () => {
    const css = `
      @media (max-width: 768px) {
        [data-id="title"] { font-size: 36px !important; }
      }
      @keyframes gradientBG {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
    const result = parseKeyframes(css);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('gradientBG');
    expect(result[1].name).toBe('spin');
  });
});

describe('formatKeyframes', () => {
  test('formats simple keyframes', () => {
    const result = formatKeyframes({
      name: 'fadeIn',
      stops: [
        { offset: 0, properties: { opacity: '0' } },
        { offset: 100, properties: { opacity: '1' } },
      ],
    });
    expect(result).toContain('@keyframes fadeIn');
    expect(result).toContain('0% { opacity: 0; }');
    expect(result).toContain('100% { opacity: 1; }');
  });
});

describe('keyframes round-trip', () => {
  test('parse → format → parse produces same data', () => {
    const css = `
      @keyframes bounce {
        0% { transform: translateY(0); }
        50% { transform: translateY(-30px); }
        100% { transform: translateY(0); }
      }
    `;
    const parsed = parseKeyframes(css);
    const formatted = formatKeyframes(parsed[0]);
    const reParsed = parseKeyframes(formatted);
    expect(reParsed[0].name).toBe(parsed[0].name);
    expect(reParsed[0].stops).toEqual(parsed[0].stops);
  });
});

// ─── Summary helpers ────────────────────────────────────────────────────────

describe('transitionSummary', () => {
  test('returns None for empty', () => {
    expect(transitionSummary([])).toBe('None');
  });
  test('returns single summary', () => {
    expect(transitionSummary([{ property: 'all', duration: 0.3, easing: 'ease', delay: 0 }])).toBe('all 0.3s ease');
  });
  test('returns count for multiple', () => {
    expect(transitionSummary([
      { property: 'transform', duration: 0.5, easing: 'ease', delay: 0 },
      { property: 'opacity', duration: 0.3, easing: 'ease', delay: 0 },
    ])).toBe('2 transitions');
  });
});

describe('animationSummary', () => {
  test('returns None for empty', () => {
    expect(animationSummary([])).toBe('None');
  });
  test('returns summary with infinity symbol', () => {
    expect(animationSummary([{
      keyframeName: 'float', duration: 3, easing: 'ease', delay: 0,
      iterationCount: 'infinite', direction: 'normal', fillMode: 'none',
    }])).toBe('float 3s ∞');
  });
});

// ── Stored ease → framer-acceptable ease ───────────────────────────────────
// The editor persists a custom curve as the STRING "[0.22, 1, 0.36, 1]". framer
// takes a named easing or a real 4-number array; handed the string it throws
// "Invalid easing type" and unmounts the tree — opening the Text popup crashed
// the whole editor this way. Live find 2026-07-30.
describe('easeToMotion', () => {
  test('parses a bezier string into a real number array', () => {
    expect(easeToMotion('[0.22, 1, 0.36, 1]')).toEqual([0.22, 1, 0.36, 1]);
  });

  test('passes a named curve through untouched', () => {
    expect(easeToMotion('easeOut')).toBe('easeOut');
    expect(easeToMotion('linear')).toBe('linear');
  });

  test('passes an already-parsed array through', () => {
    expect(easeToMotion([0.4, 0, 0.2, 1])).toEqual([0.4, 0, 0.2, 1]);
  });

  test('returns undefined for undefined or a malformed bezier (caller falls back)', () => {
    expect(easeToMotion(undefined)).toBeUndefined();
    expect(easeToMotion('[0.1, 0.2]')).toBeUndefined();       // wrong arity
    expect(easeToMotion('[a, b, c, d]')).toBeUndefined();     // non-numeric
  });
});
