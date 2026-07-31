import { describe, test, expect } from 'vitest';
import { parse } from '@babel/parser';
import {
  createOverlayInCode,
  updateOverlayPositionInCode,
  updateOverlayConfigInCode,
  updateOverlayTriggerInCode,
  removeOverlayInCode,
  extractOverlayToCanvasInCode,
  healDanglingOverlayState,
  createCanvasOverlayInCode,
  cloneOverlayToCanvasTriggerInCode,
  rehydrateOverlayFromCanvasInCode,
  pruneOverlayDuplicatesInCode,
  liftNestedCanvasOverlaysToRoot,
  stripOverlaysNestedInOverlaysInCode,
  syncOverlayAppearTransformInCode,
  healMissingOverlayEffectsInCode,
  transferRootOverlayToInstanceInCode,
  transferDescendantOverlaysToMasterInCode,
  reattachPastedOverlayInCode,
  healUnwrappedOverlayInCode,
  healMisplacedOverlayInCode,
} from './overlay-gen';
import { parseOverlayCalls, parseOverlayTriggerCalls } from '@/code/parsing/overlay-parser';
import type { OverlayConfig, OverlayTriggerConfig } from '@/shared/types';

/** Parse the (single) overlay's data-overlay config out of generated code. */
function readOverlayConfig(code: string): OverlayConfig {
  const calls = parseOverlayCalls(code);
  expect(calls.length).toBeGreaterThan(0);
  return calls[0].config;
}

/** Assert code parses as valid JSX/TSX — guards against dangling `{v && ( )}`
 *  wrappers and other syntax errors produced by an incomplete overlay removal. */
function expectParses(code: string) {
  expect(() => parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).not.toThrow();
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_CODE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="card1" style={{ width: '200px', height: '100px' }}>Card 1</div>
    </div>
  );
}`;

const BASE_CODE_MULTI = `'use client';
import React, { useState, useLayoutEffect } from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <div data-id="btn1" style={{ width: '100px', height: '40px' }}>Button 1</div>
      <div data-id="btn2" style={{ width: '100px', height: '40px' }}>Button 2</div>
    </div>
  );
}`;

function makeOverlayConfig(overrides: Partial<OverlayConfig> = {}): OverlayConfig {
  return {
    type: 'relative',
    triggerId: 'card1',
    side: 'bottom',
    align: 'start',
    offsetX: 0,
    offsetY: 0,
    ...overrides,
  };
}

function makeTriggerConfig(overrides: Partial<OverlayTriggerConfig> = {}): OverlayTriggerConfig {
  return {
    targetId: 'dropdown1',
    trigger: 'click',
    dismiss: 'outside',
    ...overrides,
  };
}

// ─── createOverlayInCode ────────────────────────────────────────────────────

describe('createOverlayInCode', () => {
  test('creates useState declaration', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    expect(result).toContain('const [dropdown1Open, setDropdown1Open] = useState(false)');
  });

  test('creates useLayoutEffect for positioning', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    expect(result).toContain('useLayoutEffect(');
    expect(result).toContain('[data-id="dropdown1"]');
    expect(result).toContain('[dropdown1Open]');
    expect(result).toContain('getBoundingClientRect');
    expect(result).toContain("addEventListener('resize'");
    expect(result).toContain("addEventListener('scroll'");
  });

  test('adds data-overlay-trigger attr to trigger element', () => {
    const triggerConfig = makeTriggerConfig();
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      triggerConfig,
    );
    expect(result).toContain(`data-overlay-trigger='${JSON.stringify(triggerConfig)}'`);
    // Trigger attr should be on the card1 element (near data-id="card1")
    const triggerIdx = result.indexOf('data-overlay-trigger');
    const nearbySlice = result.slice(Math.max(0, triggerIdx - 200), triggerIdx + 200);
    expect(nearbySlice).toContain('data-id="card1"');
  });

  test('adds onClick handler for click trigger', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig({ trigger: 'click' }),
    );
    expect(result).toContain('onClick={() => setDropdown1Open(!dropdown1Open)}');
    expect(result).not.toContain('onMouseEnter');
    expect(result).not.toContain('onMouseLeave');
  });

  test('adds onMouseEnter/onMouseLeave for hover trigger', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig({ trigger: 'hover' }),
    );
    // Grace-period form: enter cancels the shared close timer, leave arms it
    // (180ms) so the cursor can cross the trigger↔overlay gap without the
    // dropdown closing mid-travel.
    expect(result).toContain("onMouseEnter={() => { clearTimeout(((window as any).__ovGrace ||= {})['dropdown1']); setDropdown1Open(true); }}");
    expect(result).toContain("g['dropdown1'] = setTimeout(() => setDropdown1Open(false), 180);");
    // Hover now uses a BRIDGE leave handler (don't close if moving onto the overlay)
    // so a fixed modal covering its trigger doesn't flicker shut.
    expect(result).toMatch(/onMouseLeave=\{\(e\) => \{ const ov = document\.querySelector/);
    expect(result).toMatch(/onMouseLeave=\{\(e\) => \{ const tr = document\.querySelector/); // overlay mirror
    expect(result).not.toContain('onClick');
  });

  test('relative overlay wraps in AnimatePresence with enter + exit', () => {
    const result = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    expectParses(result);
    expect(result).toContain('<AnimatePresence>');
    expect(result).toContain('</AnimatePresence>');
    expect(result).toContain('<motion.div key="dropdown1"');
    expect(result).toContain('initial={{ opacity: 0, y: 20 }}');
    expect(result).toContain('animate={{ opacity: 1, y: 0 }}');
    expect(result).toContain('exit={{ opacity: 0, y: 20 }}');
  });

  test('removeOverlay strips the AnimatePresence wrapper (no empty leftover)', () => {
    const code = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    const removed = removeOverlayInCode(code, 'dropdown1', 'card1');
    expectParses(removed);
    expect(removed).not.toContain('AnimatePresence');
    expect(removed).not.toContain('motion.div');
  });

  test('fixed overlay emits an animated, config-driven modal', () => {
    const result = createOverlayInCode(BASE_CODE, 'card1', 'modal1', makeOverlayConfig({ type: 'fixed' }), makeTriggerConfig({ targetId: 'modal1' }));
    expectParses(result);
    // AnimatePresence + motion.div with enter/exit easing (modals animate now).
    expect(result).toContain('AnimatePresence');
    expect(result).toContain('motion.div');
    expect(result).toContain("ease: 'easeIn'");
    expect(result).toContain("ease: 'easeOut'");
    // Config-driven runtime: backdrop dismiss + body-scroll lock, read from data-overlay.
    expect(result).toContain('useEffect');
    expect(result).toContain('cfg.dismissible !== false');
    expect(result).toContain('document.body.style.overflow');
    // Full-viewport backdrop styles.
    expect(result).toContain("position: 'fixed'");
    expect(result).toContain("height: '100vh'");
  });

  test('removeOverlay cleans up a FIXED overlay (useEffect + AnimatePresence)', () => {
    const code = createOverlayInCode(BASE_CODE, 'card1', 'modal1', makeOverlayConfig({ type: 'fixed' }), makeTriggerConfig({ targetId: 'modal1' }));
    const removed = removeOverlayInCode(code, 'modal1', 'card1');
    expectParses(removed);
    expect(removed).not.toContain('modal1');
    expect(removed).not.toContain('useEffect');
    expect(removed).not.toContain('document.body.style.overflow');
  });

  test('adds an outside-press dismiss listener that closes the overlay', () => {
    const result = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    expectParses(result);
    // A document mousedown listener that closes the overlay when the press is
    // outside both the overlay and its trigger.
    expect(result).toContain("document.addEventListener('mousedown', onOutside)");
    expect(result).toContain('setDropdown1Open(false)');
    expect(result).toContain("document.removeEventListener('mousedown', onOutside)");
  });

  test('removeOverlay strips the dismiss listener with the effect', () => {
    const code = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    const removed = removeOverlayInCode(code, 'dropdown1', 'card1');
    expectParses(removed);
    expect(removed).not.toContain('onOutside');
    expect(removed).not.toContain("addEventListener('mousedown'");
  });

  test('creates conditional overlay block with data-overlay attr', () => {
    const overlayConfig = makeOverlayConfig();
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      overlayConfig,
      makeTriggerConfig(),
    );
    expect(result).toContain('{dropdown1Open && (');
    expect(result).toContain('data-id="dropdown1"');
    expect(result).toContain(`data-overlay='${JSON.stringify(overlayConfig)}'`);
  });

  test('creates with relative type (dropdown) — position fixed + dropdown styles', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig({ type: 'relative' }),
      makeTriggerConfig(),
    );
    // Relative overlays still use position: fixed for positioning, but get dropdown-specific styles
    expect(result).toContain("position: 'fixed'");
    expect(result).toContain("zIndex: '50'");
    expect(result).toContain("width: '200px'");
    expect(result).toContain("borderRadius: '8px'");
    expect(result).toContain("boxShadow:");
  });

  test('creates with fixed type (modal) — full-viewport backdrop, no inner child', () => {
    const overlayConfig = makeOverlayConfig({ type: 'fixed' });
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'modal1',
      overlayConfig,
      makeTriggerConfig({ targetId: 'modal1' }),
    );
    expect(result).toContain("position: 'fixed'");
    expect(result).toContain("left: '0'");
    expect(result).toContain("top: '0'");
    expect(result).toContain("width: '100%'");
    expect(result).toContain("height: '100vh'");
    expect(result).toContain("zIndex: '100'");
    expect(result).toContain("backgroundColor: 'rgba(0, 0, 0, 0.5)'");
    // No inner content div — user adds children inside
    expect(result).not.toContain("minWidth:");
    expect(result).not.toContain("minHeight:");
    // Fixed overlays don't generate useLayoutEffect call (no trigger positioning)
    expect(result).not.toContain("useLayoutEffect(() =>");
  });

  test('overlay block is placed inside root element (not after trigger)', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    // The overlay should be BEFORE the root's closing </div>
    const overlayIdx = result.indexOf('{dropdown1Open && (');
    const lastClose = result.lastIndexOf('</div>');
    expect(overlayIdx).toBeGreaterThan(0);
    expect(overlayIdx).toBeLessThan(lastClose);
  });

  test('useState appears before return statement', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const stateIdx = result.indexOf('const [dropdown1Open');
    const returnIdx = result.indexOf('return (');
    expect(stateIdx).toBeGreaterThan(0);
    expect(returnIdx).toBeGreaterThan(0);
    expect(stateIdx).toBeLessThan(returnIdx);
  });

  test('useLayoutEffect appears before return statement', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const effectIdx = result.indexOf('useLayoutEffect(');
    const returnIdx = result.indexOf('return (');
    expect(effectIdx).toBeGreaterThan(0);
    expect(effectIdx).toBeLessThan(returnIdx);
  });

  test('handles hyphenated overlay IDs (cleaning var name)', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'drop-down-1',
      makeOverlayConfig({ triggerId: 'card1' }),
      makeTriggerConfig({ targetId: 'drop-down-1' }),
    );
    // Hyphens become underscores, then _[a-z] becomes camelCase
    // "drop-down-1" → "drop_down_1" → "drop_down_1" (digit after _ stays)
    expect(result).toContain('dropDown_1Open');
    expect(result).toContain('setDropDown_1Open');
    expect(result).toContain('data-id="drop-down-1"');
  });

  test('result is valid JSX (no unclosed braces or parens from overlay block)', () => {
    const result = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    // Count { and } in the overlay block
    const overlayStart = result.indexOf('{dropdown1Open && (');
    const afterOverlay = result.slice(overlayStart);
    // Find the closing )} for the conditional
    expect(afterOverlay).toContain(')}');
  });

  test('cleans stale data-overlay-trigger if one already exists on trigger', () => {
    // Pre-add a stale trigger attr
    const codeWithStale = BASE_CODE.replace(
      'data-id="card1"',
      `data-id="card1" data-overlay-trigger='{"old":"config"}'`,
    );
    const result = createOverlayInCode(
      codeWithStale,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    // Should only have ONE data-overlay-trigger
    const matches = result.match(/data-overlay-trigger/g);
    expect(matches).toHaveLength(1);
  });
});

// ─── updateOverlayPositionInCode ────────────────────────────────────────────

describe('updateOverlayPositionInCode', () => {
  function codeWithOverlay(): string {
    return createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig({ side: 'bottom', align: 'start' }),
      makeTriggerConfig(),
    );
  }

  test('updates data-overlay JSON attribute', () => {
    const code = codeWithOverlay();
    const newConfig = makeOverlayConfig({ side: 'top', align: 'center', offsetX: 10, offsetY: -5 });
    const result = updateOverlayPositionInCode(code, 'dropdown1', newConfig);

    expect(result).toContain(`data-overlay='${JSON.stringify(newConfig)}'`);
    // Old config should not be present
    const oldConfig = makeOverlayConfig({ side: 'bottom', align: 'start' });
    expect(result).not.toContain(`data-overlay='${JSON.stringify(oldConfig)}'`);
  });

  test('handles data-overlay before data-id', () => {
    // Manually construct code where data-overlay comes before data-id
    const overlayConfig = makeOverlayConfig({ side: 'bottom', align: 'start' });
    const codeReversed = `<div data-overlay='${JSON.stringify(overlayConfig)}' data-id="dropdown1" style={{ position: 'fixed' }}></div>`;

    const newConfig = makeOverlayConfig({ side: 'right', align: 'end' });
    const result = updateOverlayPositionInCode(codeReversed, 'dropdown1', newConfig);

    expect(result).toContain(`data-overlay='${JSON.stringify(newConfig)}'`);
  });

  test('preserves non-position styles when updating', () => {
    const code = codeWithOverlay();
    const newConfig = makeOverlayConfig({ side: 'left', align: 'center' });
    const result = updateOverlayPositionInCode(code, 'dropdown1', newConfig);

    // Non-position styles should remain (like width, borderRadius, etc.)
    expect(result).toContain('width');
    expect(result).toContain('borderRadius');
  });

  test('returns code unchanged if overlay ID not found', () => {
    const code = codeWithOverlay();
    const newConfig = makeOverlayConfig({ side: 'top' });
    const result = updateOverlayPositionInCode(code, 'nonexistent', newConfig);
    // data-overlay for dropdown1 should be unchanged
    const oldConfig = makeOverlayConfig({ side: 'bottom', align: 'start' });
    expect(result).toContain(`data-overlay='${JSON.stringify(oldConfig)}'`);
  });
});

// ─── createOverlayInCode — inside a DESIGN COMPONENT (function + withResponsiveProps) ─

describe('createOverlayInCode — component file', () => {
  const COMPONENT_CODE = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';

function MyComp({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div data-id="root-comp" data-name="Frame" style={{ position: 'absolute', width: '300px', height: '500px' }} animate={variant}>
      <motion.div data-id="card1" style={{ width: '120px', height: '80px' }}></motion.div>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(MyComp);`;

  test('inserts useState + useLayoutEffect into the COMPONENT function (no crash/no-op)', () => {
    const result = createOverlayInCode(COMPONENT_CODE, 'card1', 'dropdown1',
      makeOverlayConfig(), makeTriggerConfig());
    expectParses(result);
    // Runtime landed INSIDE MyComp (not lost), and the conditional references it.
    expect(result).toContain('const [dropdown1Open, setDropdown1Open] = useState(false)');
    expect(result).toContain('useLayoutEffect(()');
    expect(result).toContain('{dropdown1Open &&');
    expect(result).toContain('<AnimatePresence>');
    // Trigger got its handler + pairing.
    expect(result).toContain('data-overlay-trigger=');
    expect(result).toContain('onClick={() => setDropdown1Open(!dropdown1Open)}');
    // The state decl sits after the existing variant useState, before the return.
    const stateIdx = result.indexOf('const [dropdown1Open');
    const returnIdx = result.indexOf('return <LayoutGroup>');
    expect(stateIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(returnIdx);
  });
});

