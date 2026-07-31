import { describe, test, expect } from 'vitest';
import {
  parseOverlayCalls,
  parseOverlayTriggerCalls,
  getOverlayPairs,
  getOverlayForNode,
  getTriggerForNode,
  resolveOverlayConfigForWidth,
  resolveOverlayConfig,
} from './overlay-parser';
import type { OverlayConfig } from '@/shared/types';

// ─── helpers ────────────────────────────────────────────────────────────

function overlayAttr(cfg: Record<string, unknown>) {
  return `data-overlay='${JSON.stringify(cfg)}'`;
}

function triggerAttr(cfg: Record<string, unknown>) {
  return `data-overlay-trigger='${JSON.stringify(cfg)}'`;
}

const defaultOverlayConfig = {
  type: 'relative',
  triggerId: 'btn-1',
  side: 'bottom',
  align: 'start',
  offsetX: 0,
  offsetY: 8,
};

const defaultTriggerConfig = {
  targetId: 'popup-1',
  trigger: 'click',
  dismiss: 'outside',
};

// ─── parseOverlayCalls ──────────────────────────────────────────────────

describe('parseOverlayCalls', () => {
  test('parses a single overlay', () => {
    const code = `<div data-id="popup-1" ${overlayAttr(defaultOverlayConfig)}>content</div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].overlayId).toBe('popup-1');
    expect(calls[0].config.type).toBe('relative');
    expect(calls[0].config.triggerId).toBe('btn-1');
    expect(calls[0].config.side).toBe('bottom');
    expect(calls[0].config.align).toBe('start');
    expect(calls[0].config.offsetX).toBe(0);
    expect(calls[0].config.offsetY).toBe(8);
  });

  test('parses multiple overlays', () => {
    const cfg1 = { type: 'relative', triggerId: 'btn-a', side: 'top', align: 'center', offsetX: 0, offsetY: 4 };
    const cfg2 = { type: 'fixed', triggerId: 'btn-b', side: 'left', align: 'end', offsetX: 10, offsetY: 0 };
    const code = `
      <div data-id="overlay-a" ${overlayAttr(cfg1)}>A</div>
      <div data-id="overlay-b" ${overlayAttr(cfg2)}>B</div>
    `;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(2);
    expect(calls[0].overlayId).toBe('overlay-a');
    expect(calls[0].config.triggerId).toBe('btn-a');
    expect(calls[0].config.side).toBe('top');
    expect(calls[1].overlayId).toBe('overlay-b');
    expect(calls[1].config.type).toBe('fixed');
    expect(calls[1].config.side).toBe('left');
  });

  test('returns empty array when no overlays', () => {
    const code = `<div data-id="plain">just a div</div>`;
    expect(parseOverlayCalls(code)).toHaveLength(0);
  });

  test('skips invalid JSON gracefully', () => {
    const code = `<div data-id="bad" data-overlay='not-json'>x</div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(0);
  });

  test('skips overlay with no preceding data-id', () => {
    const code = `<div ${overlayAttr(defaultOverlayConfig)}>no id</div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(0);
  });

  test('picks closest data-id when multiple exist nearby', () => {
    // The parser takes the last data-id found in the 1000 chars before the attribute
    const code = `<div data-id="outer"><span data-id="inner" ${overlayAttr(defaultOverlayConfig)}>x</span></div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].overlayId).toBe('inner');
  });

  test('parses all four side values', () => {
    const sides = ['top', 'right', 'bottom', 'left'] as const;
    for (const side of sides) {
      const cfg = { ...defaultOverlayConfig, side };
      const code = `<div data-id="s-${side}" ${overlayAttr(cfg)}>x</div>`;
      const calls = parseOverlayCalls(code);
      expect(calls).toHaveLength(1);
      expect(calls[0].config.side).toBe(side);
    }
  });

  test('parses all align values', () => {
    const aligns = ['start', 'center', 'end'] as const;
    for (const align of aligns) {
      const cfg = { ...defaultOverlayConfig, align };
      const code = `<div data-id="a-${align}" ${overlayAttr(cfg)}>x</div>`;
      const calls = parseOverlayCalls(code);
      expect(calls).toHaveLength(1);
      expect(calls[0].config.align).toBe(align);
    }
  });

  test('parses fixed type overlay', () => {
    const cfg = { ...defaultOverlayConfig, type: 'fixed' };
    const code = `<div data-id="modal" ${overlayAttr(cfg)}>modal content</div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].config.type).toBe('fixed');
  });
});

// ─── parseOverlayCalls code positions ───────────────────────────────────

describe('parseOverlayCalls code positions', () => {
  test('codeStart points to opening < of the element', () => {
    const code = `<div data-id="popup" ${overlayAttr(defaultOverlayConfig)}>hello</div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].codeStart).toBe(0);
    expect(code[calls[0].codeStart]).toBe('<');
  });

  test('codeEnd points past the closing tag', () => {
    const code = `<div data-id="popup" ${overlayAttr(defaultOverlayConfig)}>hello</div>`;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].codeEnd).toBe(code.length);
    expect(code.slice(calls[0].codeEnd - 6, calls[0].codeEnd)).toBe('</div>');
  });

  test('codeStart/codeEnd with content before the element', () => {
    const prefix = '<main>BEFORE';
    const element = `<section data-id="pop" ${overlayAttr(defaultOverlayConfig)}>inner</section>`;
    const code = prefix + element + '</main>';
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].codeStart).toBe(prefix.length);
    expect(calls[0].codeEnd).toBe(prefix.length + element.length);
    expect(code.slice(calls[0].codeStart, calls[0].codeEnd)).toBe(element);
  });

  test('code positions for multiple overlays are independent', () => {
    const el1 = `<div data-id="a" ${overlayAttr({ ...defaultOverlayConfig, triggerId: 'x' })}>A</div>`;
    const el2 = `<div data-id="b" ${overlayAttr({ ...defaultOverlayConfig, triggerId: 'y' })}>B</div>`;
    const code = el1 + el2;
    const calls = parseOverlayCalls(code);
    expect(calls).toHaveLength(2);
    expect(calls[0].codeStart).toBe(0);
    expect(calls[0].codeEnd).toBe(el1.length);
    expect(calls[1].codeStart).toBe(el1.length);
    expect(calls[1].codeEnd).toBe(code.length);
  });

  test('codeEnd falls back when closing tag is missing', () => {
    // Self-closing or unclosed — codeEnd should be at least past the attribute
    const code = `<img data-id="pic" ${overlayAttr(defaultOverlayConfig)} />`;
    const calls = parseOverlayCalls(code);
    // No closing </img> tag, so codeEnd should fallback
    if (calls.length === 1) {
      expect(calls[0].codeEnd).toBeGreaterThan(calls[0].codeStart);
    }
  });
});

