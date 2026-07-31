// animation-utils.ts — Parse/format utilities for CSS animations.
// Handles: CSS transition shorthand, CSS animation shorthand, @keyframes definitions.
// All functions are pure: string in → data out, data in → string out.

import { trace } from '@/shared/debug-trace';
import { splitStyleProps } from '@/shared/css-utils';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TransitionData {
  property: string;   // 'all', 'transform', 'opacity', 'background-color', etc.
  duration: number;   // seconds
  easing: string;     // 'ease', 'ease-in-out', 'linear', 'cubic-bezier(...)'
  delay: number;      // seconds
}

export interface KeyframeStop {
  offset: number;     // 0-100 (percent)
  properties: Record<string, string>;
}

export interface KeyframeAnimation {
  name: string;
  stops: KeyframeStop[];
}

export interface AnimationData {
  keyframeName: string;
  duration: number;        // seconds
  easing: string;
  delay: number;           // seconds
  iterationCount: string;  // 'infinite' or number string like '1', '3'
  direction: string;       // 'normal', 'reverse', 'alternate', 'alternate-reverse'
  fillMode: string;        // 'none', 'forwards', 'backwards', 'both'
}

// ─── CSS Transition Parsing ─────────────────────────────────────────────────

const TIMING_FUNCTIONS = new Set([
  'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end',
]);

function isTimingFunction(s: string): boolean {
  return TIMING_FUNCTIONS.has(s) || s.startsWith('cubic-bezier(') || s.startsWith('steps(');
}

function parseTime(s: string): number {
  if (s.endsWith('ms')) return parseFloat(s) / 1000;
  if (s.endsWith('s')) return parseFloat(s);
  return parseFloat(s) || 0;
}

/**
 * Parse CSS transition shorthand into structured data.
 * Input: 'transform 0.5s ease-in-out, opacity 0.3s ease 0.1s'
 * Output: [{ property:'transform', duration:0.5, easing:'ease-in-out', delay:0 }, ...]
 */
export function parseTransitionShorthand(raw: string | undefined): TransitionData[] {
  if (!raw || raw === 'none') return [];
  trace.fn('parseTransitionShorthand', { raw });

  // Split by comma, but respect parentheses (for cubic-bezier, steps)
  const entries = splitStyleProps(raw);

  return entries.map(entry => {
    const parts = entry.trim().split(/\s+/);
    const result: TransitionData = { property: 'all', duration: 0, easing: 'ease', delay: 0 };

    // Rebuild parts respecting parenthesized values
    const tokens: string[] = [];
    let buf = '';
    let d = 0;
    for (const p of parts) {
      buf += (buf ? ' ' : '') + p;
      d += (p.match(/\(/g) || []).length - (p.match(/\)/g) || []).length;
      if (d === 0) { tokens.push(buf); buf = ''; }
    }
    if (buf) tokens.push(buf);

    let timesSeen = 0;
    for (const token of tokens) {
      if (isTimingFunction(token)) {
        result.easing = token;
      } else if (/^[\d.]+m?s$/.test(token)) {
        if (timesSeen === 0) { result.duration = parseTime(token); timesSeen++; }
        else { result.delay = parseTime(token); timesSeen++; }
      } else if (!isTimingFunction(token) && !/^[\d.]+m?s$/.test(token)) {
        result.property = token;
      }
    }

    return result;
  });
}

/**
 * Format transition data back to CSS shorthand.
 * Output: 'transform 0.5s ease-in-out, opacity 0.3s ease 0.1s'
 */
export function formatTransitionShorthand(entries: TransitionData[]): string {
  if (entries.length === 0) return '';
  return entries.map(e => {
    const parts = [e.property, `${e.duration}s`];
    if (e.easing !== 'ease') parts.push(e.easing);
    if (e.delay > 0) parts.push(`${e.delay}s`);
    return parts.join(' ');
  }).join(', ');
}

// ─── CSS Animation Shorthand Parsing ────────────────────────────────────────

const DIRECTION_VALUES = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILL_VALUES = new Set(['none', 'forwards', 'backwards', 'both']);
const PLAY_STATE_VALUES = new Set(['running', 'paused']);

/**
 * Parse CSS animation shorthand into structured data.
 * Input: 'float-slow 3s ease-in-out infinite alternate'
 * Output: [{ keyframeName:'float-slow', duration:3, easing:'ease-in-out', ... }]
 *
 * Shorthand order: name duration timing-function delay iteration-count direction fill-mode play-state
 * But browsers are flexible on order (they identify tokens by type).
 */