// ─── healDanglingOverlayState ───────────────────────────────────────────────

describe('healDanglingOverlayState', () => {
  test('re-declares a missing useState referenced by an overlay conditional', () => {
    // A conditional + posEffect reference `dropOpen` but the useState was dropped.
    const code = `'use client';
import React, { useState, useLayoutEffect } from 'react';
export default function Page() {
  useLayoutEffect(() => { if (!dropOpen) return; }, [dropOpen]);
  return (
    <div data-id="root">
      <div data-id="t" onClick={() => setDropOpen(!dropOpen)}></div>
      {dropOpen && <div data-id="d" data-overlay='{}'></div>}
    </div>
  );
}`;
    const result = healDanglingOverlayState(code);
    expectParses(result);
    expect(result).toContain('const [dropOpen, setDropOpen] = useState(false)');
    const sIdx = result.indexOf('const [dropOpen');
    const rIdx = result.indexOf('return (');
    expect(sIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeLessThan(rIdx);
  });

  test('no-op when the useState already exists', () => {
    const code = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    expect(healDanglingOverlayState(code)).toBe(code);
  });
});

// ─── updateOverlayTriggerInCode ─────────────────────────────────────────────

describe('updateOverlayTriggerInCode', () => {
  function codeWithOverlay(): string {
    return createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig({ trigger: 'click', dismiss: 'outside' }),
    );
  }

  test('updates data-overlay-trigger attribute', () => {
    const code = codeWithOverlay();
    const newTriggerConfig = makeTriggerConfig({ trigger: 'hover', dismiss: 'click' });
    const result = updateOverlayTriggerInCode(code, 'card1', newTriggerConfig);

    expect(result).toContain(`data-overlay-trigger='${JSON.stringify(newTriggerConfig)}'`);
  });

  test('only updates the matching trigger (by nearby data-id)', () => {
    // Create two overlays on different triggers
    let code = createOverlayInCode(
      BASE_CODE_MULTI,
      'btn1',
      'dropdown1',
      makeOverlayConfig({ triggerId: 'btn1' }),
      makeTriggerConfig({ targetId: 'dropdown1', trigger: 'click' }),
    );
    code = createOverlayInCode(
      code,
      'btn2',
      'dropdown2',
      makeOverlayConfig({ triggerId: 'btn2' }),
      makeTriggerConfig({ targetId: 'dropdown2', trigger: 'click' }),
    );

    // Update only btn1's trigger config
    const newConfig = makeTriggerConfig({ targetId: 'dropdown1', trigger: 'hover', dismiss: 'escape' });
    const result = updateOverlayTriggerInCode(code, 'btn1', newConfig);

    // btn1's trigger should be updated
    const btn1Idx = result.indexOf('data-id="btn1"');
    const btn1Region = result.slice(btn1Idx, btn1Idx + 500);
    expect(btn1Region).toContain(`data-overlay-trigger='${JSON.stringify(newConfig)}'`);
  });

  test('returns code unchanged when triggerId not found', () => {
    const code = codeWithOverlay();
    const newConfig = makeTriggerConfig({ trigger: 'hover' });
    const result = updateOverlayTriggerInCode(code, 'nonexistent-trigger', newConfig);
    expect(result).toBe(code);
  });

  test('click → hover SWAPS the runtime handler (live site actually uses hover)', () => {
    const code = codeWithOverlay(); // starts with onClick
    expect(code).toContain('onClick={() => setDropdown1Open(!dropdown1Open)}');
    const result = updateOverlayTriggerInCode(code, 'card1', makeTriggerConfig({ trigger: 'hover' }));
    expectParses(result);
    // onClick gone, hover handlers (bridge) added on trigger AND overlay.
    expect(result).not.toContain('onClick={() => setDropdown1Open(!dropdown1Open)}');
    expect(result).toContain("onMouseEnter={() => { clearTimeout(((window as any).__ovGrace ||= {})['dropdown1']); setDropdown1Open(true); }}");
    expect(result).toMatch(/onMouseLeave=\{\(e\) => \{ const ov = document\.querySelector/);
    expect(result).toContain("setTimeout(() => setDropdown1Open(false), 180)");
    expect(result).toMatch(/onMouseLeave=\{\(e\) => \{ const tr = document\.querySelector/);
  });

  test('hover → click swaps back to onClick', () => {
    const hover = updateOverlayTriggerInCode(codeWithOverlay(), 'card1', makeTriggerConfig({ trigger: 'hover' }));
    const back = updateOverlayTriggerInCode(hover, 'card1', makeTriggerConfig({ trigger: 'click' }));
    expectParses(back);
    expect(back).toContain('onClick={() => setDropdown1Open(!dropdown1Open)}');
    expect(back).not.toContain('onMouseEnter={() => setDropdown1Open(true)}');
  });

  test('canvas overlay (no runtime) updates config but adds NO handler', () => {
    // Overlay created on the canvas — no useState, so no handler should be added.
    const canvasCode = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root"></div>;
}

const canvasNodes = (<>
  <div data-id="box1" data-canvas-node="true" data-overlay-trigger='{"targetId":"box1-overlay","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '0px', top: '0px', width: '100px', height: '50px' }}></div>
  <div data-id="box1-overlay" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"box1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'absolute', left: '0px', top: '60px', width: '200px', height: '100px' }}></div>
</>);`;
    const result = updateOverlayTriggerInCode(canvasCode, 'box1', makeTriggerConfig({ targetId: 'box1-overlay', trigger: 'hover' }));
    expectParses(result);
    expect(result).toContain('"trigger":"hover"');
    expect(result).not.toContain('onMouseEnter');  // no runtime → no handler
    expect(result).not.toContain('onClick');
  });
});

// ─── removeOverlayInCode ────────────────────────────────────────────────────

describe('removeOverlayInCode', () => {
  test('removes conditional overlay block', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');
    expect(result).not.toContain('{dropdown1Open && (');
    expect(result).not.toContain('data-id="dropdown1"');
  });

  test('removes useState declaration', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');
    expect(result).not.toContain('dropdown1Open');
    expect(result).not.toContain('setDropdown1Open');
    expect(result).not.toContain('useState(false)');
  });

  test('removes useLayoutEffect', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');
    expect(result).not.toContain('[dropdown1Open]');
    // Should not contain the overlay-specific effect
    expect(result).not.toContain('[data-id="dropdown1"]');
  });

  test('removes data-overlay-trigger attr', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');
    expect(result).not.toContain('data-overlay-trigger');
  });

  test('removes onClick handler', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig({ trigger: 'click' }),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');
    expect(result).not.toContain('onClick');
  });

  test('removes hover handlers (onMouseEnter/onMouseLeave)', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig({ trigger: 'hover' }),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');
    expect(result).not.toContain('onMouseEnter');
    expect(result).not.toContain('onMouseLeave');
  });

  test('result is clean — no leftover artifacts', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');

    // Should not contain any overlay-related artifacts
    expect(result).not.toContain('dropdown1Open');
    expect(result).not.toContain('setDropdown1Open');
    expect(result).not.toContain('data-overlay-trigger');
    expect(result).not.toContain('data-overlay=');
    expect(result).not.toContain('data-id="dropdown1"');

    // Should still contain original elements
    expect(result).toContain('data-id="root"');
    expect(result).toContain('data-id="card1"');
    expect(result).toContain('Card 1');
  });

  test('removes fixed (modal) overlay cleanly', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'modal1',
      makeOverlayConfig({ type: 'fixed' }),
      makeTriggerConfig({ targetId: 'modal1', trigger: 'click' }),
    );
    const result = removeOverlayInCode(code, 'modal1', 'card1');
    expect(result).not.toContain('modal1Open');
    expect(result).not.toContain('data-id="modal1"');
    expect(result).not.toContain('data-overlay');
    expect(result).toContain('data-id="root"');
    expect(result).toContain('data-id="card1"');
  });

  test('round-trip: create then remove yields code similar to original', () => {
    const code = createOverlayInCode(
      BASE_CODE,
      'card1',
      'dropdown1',
      makeOverlayConfig(),
      makeTriggerConfig(),
    );
    const result = removeOverlayInCode(code, 'dropdown1', 'card1');

    // Original content should be preserved
    expect(result).toContain('data-id="root"');
    expect(result).toContain('data-id="card1"');
    expect(result).toContain("width: '200px'");
    expect(result).toContain("height: '100px'");
    expect(result).toContain('Card 1');
    expect(result).toContain('export default function Page()');
  });
});

// ─── removeOverlayInCode — real-world forms (motion.div, parens, multi) ──────
//
// Overlays in real pages diverge from the canonical `createOverlayInCode`
// output: an Appear animation turns `<div>` into `<motion.div>`, and the
// conditional is sometimes serialized with parens (`&& ( … )`) and sometimes
// without (`&& <motion.div/>`). Deleting these used to fall through to a plain
// removeNode and leave `{varOpen && ( )}` behind → "Unexpected token".

describe('removeOverlayInCode — real-world forms', () => {
  const PAGE_WITH_MOTION_OVERLAYS = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  const [overlayAOpen, setOverlayAOpen] = useState(false);
  const [overlayBOpen, setOverlayBOpen] = useState(false);
  useLayoutEffect(() => {
    if (!overlayBOpen) return;
    const position = () => {
      const overlay = document.querySelector('[data-id="overlayB"]');
      if (!overlay) return;
      const cfg = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
      overlay.style.top = '0px';
    };
    position();
    window.addEventListener('resize', position);
    return () => { window.removeEventListener('resize', position); };
  }, [overlayBOpen]);
  return <div data-id="root" style={{ position: 'relative', width: '100%', height: '900px' }}>

      {overlayAOpen && <motion.div data-id="overlayA" data-overlay='{"type":"relative","triggerId":"triggerA","side":"bottom","align":"start","offsetX":-40,"offsetY":20}' style={{
      position: 'fixed',
      zIndex: '50',
      width: '495px',
      height: '276px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
    }} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
      <div data-id="inner-a" style={{ width: '147px', height: '162px' }}></div>
  </motion.div>}

    <div data-id="triggerA" style={{ position: 'absolute', width: '100px', height: '40px' }} data-overlay-trigger='{"targetId":"overlayA","trigger":"click","dismiss":"outside"}' onClick={() => setOverlayAOpen(!overlayAOpen)}></div>

    <div data-id="triggerB" style={{ position: 'absolute', width: '120px', height: '50px' }} data-overlay-trigger='{"targetId":"overlayB","trigger":"click","dismiss":"outside"}' onClick={() => setOverlayBOpen(!overlayBOpen)}></div>

      {overlayBOpen && (
        <motion.div data-id="overlayB" data-overlay='{"type":"relative","triggerId":"triggerB","side":"top","align":"end","offsetX":32,"offsetY":12}' style={{
        position: 'fixed',
        zIndex: '50',
        width: '534px',
        height: '143px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
      }}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          >
        </motion.div>
      )}
    </div>;
}`;

  test('removes a no-parens motion.div overlay (leaves siblings intact + parses)', () => {
    const result = removeOverlayInCode(PAGE_WITH_MOTION_OVERLAYS, 'overlayA', 'triggerA');
    expectParses(result);
    // Overlay A fully gone
    expect(result).not.toContain('data-id="overlayA"');
    expect(result).not.toContain('overlayAOpen');
    expect(result).not.toContain('setOverlayAOpen');
    expect(result).not.toContain('"targetId":"overlayA"');
    expect(result).not.toContain('{overlayAOpen &&');
    // Sibling overlay B untouched (block, state, effect, trigger attr, handler)
    expect(result).toContain('data-id="overlayB"');
    expect(result).toContain('const [overlayBOpen, setOverlayBOpen] = useState(false)');
    expect(result).toContain('}, [overlayBOpen]);');
    expect(result).toContain('"targetId":"overlayB"');
    expect(result).toContain('setOverlayBOpen(!overlayBOpen)');
    // triggerA element survives (only its overlay wiring removed)
    expect(result).toContain('data-id="triggerA"');
  });

  test('removes a parens-wrapped motion.div overlay + its useLayoutEffect', () => {
    const result = removeOverlayInCode(PAGE_WITH_MOTION_OVERLAYS, 'overlayB', 'triggerB');
    expectParses(result);
    expect(result).not.toContain('data-id="overlayB"');
    expect(result).not.toContain('overlayBOpen');
    // The useLayoutEffect BLOCK is removed (the bare import token is cleaned
    // separately by syncImports after the mutation, not by this pure transform).
    expect(result).not.toContain('useLayoutEffect(()');
    expect(result).not.toContain('}, [overlayBOpen]);');
    expect(result).not.toContain('"targetId":"overlayB"');
    // Sibling overlay A untouched
    expect(result).toContain('data-id="overlayA"');
    expect(result).toContain('overlayAOpen');
    expect(result).toContain('"targetId":"overlayA"');
  });

  test('deleting one overlay does NOT strip the other overlay trigger attr', () => {
    const result = removeOverlayInCode(PAGE_WITH_MOTION_OVERLAYS, 'overlayA', 'triggerA');
    // The old unscoped replace stripped the FIRST data-overlay-trigger in file.
    const triggerAttrs = result.match(/data-overlay-trigger=/g) || [];
    expect(triggerAttrs).toHaveLength(1);
    expect(result).toContain('"targetId":"overlayB"');
  });

  test('self-heals a half-deleted overlay (empty {varOpen && ( )} wrapper)', () => {
    // Simulates the broken state: a prior plain removeNode stripped the element
    // but left the conditional wrapper + state behind (the parse error).
    const broken = `'use client';
import React, { useState } from 'react';
export default function Page() {
  const [overlayCOpen, setOverlayCOpen] = useState(false);
  return <div data-id="root" style={{ position: 'relative' }}>
    <div data-id="triggerC" data-overlay-trigger='{"targetId":"overlayC","trigger":"click","dismiss":"outside"}' onClick={() => setOverlayCOpen(!overlayCOpen)}></div>

      {overlayCOpen && (
      )}
    </div>;
}`;
    // broken input does NOT parse
    expect(() => parse(broken, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).toThrow();
    const result = removeOverlayInCode(broken, 'overlayC', 'triggerC');
    expectParses(result);
    expect(result).not.toContain('overlayCOpen');
    expect(result).not.toContain('data-overlay-trigger');
    expect(result).toContain('data-id="triggerC"');
  });
});

// ─── Per-viewport responsive config ──────────────────────────────────────────

describe('createOverlayInCode — responsive runtime', () => {
  test('generated positioner resolves per-window-width responsive overrides', () => {
    const code = createOverlayInCode(
      BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig(),
    );
    // The useLayoutEffect must read raw.responsive and cascade by window width.
    expect(code).toContain('raw.responsive');
    expect(code).toContain('window.innerWidth');
    expectParses(code);
  });
});

describe('updateOverlayConfigInCode — base vs replica overrides', () => {
  const make = () => createOverlayInCode(
    BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig(),
  );

  test('vpWidth null writes the BASE config', () => {
    const code = make();
    const result = updateOverlayConfigInCode(code, 'dropdown1', { offsetX: 25, side: 'top' }, null);
    expectParses(result);
    const cfg = readOverlayConfig(result);
    expect(cfg.offsetX).toBe(25);
    expect(cfg.side).toBe('top');
    expect(cfg.responsive).toBeUndefined();
  });

  test('vpWidth writes a responsive override, leaving base intact', () => {
    const code = make();
    const result = updateOverlayConfigInCode(code, 'dropdown1', { offsetX: 40, side: 'left' }, 768);
    expectParses(result);
    const cfg = readOverlayConfig(result);
    expect(cfg.offsetX).toBe(0);        // base untouched
    expect(cfg.side).toBe('bottom');    // base untouched
    expect(cfg.responsive?.['768']).toEqual({ offsetX: 40, side: 'left' });
  });

  test('variant writes a per-VARIANT override (component), leaving base intact', () => {
    const code = make();
    const result = updateOverlayConfigInCode(code, 'dropdown1', { offsetX: 30, align: 'end' }, null, [], undefined, 'variant-1');
    expectParses(result);
    const cfg = readOverlayConfig(result);
    expect(cfg.offsetX).toBe(0);        // base untouched
    expect(cfg.align).toBe('start');    // base untouched (makeOverlayConfig default)
    expect(cfg.responsiveVariant?.['variant-1']).toEqual({ offsetX: 30, align: 'end' });
    expect(cfg.responsive).toBeUndefined(); // not the width path
  });

  test('variant reset removes the key (and the map when empty)', () => {
    let code = updateOverlayConfigInCode(make(), 'dropdown1', { offsetX: 30 }, null, [], undefined, 'variant-1');
    code = updateOverlayConfigInCode(code, 'dropdown1', {}, null, ['offsetX'], undefined, 'variant-1');
    const cfg = readOverlayConfig(code);
    expect(cfg.responsiveVariant).toBeUndefined();
  });

  test('successive replica writes MERGE into the same breakpoint', () => {
    let code = make();
    code = updateOverlayConfigInCode(code, 'dropdown1', { offsetX: 40 }, 768);
    code = updateOverlayConfigInCode(code, 'dropdown1', { align: 'end' }, 768);
    const cfg = readOverlayConfig(code);
    expect(cfg.responsive?.['768']).toEqual({ offsetX: 40, align: 'end' });
  });

  test('resetKeys removes overridden keys; empties drop the breakpoint + map', () => {
    let code = make();
    code = updateOverlayConfigInCode(code, 'dropdown1', { offsetX: 40, side: 'left' }, 768);
    // Reset just `side` → keeps offsetX
    code = updateOverlayConfigInCode(code, 'dropdown1', {}, 768, ['side']);
    expect(readOverlayConfig(code).responsive?.['768']).toEqual({ offsetX: 40 });
    // Reset the last key → breakpoint gone, and with no breakpoints, responsive gone
    code = updateOverlayConfigInCode(code, 'dropdown1', {}, 768, ['offsetX']);
    expect(readOverlayConfig(code).responsive).toBeUndefined();
    expectParses(code);
  });

  test('two breakpoints coexist independently', () => {
    let code = make();
    code = updateOverlayConfigInCode(code, 'dropdown1', { offsetY: 12 }, 768);
    code = updateOverlayConfigInCode(code, 'dropdown1', { offsetY: 30 }, 375);
    const cfg = readOverlayConfig(code);
    expect(cfg.responsive?.['768']).toEqual({ offsetY: 12 });
    expect(cfg.responsive?.['375']).toEqual({ offsetY: 30 });
  });

  // ─── onOpenVariant: base rewrites the instance ternary; replica/variant store config only ─
  test('BASE onOpenVariant rewrites the instance trigger ternary', () => {
    const code = make();
    const result = updateOverlayConfigInCode(code, 'dropdown1', { onOpenVariant: 'variant-2' }, null);
    expectParses(result);
    // The card1 trigger now drives initialVariant from the overlay open state.
    expect(result).toMatch(/initialVariant=\{dropdown1Open \? 'variant-2' : 'default'\}/);
    expect(readOverlayConfig(result).onOpenVariant).toBe('variant-2');
  });

  test('REPLICA onOpenVariant bakes a window.innerWidth resolver into the instance ternary', () => {
    let code = updateOverlayConfigInCode(make(), 'dropdown1', { onOpenVariant: 'variant-2' }, null); // base
    code = updateOverlayConfigInCode(code, 'dropdown1', { onOpenVariant: 'variant-3' }, 768, [], [375, 768, 1440]);
    expectParses(code);
    const cfg = readOverlayConfig(code);
    expect(cfg.onOpenVariant).toBe('variant-2');                       // base untouched
    expect(cfg.responsive?.['768']).toEqual({ onOpenVariant: 'variant-3' });
    // The instance now resolves the OPEN variant by viewport width: tablet (≤768)
    // → variant-3, wider → base variant-2; mobile (≤375, no override) → base.
    expect(code).toContain(
      "initialVariant={dropdown1Open ? (window.innerWidth <= 375 ? 'variant-2' : window.innerWidth <= 768 ? 'variant-3' : 'variant-2') : 'default'}",
    );
  });

  test('replica resolver collapses back to a static ternary when the override is reset', () => {
    let code = updateOverlayConfigInCode(make(), 'dropdown1', { onOpenVariant: 'variant-2' }, null);
    code = updateOverlayConfigInCode(code, 'dropdown1', { onOpenVariant: 'variant-3' }, 768, [], [375, 768, 1440]);
    code = updateOverlayConfigInCode(code, 'dropdown1', {}, 768, ['onOpenVariant'], [375, 768, 1440]); // reset replica
    expectParses(code);
    expect(readOverlayConfig(code).responsive).toBeUndefined();
    expect(code).toMatch(/initialVariant=\{dropdown1Open \? 'variant-2' : 'default'\}/);
    // The instance ternary itself collapses back to the static base (no resolver).
    const iv = code.match(/initialVariant=\{[^}]*\}/)![0];
    expect(iv).not.toContain('window.innerWidth');
  });

  test('VARIANT onOpenVariant stores responsiveVariant override WITHOUT touching the base ternary', () => {
    let code = updateOverlayConfigInCode(make(), 'dropdown1', { onOpenVariant: 'variant-2' }, null);
    code = updateOverlayConfigInCode(code, 'dropdown1', { onOpenVariant: 'variant-3' }, null, [], undefined, 'variant-1');
    expectParses(code);
    const cfg = readOverlayConfig(code);
    expect(cfg.onOpenVariant).toBe('variant-2');
    expect(cfg.responsiveVariant?.['variant-1']).toEqual({ onOpenVariant: 'variant-3' });
    expect(code).toMatch(/initialVariant=\{dropdown1Open \? 'variant-2' : 'default'\}/);
  });

  test('breakpoints arg bakes a sorted responsiveBp; cleared when overrides empty', () => {
    let code = make();
    code = updateOverlayConfigInCode(code, 'dropdown1', { offsetX: 40 }, 768, [], [375, 1440, 768, 768]);
    expect(readOverlayConfig(code).responsiveBp).toEqual([375, 768, 1440]); // sorted + deduped
    // Reset the only override → responsive AND responsiveBp both dropped.
    code = updateOverlayConfigInCode(code, 'dropdown1', {}, 768, ['offsetX'], [375, 1440, 768]);
    expect(readOverlayConfig(code).responsive).toBeUndefined();
    expect(readOverlayConfig(code).responsiveBp).toBeUndefined();
  });
});

// ─── extractOverlayToCanvasInCode (drag trigger out → both become canvas nodes) ─

describe('extractOverlayToCanvasInCode', () => {
  const make = () => createOverlayInCode(
    BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig(),
  );

  test('produces valid module-scope code (no undefined-identifier crash)', () => {
    const code = make();
    const result = extractOverlayToCanvasInCode(code, 'card1', 40, 200);
    expectParses(result);
    // The runtime mechanism is gone — these are what crash at module scope.
    // (The bare `useState`/`useLayoutEffect` import tokens are cleaned by
    // syncImports after the mutation, not by this pure transform.)
    expect(result).not.toContain('useState(false)');
    expect(result).not.toContain('useLayoutEffect(()');
    expect(result).not.toContain('}, [dropdown1Open]');
    expect(result).not.toContain('dropdown1Open');     // the state var + its setter
    expect(result).not.toContain('onClick');
  });

  test('moves the overlay into canvasNodes as metadata, flips fixed→absolute', () => {
    const code = make();
    const result = extractOverlayToCanvasInCode(code, 'card1', 40, 200);
    // Overlay element is now a canvas node carrying its data-overlay metadata.
    expect(result).toContain('const canvasNodes');
    const cn = result.slice(result.indexOf('const canvasNodes'));
    expect(cn).toContain('data-id="dropdown1"');
    expect(cn).toContain('data-overlay=');
    expect(cn).toContain('data-canvas-node="true"');
    expect(cn).toContain("position: 'absolute'");
    expect(cn).toContain("left: '40px'");
    expect(cn).not.toContain("position: 'fixed'");
    // The conditional wrapper is gone from the page return.
    expect(result).not.toContain('{dropdown1Open &&');
  });

  test('keeps the trigger pairing (data-overlay-trigger) but drops its onClick', () => {
    const code = make();
    const result = extractOverlayToCanvasInCode(code, 'card1', 40, 200);
    expect(result).toContain('data-overlay-trigger=');     // pairing preserved
    expect(result).toContain('"targetId":"dropdown1"');
    expect(result).not.toContain('setDropdown1Open');      // handler gone
  });

  test('already a canvas node → no-op (no duplicate overlay)', () => {
    const code = make();
    const once = extractOverlayToCanvasInCode(code, 'card1', 40, 200);
    // Running extract AGAIN must not append a second copy of the overlay.
    const twice = extractOverlayToCanvasInCode(once, 'card1', 40, 200);
    expect(twice).toBe(once);
    const occurrences = (twice.match(/data-id="dropdown1"/g) || []).length;
    expect(occurrences).toBe(1);
  });

  test('overlay already gone → falls back to a clean removeOverlay (still parses)', () => {
    const code = make();
    // Remove the overlay element first, then extract — should not throw / corrupt.
    const stripped = removeOverlayInCode(code, 'dropdown1', 'card1');
    const result = extractOverlayToCanvasInCode(stripped, 'card1', 0, 0);
    expectParses(result);
  });

  // Regression: with MULTIPLE overlays, extracting a non-first one must only remove
  // THAT overlay's useState + positioner — not span across the others. The old lazy
  // `useLayoutEffect(() => {…[data-id="X"]…}` regex anchored on the FIRST effect and
  // swallowed every intermediate overlay's runtime → "References undefined identifiers
  // …Open" crash when dragging a non-first overlay's trigger to the canvas.
  test('multi-overlay: extracting a NON-first trigger leaves the others intact', () => {
    const multi = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return (<div data-id="root" style={{ position: 'relative' }}>
    <div data-id="t1" style={{ width: '50px', height: '50px' }}></div>
    <div data-id="t2" style={{ width: '50px', height: '50px' }}></div>
    <div data-id="t3" style={{ width: '50px', height: '50px' }}></div>
  </div>);
}`;
    let c = createOverlayInCode(multi, 't1', 'ov1', makeOverlayConfig({ triggerId: 't1' }), makeTriggerConfig({ targetId: 'ov1' }));
    c = createOverlayInCode(c, 't2', 'ov2', makeOverlayConfig({ triggerId: 't2' }), makeTriggerConfig({ targetId: 'ov2' }));
    c = createOverlayInCode(c, 't3', 'ov3', makeOverlayConfig({ triggerId: 't3' }), makeTriggerConfig({ targetId: 'ov3' }));
    expect((c.match(/= useState\(false\)/g) || []).length).toBe(3);

    const out = extractOverlayToCanvasInCode(c, 't3', 100, 100); // last
    expectParses(out);
    expect((out.match(/= useState\(false\)/g) || []).length).toBe(2); // ov1 + ov2 survive
    expect(out).toMatch(/const \[ov1Open/);
    expect(out).toMatch(/const \[ov2Open/);
    expect(out).not.toMatch(/const \[ov3Open/);
    expect(out).toMatch(/data-id="ov3"[^>]*data-canvas-node|data-canvas-node[^>]*data-id="ov3"/);

    // And extracting the FIRST one is equally scoped.
    const out2 = extractOverlayToCanvasInCode(c, 't1', 0, 0);
    expectParses(out2);
    expect((out2.match(/= useState\(false\)/g) || []).length).toBe(2);
    expect(out2).not.toMatch(/const \[ov1Open/);
  });

  // Worst case: a leading helper hook (`useOverlayPos`) whose own `useLayoutEffect` is the
  // FIRST in the file. The old regex anchored there and the lazy span swallowed the
  // helper's close + `export default function Page() {` + every useState — MERGING the
  // page into the helper. The scoped `, [<var>]);` anchor must keep both intact.
  test('a leading useOverlayPos helper is NOT merged into Page on extract', () => {
    const withHelper = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
function useOverlayPos(openState, overlayId) {
  useLayoutEffect(() => {
    if (!openState) return;
    const overlay = document.querySelector('[data-id="' + overlayId + '"]');
  }, [openState, overlayId]);
}
export default function Page() {
  return (<div data-id="root" style={{ position: 'relative' }}>
    <div data-id="t1" style={{ width: '50px', height: '50px' }}></div>
    <div data-id="t2" style={{ width: '50px', height: '50px' }}></div>
  </div>);
}`;
    let c = createOverlayInCode(withHelper, 't1', 'ov1', makeOverlayConfig({ triggerId: 't1' }), makeTriggerConfig({ targetId: 'ov1' }));
    c = createOverlayInCode(c, 't2', 'ov2', makeOverlayConfig({ triggerId: 't2' }), makeTriggerConfig({ targetId: 'ov2' }));
    const out = extractOverlayToCanvasInCode(c, 't2', 100, 100);
    expectParses(out);
    expect(out).toContain('function useOverlayPos(openState, overlayId)');
    expect(out).toContain('export default function Page()');
    expect(out).toMatch(/useOverlayPos[\s\S]*\}, \[openState, overlayId\]\)/); // helper effect intact
    expect(out).toMatch(/const \[ov1Open/);   // other overlay survives
    expect(out).not.toMatch(/const \[ov2Open/); // extracted one removed
  });
});

// ─── createCanvasOverlayInCode (create overlay directly on a canvas-node trigger) ─

describe('createCanvasOverlayInCode', () => {
  // A page whose trigger lives in the module-scope canvasNodes fragment.
  const CANVAS_CODE = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
    </div>
  );
}

const canvasNodes = (<>
  <div data-id="box1" data-canvas-node="true" style={{ position: 'absolute', left: '500px', top: '300px', width: '180px', height: '120px' }}>Box</div>
</>);`;

  const cfg = makeOverlayConfig({ triggerId: 'box1', align: 'center', offsetY: 10 });
  const trig = makeTriggerConfig();

  test('produces valid code with NO runtime mechanism (module-scope safe)', () => {
    const result = createCanvasOverlayInCode(CANVAS_CODE, 'box1', 'dropdown1', cfg, trig);
    expectParses(result);
    expect(result).not.toContain('useState');
    expect(result).not.toContain('useLayoutEffect');
    expect(result).not.toContain('onClick');
  });

  test('appends the overlay as a canvas node carrying data-overlay', () => {
    const result = createCanvasOverlayInCode(CANVAS_CODE, 'box1', 'dropdown1', cfg, trig);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    expect(cn).toContain('data-id="dropdown1"');
    expect(cn).toContain('data-canvas-node="true"');
    expect(cn).toContain('data-overlay=');
    expect(cn).toContain("position: 'absolute'");
    // Config round-trips through the parser.
    const created = parseOverlayCalls(result).find(c => c.overlayId === 'dropdown1');
    expect(created?.config.triggerId).toBe('box1');
    expect(created?.config.align).toBe('center');
  });

  test('canvas overlay carries the Appear (motion.div + initial/animate/exit) as metadata', () => {
    const result = createCanvasOverlayInCode(CANVAS_CODE, 'box1', 'dropdown1', cfg, trig);
    expectParses(result);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    expect(cn).toContain('<motion.div key="dropdown1"');
    expect(cn).toContain('initial={{ opacity: 0, y: 20 }}');
    expect(cn).toContain('animate={{ opacity: 1, y: 0 }}');
    expect(cn).toContain('exit={{ opacity: 0, y: 20 }}');
    expect(cn).not.toContain('<AnimatePresence>'); // canvas = static metadata, no runtime wrapper
  });

  test('canvas-created overlay rehydrates WITH its Appear when dragged into a viewport', () => {
    // Trigger back in the return (executable scope, as a real drag-in leaves it),
    // the canvas overlay (motion.div + appear, as createCanvasOverlay emits) in canvasNodes.
    const code = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="box1" data-overlay-trigger='{"targetId":"dropdown1","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '10px', top: '20px', width: '120px', height: '80px' }}></div>
    </div>
  );
}

const canvasNodes = (<>
  <motion.div key="dropdown1" data-id="dropdown1" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"box1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'absolute', left: '20px', top: '108px', width: '200px', height: '100px' }}></motion.div>
</>);`;
    const rehydrated = rehydrateOverlayFromCanvasInCode(code, 'box1');
    expectParses(rehydrated);
    expect(rehydrated).toContain('<AnimatePresence>');
    expect(rehydrated).toContain('exit={{ opacity: 0, y: 20 }}');
  });

  test('initial position is computed below the trigger (bottom/center, +10 Y)', () => {
    const result = createCanvasOverlayInCode(CANVAS_CODE, 'box1', 'dropdown1', cfg, trig);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    // trigger: left 500, top 300, w 180, h 120; overlay 200×100.
    // bottom: top = 300 + 120 + 8 + 10 = 438; center: left = 500 + 90 - 100 = 490.
    expect(cn).toContain("top: '438px'");
    expect(cn).toContain("left: '490px'");
  });

  test('tags the trigger with data-overlay-trigger (pairing) and no onClick', () => {
    const result = createCanvasOverlayInCode(CANVAS_CODE, 'box1', 'dropdown1', cfg, trig);
    expect(result).toContain('data-overlay-trigger=');
    expect(result).toContain('"targetId":"dropdown1"');
    expect(result).not.toContain('onClick');
  });

  test('creates the canvasNodes fragment when absent', () => {
    const noFragment = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="box1" data-canvas-node="true" style={{ position: 'absolute', left: '10px', top: '20px', width: '100px', height: '50px' }}>Box</div>
    </div>
  );
}`;
    const result = createCanvasOverlayInCode(noFragment, 'box1', 'dropdown1', cfg, trig);
    expectParses(result);
    expect(result).toContain('const canvasNodes');
    expect(result.slice(result.indexOf('const canvasNodes'))).toContain('data-id="dropdown1"');
  });

  test('missing trigger → returns code unchanged (no crash)', () => {
    const result = createCanvasOverlayInCode(CANVAS_CODE, 'nope', 'dropdown1', cfg, trig);
    expect(result).toBe(CANVAS_CODE);
  });
});

// ─── rehydrateOverlayFromCanvasInCode (drag trigger back into a viewport) ───────

describe('rehydrateOverlayFromCanvasInCode', () => {
  // Full round-trip: create on a viewport trigger → extract to canvas → rehydrate.
  const extracted = () => extractOverlayToCanvasInCode(
    createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig()),
    'card1', 40, 200,
  );

  test('restores the runtime mechanism and parses', () => {
    const result = rehydrateOverlayFromCanvasInCode(extracted(), 'card1');
    expectParses(result);
    expect(result).toContain('useState(false)');
    expect(result).toContain('useLayoutEffect(()');
    expect(result).toContain('{dropdown1Open &&');
    // Trigger handler restored.
    expect(result).toContain('setDropdown1Open');
  });

  test('moves the overlay out of canvasNodes back into the page return as fixed', () => {
    const result = rehydrateOverlayFromCanvasInCode(extracted(), 'card1');
    // The overlay element is no longer a canvas node.
    expect(result).not.toContain('data-canvas-node="true"');
    expect(result).toContain("position: 'fixed'");
    expect(result).not.toContain("position: 'absolute'");
    // Config still parses and points at the trigger.
    const call = parseOverlayCalls(result).find(c => c.overlayId === 'dropdown1');
    expect(call?.config.triggerId).toBe('card1');
  });

  test('round-trip create→extract→rehydrate restores an openable overlay', () => {
    const original = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    const round = rehydrateOverlayFromCanvasInCode(extractOverlayToCanvasInCode(original, 'card1', 40, 200), 'card1');
    expectParses(round);
    // Same runtime shape as a freshly-created viewport overlay.
    expect(round).toContain('const [dropdown1Open, setDropdown1Open] = useState(false)');
    expect(round).toContain('data-overlay-trigger=');
  });

  test('works for a canvas-CREATED overlay dragged into a viewport', () => {
    // Overlay born on the canvas (no prior runtime), then trigger dragged in.
    const canvasCode = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="box1" style={{ width: '180px', height: '120px' }}>Box</div>
    </div>
  );
}

const canvasNodes = (<>
</>);`;
    const created = createCanvasOverlayInCode(canvasCode, 'box1', 'dropdown1', makeOverlayConfig({ triggerId: 'box1' }), makeTriggerConfig());
    const result = rehydrateOverlayFromCanvasInCode(created, 'box1');
    expectParses(result);
    expect(result).toContain('useLayoutEffect(()');
    expect(result).toContain("position: 'fixed'");
    expect(result).toContain('zIndex: 50');   // z-index ensured even though canvas create omitted it
    expect(result).not.toContain('data-canvas-node="true"');
  });

  test('non-overlay node → unchanged', () => {
    const result = rehydrateOverlayFromCanvasInCode(BASE_CODE, 'card1');
    expect(result).toBe(BASE_CODE);
  });

  test('ignores [data-id] CSS selectors in <style> blocks (no <style> handler, no module-scope conditional)', () => {
    // Reproduces the replica round-trip: the page has a container-query <style>
    // block whose `[data-id="box1"]{display:none}` selector appears BEFORE the
    // real trigger element, and the overlay lives in canvasNodes.
    const code = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <style>{\`
        @media (max-width: 768px) { [data-id="box1"] { display: none !important; } }
      \`}</style>
      <div data-id="box1" data-name="Frame" data-overlay-trigger='{"targetId":"box1-overlay","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '10px', top: '20px', width: '120px', height: '80px' }}></div>
    </div>
  );
}

const canvasNodes = (<>
  <div data-id="box1-overlay" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"box1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'absolute', left: '20px', top: '108px', width: '200px', height: '100px', backgroundColor: '#7CBFFF' }}></div>
</>);`;
    const result = rehydrateOverlayFromCanvasInCode(code, 'box1');
    expectParses(result);
    // Handler went on the real trigger, NOT the <style> element.
    expect(result).not.toMatch(/<style[^>]*onClick/);
    // The conditional is in the RETURN (before canvasNodes), not module scope.
    const condIdx = result.indexOf('box1OverlayOpen &&');
    const canvasIdx = result.indexOf('const canvasNodes');
    expect(condIdx).toBeGreaterThan(-1);
    expect(condIdx).toBeLessThan(canvasIdx);
    // useState declared so the conditional identifier is defined.
    expect(result).toContain('const [box1OverlayOpen, setBox1OverlayOpen] = useState(false)');
  });

  test('already a live viewport overlay → unchanged (no double-wrap)', () => {
    const live = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    const result = rehydrateOverlayFromCanvasInCode(live, 'card1');
    expect(result).toBe(live);
  });

  test('rehydrate into a COMPONENT variant inserts useState (no undefined-identifier crash)', () => {
    // Mirrors the real component: typed destructured params, a variant useState +
    // useEffect, the trigger back in the return, the canvas overlay in canvasNodes.
    const code = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

function JoMoBa({
  style,
  initialVariant = 'default'
}: {style?: React.CSSProperties;initialVariant?: string;}) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => {
    setVariant(initialVariant);
  }, [initialVariant]);
  return <LayoutGroup>
    <motion.div data-id="root-comp" animate={variant} style={{ position: 'absolute', width: '300px', height: '500px' }}>
      <motion.div data-id="trig1" data-overlay-trigger='{"targetId":"trig1-overlay","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '10px', top: '20px', width: '120px', height: '80px' }}></motion.div>
    </motion.div>
  </LayoutGroup>;
}
export default withResponsiveProps(JoMoBa);

const canvasNodes = <>
  <motion.div key="trig1-overlay" data-id="trig1-overlay" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"trig1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'absolute', left: '20px', top: '108px', width: '200px', height: '100px' }}></motion.div>
</>;`;
    const result = rehydrateOverlayFromCanvasInCode(code, 'trig1');
    expectParses(result);
    // The useState MUST be declared (the conditional + posEffect reference it).
    expect(result).toContain('const [trig1OverlayOpen, setTrig1OverlayOpen] = useState(false)');
    expect(result).toContain('{trig1OverlayOpen &&');
    expect(result).toContain('onClick={() => setTrig1OverlayOpen(!trig1OverlayOpen)}');
    // useState sits inside the component, before the return.
    const sIdx = result.indexOf('const [trig1OverlayOpen');
    const rIdx = result.indexOf('return <LayoutGroup>');
    expect(sIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeLessThan(rIdx);
  });

  test('trigger dragged into ANOTHER canvas frame (still module scope) → no-op (no runtime, no crash)', () => {
    // Both the trigger and its overlay are inside canvasNodes — the trigger
    // nested inside another canvas frame. Rehydrate must NOT add useState/onClick
    // (they'd reference a function-local var from module scope → crash).
    const code = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}></div>
  );
}

const canvasNodes = (<>
  <div data-id="frameA" data-canvas-node="true" style={{ position: 'absolute', left: '0px', top: '0px', width: '400px', height: '400px' }}>
    <div data-id="box1" data-overlay-trigger='{"targetId":"box1-overlay","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '10px', top: '20px', width: '120px', height: '80px' }}></div>
  </div>
  <div data-id="box1-overlay" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"box1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'absolute', left: '20px', top: '108px', width: '200px', height: '100px' }}></div>
</>);`;
    const result = rehydrateOverlayFromCanvasInCode(code, 'box1');
    expect(result).toBe(code);            // untouched
    expect(result).not.toContain('useState');
    expect(result).not.toContain('Box1OverlayOpen');
  });
});