// ─── parseOverlayTriggerCalls ───────────────────────────────────────────

describe('parseOverlayTriggerCalls', () => {
  test('parses a single trigger', () => {
    const code = `<button data-id="btn-1" ${triggerAttr(defaultTriggerConfig)}>Open</button>`;
    const calls = parseOverlayTriggerCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].triggerId).toBe('btn-1');
    expect(calls[0].config.targetId).toBe('popup-1');
    expect(calls[0].config.trigger).toBe('click');
    expect(calls[0].config.dismiss).toBe('outside');
  });

  test('parses multiple triggers', () => {
    const cfg1 = { targetId: 'menu-1', trigger: 'click', dismiss: 'outside' };
    const cfg2 = { targetId: 'tooltip-1', trigger: 'hover', dismiss: 'escape' };
    const code = `
      <button data-id="trigger-a" ${triggerAttr(cfg1)}>Menu</button>
      <span data-id="trigger-b" ${triggerAttr(cfg2)}>Info</span>
    `;
    const calls = parseOverlayTriggerCalls(code);
    expect(calls).toHaveLength(2);
    expect(calls[0].triggerId).toBe('trigger-a');
    expect(calls[0].config.targetId).toBe('menu-1');
    expect(calls[0].config.trigger).toBe('click');
    expect(calls[1].triggerId).toBe('trigger-b');
    expect(calls[1].config.targetId).toBe('tooltip-1');
    expect(calls[1].config.trigger).toBe('hover');
    expect(calls[1].config.dismiss).toBe('escape');
  });

  test('returns empty array when no triggers', () => {
    const code = `<div data-id="nope">nothing</div>`;
    expect(parseOverlayTriggerCalls(code)).toHaveLength(0);
  });

  test('skips invalid JSON gracefully', () => {
    const code = `<button data-id="bad" data-overlay-trigger='{broken}'>x</button>`;
    const calls = parseOverlayTriggerCalls(code);
    expect(calls).toHaveLength(0);
  });

  test('skips trigger with no preceding data-id', () => {
    const code = `<button ${triggerAttr(defaultTriggerConfig)}>no id</button>`;
    const calls = parseOverlayTriggerCalls(code);
    expect(calls).toHaveLength(0);
  });

  test('parses hover trigger', () => {
    const cfg = { targetId: 'tip', trigger: 'hover', dismiss: 'click' };
    const code = `<span data-id="hover-trigger" ${triggerAttr(cfg)}>?</span>`;
    const calls = parseOverlayTriggerCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].config.trigger).toBe('hover');
    expect(calls[0].config.dismiss).toBe('click');
  });

  test('parses all dismiss values', () => {
    const dismissValues = ['outside', 'click', 'escape'] as const;
    for (const dismiss of dismissValues) {
      const cfg = { ...defaultTriggerConfig, dismiss };
      const code = `<button data-id="d-${dismiss}" ${triggerAttr(cfg)}>x</button>`;
      const calls = parseOverlayTriggerCalls(code);
      expect(calls).toHaveLength(1);
      expect(calls[0].config.dismiss).toBe(dismiss);
    }
  });
});

