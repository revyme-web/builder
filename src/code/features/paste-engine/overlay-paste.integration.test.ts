// overlay-paste.integration.test.ts — END-TO-END copy/paste of a node that owns
// an overlay. Drives the REAL pipeline (copyNodes → executePaste → mutation-queue
// flush → reattach) against an in-memory ProjectFS, so it catches wiring bugs the
// codegen-only unit tests (overlay-gen.test.ts) can't.
//
// The harness MUST initialise the mutation queue (`initMutationQueue`) so `addNode`
// actually persists — flushNow writes to the queue's `currentCode` + `onFlush`
// callback, NOT to ProjectFS directly. Without it, addNode silently no-ops.

import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue, queueMutation } from '@/code/mutation/mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { copyNodes, getClipboardData } from './copy';
import { executePaste } from './paste';
import { createOverlayInCode, createCanvasOverlayInCode } from '@/code/generation/overlay-gen';
import { parseOverlayCalls, parseOverlayTriggerCalls } from '@/code/parsing/overlay-parser';
import { parse } from '@babel/parser';
import type { OverlayConfig, OverlayTriggerConfig } from '@/shared/types';

const FILE = 'app/page.tsx';
const BASE = `'use client';
import React, { useState, useEffect, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '1440px', height: '900px' }}>
      <div data-id="trig" style={{ position: 'absolute', width: '180px', height: '80px', left: '100px', top: '100px' }}></div>
    </div>
  );
}`;

/** Seed ProjectFS + wire the mutation queue so addNode persists, then paste.
 *  `onCanvas` pastes with no selection (canvas target) instead of as a sibling. */
function pasteTriggerWithOverlay(overlayType: 'relative' | 'fixed', extraOverlayJsx = '', onCanvas = false): string {
  const ovCfg: OverlayConfig = overlayType === 'fixed'
    ? { type: 'fixed', triggerId: 'trig', side: 'bottom' } as OverlayConfig
    : { type: 'relative', triggerId: 'trig', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 };
  const trCfg: OverlayTriggerConfig = { targetId: 'ovl', trigger: 'click', dismiss: 'outside' };
  let seeded = createOverlayInCode(BASE, 'trig', 'ovl', ovCfg, trCfg);
  if (extraOverlayJsx) {
    // Inject a child into the empty overlay body to test content preservation.
    seeded = seeded.replace(/(<motion\.div key="ovl"[\s\S]*?>)(\s*<\/motion\.div>)/, `$1${extraOverlayJsx}$2`);
  }
  projectFS.writeFile(FILE, seeded);
  setActiveFilePath(FILE);
  setBumpVersion(() => {});
  initMutationQueue(seeded, code => projectFS.writeFile(FILE, code));
  const nodes = parseJSXToNodes(seeded);
  copyNodes(['trig'], nodes);
  executePaste(onCanvas
    ? { selectedIds: [], nodes, forcePosition: { x: 300, y: 600 }, viewportWidths: { desktop: 1440 }, activeFilePath: FILE }
    : { selectedIds: ['trig'], nodes, activeFilePath: FILE });
  flushNow();
  return projectFS.readFile(FILE)!;
}

const expectParses = (code: string) =>
  expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();