// ─── cloneOverlayToCanvasTriggerInCode (replica with overlay dragged to canvas) ─

describe('cloneOverlayToCanvasTriggerInCode', () => {
  // A page with a viewport overlay on `card1`, PLUS a canvas-node clone of the
  // trigger (id `clone1`) that a replica drag-out just produced — the clone
  // carries the SOURCE's stale data-overlay-trigger.
  const withClone = () => {
    const base = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig({ align: 'center', offsetY: 10 }), makeTriggerConfig());
    // Simulate the addCanvasNode clone: a canvas node with the cloned (stale) trigger attr.
    const exportIdx = base.indexOf('const canvasNodes');
    const cloneEl = `\n\nconst canvasNodes = (<>\n  <div data-id="clone1" data-canvas-node="true" data-overlay-trigger='{"targetId":"dropdown1","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '700px', top: '300px', width: '200px', height: '100px' }}>Clone</div>\n</>);\n`;
    return exportIdx >= 0 ? base : base + cloneEl;
  };

  test('clones the overlay as a NEW canvas overlay paired to the clone trigger', () => {
    const result = cloneOverlayToCanvasTriggerInCode(withClone(), 'card1', 'clone1', 0);
    expectParses(result);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    // New overlay node exists and points at the clone, not the source.
    expect(cn).toContain('data-id="clone1-overlay"');
    const cloned = parseOverlayCalls(result).find(c => c.overlayId === 'clone1-overlay');
    expect(cloned?.config.triggerId).toBe('clone1');
    expect(cloned?.config.align).toBe('center');
  });

  test('rewrites the clone trigger\'s stale pairing to the new overlay', () => {
    const result = cloneOverlayToCanvasTriggerInCode(withClone(), 'card1', 'clone1', 0);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    // The clone trigger now points at clone1-overlay, not the source dropdown1.
    expect(cn).toContain('"targetId":"clone1-overlay"');
    // The clone trigger no longer references the source overlay id as its target.
    expect(cn).not.toMatch(/clone1"[^>]*"targetId":"dropdown1"/);
  });

  test('mirrors the source overlay look (size) onto the clone', () => {
    const result = cloneOverlayToCanvasTriggerInCode(withClone(), 'card1', 'clone1', 0);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    // Source overlay is 200×100 (createOverlay default card) → clone matches.
    expect(cn).toContain("width: '200px'");
    expect(cn).toContain("height: '100px'");
    expect(cn).toContain("position: 'absolute'");
  });

  test('source not an overlay trigger → unchanged', () => {
    const result = cloneOverlayToCanvasTriggerInCode(BASE_CODE, 'card1', 'clone1', 0);
    expect(result).toBe(BASE_CODE);
  });

  test('clones the overlay CHILDREN too, with re-mapped data-ids', () => {
    // Overlay with two nested children (a frame containing text).
    const code = `'use client';
import React, { useState, useLayoutEffect } from 'react';
export default function Page() {
  const [card1OverlayOpen, setCard1OverlayOpen] = useState(false);
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="card1" data-overlay-trigger='{"targetId":"card1-overlay","trigger":"click","dismiss":"outside"}' onClick={() => setCard1OverlayOpen(!card1OverlayOpen)} style={{ width: '120px', height: '80px' }}></div>
      {card1OverlayOpen && <div key="card1-overlay" data-id="card1-overlay" data-overlay='{"type":"relative","triggerId":"card1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'fixed', zIndex: 50, width: '200px', height: '120px' }}>
        <div data-id="inner-box" style={{ width: '60px', height: '40px' }}>
          <p data-id="inner-text">Hi</p>
        </div>
      </div>}
    </div>
  );
}

const canvasNodes = (<>
  <div data-id="clone1" data-canvas-node="true" data-overlay-trigger='{"targetId":"card1-overlay","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', left: '700px', top: '300px', width: '120px', height: '80px' }}></div>
</>);`;
    const result = cloneOverlayToCanvasTriggerInCode(code, 'card1', 'clone1', 0);
    expectParses(result);
    const cn = result.slice(result.indexOf('const canvasNodes'));
    // The cloned overlay carries the children, with fresh ids (suffixed by the clone trigger).
    expect(cn).toContain('data-id="clone1-overlay"');
    expect(cn).toContain('data-id="inner-box-clone1"');
    expect(cn).toContain('data-id="inner-text-clone1"');
    // The matching key="…" is re-ided too (no stale/duplicate AnimatePresence key).
    expect(cn).toContain('key="clone1-overlay"');
    expect(cn).not.toContain('key="card1-overlay"');
    expect(cn).toContain('Hi'); // child text preserved
    // Clone overlay is a canvas node, absolute-positioned.
    expect(cn).toContain('data-canvas-node="true"');
    expect(cn).toContain("position: 'absolute'");
    expect(cn).not.toContain("position: 'fixed'");
    // The SOURCE overlay + its original child ids are untouched in the return.
    const ret = result.slice(0, result.indexOf('const canvasNodes'));
    expect(ret).toContain('data-id="inner-box"');
    expect(ret).toContain('data-id="card1-overlay"');
  });
});