// ─── getOverlayPairs ────────────────────────────────────────────────────

describe('getOverlayPairs', () => {
  test('links a trigger to its overlay', () => {
    const overlayCfg = { type: 'relative', triggerId: 'btn-1', side: 'bottom', align: 'start', offsetX: 0, offsetY: 8 };
    const triggerCfg = { targetId: 'popup-1', trigger: 'click', dismiss: 'outside' };
    const code = `
      <button data-id="btn-1" ${triggerAttr(triggerCfg)}>Open</button>
      <div data-id="popup-1" ${overlayAttr(overlayCfg)}>Popup</div>
    `;
    const pairs = getOverlayPairs(code);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].trigger.triggerId).toBe('btn-1');
    expect(pairs[0].trigger.config.targetId).toBe('popup-1');
    expect(pairs[0].overlay.overlayId).toBe('popup-1');
    expect(pairs[0].overlay.config.triggerId).toBe('btn-1');
  });

  test('returns empty when trigger has no matching overlay', () => {
    const triggerCfg = { targetId: 'nonexistent', trigger: 'click', dismiss: 'outside' };
    const code = `<button data-id="btn-2" ${triggerAttr(triggerCfg)}>Open</button>`;
    const pairs = getOverlayPairs(code);
    expect(pairs).toHaveLength(0);
  });

  test('returns empty when overlay has no matching trigger', () => {
    const overlayCfg = { type: 'relative', triggerId: 'missing-btn', side: 'top', align: 'center', offsetX: 0, offsetY: 0 };
    const code = `<div data-id="lonely-popup" ${overlayAttr(overlayCfg)}>Orphan</div>`;
    const pairs = getOverlayPairs(code);
    expect(pairs).toHaveLength(0);
  });

  test('matches multiple pairs correctly', () => {
    const overlay1 = { type: 'relative', triggerId: 'btn-a', side: 'bottom', align: 'start', offsetX: 0, offsetY: 4 };
    const overlay2 = { type: 'fixed', triggerId: 'btn-b', side: 'left', align: 'end', offsetX: 0, offsetY: 0 };
    const trigger1 = { targetId: 'menu-a', trigger: 'click', dismiss: 'outside' };
    const trigger2 = { targetId: 'menu-b', trigger: 'hover', dismiss: 'escape' };
    const code = `
      <button data-id="btn-a" ${triggerAttr(trigger1)}>A</button>
      <button data-id="btn-b" ${triggerAttr(trigger2)}>B</button>
      <div data-id="menu-a" ${overlayAttr(overlay1)}>Menu A</div>
      <div data-id="menu-b" ${overlayAttr(overlay2)}>Menu B</div>
    `;
    const pairs = getOverlayPairs(code);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].trigger.triggerId).toBe('btn-a');
    expect(pairs[0].overlay.overlayId).toBe('menu-a');
    expect(pairs[1].trigger.triggerId).toBe('btn-b');
    expect(pairs[1].overlay.overlayId).toBe('menu-b');
  });

  test('only matched pairs are returned, unmatched are excluded', () => {
    const overlayCfg = { type: 'relative', triggerId: 'btn-matched', side: 'bottom', align: 'start', offsetX: 0, offsetY: 0 };
    const triggerMatched = { targetId: 'popup-matched', trigger: 'click', dismiss: 'outside' };
    const triggerOrphan = { targetId: 'popup-nonexistent', trigger: 'hover', dismiss: 'click' };
    const code = `
      <button data-id="btn-matched" ${triggerAttr(triggerMatched)}>Match</button>
      <button data-id="btn-orphan" ${triggerAttr(triggerOrphan)}>Orphan</button>
      <div data-id="popup-matched" ${overlayAttr(overlayCfg)}>Matched Popup</div>
    `;
    const pairs = getOverlayPairs(code);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].trigger.triggerId).toBe('btn-matched');
    expect(pairs[0].overlay.overlayId).toBe('popup-matched');
  });

  test('returns empty when code has no overlays or triggers', () => {
    const code = `<div data-id="plain">Nothing overlay-related here</div>`;
    expect(getOverlayPairs(code)).toHaveLength(0);
  });
});

