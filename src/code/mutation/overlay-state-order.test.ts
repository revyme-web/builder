// overlay-state-order.test.ts — EMPIRICAL PIN, live find 2026-10-06 (PearlRhine,
// www.pearlrhine.com served Cloudflare 1101 on every request to `/`).
//
// The agent's `delete_node` on an overlay ELEMENT sent a raw `removeNode`. The
// plain strip's scroll-fx const sweep matched the overlay's state by name
// (`overlay-faq-cta-7` → `overlayFaqCta_7` → state `overlayFaqCta_7Open`) and
// dropped it, but missed the multi-line `useEffect`; the structural heal then
// re-declared the state at the END of the hook prologue — BELOW that effect,
// whose deps array reads it during render. The canvas tolerated it; production
// SSR threw "Cannot access 'overlayFaqCta_7Open' before initialization".
import { describe, it, expect, beforeEach } from 'vitest';
import { parse } from '@babel/parser';
import { projectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue, queueMutation, validateGeneratedCode } from './mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import { findUseBeforeDeclare } from './use-before-declare';
import {
  createOverlayInCode,
  healDanglingOverlayState,
  healMisorderedOverlayStateInCode,
} from '@/code/generation/overlay-gen';
import { clearNodeScrollFx } from '@/code/generation/generator-motion-scroll-fx';
import type { OverlayConfig, OverlayTriggerConfig } from '@/shared/types';

const FILE = 'app/page.client.tsx';

const PAGE = `'use client';
import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Page() {
  const tgeTrackRef = useRef(null);
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <button data-id="a-cta" style={{ padding: '8px' }}>A</button>
      <button data-id="faq-cta" style={{ padding: '8px' }}>FAQ</button>
      <button data-id="b-cta" style={{ padding: '8px' }}>B</button>
    </div>
  );
}
`;

const fixed = (triggerId: string): OverlayConfig =>
  ({ type: 'fixed', triggerId, side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 }) as OverlayConfig;
const trig = (targetId: string): OverlayTriggerConfig =>
  ({ targetId, trigger: 'click', dismiss: 'outside' }) as OverlayTriggerConfig;

/** Three fixed (modal) overlays, the middle one being the FAQ CTA. */
function threeOverlays(): string {
  let code = PAGE;
  code = createOverlayInCode(code, 'a-cta', 'overlay-a-cta-6', fixed('a-cta'), trig('overlay-a-cta-6'));
  code = createOverlayInCode(code, 'faq-cta', 'overlay-faq-cta-7', fixed('faq-cta'), trig('overlay-faq-cta-7'));
  code = createOverlayInCode(code, 'b-cta', 'overlay-b-cta-8', fixed('b-cta'), trig('overlay-b-cta-8'));
  return code;
}

/** `S:<var>` / `E:<var>` in source order — the shape the live file was read in. */
function hookOrder(code: string): string[] {
  const hits: Array<[number, string]> = [];
  for (const m of code.matchAll(/const \[(overlay\w+Open),/g)) hits.push([m.index!, `S:${m[1]}`]);
  for (const m of code.matchAll(/\}, \[(overlay\w+Open)\]\);/g)) hits.push([m.index!, `E:${m[1]}`]);
  return hits.sort((a, b) => a[0] - b[0]).map(h => h[1]);
}

const tdz = (code: string) => findUseBeforeDeclare(parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] }));

describe('removeNode on an overlay element (agent delete_node)', () => {
  beforeEach(() => {
    const code = threeOverlays();
    projectFS.writeFile(FILE, code);
    setActiveFilePath(FILE);
    setBumpVersion(() => {});
    initMutationQueue(code, c => projectFS.writeFile(FILE, c));
  });

  it('tears the whole overlay down — no state left below a surviving effect', () => {
    queueMutation({ type: 'removeNode', nodeId: 'overlay-faq-cta-7' });
    flushNow();
    const out = projectFS.readFile(FILE)!;

    expect(out).not.toContain('overlayFaqCta_7Open');
    expect(out).not.toContain('overlay-faq-cta-7');
    expect(out).not.toContain('data-overlay-trigger=\'{"targetId":"overlay-faq-cta-7"');
    expect(hookOrder(out)).toEqual([
      'S:overlayACta_6Open', 'E:overlayACta_6Open',
      'S:overlayBCta_8Open', 'E:overlayBCta_8Open',
    ]);
    expect(tdz(out)).toBeNull();
    expect(validateGeneratedCode(out)).toBeNull();
  });

  it('leaves the sibling overlays fully wired', () => {
    queueMutation({ type: 'removeNode', nodeId: 'overlay-faq-cta-7' });
    flushNow();
    const out = projectFS.readFile(FILE)!;
    expect(out).toContain('{overlayACta_6Open &&');
    expect(out).toContain('{overlayBCta_8Open &&');
    expect(out).toContain('setOverlayBCta_8Open(!overlayBCta_8Open)');
  });
});

describe('clearNodeScrollFx never claims an overlay state', () => {
  it('keeps `const [<cn>Open, …]` when the overlay element itself is cleared', () => {
    const code = threeOverlays();
    const out = clearNodeScrollFx(code, 'overlay-faq-cta-7');
    expect(out).toContain('const [overlayFaqCta_7Open, setOverlayFaqCta_7Open] = useState(false);');
    expect(hookOrder(out)).toEqual(hookOrder(code));
  });
});