describe('pruneOverlayDuplicatesInCode', () => {
  const countId = (code: string, id: string) =>
    (code.match(new RegExp(`data-id="${id}"`, 'g')) || []).length;

  test('removes a duplicate overlay (same id in return AND canvas), keeping the canvas copy when the trigger is a canvas node', () => {
    // The canvas↔viewport round-trip ghost: trigger on canvas points to ov-1,
    // but ov-1 exists BOTH bare in the return AND on the canvas.
    const code = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
    <motion.div key="ov-1" data-id="ov-1" data-overlay='{"type":"relative","triggerId":"trig-1"}' style={{ position: 'fixed', zIndex: '50' }}></motion.div>
  </div>;
}
const canvasNodes = <>
  <motion.div key="ov-1" data-id="ov-1" data-overlay='{"type":"relative","triggerId":"trig-1"}' style={{ position: 'absolute', left: '10px', top: '10px' }} data-canvas-node="true"></motion.div>
  <div data-id="trig-1" data-name="Frame" style={{ position: 'absolute' }} data-overlay-trigger='{"targetId":"ov-1","trigger":"click","dismiss":"outside"}' data-canvas-node="true"></div>
</>;`;
    const out = pruneOverlayDuplicatesInCode(code);
    expect(countId(out, 'ov-1')).toBe(1);
    // The surviving copy is the canvas one (matches the canvas trigger).
    const canvasPart = out.slice(out.indexOf('const canvasNodes'));
    expect(canvasPart).toContain('data-id="ov-1"');
  });

  test('removes an ORPHAN overlay whose id is no trigger target', () => {
    // ov-old is stranded (the trigger now points to ov-new).
    const code = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
    <motion.div key="ov-old" data-id="ov-old" data-overlay='{"type":"relative","triggerId":"trig-1"}' style={{ position: 'fixed' }}></motion.div>
    <AnimatePresence>{ovNewOpen && (
      <motion.div key="ov-new" data-id="ov-new" data-overlay='{"type":"relative","triggerId":"trig-1"}' style={{ position: 'fixed' }}></motion.div>
    )}</AnimatePresence>
    <div data-id="trig-1" data-name="Frame" data-overlay-trigger='{"targetId":"ov-new","trigger":"click"}' style={{ position: 'absolute' }}></div>
  </div>;
}
const canvasNodes = <>
</>;`;
    const out = pruneOverlayDuplicatesInCode(code);
    expect(countId(out, 'ov-old')).toBe(0); // orphan gone
    expect(countId(out, 'ov-new')).toBe(1); // kept (it's the trigger's target, in-return matches in-return trigger)
    // The AnimatePresence wrapper of the survivor stays intact.
    expect(out).toContain('ovNewOpen &&');
  });

  test('idempotent / no-op on a healthy single-overlay file', () => {
    const code = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
    <AnimatePresence>{ov1Open && (
      <motion.div key="ov-1" data-id="ov-1" data-overlay='{"type":"relative","triggerId":"trig-1"}' style={{ position: 'fixed' }}></motion.div>
    )}</AnimatePresence>
    <div data-id="trig-1" data-name="Frame" data-overlay-trigger='{"targetId":"ov-1","trigger":"click"}' style={{ position: 'absolute' }}></div>
  </div>;
}
const canvasNodes = <>
</>;`;
    expect(pruneOverlayDuplicatesInCode(code)).toBe(code);
  });
});

describe('liftNestedCanvasOverlaysToRoot', () => {
  test('hoists a canvas overlay nested inside a canvas frame back to the fragment top level', () => {
    const code = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" data-name="Page"></div>;
}
const canvasNodes = <>
  <div data-id="cv-trig" data-name="Frame" data-overlay-trigger='{"targetId":"cv-ov","trigger":"click"}' data-canvas-node="true" style={{ position: 'absolute', left: '0px', top: '0px' }}></div>
  <div data-id="cv-frame" data-name="Frame" data-canvas-node="true" style={{ position: 'absolute', left: '-1069px', top: '635px', overflow: 'hidden' }}>
    <motion.div key="cv-ov" data-id="cv-ov" data-overlay='{"type":"relative","triggerId":"cv-trig","side":"bottom"}' style={{ position: 'absolute', left: '-424px', top: '2223px' }}></motion.div>
  </div>
</>;`;
    const out = liftNestedCanvasOverlaysToRoot(code);
    const cn = out.slice(out.indexOf('const canvasNodes'));
    const frameStart = cn.indexOf('data-id="cv-frame"');
    const frameEnd = cn.indexOf('</div>', frameStart);
    const ovStart = cn.indexOf('data-id="cv-ov"');
    // overlay no longer sits between the frame's open tag and its close
    expect(ovStart > frameStart && ovStart < frameEnd).toBe(false);
    // and it gained data-canvas-node on lift
    const ovTagStart = out.lastIndexOf('<', out.indexOf('data-id="cv-ov"'));
    const ovTagEnd = out.indexOf('</motion.div>', ovTagStart);
    expect(out.slice(ovTagStart, ovTagEnd)).toContain('data-canvas-node="true"');
  });

  test('no-op when the canvas overlay is already top-level', () => {
    const code = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" data-name="Page"></div>;
}
const canvasNodes = <>
  <div data-id="cv-trig" data-name="Frame" data-overlay-trigger='{"targetId":"cv-ov","trigger":"click"}' data-canvas-node="true" style={{ position: 'absolute' }}></div>
  <motion.div key="cv-ov" data-id="cv-ov" data-overlay='{"type":"relative","triggerId":"cv-trig","side":"bottom"}' data-canvas-node="true" style={{ position: 'absolute' }}></motion.div>
</>;`;
    expect(liftNestedCanvasOverlaysToRoot(code)).toBe(code);
  });
});

describe('stripOverlaysNestedInOverlaysInCode — no overlays inside overlays', () => {
  // A fixed overlay (fixed1) whose subtree now contains `inner` — a trigger for a
  // separate relative overlay (pop1). That nested trigger + its overlay must go.
  const NESTED = `'use client';
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [fixed1Open, setFixed1Open] = useState(false);
  const [pop1Open, setPop1Open] = useState(false);
  return (<div data-id="root" style={{ position: 'relative' }}>
      <div data-id="trig0" data-overlay-trigger='{"targetId":"fixed1","trigger":"click"}' onClick={() => setFixed1Open(!fixed1Open)}></div>
      <AnimatePresence>{fixed1Open && <motion.div key="fixed1" data-id="fixed1" data-overlay='{"type":"fixed","triggerId":"trig0","side":"bottom"}' style={{ position: 'fixed' }}>
        <div data-id="inner" data-overlay-trigger='{"targetId":"pop1","trigger":"click"}' onClick={() => setPop1Open(!pop1Open)} style={{ width: '50px' }}></div>
      </motion.div>}</AnimatePresence>
      <AnimatePresence>{pop1Open && <motion.div key="pop1" data-id="pop1" data-overlay='{"type":"relative","triggerId":"inner","side":"bottom"}' style={{ position: 'fixed' }}></motion.div>}</AnimatePresence>
    </div>);
}`;

  test('strips a trigger nested inside a fixed overlay + its overlay/state/handler', () => {
    const out = stripOverlaysNestedInOverlaysInCode(NESTED);
    expect(parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).toBeTruthy();
    // pop1 overlay node gone, its state gone, the nested trigger attr + handler gone.
    expect(out).not.toContain('data-id="pop1"');
    expect(out).not.toContain('pop1Open');
    expect(out).not.toContain('"targetId":"pop1"');
    expect(out).not.toContain('setPop1Open');
    // The fixed overlay itself + its (outside) trigger survive untouched.
    expect(out).toContain('data-id="fixed1"');
    expect(out).toContain('"targetId":"fixed1"');
    expect(out).toContain('data-id="inner"'); // the element stays, just not a trigger
    expect(parseOverlayCalls(out).map(o => o.overlayId).sort()).toEqual(['fixed1']);
    expect(parseOverlayTriggerCalls(out).map(t => t.triggerId)).toEqual(['trig0']);
  });

  test('is a no-op when no overlay is nested inside another', () => {
    const flat = `'use client';
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [aOpen, setAOpen] = useState(false);
  return (<div data-id="root">
      <div data-id="t" data-overlay-trigger='{"targetId":"a","trigger":"click"}' onClick={() => setAOpen(!aOpen)}></div>
      <AnimatePresence>{aOpen && <motion.div key="a" data-id="a" data-overlay='{"type":"fixed","triggerId":"t","side":"bottom"}'></motion.div>}</AnimatePresence>
    </div>);
}`;
    expect(stripOverlaysNestedInOverlaysInCode(flat)).toBe(flat);
  });

  test('no overlays at all → untouched', () => {
    const plain = `export default function P() { return <div data-id="x" />; }`;
    expect(stripOverlaysNestedInOverlaysInCode(plain)).toBe(plain);
  });
});

describe('syncOverlayAppearTransformInCode — transforms mix with enter/exit', () => {
  const OV = (styleExtra: string) => `'use client';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return (<div data-id="root">
      <AnimatePresence>{ov1Open && <motion.div key="ov1" data-id="ov1" data-overlay='{"type":"relative","triggerId":"t","side":"bottom"}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'fixed', width: '237px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)'${styleExtra} }}></motion.div>}</AnimatePresence>
    </div>);
}`;

  test('mirrors rotate from style into initial/animate/exit (constant through the animation)', () => {
    const out = syncOverlayAppearTransformInCode(OV(`, rotate: '142.5'`), 'ov1');
    expect(parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).toBeTruthy();
    expect(out).toContain('initial={{ opacity: 0, y: 20, rotate: 142.5 }}');
    expect(out).toContain('animate={{ opacity: 1, y: 0, rotate: 142.5 }}');
    expect(out).toContain('exit={{ opacity: 0, y: 20, rotate: 142.5 }}');
    // style keeps its copy (the canvas renders from style via foldMotionTransforms).
    expect(out).toContain("rotate: '142.5'");
  });

  test('mirrors multiple transforms (rotate + scale + skew)', () => {
    const out = syncOverlayAppearTransformInCode(OV(`, rotate: '30', scaleX: '1.2', skewY: '5'`), 'ov1');
    expect(parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] })).toBeTruthy();
    expect(out).toContain('animate={{ opacity: 1, y: 0, rotate: 30, scaleX: 1.2, skewY: 5 }}');
  });

  test('removing the transform collapses the appear back to opacity/y', () => {
    // First with rotate, then sync a style that no longer has it.
    const withRot = syncOverlayAppearTransformInCode(OV(`, rotate: '90'`), 'ov1');
    expect(withRot).toContain('rotate: 90 }}');
    const cleared = syncOverlayAppearTransformInCode(withRot.replace(", rotate: '90'", ''), 'ov1');
    expect(cleared).toContain('initial={{ opacity: 0, y: 20 }}');
    expect(cleared).toContain('animate={{ opacity: 1, y: 0 }}');
    expect(cleared).not.toMatch(/animate=\{\{[^}]*rotate/);
  });

  test('idempotent — re-running does not duplicate transform keys', () => {
    const once = syncOverlayAppearTransformInCode(OV(`, rotate: '45'`), 'ov1');
    const twice = syncOverlayAppearTransformInCode(once, 'ov1');
    expect(twice).toBe(once);
  });
});

describe('removeOverlayInCode — does not nuke OTHER overlays effects (0,0 corruption)', () => {
  const twoOverlays = () => {
    let code = createOverlayInCode(BASE_CODE_MULTI, 'btn1', 'ov1', makeOverlayConfig({ triggerId: 'btn1' }), makeTriggerConfig({ targetId: 'ov1' }));
    code = createOverlayInCode(code, 'btn2', 'ov2', makeOverlayConfig({ triggerId: 'btn2' }), makeTriggerConfig({ targetId: 'ov2' }));
    return code;
  };

  test('removing the SECOND overlay keeps the FIRST overlay positioner effect', () => {
    const code = twoOverlays();
    expect(code).toContain(', [ov1Open]);');
    expect(code).toContain(', [ov2Open]);');
    const out = removeOverlayInCode(code, 'ov2', 'btn2');
    expectParses(out);
    expect(out).toContain(', [ov1Open]);');     // first overlay's effect SURVIVES
    expect(out).not.toContain(', [ov2Open]);');  // only the removed one's effect is gone
    expect(out).toContain('data-id="ov1"');       // sanity: ov1 still there
    expect(out).not.toContain('ov2Open');
  });
});

describe('healMissingOverlayEffectsInCode — restores a dropped positioner', () => {
  test('regenerates a relative overlay positioner that was deleted', () => {
    const code = createOverlayInCode(BASE_CODE_MULTI, 'btn1', 'ov1', makeOverlayConfig({ triggerId: 'btn1' }), makeTriggerConfig({ targetId: 'ov1' }));
    // Simulate the corruption: strip ov1's positioner effect block only.
    const dep = ', [ov1Open]);';
    const depIdx = code.indexOf(dep);
    const start = code.lastIndexOf('useLayoutEffect(', depIdx);
    const corrupted = code.slice(0, start) + code.slice(depIdx + dep.length);
    expect(corrupted).not.toContain(', [ov1Open]);');     // effect gone
    expect(corrupted).toContain('const [ov1Open,');        // but state + conditional remain

    const healed = healMissingOverlayEffectsInCode(corrupted);
    expectParses(healed);
    expect(healed).toContain(', [ov1Open]);');             // positioner restored
    expect(healed).toContain('overlay.style.top = top');   // it's the real positioner
  });

  test('no-op when every overlay already has its effect', () => {
    const code = createOverlayInCode(BASE_CODE_MULTI, 'btn1', 'ov1', makeOverlayConfig({ triggerId: 'btn1' }), makeTriggerConfig({ targetId: 'ov1' }));
    expect(healMissingOverlayEffectsInCode(code)).toBe(code);
  });
});

describe('createOverlayInCode — component master ROOT trigger parents the overlay', () => {
  const COMP = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true }];
function LeSuSe({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="frame-root" {...rest} data-name="Frame" style={{ position: 'absolute', width: '418px', height: '432px', ...style }}></motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(LeSuSe);`;

  test('overlay is nested INSIDE the variant-root (not a parentless LayoutGroup sibling)', () => {
    const out = createOverlayInCode(COMP, 'frame-root', 'ov1', makeOverlayConfig({ triggerId: 'frame-root' }), makeTriggerConfig({ targetId: 'ov1' }));
    expectParses(out);
    expect(out).toContain('data-id="ov1"');
    // Order proves nesting: </AnimatePresence> (overlay) comes BEFORE the root's
    // closing </motion.div>, which comes before </LayoutGroup>. A parentless
    // sibling would close the root FIRST (root </motion.div> before the overlay).
    const apClose = out.indexOf('</AnimatePresence>');
    const rootClose = out.lastIndexOf('</motion.div>');
    const lgClose = out.indexOf('</LayoutGroup>');
    expect(apClose).toBeGreaterThan(0);
    expect(apClose).toBeLessThan(rootClose);
    expect(rootClose).toBeLessThan(lgClose);
  });

  test('CHILD trigger in a component still works (overlay parses, present)', () => {
    const compWithChild = COMP.replace(
      '<motion.div layout={true} data-id="frame-root" {...rest} data-name="Frame" style={{ position: \'absolute\', width: \'418px\', height: \'432px\', ...style }}></motion.div>',
      '<motion.div layout={true} data-id="frame-root" {...rest} data-name="Frame" style={{ position: \'absolute\', ...style }}><motion.div data-id="child-1" style={{ width: \'50px\' }}></motion.div></motion.div>',
    );
    const out = createOverlayInCode(compWithChild, 'child-1', 'ov2', makeOverlayConfig({ triggerId: 'child-1' }), makeTriggerConfig({ targetId: 'ov2' }));
    expectParses(out);
    expect(out).toContain('data-id="ov2"');
    expect(out).toContain('data-overlay-trigger=');
  });
});