// ─── getOverlayForNode ──────────────────────────────────────────────────

describe('getOverlayForNode', () => {
  test('returns the overlay matching the nodeId', () => {
    const code = `<div data-id="popup-x" ${overlayAttr(defaultOverlayConfig)}>x</div>`;
    const overlays = parseOverlayCalls(code);
    const result = getOverlayForNode(overlays, 'popup-x');
    expect(result).not.toBeNull();
    expect(result!.overlayId).toBe('popup-x');
    expect(result!.config.side).toBe('bottom');
  });

  test('returns null when nodeId is not found', () => {
    const code = `<div data-id="popup-x" ${overlayAttr(defaultOverlayConfig)}>x</div>`;
    const overlays = parseOverlayCalls(code);
    expect(getOverlayForNode(overlays, 'nonexistent')).toBeNull();
  });

  test('returns null when overlays array is empty', () => {
    expect(getOverlayForNode([], 'any-id')).toBeNull();
  });

  test('finds correct overlay among multiple', () => {
    const cfg1 = { ...defaultOverlayConfig, triggerId: 'btn-1' };
    const cfg2 = { ...defaultOverlayConfig, triggerId: 'btn-2', side: 'right' };
    const code = `
      <div data-id="popup-1" ${overlayAttr(cfg1)}>A</div>
      <div data-id="popup-2" ${overlayAttr(cfg2)}>B</div>
    `;
    const overlays = parseOverlayCalls(code);
    const result = getOverlayForNode(overlays, 'popup-2');
    expect(result).not.toBeNull();
    expect(result!.overlayId).toBe('popup-2');
    expect(result!.config.side).toBe('right');
  });
});

// ─── getTriggerForNode ──────────────────────────────────────────────────

describe('getTriggerForNode', () => {
  test('returns the trigger matching the nodeId', () => {
    const code = `<button data-id="btn-1" ${triggerAttr(defaultTriggerConfig)}>Click</button>`;
    const triggers = parseOverlayTriggerCalls(code);
    const result = getTriggerForNode(triggers, 'btn-1');
    expect(result).not.toBeNull();
    expect(result!.triggerId).toBe('btn-1');
    expect(result!.config.trigger).toBe('click');
  });

  test('returns null when nodeId is not found', () => {
    const code = `<button data-id="btn-1" ${triggerAttr(defaultTriggerConfig)}>Click</button>`;
    const triggers = parseOverlayTriggerCalls(code);
    expect(getTriggerForNode(triggers, 'nonexistent')).toBeNull();
  });

  test('returns null when triggers array is empty', () => {
    expect(getTriggerForNode([], 'any-id')).toBeNull();
  });

  test('finds correct trigger among multiple', () => {
    const cfg1 = { targetId: 'menu-1', trigger: 'click', dismiss: 'outside' };
    const cfg2 = { targetId: 'tooltip-1', trigger: 'hover', dismiss: 'escape' };
    const code = `
      <button data-id="trigger-a" ${triggerAttr(cfg1)}>Menu</button>
      <span data-id="trigger-b" ${triggerAttr(cfg2)}>Info</span>
    `;
    const triggers = parseOverlayTriggerCalls(code);
    const result = getTriggerForNode(triggers, 'trigger-b');
    expect(result).not.toBeNull();
    expect(result!.triggerId).toBe('trigger-b');
    expect(result!.config.trigger).toBe('hover');
    expect(result!.config.targetId).toBe('tooltip-1');
  });
});