describe('healDanglingOverlayState — declaration position', () => {
  it('re-declares a missing state ABOVE the effect that reads it', () => {
    // State lost, effect + trigger handler + conditional still present.
    const broken = threeOverlays().replace(/\n[ \t]*const \[overlayFaqCta_7Open, setOverlayFaqCta_7Open\] = useState\(false\);/, '');
    expect(broken).not.toContain('const [overlayFaqCta_7Open');
    const out = healDanglingOverlayState(broken);
    expect(hookOrder(out)).toEqual(hookOrder(threeOverlays()));
    expect(tdz(out)).toBeNull();
  });

  it('drops an effect that nothing else references instead of keeping it alive', () => {
    // The live file's state: the FAQ overlay's element, conditional and trigger
    // were all gone — only its effect remained.
    let code = threeOverlays();
    code = code.replace(/\n[ \t]*const \[overlayFaqCta_7Open, setOverlayFaqCta_7Open\] = useState\(false\);/, '');
    const cond = code.indexOf('<AnimatePresence>{overlayFaqCta_7Open &&');
    const condEnd = code.indexOf('</AnimatePresence>', cond) + '</AnimatePresence>'.length;
    code = code.slice(0, cond) + code.slice(condEnd);
    code = code.replace(/\s*data-overlay-trigger='\{"targetId":"overlay-faq-cta-7"[^']*'/, '');
    code = code.replace(/\s*onClick=\{\(\) => setOverlayFaqCta_7Open\(!overlayFaqCta_7Open\)\}/, '');
    expect(code).not.toMatch(/\{overlayFaqCta_7Open &&|onClick=\{\(\) => setOverlayFaqCta_7Open/);

    const out = healDanglingOverlayState(code);
    expect(out).not.toContain('overlayFaqCta_7Open');
    expect(hookOrder(out)).toEqual([
      'S:overlayACta_6Open', 'E:overlayACta_6Open',
      'S:overlayBCta_8Open', 'E:overlayBCta_8Open',
    ]);
  });
});

describe('healMisorderedOverlayStateInCode', () => {
  /** The exact live fingerprint: `E:x S:y E:y S:x`, the stray state right
   *  before the first non-hook line. */
  function liveShape(): string {
    const code = threeOverlays();
    const decl = '  const [overlayFaqCta_7Open, setOverlayFaqCta_7Open] = useState(false);\n';
    const without = code.replace(decl, '');
    return without.replace('  const tgeTrackRef = useRef(null);', `${decl}  const tgeTrackRef = useRef(null);`);
  }

  it('reproduces the crash shape (sanity)', () => {
    const code = liveShape();
    expect(hookOrder(code)).toEqual([
      'S:overlayACta_6Open', 'E:overlayACta_6Open',
      'E:overlayFaqCta_7Open',
      'S:overlayBCta_8Open', 'E:overlayBCta_8Open',
      'S:overlayFaqCta_7Open',
    ]);
    expect(tdz(code)?.name).toBe('overlayFaqCta_7Open');
    expect(validateGeneratedCode(code)).toContain("Cannot access 'overlayFaqCta_7Open' before initialization");
  });

  it('moves the state back above its effect', () => {
    const out = healMisorderedOverlayStateInCode(liveShape());
    expect(hookOrder(out)).toEqual(hookOrder(threeOverlays()));
    expect(tdz(out)).toBeNull();
    expect(validateGeneratedCode(out)).toBeNull();
  });

  it('runs as part of the structural heal', () => {
    expect(tdz(healDanglingOverlayState(liveShape()))).toBeNull();
  });

  it('is a no-op on a healthy file and idempotent', () => {
    const healthy = threeOverlays();
    expect(healMisorderedOverlayStateInCode(healthy)).toBe(healthy);
    const once = healMisorderedOverlayStateInCode(liveShape());
    expect(healMisorderedOverlayStateInCode(once)).toBe(once);
  });
});

describe('createOverlayInCode — idempotent top-up', () => {
  it('a re-create whose effect survived declares the state ABOVE that effect', () => {
    // Half-removal: state gone, effect kept — then the same overlay id is created
    // again (paste re-attach, or the restarted id counter).
    const broken = threeOverlays().replace(/\n[ \t]*const \[overlayFaqCta_7Open, setOverlayFaqCta_7Open\] = useState\(false\);/, '');
    const out = createOverlayInCode(broken, 'faq-cta', 'overlay-faq-cta-7', fixed('faq-cta'), trig('overlay-faq-cta-7'));
    const order = hookOrder(out);
    expect(order.indexOf('S:overlayFaqCta_7Open')).toBeLessThan(order.indexOf('E:overlayFaqCta_7Open'));
    expect(tdz(out)).toBeNull();
  });

  it('a re-create whose state sits after a non-hook line puts the effect BELOW it', () => {
    const code = `'use client';
import React, { useState, useEffect, useRef } from 'react';
export default function Page() {
  const ref = useRef(null);
  const [overlayCard1_1Open, setOverlayCard1_1Open] = useState(false);
  return (
    <div data-id="root">
      <div data-id="card1">Card</div>
    </div>
  );
}`;
    const out = createOverlayInCode(code, 'card1', 'overlay-card1-1', fixed('card1'), trig('overlay-card1-1'));
    const order = hookOrder(out);
    expect(order).toEqual(['S:overlayCard1_1Open', 'E:overlayCard1_1Open']);
    expect(tdz(out)).toBeNull();
  });
});