describe('transferRootOverlayToInstanceInCode — make-component: root trigger → instance', () => {
  const ORIGINAL_PAGE = `'use client';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [ov1Open, setOv1Open] = useState(false);
  return (<div data-id="root">
      <div data-id="frameA" style={{ position: 'absolute' }} data-overlay-trigger='{"targetId":"ov1","trigger":"click","dismiss":"outside"}' onClick={() => setOv1Open(!ov1Open)}></div>
      <AnimatePresence>{ov1Open && <motion.div key="ov1" data-id="ov1" data-overlay='{"type":"relative","triggerId":"frameA","side":"bottom"}'></motion.div>}</AnimatePresence>
    </div>);
}`;
  // After makeComponent: master holds the extracted root (with the broken trigger
  // attr + handler), the page holds the instance + the still-page-level overlay.
  const MASTER = `function LeSuSe({ style, initialVariant = 'default', ...rest }: any) {
  return (<LayoutGroup>
    <motion.div data-id="frameA" {...rest} style={{ position: 'absolute', ...style }} data-overlay-trigger='{"targetId":"ov1","trigger":"click","dismiss":"outside"}' onClick={() => setOv1Open(!ov1Open)}></motion.div>
    </LayoutGroup>);
}
export default withResponsiveProps(LeSuSe);`;
  const INSTANCE_PAGE = `'use client';
import { motion, AnimatePresence } from 'framer-motion';
import LeSuSe from '@/components/LeSuSe';
export default function Page() {
  const [ov1Open, setOv1Open] = useState(false);
  return (<div data-id="root">
      <LeSuSe data-id="frameA" data-name="Frame" style={{ position: 'absolute' }} />
      <AnimatePresence>{ov1Open && <motion.div key="ov1" data-id="ov1" data-overlay='{"type":"relative","triggerId":"frameA","side":"bottom"}'></motion.div>}</AnimatePresence>
    </div>);
}`;

  test('strips trigger attr + handler from master, arms them on the instance; overlay stays on page', () => {
    const r = transferRootOverlayToInstanceInCode(MASTER, INSTANCE_PAGE, ORIGINAL_PAGE, 'frameA');
    expect(r.moved).toBe(true);
    expectParses(r.componentCode);
    expectParses(r.instancePageCode);
    // MASTER is now clean — no trigger attr, no broken setter reference.
    expect(r.componentCode).not.toContain('data-overlay-trigger');
    expect(r.componentCode).not.toContain('setOv1Open');
    // INSTANCE tag is the trigger now.
    expect(r.instancePageCode).toMatch(/<LeSuSe[^>]*data-overlay-trigger='[^']*"targetId":"ov1"/);
    expect(r.instancePageCode).toContain('setOv1Open');
    // Overlay element + useState stay on the page.
    expect(r.instancePageCode).toContain('data-id="ov1"');
    expect(r.instancePageCode).toContain('const [ov1Open, setOv1Open] = useState(false)');
  });

  test('no-op when the extracted root is NOT a trigger', () => {
    const r = transferRootOverlayToInstanceInCode(MASTER, INSTANCE_PAGE, ORIGINAL_PAGE, 'frameB');
    expect(r.moved).toBe(false);
    expect(r.componentCode).toBe(MASTER);
    expect(r.instancePageCode).toBe(INSTANCE_PAGE);
  });
});