export function parseAnimationShorthand(raw: string | undefined): AnimationData[] {
  if (!raw || raw === 'none') return [];
  trace.fn('parseAnimationShorthand', { raw });

  // Split by comma, respecting parentheses
  const entries = splitStyleProps(raw);

  return entries.map(entry => {
    const result: AnimationData = {
      keyframeName: '',
      duration: 0,
      easing: 'ease',
      delay: 0,
      iterationCount: '1',
      direction: 'normal',
      fillMode: 'none',
    };

    const parts = entry.trim().split(/\s+/);
    // Rebuild respecting parentheses
    const tokens: string[] = [];
    let buf = '';
    let d = 0;
    for (const p of parts) {
      buf += (buf ? ' ' : '') + p;
      d += (p.match(/\(/g) || []).length - (p.match(/\)/g) || []).length;
      if (d === 0) { tokens.push(buf); buf = ''; }
    }
    if (buf) tokens.push(buf);

    let timesSeen = 0;
    for (const token of tokens) {
      if (isTimingFunction(token)) {
        result.easing = token;
      } else if (/^[\d.]+m?s$/.test(token)) {
        if (timesSeen === 0) { result.duration = parseTime(token); timesSeen++; }
        else { result.delay = parseTime(token); timesSeen++; }
      } else if (token === 'infinite' || /^\d+$/.test(token)) {
        result.iterationCount = token;
      } else if (DIRECTION_VALUES.has(token)) {
        result.direction = token;
      } else if (FILL_VALUES.has(token) && result.keyframeName) {
        // 'none' could be fill-mode or keyframe name — if we already have a name, it's fill-mode
        result.fillMode = token;
      } else if (PLAY_STATE_VALUES.has(token)) {
        // skip play-state (we don't expose it in UI)
      } else {
        // Must be the keyframe name
        result.keyframeName = token;
      }
    }

    return result;
  });
}

/**
 * Format animation data back to CSS shorthand.
 * Output: 'float-slow 3s ease-in-out infinite alternate forwards'
 */
export function formatAnimationShorthand(entries: AnimationData[]): string {
  if (entries.length === 0) return '';
  return entries.map(e => {
    const parts = [e.keyframeName, `${e.duration}s`];
    if (e.easing !== 'ease') parts.push(e.easing);
    if (e.delay > 0) parts.push(`${e.delay}s`);
    if (e.iterationCount !== '1') parts.push(e.iterationCount);
    if (e.direction !== 'normal') parts.push(e.direction);
    if (e.fillMode !== 'none') parts.push(e.fillMode);
    return parts.join(' ');
  }).join(', ');
}

// ─── CSS @keyframes Parsing ─────────────────────────────────────────────────

/**
 * Parse all @keyframes definitions from a CSS string.
 * Input: '@keyframes float-slow { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-20px); } }'
 * Output: [{ name: 'float-slow', stops: [...] }]
 */
export function parseKeyframes(css: string | undefined): KeyframeAnimation[] {
  if (!css) return [];
  trace.fn('parseKeyframes', { cssLength: css.length });

  const results: KeyframeAnimation[] = [];

  // Match @keyframes blocks
  const keyframeRegex = /@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}/g;
  let match;
  while ((match = keyframeRegex.exec(css)) !== null) {
    const name = match[1];
    const body = match[2];
    const stops: KeyframeStop[] = [];

    // Match stops: "0%, 100% { ... }" or "from { ... }" or "50% { ... }"
    const stopRegex = /([\w%,\s]+)\s*\{([^}]*)\}/g;
    let stopMatch;
    while ((stopMatch = stopRegex.exec(body)) !== null) {
      const offsetStr = stopMatch[1].trim();
      const propsStr = stopMatch[2].trim();

      // Parse offsets (can be comma-separated: "0%, 100%")
      const offsets = offsetStr.split(',').map(s => {
        const t = s.trim();
        if (t === 'from') return 0;
        if (t === 'to') return 100;
        return parseFloat(t) || 0;
      });

      // Parse properties
      const properties: Record<string, string> = {};
      const declarations = propsStr.split(';').filter(Boolean);
      for (const decl of declarations) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const prop = decl.slice(0, colonIdx).trim();
        const val = decl.slice(colonIdx + 1).trim();
        if (prop && val) properties[prop] = val;
      }

      // Create a stop entry for each offset
      for (const offset of offsets) {
        // Merge with existing stop at same offset
        const existing = stops.find(s => s.offset === offset);
        if (existing) {
          Object.assign(existing.properties, properties);
        } else {
          stops.push({ offset, properties: { ...properties } });
        }
      }
    }

    // Sort stops by offset
    stops.sort((a, b) => a.offset - b.offset);
    results.push({ name, stops });
  }

  return results;
}