// ─── resolveOverlayConfig (unified: variant override > width path) ─────────

describe('resolveOverlayConfig (variant + width)', () => {
  const cfg: OverlayConfig = {
    type: 'relative', triggerId: 't', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10,
    responsive: { '768': { side: 'right' } },
    responsiveVariant: { 'variant-1': { align: 'end', offsetX: 30 } },
  };

  test('a variant with an override applies it (over the base)', () => {
    const r = resolveOverlayConfig(cfg, 'variant-1', 0);
    expect(r.align).toBe('end');
    expect(r.offsetX).toBe(30);
    expect(r.side).toBe('bottom'); // base
  });
  test('the default variant (desktop) → base (no variant override)', () => {
    const r = resolveOverlayConfig(cfg, 'desktop', 0);
    expect(r.align).toBe('center');
    expect(r.offsetX).toBe(0);
  });
  test('a variant with no override → base', () => {
    const r = resolveOverlayConfig(cfg, 'variant-2', 0);
    expect(r.align).toBe('center');
  });
  test('falls through to the WIDTH path when no variant override matches', () => {
    const r = resolveOverlayConfig(cfg, 'tablet', 768);
    expect(r.side).toBe('right'); // the 768 responsive override
  });
});

// ─── resolveOverlayConfigForWidth (per-viewport cascade) ──────────────────

describe('resolveOverlayConfigForWidth', () => {
  const base: OverlayConfig = {
    type: 'relative', triggerId: 't', side: 'bottom', align: 'start',
    offsetX: 0, offsetY: 0, collision: 'auto', collisionPadding: 20,
    responsive: {
      '768': { offsetX: 10, side: 'right' },
      '375': { side: 'top' },
    },
  };

  // ── No responsiveBp: exact-width match (the canvas passes a tile's own width) ──
  test('exact tile width 1440 → base (no 1440 override)', () => {
    const r = resolveOverlayConfigForWidth(base, 1440);
    expect(r.offsetX).toBe(0);
    expect(r.side).toBe('bottom');
  });
  test('exact tile width 768 → the 768 override', () => {
    const r = resolveOverlayConfigForWidth(base, 768);
    expect(r.offsetX).toBe(10);
    expect(r.side).toBe('right');
  });
  test('exact tile width 375 → ONLY its own override (no tablet inheritance)', () => {
    const r = resolveOverlayConfigForWidth(base, 375);
    expect(r.offsetX).toBe(0);   // base, NOT 768's 10
    expect(r.side).toBe('top');
  });

  // ── With responsiveBp: owning-viewport ranges (the runtime path) ──
  const withBp: OverlayConfig = { ...base, responsiveBp: [1440, 768, 375] };
  test('range width 500 → owning viewport 768 applies', () => {
    const r = resolveOverlayConfigForWidth(withBp, 500);
    expect(r.offsetX).toBe(10);
    expect(r.side).toBe('right');
  });
  test('range width 1000 → above all replicas → base', () => {
    const r = resolveOverlayConfigForWidth(withBp, 1000);
    expect(r.side).toBe('bottom');
  });

  // ── THE bug: tablet override only, mobile has none → mobile stays on BASE ──
  test('tablet-only override → mobile (375) resolves to BASE, not tablet', () => {
    const tabletOnly: OverlayConfig = {
      ...base, responsive: { '768': { offsetX: 40, side: 'right' } }, responsiveBp: [1440, 768, 375],
    };
    const mobile = resolveOverlayConfigForWidth(tabletOnly, 375); // owning vp = 375, no override
    expect(mobile.offsetX).toBe(0);     // BASE — does not follow the tablet
    expect(mobile.side).toBe('bottom'); // BASE
    const tablet = resolveOverlayConfigForWidth(tabletOnly, 768);
    expect(tablet.offsetX).toBe(40);    // tablet keeps its own
  });

  test('no responsive map → returns base unchanged', () => {
    const { responsive: _drop, ...plain } = base;
    const r = resolveOverlayConfigForWidth(plain as OverlayConfig, 375);
    expect(r.side).toBe('bottom');
  });
});