describe('removeOverlayInCode — reverts the instance On-Open-variant ternary', () => {
  // An overlay on a component INSTANCE drives `initialVariant` from the open state.
  // Removing the overlay must revert that ternary, else it references the deleted
  // useState ("undefined identifier") and validation blocks the removal.
  const PAGE = `'use client';
import { motion, AnimatePresence } from 'framer-motion';
import NuXiKu from '@/components/NuXiKu';
export default function Page() {
  const [overlayXOpen, setOverlayFrameX_2Open] = useState(false);
  return (<div data-id="root">
      <NuXiKu data-id="frame-x" style={{ position: 'relative' }} data-overlay-trigger='{"targetId":"overlay-x","trigger":"click","dismiss":"outside"}' onClick={() => setOverlayFrameX_2Open(!overlayXOpen)} initialVariant={overlayXOpen ? 'variant-1' : 'default'} />
      <AnimatePresence>{overlayXOpen && <motion.div key="overlay-x" data-id="overlay-x" data-overlay='{"type":"relative","triggerId":"frame-x","side":"bottom","onOpenVariant":"variant-1"}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed' }}></motion.div>}</AnimatePresence>
    </div>);
}`;

  test('removes the overlay AND reverts initialVariant to the static closed value (no dangling state ref)', () => {
    // stateVarName('overlay-x') → 'overlayXOpen' — but the page used a custom var; use the real one.
    const out = removeOverlayInCode(PAGE, 'overlay-x', 'frame-x');
    expectParses(out);
    // The instance ternary is reverted to the static base — no reference to the removed state.
    expect(out).toContain('initialVariant="default"');
    expect(out).not.toMatch(/initialVariant=\{[^}]*Open/);
    // Overlay element + trigger attr gone.
    expect(out).not.toContain('data-id="overlay-x"');
    expect(out).not.toContain('data-overlay-trigger');
  });
});

describe('transferDescendantOverlaysToMasterInCode — make-component: child overlay → master', () => {
  // Child trigger with a relative overlay nested inside the parent. Make-component
  // extracts the parent → the child + overlay element land in the master, but the
  // useState/effect (page-body) don't. The transfer adds them to the master and
  // strips the orphaned page hooks.
  const ORIGINAL_PAGE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [ovcOpen, setOvcOpen] = useState(false);
  useLayoutEffect(() => {
    if (!ovcOpen) return;
    const overlay = document.querySelector('[data-id="ovc"]');
    if (!overlay) return;
    overlay.style.top = '0px';
  }, [ovcOpen]);
  return (<div data-id="root">
      <div data-id="parent" style={{ position: 'absolute' }}>
        <div data-id="child" data-overlay-trigger='{"targetId":"ovc","trigger":"click","dismiss":"outside"}' onClick={() => setOvcOpen(!ovcOpen)}></div>
        <AnimatePresence>{ovcOpen && <motion.div key="ovc" data-id="ovc" data-overlay='{"type":"relative","triggerId":"child","side":"bottom"}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed' }}></motion.div>}</AnimatePresence>
      </div>
    </div>);
}`;
  const EXTRACTED = `<div data-id="parent" style={{ position: 'absolute' }}>
        <div data-id="child" data-overlay-trigger='{"targetId":"ovc","trigger":"click","dismiss":"outside"}' onClick={() => setOvcOpen(!ovcOpen)}></div>
        <AnimatePresence>{ovcOpen && <motion.div key="ovc" data-id="ovc" data-overlay='{"type":"relative","triggerId":"child","side":"bottom"}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed' }}></motion.div>}</AnimatePresence>
      </div>`;
  const MASTER = `function Comp({ style, initialVariant = 'default', ...rest }: any) {
  return (<LayoutGroup>
    <motion.div data-id="parent" {...rest} style={{ position: 'absolute', ...style }}>
        <motion.div data-id="child" data-overlay-trigger='{"targetId":"ovc","trigger":"click","dismiss":"outside"}' onClick={() => setOvcOpen(!ovcOpen)}></motion.div>
        <AnimatePresence>{ovcOpen && <motion.div key="ovc" data-id="ovc" data-overlay='{"type":"relative","triggerId":"child","side":"bottom"}' initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ position: 'fixed' }}></motion.div>}</AnimatePresence>
    </motion.div>
    </LayoutGroup>);
}
export default withResponsiveProps(Comp);`;
  const INSTANCE_PAGE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
export default function Page() {
  const [ovcOpen, setOvcOpen] = useState(false);
  useLayoutEffect(() => {
    if (!ovcOpen) return;
    const overlay = document.querySelector('[data-id="ovc"]');
    if (!overlay) return;
    overlay.style.top = '0px';
  }, [ovcOpen]);
  return (<div data-id="root">
      <Comp data-id="parent" data-name="Frame" style={{ position: 'absolute' }} />
    </div>);
}`;

  test('adds useState + positioner effect to the master; strips the orphaned page hooks', () => {
    const r = transferDescendantOverlaysToMasterInCode(MASTER, INSTANCE_PAGE, ORIGINAL_PAGE, 'parent', EXTRACTED);
    expect(r.moved).toBe(true);
    expectParses(r.componentCode);
    expectParses(r.instancePageCode);
    // MASTER gained the state + positioner.
    expect(r.componentCode).toContain('const [ovcOpen, setOvcOpen] = useState(false)');
    expect(r.componentCode).toContain(', [ovcOpen]);');
    expect(r.componentCode).toContain('overlay.style.top'); // the real positioner
    expect(r.componentCode).toContain('data-id="ovc"');     // element kept
    expect(r.componentCode).toContain('setOvcOpen');        // handler kept
    // PAGE: the orphaned state + effect are gone.
    expect(r.instancePageCode).not.toContain('ovcOpen');
  });

  test('no-op when no descendant trigger is in the extracted subtree', () => {
    const r = transferDescendantOverlaysToMasterInCode(MASTER, INSTANCE_PAGE, ORIGINAL_PAGE, 'parent', '<div data-id="parent"></div>');
    expect(r.moved).toBe(false);
  });
});

describe('transferDescendantOverlaysToMasterInCode — CANVAS overlay (static) → runtime in master', () => {
  // A canvas-node parent whose child has a STATIC canvas overlay (in canvasNodes, no
  // conditional/state/effect, a sibling — not nested). Making the parent a component
  // must give the master a working RUNTIME overlay (built fresh), and sweep the
  // orphaned bare canvas overlay off the page.
  const ORIGINAL_PAGE = `'use client';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return (<div data-id="root"></div>);
}
const canvasNodes = <>
  <div data-id="parent" data-canvas-node="true" style={{ position: 'absolute', left: '0px', top: '0px' }}>
    <div data-id="child" data-overlay-trigger='{"targetId":"ovc","trigger":"click","dismiss":"outside"}'></div>
  </div>
  <motion.div data-id="ovc" data-overlay='{"type":"relative","triggerId":"child","side":"bottom","align":"center","offsetX":0,"offsetY":10}' data-canvas-node="true" style={{ position: 'absolute', width: '200px', height: '100px' }}></motion.div>
</>;`;
  const EXTRACTED = `<div data-id="parent" style={{ position: 'absolute' }}>
    <div data-id="child" data-overlay-trigger='{"targetId":"ovc","trigger":"click","dismiss":"outside"}'></div>
  </div>`;
  const MASTER = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function Comp({ style, initialVariant = 'default', ...rest }: any) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="parent" {...rest} style={{ position: 'absolute', ...style }}>
      <motion.div layout={true} data-id="child" data-overlay-trigger='{"targetId":"ovc","trigger":"click","dismiss":"outside"}'></motion.div>
    </motion.div>
    </LayoutGroup>);
}
export default withResponsiveProps(Comp);`;
  const INSTANCE_PAGE = `'use client';
import { motion, AnimatePresence } from 'framer-motion';
import Comp from '@/components/Comp';
export default function Page() {
  return (<div data-id="root"></div>);
}
const canvasNodes = <>
  <Comp data-id="parent" data-canvas-node="true" style={{ position: 'absolute', left: '0px', top: '0px' }} />
  <motion.div data-id="ovc" data-overlay='{"type":"relative","triggerId":"child","side":"bottom","align":"center","offsetX":0,"offsetY":10}' data-canvas-node="true" style={{ position: 'absolute', width: '200px', height: '100px' }}></motion.div>