/**
 * Format a single @keyframes definition back to CSS.
 * Output: '@keyframes float-slow {\n  0%, 100% { transform: translateY(0); }\n  50% { transform: translateY(-20px); }\n}'
 */
export function formatKeyframes(anim: KeyframeAnimation): string {
  // Group stops with identical properties
  const lines: string[] = [];
  for (const stop of anim.stops) {
    const offset = stop.offset === 0 ? '0%' : stop.offset === 100 ? '100%' : `${stop.offset}%`;
    const props = Object.entries(stop.properties)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
    lines.push(`  ${offset} { ${props}; }`);
  }
  return `@keyframes ${anim.name} {\n${lines.join('\n')}\n}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get a human-readable summary of a transition. */
export function transitionSummary(entries: TransitionData[]): string {
  if (entries.length === 0) return 'None';
  if (entries.length === 1) {
    const e = entries[0];
    return `${e.property} ${e.duration}s ${e.easing}`;
  }
  return `${entries.length} transitions`;
}

/** Get a human-readable summary of an animation. */
export function animationSummary(entries: AnimationData[]): string {
  if (entries.length === 0) return 'None';
  if (entries.length === 1) {
    const e = entries[0];
    const inf = e.iterationCount === 'infinite' ? ' ∞' : '';
    return `${e.keyframeName} ${e.duration}s${inf}`;
  }
  return `${entries.length} animations`;
}

/** Create a default transition entry. */
export function createDefaultTransition(): TransitionData {
  return { property: 'all', duration: 0.3, easing: 'ease', delay: 0 };
}

/** Create a default animation entry. */
export function createDefaultAnimation(): AnimationData {
  return {
    keyframeName: '',
    duration: 1,
    easing: 'ease',
    delay: 0,
    iterationCount: '1',
    direction: 'normal',
    fillMode: 'none',
  };
}

/** Create a default keyframe animation definition. */
export function createDefaultKeyframeAnimation(name: string): KeyframeAnimation {
  return {
    name,
    stops: [
      { offset: 0, properties: { opacity: '0' } },
      { offset: 100, properties: { opacity: '1' } },
    ],
  };
}

// ─── Easing Options ─────────────────────────────────────────────────────────

export const CSS_EASING_OPTIONS = [
  { value: 'ease', label: 'Ease' },
  { value: 'ease-in', label: 'Ease In' },
  { value: 'ease-out', label: 'Ease Out' },
  { value: 'ease-in-out', label: 'Ease In Out' },
  { value: 'linear', label: 'Linear' },
  { value: 'step-start', label: 'Step Start' },
  { value: 'step-end', label: 'Step End' },
];

export const CSS_DIRECTION_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'alternate', label: 'Alternate' },
  { value: 'alternate-reverse', label: 'Alt Reverse' },
];

export const CSS_FILL_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'forwards', label: 'Forwards' },
  { value: 'backwards', label: 'Backwards' },
  { value: 'both', label: 'Both' },
];

export const CSS_ITERATION_OPTIONS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: 'infinite', label: '∞' },
];

/**
 * Convert a STORED ease value into one framer-motion accepts.
 *
 * The editor persists a custom cubic-bezier as the string `"[0.22, 1, 0.36, 1]"` (that's what
 * TransitionPanel's curve editor writes, and what lands in `data-text-anim`). framer accepts a
 * NAMED easing string or a real 4-number array — handed the bracket string it throws
 * `Invalid easing type '[0.22, 1, 0.36, 1]'` and takes the whole component down (live find
 * 2026-07-30: opening the Text popup crashed the editor, because its live preview passed the
 * stored value straight through).
 *
 * Code GENERATION has the mirror of this: it emits the array literal unquoted. Anything that
 * builds a runtime transition object from stored config must come through here instead.
 */
export function easeToMotion(ease: string | number[] | undefined): string | number[] | undefined {
  if (ease === undefined || Array.isArray(ease)) return ease;
  const s = String(ease).trim();
  if (!s.startsWith('[')) return s;                       // a named curve — pass through
  const nums = s.replace(/[[\]]/g, '').split(',').map(n => parseFloat(n.trim()));
  return nums.length === 4 && nums.every(Number.isFinite) ? nums : undefined;
}
