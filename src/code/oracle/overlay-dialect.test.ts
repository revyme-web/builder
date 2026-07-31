import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));

import { checkFile } from './check-file';
import { createOverlayInCode } from '@/code/generation/overlay-gen';

const BASE = `'use client';

import React, { useState, useLayoutEffect, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
  <button data-id="menu-btn" data-name="Menu Button" style={{ position: 'absolute', left: '60px', top: '40px', width: '120px', height: '40px' }}>Menu</button>
</div>
  );
}`;

const relCfg = { type: 'relative', triggerId: 'menu-btn', side: 'bottom', align: 'start', offsetX: 0, offsetY: 8 } as any;
const fixCfg = { type: 'fixed', triggerId: 'menu-btn', side: 'bottom', align: 'center', offsetX: 0, offsetY: 0 } as any;
const trgCfg = { targetId: 'overlay-menu-btn-1', trigger: 'click', dismiss: 'outside' } as any;

const overlayCodes = (code: string) =>
  checkFile(code, { kind: 'page' }).filter((x) => x.code.startsWith('OVERLAY_')).map((x) => x.code);

describe('overlay dialect', () => {
  it('PRIME RULE: the generator\'s own relative-overlay output passes clean', () => {
    const out = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', relCfg, trgCfg);
    expect(overlayCodes(out)).toEqual([]);
  });

  it('PRIME RULE: the generator\'s own fixed-modal output passes clean', () => {
    const out = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', fixCfg, trgCfg);
    expect(overlayCodes(out)).toEqual([]);
  });

  it('PRIME RULE: parked data-canvas-node overlay experiments are exempt from wiring', () => {
    const parked = `'use client';

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
  <p data-id="t" data-name="Text" style={{ position: 'relative' }}>Hi</p>
</div>
  );
}
const canvasNodes = <>
  <div data-id="pk-trig" data-name="Frame" data-canvas-node="true" data-overlay-trigger='{"targetId":"pk-ov","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '-800px', top: '0px', width: '100px', height: '100px' }}></div>
  <div data-id="pk-ov" data-name="div" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"pk-trig","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'absolute', left: '-800px', top: '120px', width: '200px', height: '100px' }}></div>
</>;`;
    expect(overlayCodes(parked)).toEqual([]);
    // sanity: WITHOUT the canvas-node flag the same unwired pair DOES bounce
    const inPage = parked.replace(/ data-canvas-node="true"/g, '');
    expect(overlayCodes(inPage).length).toBeGreaterThan(0);
  });

  it('overlay nested inside the trigger bounces toward root-last-child', () => {
    const gen = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', relCfg, trgCfg);
    // move the AnimatePresence block inside the button
    const block = gen.match(/<AnimatePresence>[\s\S]*?<\/AnimatePresence>/)![0];
    const bad = gen.replace(block, '').replace('>Menu</button>', `>Menu${block}</button>`);
    expect(overlayCodes(bad)).toContain('OVERLAY_NOT_ROOT_CHILD');
  });

  it('missing state/effect bounces with the exact snippets', () => {
    const gen = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', relCfg, trgCfg);
    const bad = gen
      .replace(/ {2}const \[overlayMenuBtn_1Open, setOverlayMenuBtn_1Open\] = useState\(false\);\n/, '')
      .replace(/ {2}useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[overlayMenuBtn_1Open\]\);\n/, '');
    const out = checkFile(bad, { kind: 'page' });
    const hit = out.find((x) => x.code === 'OVERLAY_MISSING_WIRING');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('useState(false)');
    expect(hit!.message).toContain('useLayoutEffect');
    expect(hit!.message).toContain('getBoundingClientRect');
  });

  it('missing trigger handler bounces with the exact onClick', () => {
    const gen = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', relCfg, trgCfg);
    const bad = gen.replace(" onClick={() => setOverlayMenuBtn_1Open(!overlayMenuBtn_1Open)}", '');
    const out = checkFile(bad, { kind: 'page' });
    const hit = out.find((x) => x.code === 'OVERLAY_MISSING_WIRING' && x.elementId === 'menu-btn');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('onClick={() => setOverlayMenuBtn_1Open(!overlayMenuBtn_1Open)}');
  });

  it('broken cross-link bounces', () => {
    const gen = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', relCfg, trgCfg);
    const bad = gen.replace(`"targetId":"overlay-menu-btn-1"`, `"targetId":"overlay-nope-9"`);
    expect(overlayCodes(bad)).toContain('OVERLAY_LINK_BROKEN');
  });

  it('malformed config bounces', () => {
    const gen = createOverlayInCode(BASE, 'menu-btn', 'overlay-menu-btn-1', relCfg, trgCfg);
    const bad = gen.replace(/data-overlay='\{"type":"relative"[^']*'/, `data-overlay='{"side":"bottom"}'`);
    expect(overlayCodes(bad)).toContain('OVERLAY_CONFIG_INVALID');
  });
});