</>;`;

  test('builds a fresh runtime overlay in the master (state+effect+element+handler) and sweeps the bare canvas overlay off the page', () => {
    const r = transferDescendantOverlaysToMasterInCode(MASTER, INSTANCE_PAGE, ORIGINAL_PAGE, 'parent', EXTRACTED);
    expect(r.moved).toBe(true);
    expectParses(r.componentCode);
    expectParses(r.instancePageCode);
    // MASTER: full runtime overlay now exists.
    expect(r.componentCode).toContain('const [ovcOpen, setOvcOpen] = useState(false)');
    expect(r.componentCode).toContain(', [ovcOpen]);');           // positioner effect
    expect(r.componentCode).toMatch(/<AnimatePresence>\{ovcOpen &&/); // runtime conditional
    expect(r.componentCode).toContain('data-id="ovc"');            // element present
    expect(r.componentCode).toContain('setOvcOpen');               // handler on the child
    // PAGE: the orphaned bare canvas overlay is swept (no data-overlay left for ovc).
    expect(r.instancePageCode).not.toContain('data-id="ovc"');
  });
});

// ─── reattachPastedOverlayInCode (copy/paste) ────────────────────────────────
// Paste re-emits an overlay as a BARE element (no AnimatePresence/useState/
// positioner, un-remapped ids). Reattach rebuilds the runtime machine, preserves
// the overlay's own styles + children, and repoints both configs to the new ids.

describe('reattachPastedOverlayInCode', () => {
  // Post-paste page: pasted trigger `trig2` (stale targetId→old `ovl1`) + pasted
  // BARE overlay `ovl2` (stale triggerId→old `trig1`, leaked `isAbsoluteInFrame`).
  const POST_PASTE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%', height: '900px' }}>
      <div data-id="trig2" data-name="Frame" data-overlay-trigger='{"targetId":"ovl1","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute', width: '184px', height: '297px', left: '80px', top: '96px' }}></div>
      <div data-id="ovl2" data-name="div" data-overlay='{"type":"relative","triggerId":"trig1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'absolute', zIndex: '50', width: '200px', height: '100px', backgroundColor: '#7CBFFF', borderRadius: '8px', isAbsoluteInFrame: 'true', left: '0px', top: '0px' }}></div>
    </div>
  );
}`;
  const PASTED_OVERLAY_CFG: OverlayConfig = { type: 'relative', triggerId: 'trig1', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10 };
  const PASTED_TRIGGER_CFG: OverlayTriggerConfig = { targetId: 'ovl1', trigger: 'click', dismiss: 'outside' };

  test('runtime: rebuilds the full overlay machine and parses', () => {
    const r = reattachPastedOverlayInCode(POST_PASTE, 'trig2', 'ovl2', PASTED_OVERLAY_CFG, PASTED_TRIGGER_CFG);
    expectParses(r);
    expect(r).toContain('const [ovl2Open, setOvl2Open] = useState(false)');
    expect(r).toContain('<AnimatePresence>{ovl2Open &&');
    expect(r).toContain('useLayoutEffect(');
    expect(r).toContain('[ovl2Open]');
  });

  test('runtime: repoints BOTH configs to the new ids', () => {
    const r = reattachPastedOverlayInCode(POST_PASTE, 'trig2', 'ovl2', PASTED_OVERLAY_CFG, PASTED_TRIGGER_CFG);
    // overlay's own triggerId → new trigger
    expect(parseOverlayCalls(r)[0].config.triggerId).toBe('trig2');
    // trigger's targetId → new overlay
    const trig = parseOverlayTriggerCalls(r).find(t => t.triggerId === 'trig2');
    expect(trig?.config.targetId).toBe('ovl2');
  });

  test('runtime: preserves the copied overlay styles, drops internal flags + positioner props', () => {
    const r = reattachPastedOverlayInCode(POST_PASTE, 'trig2', 'ovl2', PASTED_OVERLAY_CFG, PASTED_TRIGGER_CFG);
    expect(r).toContain("backgroundColor: '#7CBFFF'"); // user's look kept
    expect(r).toContain("borderRadius: '8px'");
    expect(r).not.toContain('isAbsoluteInFrame'); // leaked flag stripped
    expect(r).toContain("position: 'fixed'");      // portal-immune, positioner-driven
    // bare element removed (its data-name gone), exactly one rebuilt overlay element
    expect(r).not.toContain('data-name="div"');
    expect((r.match(/key="ovl2"/g) || []).length).toBe(1);
  });

  test('runtime: adds the click handler on the trigger', () => {
    const r = reattachPastedOverlayInCode(POST_PASTE, 'trig2', 'ovl2', PASTED_OVERLAY_CFG, PASTED_TRIGGER_CFG);
    expect(r).toContain('setOvl2Open');
    const onClickIdx = r.indexOf('onClick=');
    expect(onClickIdx).toBeGreaterThan(-1);
  });

  // Fixed (modal) overlay with a child + a SELF-CLOSING event trigger.
  const POST_PASTE_FIXED = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Card from '@/components/Card';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%', height: '900px' }}>
      <Card data-id="trig2" data-overlay-trigger='{"targetId":"ovl1","trigger":"event","dismiss":"outside","eventName":"event1"}' style={{ position: 'absolute', left: '80px', top: '96px' }} />
      <div data-id="ovl2" data-name="div" data-overlay='{"type":"fixed","triggerId":"trig1","side":"bottom"}' style={{ position: 'fixed', left: '0', top: '0', width: '100%', height: '100vh', zIndex: '100', backgroundColor: 'rgba(0, 0, 0, 0.5)' }}>
        <div data-id="modal-card" style={{ width: '254px', height: '204px', backgroundColor: '#ffb3ba' }}></div>
      </div>
    </div>
  );
}`;
  const FIXED_OVERLAY_CFG = { type: 'fixed', triggerId: 'trig1', side: 'bottom' } as OverlayConfig;
  const FIXED_TRIGGER_CFG: OverlayTriggerConfig = { targetId: 'ovl1', trigger: 'event', dismiss: 'outside', eventName: 'event1' };

  test('fixed: preserves modal CHILDREN and wires a self-closing event trigger', () => {
    const r = reattachPastedOverlayInCode(POST_PASTE_FIXED, 'trig2', 'ovl2', FIXED_OVERLAY_CFG, FIXED_TRIGGER_CFG);
    expectParses(r);
    expect(r).toContain('const [ovl2Open, setOvl2Open] = useState(false)');
    expect(r).toContain('data-id="modal-card"');         // child preserved
    expect(r).toContain('event1={() => setOvl2Open(true)}'); // event-trigger handler
    expect(parseOverlayCalls(r)[0].config.type).toBe('fixed');
  });

  // NOTE: CANVAS-target paste keeps a STATIC canvas overlay and is handled in
  // `rebuildPastedOverlays` (configs repointed via the mutation queue so the heals
  // don't prune the copy) — NOT through `reattachPastedOverlayInCode`, which is
  // runtime-only. See `overlay-paste.integration.test.ts` for the canvas coverage.

  test('no-op when the pasted overlay element is absent', () => {
    const r = reattachPastedOverlayInCode(POST_PASTE, 'trig2', 'missing-overlay', PASTED_OVERLAY_CFG, PASTED_TRIGGER_CFG);
    expect(r).toBe(POST_PASTE);
  });
});

// ─── healUnwrappedOverlayInCode (canvas→variant drag leaves overlay bare) ─────

describe('healUnwrappedOverlayInCode', () => {
  // A bare runtime overlay: useState + positioner exist, trigger has the handler,
  // but the overlay element is an ALWAYS-RENDERED bare <div> (not gated).
  const BARE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
export default function Page() {
  const [div_4Open, setDiv_4Open] = useState(false);
  useLayoutEffect(() => {
    if (!div_4Open) return;
    const overlay = document.querySelector('[data-id="div-4"]');
  }, [div_4Open]);
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="div-3" data-overlay-trigger='{"targetId":"div-4","trigger":"click","dismiss":"outside"}' style={{ position: 'absolute' }} onClick={() => setDiv_4Open(!div_4Open)}></div>
      <div data-id="div-4" data-name="div" data-overlay='{"type":"relative","triggerId":"div-3","side":"bottom"}' style={{ position: 'fixed', zIndex: 50, width: '200px', height: '100px' }}></div>
    </div>
  );
}`;

  test('wraps a bare runtime overlay in AnimatePresence + conditional', () => {
    const out = healUnwrappedOverlayInCode(BARE);
    expectParses(out);
    expect(out).toContain('<AnimatePresence>{div_4Open && (');
    expect(out).toMatch(/motion\.div key="div-4"[^>]*data-overlay=/);
    expect((out.match(/key="div-4"/g) || []).length).toBe(1);
    expect(out).not.toMatch(/<div data-id="div-4"/); // no longer bare
  });

  test('idempotent — already-wrapped overlay untouched', () => {
    const once = healUnwrappedOverlayInCode(BARE);
    expect(healUnwrappedOverlayInCode(once)).toBe(once);
  });

  test('skips CANVAS overlays (static, no useState)', () => {
    const canvas = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() { return <div data-id="root"></div>; }
const canvasNodes = (<>
  <div data-id="cv-1" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"t","side":"bottom"}' style={{ position: 'absolute' }}></div>
</>);`;
    expect(healUnwrappedOverlayInCode(canvas)).toBe(canvas); // no useState → not a runtime overlay
  });

  test('leaves a properly-wrapped overlay alone', () => {
    const ok = createOverlayInCode(BASE_CODE, 'card1', 'dropdown1', makeOverlayConfig(), makeTriggerConfig());
    expect(healUnwrappedOverlayInCode(ok)).toBe(ok);
  });
});

// ─── Placement + idempotency on a REAL-SHAPED page ──────────────────────────
// Two live finds from 2026-07-25, both invisible on the toy fixtures above:
//
//  1. The overlay must land as the LAST CHILD of `data-id="root"`. The old
//     insertion heuristic sliced the return statement at the first `;` after the
//     root's opening `>` and required the slice to end in a closing tag. Every
//     real page has a `;` inside its JSX — the `<style>{`…`}</style>` block the
//     responsive system writes for `@media` overrides is the common one — so the
//     region got truncated mid-element, the match failed, and the overlay fell
//     back to sitting NEXT TO ITS TRIGGER inside a section. Harmless for a
//     relative overlay (portaled out by the Renderer) but fatal for a fixed one:
//     the Renderer re-anchors it `position:absolute; inset 0` expecting the
//     viewport root, so it sized against the section instead and got clipped by
//     that section's `overflow:hidden` ("the modal never appears").
//
//  2. Re-creating an overlay under an id whose runtime is still in the body must
//     NOT re-declare it. The id embeds a module-scope counter that restarts at 0
//     each editor load, so session 2's first overlay on a trigger reuses session
//     1's id → duplicate `const [xOpen] = useState()` → SyntaxError → the page
//     parses to zero nodes and the canvas goes blank.

const PAGE_WITH_STYLE_BLOCK = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="hero"] { transform: rotate(39.5deg) !important; }
    }
  \`}</style>
    <div data-id="hero" style={{ height: '400px' }}>Hero</div>
    <div data-id="footer" style={{ height: '643px', overflow: 'hidden', position: 'relative' }}>
      <div data-id="btn" style={{ width: '200px', height: '60px' }}>FIX OVERLAYS</div>
    </div>
  </div>;
}
`;

describe('createOverlayInCode — placement on a page whose JSX contains a `;`', () => {
  test('fixed overlay is the LAST CHILD of root, not a sibling of the trigger', () => {
    const out = createOverlayInCode(
      PAGE_WITH_STYLE_BLOCK, 'btn', 'ov1',
      makeOverlayConfig({ type: 'fixed', triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'ov1' }),
    );
    expectParses(out);
    const overlayIdx = out.indexOf('key="ov1"');
    const footerClose = out.indexOf('</div>', out.indexOf('data-id="btn"'));
    expect(overlayIdx).toBeGreaterThan(footerClose); // outside the footer section
    // …and immediately before the root's own closing tag.
    const afterOverlay = out.slice(out.indexOf('</AnimatePresence>', overlayIdx));
    expect(afterOverlay.replace('</AnimatePresence>', '').trimStart().startsWith('</div>;')).toBe(true);
  });

  test('relative overlay lands in the same place', () => {
    const out = createOverlayInCode(
      PAGE_WITH_STYLE_BLOCK, 'btn', 'ov1',
      makeOverlayConfig({ triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'ov1' }),
    );
    expectParses(out);
    const footerClose = out.indexOf('</div>', out.indexOf('data-id="btn"'));
    expect(out.indexOf('key="ov1"')).toBeGreaterThan(footerClose);
  });
});

describe('createOverlayInCode — re-create under an id whose runtime already exists', () => {
  test('does not re-declare the useState (no "already been declared" crash)', () => {
    const once = createOverlayInCode(
      PAGE_WITH_STYLE_BLOCK, 'btn', 'ov1',
      makeOverlayConfig({ type: 'fixed', triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'ov1' }),
    );
    const twice = createOverlayInCode(
      once, 'btn', 'ov1',
      makeOverlayConfig({ type: 'fixed', triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'ov1' }),
    );
    expectParses(twice); // the crash was a hard SyntaxError here
    expect((twice.match(/const \[ov1Open, setOv1Open\] = useState/g) || []).length).toBe(1);
    expect((twice.match(/\}, \[ov1Open\]\);/g) || []).length).toBe(1);
  });

  test('orphan state left by a half-removal is reused, not duplicated', () => {
    // Runtime present, element gone — what a failed removal leaves behind.
    const orphan = PAGE_WITH_STYLE_BLOCK.replace(
      'export default function Page() {',
      'export default function Page() {\n  const [ov1Open, setOv1Open] = useState(false);',
    );
    const out = createOverlayInCode(
      orphan, 'btn', 'ov1',
      makeOverlayConfig({ triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'ov1' }),
    );
    expectParses(out);
    expect((out.match(/const \[ov1Open, setOv1Open\] = useState/g) || []).length).toBe(1);
    expect(out).toContain('key="ov1"');      // element created
    expect(out).toContain('}, [ov1Open]);'); // effect topped up
  });
});

// ─── healMisplacedOverlayInCode ─────────────────────────────────────────────
// Repairs pages the broken insertion heuristic already wrote: the overlay block
// sits right after its TRIGGER, deep inside a section, instead of as root's last
// child. Same violation the oracle reports as OVERLAY_NOT_ROOT_CHILD.

/** What the old generator produced for `PAGE_WITH_STYLE_BLOCK` + a fixed overlay
 *  on `btn`: everything correct except the block's position. */
