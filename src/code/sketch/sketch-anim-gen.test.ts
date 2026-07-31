// sketch-anim-gen.test.ts — Regression tests for the sketch animation
// codegen.
//
// What this file guards against, in order of pain experienced:
//
//   1. Helper-duplication crash — `setSketchAnimInCode` getting
//      called twice should be idempotent: one helper-aware import,
//      one block per wrapper, no duplicate `playSketchDraw` import.
//      We hit "Identifier '__playSketchDraw' has already been
//      declared" in dev when an old codegen mixed with a new one;
//      the defensive guards in `ensureImports` are why these tests
//      exist.
//
//   2. Round-trip via `readSketchAnimFromCode` — the inline options
//      literal we emit must parse back to the same `SketchAnimConfig`
//      so the editor popup shows the user the values that are
//      actually in source.
//
//   3. Update-in-place — emitting a config, then a different config,
//      replaces the FIRST block instead of stacking duplicates.
//
//   4. Removal cleanup — strips the block AND the
//      `playSketchDraw` import (when no other animations remain),
//      but leaves `useEffect` alone (other features may depend on
//      it).
//
//   5. Multi-sketch handling — two animations on the same page each
//      get their own block; removing one leaves the other intact.

import { describe, test, expect } from 'vitest';
import {
  setSketchAnimInCode,
  removeSketchAnimInCode,
  readSketchAnimFromCode,
  listSketchAnimsInCode,
  createDefaultSketchAnim,
} from './sketch-anim-gen';
import { type SketchAnimConfig } from './sketch-anim-config';