describe('overlay copy/paste — end-to-end', () => {
  beforeEach(() => { projectFS.writeFile(FILE, BASE); });

  it('relative: pasted node gets its OWN duplicated overlay (distinct trigger↔overlay)', () => {
    const out = pasteTriggerWithOverlay('relative');
    expectParses(out);
    const triggers = parseOverlayTriggerCalls(out);
    const overlays = parseOverlayCalls(out);
    expect(triggers.length).toBe(2);
    expect(overlays.length).toBe(2);
    // Each trigger points at a DISTINCT overlay (no sharing of the source overlay).
    const targets = triggers.map(t => t.config.targetId);
    expect(new Set(targets).size).toBe(2);
    // Each overlay points back at a DISTINCT trigger.
    const ovlTrigs = overlays.map(o => o.config.triggerId);
    expect(new Set(ovlTrigs).size).toBe(2);
    // The original pairing is intact and the new pairing is internally consistent.
    for (const t of triggers) {
      const ovl = overlays.find(o => o.overlayId === t.config.targetId);
      expect(ovl, `overlay for trigger ${t.triggerId}`).toBeTruthy();
      expect(ovl!.config.triggerId).toBe(t.triggerId);
    }
  });

  it('fixed: pasted node gets its OWN duplicated modal overlay', () => {
    const out = pasteTriggerWithOverlay('fixed');
    expectParses(out);
    const triggers = parseOverlayTriggerCalls(out);
    const overlays = parseOverlayCalls(out);
    expect(triggers.length).toBe(2);
    expect(overlays.length).toBe(2);
    expect(new Set(triggers.map(t => t.config.targetId)).size).toBe(2);
    expect(overlays.every(o => o.config.type === 'fixed')).toBe(true);
  });

  it('preserves overlay CHILDREN in the duplicate', () => {
    const out = pasteTriggerWithOverlay('fixed', `<div data-id="modal-card" style={{ width: '120px', height: '60px', backgroundColor: '#ffb3ba' }}></div>`);
    expectParses(out);
    // Source child + a re-pasted child copy → at least two modal cards exist.
    expect((out.match(/backgroundColor: '#ffb3ba'/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('CANVAS paste: pasted canvas trigger gets its OWN static canvas overlay (not the source)', () => {
    const out = pasteTriggerWithOverlay('relative', '', /* onCanvas */ true);
    expectParses(out);
    const triggers = parseOverlayTriggerCalls(out);
    const overlays = parseOverlayCalls(out);
    // Source (runtime) + pasted (canvas) trigger, each pointing at a DISTINCT overlay.
    expect(triggers.length).toBe(2);
    expect(new Set(triggers.map(t => t.config.targetId)).size).toBe(2);
    // The pasted trigger lives in canvasNodes and must NOT target the source overlay `ovl`.
    const canvasTrig = triggers.find(t => t.triggerId !== 'trig');
    expect(canvasTrig).toBeTruthy();
    expect(canvasTrig!.config.targetId).not.toBe('ovl');
    // Its overlay is a STATIC canvas overlay — no second useState machine.
    expect((out.match(/= useState\(false\)/g) || []).length).toBe(1);
    expect(out).toContain('const canvasNodes');
    // The cloned overlay is a data-canvas-node pointing back at the pasted trigger.
    const cloned = overlays.find(o => o.config.triggerId === canvasTrig!.triggerId);
    expect(cloned).toBeTruthy();
  });

  it('each overlay has its OWN useState + positioner (no shared state var)', () => {
    const out = pasteTriggerWithOverlay('relative');
    const overlays = parseOverlayCalls(out);
    for (const o of overlays) {
      const varBase = o.overlayId.replace(/[^a-zA-Z0-9]/g, '');
      // a useState whose name derives from THIS overlay id exists
      expect(out).toMatch(new RegExp(`const \\[\\w*Open, set\\w*Open\\] = useState\\(false\\)`));
    }
    // two independent open-state declarations
    expect((out.match(/= useState\(false\)/g) || []).length).toBe(2);
  });
});

// ─── Cross-file paste (copy in one file, paste in another) ───────────────────

const PAGE = 'app/page.tsx';
const COMP = 'components/Card.tsx';
const PAGE_BASE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '1440px', height: '900px' }}>
      <div data-id="trig" style={{ position: 'absolute', width: '180px', height: '80px', left: '100px', top: '100px' }}></div>
    </div>
  );
}`;
const COMP_BASE = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function Card({ style, ...rest }: any) {
  return (<LayoutGroup><motion.div data-id="croot" {...rest} style={{ ...style }}></motion.div></LayoutGroup>);
}
export default withResponsiveProps(Card);
const canvasNodes = (<>
  <div data-id="ctrig" data-name="Frame" data-canvas-node="true" style={{ position: 'absolute', width: '138px', height: '180px', backgroundColor: '#97cffc', left: '92px', top: '297px' }}></div>
</>);`;

describe('overlay copy/paste — CROSS-FILE', () => {
  it('page trigger → component CANVAS: static canvas overlay, repointed (not the source)', () => {
    const page = createOverlayInCode(PAGE_BASE, 'trig', 'ovl',
      { type: 'relative', triggerId: 'trig', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 },
      { targetId: 'ovl', trigger: 'click', dismiss: 'outside' });
    projectFS.writeFile(PAGE, page);
    projectFS.writeFile(COMP, COMP_BASE);
    setActiveFilePath(PAGE);
    copyNodes(['trig'], parseJSXToNodes(page));
    // Paste onto the COMPONENT canvas (no selection → canvas target).
    setActiveFilePath(COMP);
    setBumpVersion(() => {});
    initMutationQueue(COMP_BASE, code => projectFS.writeFile(COMP, code));
    executePaste({ selectedIds: [], nodes: parseJSXToNodes(COMP_BASE), forcePosition: { x: 400, y: 400 }, viewportWidths: { desktop: 1440 }, activeFilePath: COMP });
    flushNow();

    const out = projectFS.readFile(COMP)!;
    expectParses(out);
    const triggers = parseOverlayTriggerCalls(out);
    const overlays = parseOverlayCalls(out);
    expect(triggers.length).toBe(1);
    expect(overlays.length).toBe(1);
    // Pasted trigger ↔ pasted overlay form a consistent NEW pair (source `ovl`/`trig` not present).
    expect(triggers[0].config.targetId).toBe(overlays[0].overlayId);
    expect(overlays[0].config.triggerId).toBe(triggers[0].triggerId);
    expect(triggers[0].config.targetId).not.toBe('ovl');
    // Static canvas overlay — no runtime machine in the component file.
    expect((out.match(/= useState\(false\)/g) || []).length).toBe(0);
    expect(out).not.toContain('AnimatePresence');
    // Overlay look preserved.
    expect(out).toContain("backgroundColor: '#7CBFFF'");
  });

  it('component CANVAS overlay → page (runtime): becomes a real AnimatePresence overlay', () => {
    const comp = createCanvasOverlayInCode(COMP_BASE, 'ctrig', 'ctrig-overlay',
      { type: 'relative', triggerId: 'ctrig', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 },
      { targetId: 'ctrig-overlay', trigger: 'click', dismiss: 'outside' });
    projectFS.writeFile(COMP, comp);
    projectFS.writeFile(PAGE, PAGE_BASE);
    setActiveFilePath(COMP);
    copyNodes(['ctrig'], parseJSXToNodes(comp));
    // Paste onto the PAGE as a sibling of `trig` (runtime target).
    setActiveFilePath(PAGE);
    setBumpVersion(() => {});
    initMutationQueue(PAGE_BASE, code => projectFS.writeFile(PAGE, code));
    executePaste({ selectedIds: ['trig'], nodes: parseJSXToNodes(PAGE_BASE), activeFilePath: PAGE });
    flushNow();

    const out = projectFS.readFile(PAGE)!;
    expectParses(out);
    const triggers = parseOverlayTriggerCalls(out);
    const overlays = parseOverlayCalls(out);
    expect(triggers.length).toBe(1);
    expect(overlays.length).toBe(1);
    expect(triggers[0].config.targetId).toBe(overlays[0].overlayId);
    // Now a RUNTIME overlay on the page: useState + AnimatePresence, NOT a canvas node.
    expect((out.match(/= useState\(false\)/g) || []).length).toBe(1);
    expect(out).toContain('AnimatePresence');
  });

  it('paste onto component CANVAS, then DRAG the trigger into the variant → overlay is CONDITIONALLY rendered (not always-on)', () => {
    const page = createOverlayInCode(PAGE_BASE, 'trig', 'ovl',
      { type: 'relative', triggerId: 'trig', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 },
      { targetId: 'ovl', trigger: 'click', dismiss: 'outside' });
    projectFS.writeFile(PAGE, page);
    projectFS.writeFile(COMP, COMP_BASE);
    setActiveFilePath(PAGE);
    copyNodes(['trig'], parseJSXToNodes(page));
    // 1. Paste onto the component canvas (static canvas overlay).
    setActiveFilePath(COMP);
    setBumpVersion(() => {});
    initMutationQueue(COMP_BASE, code => projectFS.writeFile(COMP, code));
    executePaste({ selectedIds: [], nodes: parseJSXToNodes(COMP_BASE), forcePosition: { x: 400, y: 400 }, viewportWidths: { desktop: 1440 }, activeFilePath: COMP });
    flushNow();
    const afterPaste = projectFS.readFile(COMP)!;
    const m = afterPaste.match(/data-id="([^"]+)"[^>]*data-overlay-trigger[^>]*data-canvas-node/)
      || afterPaste.match(/data-id="([^"]+)"[^>]*data-canvas-node[^>]*data-overlay-trigger/);
    expect(m, 'pasted canvas trigger present').toBeTruthy();
    const ctrig = m![1];

    // 2. Drag that canvas trigger INTO the master root (runtime) — the drop's `move`.
    queueMutation({ type: 'move', nodeId: ctrig, newParentId: 'croot', index: 0, canvasNode: false, styles: { left: '50px', top: '50px', position: 'absolute' } } as never);
    flushNow();

    const out = projectFS.readFile(COMP)!;
    expectParses(out);
    // The overlay must be RUNTIME now: gated behind `{…Open && …}` inside AnimatePresence,
    // NOT a bare always-rendered element (the reported "directly appears" bug).
    expect(out).toContain('AnimatePresence');
    expect(out).toMatch(/\{\w*Open && \(/);
    expect((out.match(/= useState\(false\)/g) || []).length).toBe(1);
    // The overlay element is NO LONGER a canvas node.
    expect(out).not.toMatch(/data-overlay='[^']*'[^>]*data-canvas-node/);
  });

  it('NO orphaned overlay positioner effect injected (no undefined-identifier crash)', () => {
    // Trigger id `frame-abc-1` deliberately makes the substring trap visible: a bare
    // `includes('frame-abc-1')` is fine, but the overlay positioner is also guarded by
    // the `getAttribute('data-overlay')` skip so it never travels as an "effect".
    const page = createOverlayInCode(PAGE_BASE.replace(/data-id="trig"/, 'data-id="frame-abc-1"'), 'frame-abc-1', 'overlay-abc-2',
      { type: 'relative', triggerId: 'frame-abc-1', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 },
      { targetId: 'overlay-abc-2', trigger: 'click', dismiss: 'outside' });
    projectFS.writeFile(PAGE, page);
    projectFS.writeFile(COMP, COMP_BASE);
    setActiveFilePath(PAGE);
    copyNodes(['frame-abc-1'], parseJSXToNodes(page));
    // The overlay's runtime (positioner + useState) must NOT be captured as an effect.
    const cd = getClipboardData();
    expect(cd?.effects, 'overlay runtime must not be carried as an effect').toBeNull();

    setActiveFilePath(COMP);
    setBumpVersion(() => {});
    initMutationQueue(COMP_BASE, code => projectFS.writeFile(COMP, code));
    executePaste({ selectedIds: [], nodes: parseJSXToNodes(COMP_BASE), forcePosition: { x: 400, y: 400 }, viewportWidths: { desktop: 1440 }, activeFilePath: COMP });
    flushNow();

    const out = projectFS.readFile(COMP)!;
    expectParses(out);
    // No orphaned positioner effect, no setXOpen referencing a missing useState.
    expect(out).not.toContain('getAttribute');
    expect(out).not.toMatch(/use(Layout)?Effect/);
    expect(out).not.toContain('useState');
  });

  it('FIXED overlay pasted INTO a component master is STRIPPED (components do not resolve modals)', () => {
    const page = createOverlayInCode(PAGE_BASE, 'trig', 'ovl',
      { type: 'fixed', triggerId: 'trig', side: 'bottom' } as OverlayConfig,
      { targetId: 'ovl', trigger: 'click', dismiss: 'outside' });
    projectFS.writeFile(PAGE, page);
    projectFS.writeFile(COMP, COMP_BASE);
    setActiveFilePath(PAGE);
    copyNodes(['trig'], parseJSXToNodes(page));
    setActiveFilePath(COMP);
    setBumpVersion(() => {});
    initMutationQueue(COMP_BASE, code => projectFS.writeFile(COMP, code));
    executePaste({ selectedIds: [], nodes: parseJSXToNodes(COMP_BASE), forcePosition: { x: 400, y: 400 }, viewportWidths: { desktop: 1440 }, activeFilePath: COMP });
    flushNow();

    const out = projectFS.readFile(COMP)!;
    expectParses(out);
    // The fixed overlay + its trigger link are gone; the trigger is a plain node.
    expect(parseOverlayCalls(out).length).toBe(0);
    expect(parseOverlayTriggerCalls(out).length).toBe(0);
    expect(out).not.toContain('data-overlay');
    expect(out).not.toContain('useState');
  });

  it('RELATIVE overlay pasted into a component master is KEPT (runtime)', () => {
    const page = createOverlayInCode(PAGE_BASE, 'trig', 'ovl',
      { type: 'relative', triggerId: 'trig', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 },
      { targetId: 'ovl', trigger: 'click', dismiss: 'outside' });
    projectFS.writeFile(PAGE, page);
    projectFS.writeFile(COMP, COMP_BASE);
    setActiveFilePath(PAGE);
    copyNodes(['trig'], parseJSXToNodes(page));
    setActiveFilePath(COMP);
    setBumpVersion(() => {});
    initMutationQueue(COMP_BASE, code => projectFS.writeFile(COMP, code));
    executePaste({ selectedIds: [], nodes: parseJSXToNodes(COMP_BASE), forcePosition: { x: 400, y: 400 }, viewportWidths: { desktop: 1440 }, activeFilePath: COMP });
    flushNow();

    const out = projectFS.readFile(COMP)!;
    expectParses(out);
    // Relative overlays DO resolve in components — kept as a static canvas overlay.
    expect(parseOverlayCalls(out).length).toBe(1);
    expect(parseOverlayTriggerCalls(out).length).toBe(1);
  });
});