const MISPLACED_PAGE = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [ov1Open, setOv1Open] = useState(false);
  useEffect(() => {
    if (!ov1Open) return;
    const overlay = document.querySelector('[data-id="ov1"]');
    if (!overlay) return;
    const prevOverflow = document.body.style.overflow;
    return () => { document.body.style.overflow = prevOverflow; };
  }, [ov1Open]);
  return <div data-id="root" style={{ position: 'relative' }}>
  <style>{\`
    @media (max-width: 768px) { [data-id="hero"] { transform: rotate(39.5deg) !important; } }
  \`}</style>
    <div data-id="hero" style={{ height: '400px' }}>Hero</div>
    <div data-id="footer" style={{ height: '643px', overflow: 'hidden', position: 'relative' }}>
      <div data-id="btn" data-overlay-trigger='{"targetId":"ov1","trigger":"click","dismiss":"outside"}' onClick={() => setOv1Open(!ov1Open)}>FIX OVERLAYS</div>
      <AnimatePresence>{ov1Open && (
        <motion.div key="ov1" data-id="ov1" data-name="Overlay" data-overlay='{"type":"fixed","triggerId":"btn","side":"bottom","align":"start","offsetX":0,"offsetY":0}' style={{ position: 'fixed', left: '0', top: '0', width: '100%', height: '100vh' }}>
        </motion.div>
      )}</AnimatePresence>
    </div>
  </div>;
}
`;

describe('healMisplacedOverlayInCode', () => {
  test('moves an overlay sitting after its trigger out to root last child', () => {
    const out = healMisplacedOverlayInCode(MISPLACED_PAGE);
    expectParses(out);
    const overlayIdx = out.indexOf('key="ov1"');
    const footerClose = out.indexOf('</div>', out.indexOf('data-id="btn"'));
    expect(overlayIdx).toBeGreaterThan(footerClose); // escaped the section
    expect((out.match(/key="ov1"/g) || []).length).toBe(1); // moved, not copied
    expect(out).toContain('const [ov1Open, setOv1Open] = useState(false)'); // runtime intact
    expect(out).toContain('data-overlay-trigger='); // trigger intact
  });

  test('idempotent — a healed page is left alone on the next pass', () => {
    const once = healMisplacedOverlayInCode(MISPLACED_PAGE);
    expect(healMisplacedOverlayInCode(once)).toBe(once);
  });

  test('leaves a correctly-placed overlay untouched', () => {
    const good = createOverlayInCode(
      PAGE_WITH_STYLE_BLOCK, 'btn', 'ov1',
      makeOverlayConfig({ type: 'fixed', triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'ov1' }),
    );
    expect(healMisplacedOverlayInCode(good)).toBe(good);
  });

  test('no-op on a component master (no data-id="root")', () => {
    const master = `'use client';
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
function Card() {
  const [ov1Open, setOv1Open] = useState(false);
  return <motion.div data-id="card-root">
    <motion.div data-id="btn" data-overlay-trigger='{"targetId":"ov1","trigger":"click","dismiss":"outside"}'>Open</motion.div>
    <AnimatePresence>{ov1Open && (
      <motion.div key="ov1" data-id="ov1" data-overlay='{"type":"relative","triggerId":"btn","side":"bottom","align":"start","offsetX":0,"offsetY":0}'></motion.div>
    )}</AnimatePresence>
  </motion.div>;
}
export default Card;
`;
    expect(healMisplacedOverlayInCode(master)).toBe(master);
  });
});

// ─── Second overlay on a page that already HAS one ──────────────────────────
// The blank-page corruption (live find 2026-07-25). `findStateInsertPos` skips
// an existing overlay's effect block by brace-matching to `);` and then jumping
// to the next line — but babel's printer routinely emits
//   `}, [aOpen]);  return <div … style={{`
// on ONE line after a regeneration, so "the next line" is the one INSIDE the
// root element's style object. The new `const [ … ] = useState(false)` landed
// between `style={{` and `display: 'flex'` — a hard SyntaxError, page parses to
// zero nodes, canvas goes blank. Only reproduces when the page ALREADY has an
// overlay (nothing else takes that branch), which is why a fresh project was
// fine and the big landing page died every time.

const PAGE_WITH_EXISTING_OVERLAY = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [aOpen, setAOpen] = useState(false);
  useLayoutEffect(() => {
    if (!aOpen) return;
    const position = () => {
      const o = document.querySelector('[data-id="a"]');
      if (!o) return;
      const raw = JSON.parse(o.getAttribute('data-overlay') || '{}');
      o.style.top = raw.offsetY + 'px';
    };
    position();
    window.addEventListener('resize', position);
    return () => { window.removeEventListener('resize', position); };
  }, [aOpen]);  return <div data-id="root" data-name="Page" style={{
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    width: '100%'
  }}>
    <div data-id="hero" data-overlay-trigger='{"targetId":"a","trigger":"click","dismiss":"outside"}' onClick={() => setAOpen(!aOpen)}>Hero</div>
    <div data-id="btn" style={{ width: '200px' }}>FIX OVERLAYS</div>
    <AnimatePresence>{aOpen && (
      <motion.div key="a" data-id="a" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"hero","side":"bottom","align":"start","offsetX":0,"offsetY":0}' style={{ position: 'fixed', zIndex: '50' }}></motion.div>
    )}</AnimatePresence>
  </div>;
}
`;

describe('createOverlayInCode — page that already has an overlay', () => {
  test('the new useState lands in the FUNCTION BODY, not inside the JSX', () => {
    const out = createOverlayInCode(
      PAGE_WITH_EXISTING_OVERLAY, 'btn', 'b',
      makeOverlayConfig({ triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'b' }),
    );
    expectParses(out); // the crash was a hard SyntaxError here
    // The declaration must come BEFORE the render return, never after `style={{`.
    const declIdx = out.indexOf('const [bOpen, setBOpen] = useState(false)');
    expect(declIdx).toBeGreaterThan(-1);
    expect(declIdx).toBeLessThan(out.indexOf('<div data-id="root"'));
    // Both overlays' runtime survives, exactly once each.
    expect((out.match(/const \[aOpen, setAOpen\] = useState/g) || []).length).toBe(1);
    expect((out.match(/const \[bOpen, setBOpen\] = useState/g) || []).length).toBe(1);
  });

  test('the new overlay is still root last child, and the old one is untouched', () => {
    const out = createOverlayInCode(
      PAGE_WITH_EXISTING_OVERLAY, 'btn', 'b',
      makeOverlayConfig({ type: 'fixed', triggerId: 'btn' }),
      makeTriggerConfig({ targetId: 'b' }),
    );
    expectParses(out);
    expect(out.indexOf('key="b"')).toBeGreaterThan(out.indexOf('data-id="btn"'));
    expect((out.match(/key="a"/g) || []).length).toBe(1);
  });

  test('a THIRD overlay still parses (skips two hook blocks)', () => {
    let out = createOverlayInCode(
      PAGE_WITH_EXISTING_OVERLAY, 'btn', 'b',
      makeOverlayConfig({ triggerId: 'btn' }), makeTriggerConfig({ targetId: 'b' }));
    out = createOverlayInCode(
      out, 'hero', 'c',
      makeOverlayConfig({ type: 'fixed', triggerId: 'hero' }), makeTriggerConfig({ targetId: 'c' }));
    expectParses(out);
    expect(out.indexOf('const [cOpen, setCOpen] = useState(false)')).toBeLessThan(out.indexOf('<div data-id="root"'));
  });
});

describe('healMisplacedOverlayInCode — never strands a block outside the function', () => {
  test('no-ops instead of appending at EOF when root close is unresolvable', () => {
    // No `data-id="root"` reachable → the heal must leave the file byte-identical
    // rather than appending the block after the component's closing brace (which
    // is module-scope JSX referencing a hook variable = blank page).
    const noRoot = `'use client';
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [aOpen, setAOpen] = useState(false);
  return <div data-id="wrapper">
    <div data-id="btn" data-overlay-trigger='{"targetId":"a","trigger":"click","dismiss":"outside"}'></div>
    <AnimatePresence>{aOpen && (
      <motion.div key="a" data-id="a" data-overlay='{"type":"relative","triggerId":"btn","side":"bottom","align":"start","offsetX":0,"offsetY":0}'></motion.div>
    )}</AnimatePresence>
  </div>;
}
`;
    const out = healMisplacedOverlayInCode(noRoot);
    expect(out).toBe(noRoot);
    expectParses(out);
  });

  test('a healed page keeps every overlay INSIDE the component function', () => {
    const out = healMisplacedOverlayInCode(MISPLACED_PAGE);
    expectParses(out);
    // Nothing may sit after the component's closing brace except module-scope code.
    const afterFn = out.slice(out.lastIndexOf('</div>;') + '</div>;'.length);
    expect(afterFn).not.toContain('AnimatePresence');
    expect(afterFn).not.toContain('motion.div');
  });
});

// ─── Stranded at module scope ───────────────────────────────────────────────
// The worst outcome of the misplacement bug: the overlay block ended up AFTER
// the component's closing brace. It references the component's `<id>Open` hook
// variable, so the file carries a dangling identifier — the page is dead AND the
// mutation validator refuses every later overlay action ("References undefined
// identifier: overlayFrameMrzixi9c_1_2Open"), trapping the user with no way to
// edit out of it. Live find 2026-07-25.

const STRANDED_PAGE = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [aOpen, setAOpen] = useState(false);
  useEffect(() => {
    if (!aOpen) return;
    const overlay = document.querySelector('[data-id="a"]');
    if (!overlay) return;
    const prevOverflow = document.body.style.overflow;
    return () => { document.body.style.overflow = prevOverflow; };
  }, [aOpen]);
  return <div data-id="root" style={{ position: 'relative' }}>
    <div data-id="btn" data-overlay-trigger='{"targetId":"a","trigger":"click","dismiss":"outside"}' onClick={() => setAOpen(!aOpen)}>Open</div>
  </div>;
}
<AnimatePresence>{aOpen && <motion.div key="a" data-id="a" data-name="Overlay" data-overlay='{"type":"fixed","triggerId":"btn","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'fixed', left: '0', top: '0' }}>
  <div data-id="child-1" style={{ width: '10px' }}></div>
</motion.div>}</AnimatePresence>;
`;

describe('healMisplacedOverlayInCode — block stranded outside the component', () => {
  test('lifts it back inside root, children and all', () => {
    const out = healMisplacedOverlayInCode(STRANDED_PAGE);
    expectParses(out);
    // Nothing overlay-shaped may remain after the component's closing brace.
    const tail = out.slice(out.lastIndexOf('</div>;') + '</div>;'.length);
    expect(tail).not.toContain('AnimatePresence');
    expect(tail).not.toContain('motion.div');
    // Moved, not duplicated — and its subtree came along.
    expect((out.match(/key="a"/g) || []).length).toBe(1);
    expect(out).toContain('data-id="child-1"');
    // Inside root now: the block precedes root's closing tag.
    expect(out.indexOf('key="a"')).toBeGreaterThan(out.indexOf('data-id="btn"'));
    expect(out.indexOf('key="a"')).toBeLessThan(out.lastIndexOf('</div>;'));
  });

  test('the healed file has no dangling identifier left', () => {
    const out = healMisplacedOverlayInCode(STRANDED_PAGE);
    // `aOpen` is referenced only inside the component function now.
    const fnEnd = out.lastIndexOf('</div>;');
    expect(out.slice(fnEnd).includes('aOpen')).toBe(false);
  });

  test('idempotent', () => {
    const once = healMisplacedOverlayInCode(STRANDED_PAGE);
    expect(healMisplacedOverlayInCode(once)).toBe(once);
  });

  test('leaves a legitimate CANVAS overlay in canvasNodes alone', () => {
    const canvas = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root"><div data-id="btn" data-overlay-trigger='{"targetId":"cv","trigger":"click","dismiss":"outside"}'></div></div>;
}
const canvasNodes = <>
  <motion.div key="cv" data-id="cv" data-canvas-node="true" data-overlay='{"type":"relative","triggerId":"btn","side":"bottom","align":"center","offsetX":0,"offsetY":10}' style={{ position: 'absolute' }}></motion.div>
</>;
`;
    expect(healMisplacedOverlayInCode(canvas)).toBe(canvas);
  });
});

// ─── Pruning an orphan overlay printed WITHOUT parens ───────────────────────
// `{xOpen && ( … )}` is what the generator emits, but every structural rewrite
// round-trips the file through babel, which reprints it as `{xOpen && <motion.div
// … />}`. `overlayRemovalRange` required the parens, so pruning an orphan in the
// reprinted form removed only the ELEMENT and left `{xOpen && }` — a syntax error
// the mutation validator then blocked, so the node could not be deleted at all.
// Reproduces "duplicate a section with a fixed overlay, then delete the duplicate"
// (user report 2026-07-25).

/** Two sections, each with an overlay; `dup` has just had its trigger deleted, so
 *  its overlay is an orphan. The orphan is in the BABEL-REPRINTED (no-paren) form. */
const ORPHAN_NO_PARENS = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
export default function Page() {
  const [dupOpen, setDupOpen] = useState(false);
  const [origOpen, setOrigOpen] = useState(false);
  return <div data-id="root" style={{ position: 'relative' }}>
    <div data-id="orig-trigger" data-overlay-trigger='{"targetId":"orig","trigger":"click","dismiss":"outside"}' onClick={() => setOrigOpen(!origOpen)}>Play</div>

      <AnimatePresence>{dupOpen && <motion.div key="dup" data-id="dup" data-name="Overlay" data-overlay='{"type":"fixed","triggerId":"dup-trigger","side":"bottom","align":"center","offsetX":0,"offsetY":0}' style={{ position: 'fixed' }}>
        </motion.div>}</AnimatePresence>

      <AnimatePresence>{origOpen && (
        <motion.div key="orig" data-id="orig" data-name="Overlay" data-overlay='{"type":"fixed","triggerId":"orig-trigger","side":"bottom","align":"center","offsetX":0,"offsetY":0}' style={{ position: 'fixed' }}>
        </motion.div>
      )}</AnimatePresence>
  </div>;
}
`;

describe('pruneOverlayDuplicatesInCode — orphan in the no-paren form', () => {
  test('removes the WHOLE conditional, leaving no `{x && }` behind', () => {
    const out = pruneOverlayDuplicatesInCode(ORPHAN_NO_PARENS);
    expectParses(out); // this threw "Unexpected token" before the fix
    expect(out).not.toMatch(/&&\s*\}/);       // no empty conditional
    expect(out).not.toContain('key="dup"');   // the orphan is gone
    expect(out).not.toContain('data-id="dup"');
  });

  test('the still-triggered overlay is untouched', () => {
    const out = pruneOverlayDuplicatesInCode(ORPHAN_NO_PARENS);
    expect(out).toContain('key="orig"');
    expect((out.match(/key="orig"/g) || []).length).toBe(1);
    expect(out).toContain('data-overlay-trigger=');
  });

  test('the PAREN form still prunes cleanly (no regression)', () => {
    const parens = ORPHAN_NO_PARENS
      .replace('{dupOpen && <motion.div key="dup"', '{dupOpen && (<motion.div key="dup"')
      .replace('</motion.div>}</AnimatePresence>', '</motion.div>)}</AnimatePresence>');
    const out = pruneOverlayDuplicatesInCode(parens);
    expectParses(out);
    expect(out).not.toMatch(/&&\s*\}/);
    expect(out).not.toContain('key="dup"');
    expect(out).toContain('key="orig"');
  });

  test('idempotent — a pruned file is left alone', () => {
    const once = pruneOverlayDuplicatesInCode(ORPHAN_NO_PARENS);
    expect(pruneOverlayDuplicatesInCode(once)).toBe(once);
  });
});