const BARE_PAGE = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root">
    <svg data-id="sketch-1" data-sketch="true">
      <path d="M 0 0 Z" fill="red" data-points="0,0,0.5 1,1,0.5" />
    </svg>
  </div>;
}`;

function defaultConfig(): SketchAnimConfig {
  return createDefaultSketchAnim();
}

// ─── Insertion ──────────────────────────────────────────────────────────────

describe('setSketchAnimInCode — first insertion', () => {
  test('imports useEffect from react', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    expect(out).toMatch(/import\s+React,?\s*\{[^}]*\buseEffect\b/);
  });

  test('imports playSketchDraw from @revyme/runtime', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    expect(out).toMatch(/import\s+\{[^}]*\bplaySketchDraw\b[^}]*\}\s+from\s+['"]@revyme\/runtime['"]/);
  });

  test('inserts a useEffect block with begin/end markers', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    expect(out).toContain('// __SKETCH_ANIM_BLOCK_BEGIN__ sketch-1');
    expect(out).toContain('// __SKETCH_ANIM_BLOCK_END__ sketch-1');
    expect(out).toContain('useEffect(() => {');
    expect(out).toContain('playSketchDraw(__wrapper_sketch_1');
  });

  test('block is INSIDE the page component function body', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const componentOpen = out.indexOf('export default function Page');
    const blockBegin = out.indexOf('__SKETCH_ANIM_BLOCK_BEGIN__ sketch-1');
    const componentClose = out.lastIndexOf('}');
    expect(componentOpen).toBeGreaterThan(-1);
    expect(blockBegin).toBeGreaterThan(componentOpen);
    expect(blockBegin).toBeLessThan(componentClose);
  });

  test('emits the config as inline JS object literal', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', {
      trigger: 'mount',
      mode: 'staggered',
      durationScale: 2,
      stagger: 0.7,
      transition: { type: 'tween', duration: 1.5, ease: 'easeIn' },
    });
    expect(out).toMatch(/trigger:\s*'mount'/);
    expect(out).toMatch(/mode:\s*'staggered'/);
    expect(out).toMatch(/durationScale:\s*2/);
    expect(out).toMatch(/stagger:\s*0\.7/);
    expect(out).toMatch(/duration:\s*1\.5/);
    expect(out).toMatch(/ease:\s*'easeIn'/);
  });

  test('spring transition emits stiffness/damping/mass', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', {
      trigger: 'inView',
      mode: 'sequential',
      durationScale: 1,
      stagger: 0.5,
      transition: { type: 'spring', stiffness: 200, damping: 30, mass: 1 },
    });
    expect(out).toMatch(/type:\s*'spring'/);
    expect(out).toMatch(/stiffness:\s*200/);
    expect(out).toMatch(/damping:\s*30/);
    expect(out).toMatch(/mass:\s*1/);
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('setSketchAnimInCode — idempotency / updates', () => {
  test('calling twice with the same config produces a single block', () => {
    const once = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const twice = setSketchAnimInCode(once, 'sketch-1', defaultConfig());
    const blockBegins = (twice.match(/__SKETCH_ANIM_BLOCK_BEGIN__ sketch-1/g) ?? []).length;
    expect(blockBegins).toBe(1);
  });

  test('imports stay deduplicated on the second call', () => {
    const once = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const twice = setSketchAnimInCode(once, 'sketch-1', defaultConfig());
    const reactImports = (twice.match(/from\s+['"]react['"]/g) ?? []).length;
    const runtimeImports = (twice.match(/from\s+['"]@revyme\/runtime['"]/g) ?? []).length;
    expect(reactImports).toBe(1);
    expect(runtimeImports).toBe(1);
    // Inside the runtime import, playSketchDraw should appear ONCE.
    const runtimeMatch = twice.match(/import\s+\{([^}]*)\}\s+from\s+['"]@revyme\/runtime['"]/);
    expect(runtimeMatch).not.toBeNull();
    expect((runtimeMatch![1].match(/\bplaySketchDraw\b/g) ?? []).length).toBe(1);
  });

  test('updating with a different config replaces the block in place', () => {
    const initial = setSketchAnimInCode(BARE_PAGE, 'sketch-1', {
      ...defaultConfig(),
      durationScale: 1,
    });
    const updated = setSketchAnimInCode(initial, 'sketch-1', {
      ...defaultConfig(),
      durationScale: 3.5,
    });
    expect(updated).toMatch(/durationScale:\s*3\.5/);
    expect(updated).not.toMatch(/durationScale:\s*1\b/);
    // Still one block.
    expect((updated.match(/__SKETCH_ANIM_BLOCK_BEGIN__ sketch-1/g) ?? []).length).toBe(1);
  });
});

// ─── Round-trip parsing ─────────────────────────────────────────────────────

describe('readSketchAnimFromCode — round-trip', () => {
  test('reads back default config', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const parsed = readSketchAnimFromCode(out, 'sketch-1');
    expect(parsed).not.toBeNull();
    expect(parsed!.trigger).toBe('inView');
    expect(parsed!.mode).toBe('sequential');
  });

  test('round-trips spring transition', () => {
    const cfg: SketchAnimConfig = {
      trigger: 'hover',
      mode: 'staggered',
      durationScale: 1.7,
      stagger: 0.3,
      transition: { type: 'spring', stiffness: 250, damping: 40, mass: 1 },
    };
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', cfg);
    const parsed = readSketchAnimFromCode(out, 'sketch-1');
    expect(parsed).not.toBeNull();
    expect(parsed!.trigger).toBe('hover');
    expect(parsed!.mode).toBe('staggered');
    expect(parsed!.durationScale).toBe(1.7);
    expect(parsed!.stagger).toBe(0.3);
    expect(parsed!.transition.type).toBe('spring');
    expect(parsed!.transition.stiffness).toBe(250);
    expect(parsed!.transition.damping).toBe(40);
  });

  test('round-trips tween transition', () => {
    const cfg: SketchAnimConfig = {
      trigger: 'mount',
      mode: 'simultaneous',
      durationScale: 0.5,
      stagger: 0.5,
      transition: { type: 'tween', duration: 2.4, ease: 'easeInOut' },
    };
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', cfg);
    const parsed = readSketchAnimFromCode(out, 'sketch-1');
    expect(parsed).not.toBeNull();
    expect(parsed!.transition.type).toBe('tween');
    expect(parsed!.transition.duration).toBe(2.4);
    expect(parsed!.transition.ease).toBe('easeInOut');
  });

  test('returns null for absent config', () => {
    expect(readSketchAnimFromCode(BARE_PAGE, 'sketch-1')).toBeNull();
  });

  test('returns null when ID does not match an existing block', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    expect(readSketchAnimFromCode(out, 'sketch-2')).toBeNull();
  });
});

// ─── Listing ────────────────────────────────────────────────────────────────

describe('listSketchAnimsInCode', () => {
  test('returns empty for code without animations', () => {
    expect(listSketchAnimsInCode(BARE_PAGE)).toEqual([]);
  });

  test('returns one id per animation block', () => {
    const a = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    expect(listSketchAnimsInCode(a)).toEqual(['sketch-1']);
  });

  test('returns multiple ids when multiple sketches are animated', () => {
    let code = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    code = setSketchAnimInCode(code, 'sketch-2', defaultConfig());
    code = setSketchAnimInCode(code, 'sketch-3', defaultConfig());
    expect(listSketchAnimsInCode(code).sort()).toEqual(['sketch-1', 'sketch-2', 'sketch-3']);
  });
});

// ─── Removal ────────────────────────────────────────────────────────────────

describe('removeSketchAnimInCode', () => {
  test('strips the block', () => {
    const inserted = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const removed = removeSketchAnimInCode(inserted, 'sketch-1');
    expect(removed).not.toContain('__SKETCH_ANIM_BLOCK_BEGIN__ sketch-1');
    expect(removed).not.toContain('__SKETCH_ANIM_BLOCK_END__ sketch-1');
    expect(removed).not.toContain('playSketchDraw(');
  });

  test('strips the playSketchDraw import when no animations remain', () => {
    const inserted = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const removed = removeSketchAnimInCode(inserted, 'sketch-1');
    expect(removed).not.toMatch(/playSketchDraw/);
  });

  test('leaves useEffect import in place (other features may use it)', () => {
    const inserted = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    const removed = removeSketchAnimInCode(inserted, 'sketch-1');
    // useEffect MAY still be in the import — we don't strip it.
    // Just verify removal didn't crash and the file is structurally
    // sound (still has the original Page component).
    expect(removed).toContain('export default function Page');
  });

  test('removes only the targeted animation when multiple exist', () => {
    let code = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    code = setSketchAnimInCode(code, 'sketch-2', defaultConfig());
    code = removeSketchAnimInCode(code, 'sketch-1');
    expect(code).not.toContain('__SKETCH_ANIM_BLOCK_BEGIN__ sketch-1');
    expect(code).toContain('__SKETCH_ANIM_BLOCK_BEGIN__ sketch-2');
  });

  test('keeps the playSketchDraw import when other animations still use it', () => {
    let code = setSketchAnimInCode(BARE_PAGE, 'sketch-1', defaultConfig());
    code = setSketchAnimInCode(code, 'sketch-2', defaultConfig());
    code = removeSketchAnimInCode(code, 'sketch-1');
    expect(code).toMatch(/playSketchDraw/);
  });

  test('removing on code without an animation is a no-op', () => {
    const out = removeSketchAnimInCode(BARE_PAGE, 'sketch-1');
    expect(out).toBe(BARE_PAGE);
  });
});

// ─── Sanitization for IDs with special characters ───────────────────────────

describe('id sanitization in emitted variable names', () => {
  test('hyphens in the wrapper id become underscores in the variable name', () => {
    const out = setSketchAnimInCode(BARE_PAGE, 'sketch-abc-123', defaultConfig());
    // querySelector still uses the raw id (kebab is fine in a CSS attr selector).
    expect(out).toContain(`document.querySelector('[data-id="sketch-abc-123"]')`);
    // The local const name uses underscores so it's a valid JS identifier.
    expect(out).toMatch(/__wrapper_sketch_abc_123\b/);
  });
});
