/**
 * @vitest-environment jsdom
 *
 * INVARIANT: in every built-in code-component template, `...props.style`
 * must be the LAST entry of any style object that contains it.
 *
 * The instance tag is where the builder expresses placement — position,
 * offsets, size — and the spread is how it reaches the component's root.
 * A default written AFTER the spread silently discards the instance's
 * value on the live site while the canvas (whose CodeComponentHost carries
 * the instance style on the host element) still renders it correctly: a
 * dropped Film Grain positioned absolute rendered in-flow live and shoved
 * its siblings (the adam-urban hero, 2026-08-17). 45 of the templates
 * shipped with the spread first; this sweep keeps the whole library honest.
 */
import { describe, it, expect } from 'vitest';
import * as barrel from './index';
import { compileCodeComponent } from '@/canvas/code-component-runtime';

const TEMPLATES: Array<[string, string]> = Object.entries(barrel)
  .filter(([k, v]) => k.endsWith('_COMPONENT') && typeof v === 'string') as Array<[string, string]>;

const SPREAD_RE = /\.\.\.\(?props\.style(?:\s*\|\|\s*\{\})?\)?/g;

function enclosingObjectClose(src: string, idx: number): number {
  let depth = 0;
  let i = idx;
  while (i >= 0) {
    const ch = src[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) break;
      depth--;
    }
    i--;
  }
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return j; }
  }
  return -1;
}

describe('built-in templates: ...props.style is last in its style object', () => {
  it('found the library', () => {
    expect(TEMPLATES.length).toBeGreaterThan(50);
  });

  for (const [name, src] of TEMPLATES) {
    it(name, () => {
      for (const m of src.matchAll(SPREAD_RE)) {
        const close = enclosingObjectClose(src, m.index!);
        expect(close).toBeGreaterThan(-1);
        let tail = src.slice(m.index! + m[0].length, close).trim();
        if (tail.startsWith(',')) tail = tail.slice(1).trim();
        // nothing meaningful may follow the spread before the object closes
        expect(tail).toBe('');
      }
    });
  }
});

describe('built-in templates still compile after the sweep', () => {
  for (const [name, src] of TEMPLATES) {
    it(name, () => {
      const Comp = compileCodeComponent(src, name);
      expect(Comp).not.toBeNull();
    });
  }
});
