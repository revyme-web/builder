// overlay-top-layer.test.ts — overlays render in the browser's TOP LAYER.
// A component whose root is perf-isolated (contain + willChange) clipped its
// dropdown at the header's edge on the live site (user report 2026-10-20).
// The runtime effect now lifts the open overlay into the top layer (Popover
// API) and follows its trigger every frame; healOverlayTopLayerInCode upgrades
// the effects already in projects. The old effects below are the EXACT output
// of the previous builder (and a Babel-reformatted copy from the reported
// Header), so the heal's signature match is tested against real text.
import { describe, test, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import {
  createOverlayInCode, buildRelativeOverlayPosEffect, buildFixedOverlayRuntimeEffect,
  healOverlayTopLayerInCode, OVERLAY_TOP_LAYER_CSS,
} from './overlay-gen';
import { validateGeneratedCode } from '../mutation/mutation-queue';
import { checkFile } from '../oracle/check-file';

const OV = 'overlay-menu-btn-1';
const VAR = 'overlayMenuBtn_1Open';

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

const cfg = (type: 'relative' | 'fixed') =>
  ({ type, triggerId: 'menu-btn', side: 'bottom', align: 'start', offsetX: 0, offsetY: 8 }) as any;
const trg = { targetId: OV, trigger: 'click', dismiss: 'outside' } as any;

/** Swap the overlay's runtime effect (anchored on its unique deps) for `effect`. */
function withEffect(code: string, effect: string): string {
  const dep = `, [${VAR}]);\n`;
  const depIdx = code.indexOf(dep);
  const before = code.slice(0, depIdx);
  const opener = Math.max(before.lastIndexOf('useLayoutEffect('), before.lastIndexOf('useEffect('));
  const lineStart = code.lastIndexOf('\n', opener) + 1;
  return code.slice(0, lineStart) + effect + code.slice(depIdx + dep.length);
}

const OLD_RELATIVE = `  useLayoutEffect(() => {
    if (!overlayMenuBtn_1Open) return;
    const position = () => {
      const overlay = document.querySelector('[data-id="overlay-menu-btn-1"]');
      if (!overlay) return;
      const raw = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
      let cfg = raw;
      if (raw.responsive) {
        const ww = window.innerWidth;
        const bps = raw.responsiveBp;
        const owning = (bps && bps.length)
          ? bps.filter(b => ww <= b).sort((a, b) => a - b)[0]
          : Object.keys(raw.responsive).map(Number).filter(n => ww <= n).sort((a, b) => a - b)[0];
        if (owning !== undefined && raw.responsive[owning]) cfg = { ...raw, ...raw.responsive[owning] };
      }
      const trigger = document.querySelector('[data-id="' + cfg.triggerId + '"]');
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const w = overlay.offsetWidth, h = overlay.offsetHeight;
      const g = 8, ox = cfg.offsetX || 0, oy = cfg.offsetY || 0;
      let top, left;
      switch (cfg.side || 'bottom') {
        case 'top': top = r.top - h - g + oy; break;
        case 'left': top = r.top + oy; left = r.left - w - g + ox; break;
        case 'right': top = r.top + oy; left = r.right + g + ox; break;
        default: top = r.bottom + g + oy;
      }
      if (left === undefined) {
        if (cfg.align === 'center') left = r.left + r.width / 2 - w / 2 + ox;
        else if (cfg.align === 'end') left = r.right - w + ox;
        else left = r.left + ox;
      } else if (cfg.align === 'center') top = r.top + r.height / 2 - h / 2 + oy;
      else if (cfg.align === 'end') top = r.bottom - h + oy;
      if (cfg.collision !== 'none') {
        const pad = cfg.collisionPadding ?? 20;
        left = Math.min(Math.max(left, pad), window.innerWidth - w - pad);
        top = Math.min(Math.max(top, pad), window.innerHeight - h - pad);
      }
      overlay.style.top = top + 'px';
      overlay.style.left = left + 'px';
    };
    const onOutside = (e) => {
      const ov = document.querySelector('[data-id="overlay-menu-btn-1"]');
      if (ov && ov.contains(e.target)) return;
      const tid = ov ? (JSON.parse(ov.getAttribute('data-overlay') || '{}').triggerId) : null;
      const tr = tid ? document.querySelector('[data-id="' + tid + '"]') : null;
      if (tr && tr.contains(e.target)) return;
      setOverlayMenuBtn_1Open(false);
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('mousedown', onOutside);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); document.removeEventListener('mousedown', onOutside); };
  }, [overlayMenuBtn_1Open]);
`;
const OLD_FIXED = `  useEffect(() => {
    if (!overlayMenuBtn_1Open) return;
    const overlay = document.querySelector('[data-id="overlay-menu-btn-1"]');
    if (!overlay) return;
    const cfg = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
    if (cfg.fill) overlay.style.backgroundColor = cfg.fill;
    if (cfg.zIndex != null) overlay.style.zIndex = String(cfg.zIndex);
    const onBackdrop = (e) => { if (e.target === overlay && cfg.dismissible !== false) setOverlayMenuBtn_1Open(false); };
    overlay.addEventListener('mousedown', onBackdrop);
    const prevOverflow = document.body.style.overflow;
    if (cfg.pageScroll !== 'auto') document.body.style.overflow = 'hidden';
    return () => {
      overlay.removeEventListener('mousedown', onBackdrop);
      document.body.style.overflow = prevOverflow;
    };
  }, [overlayMenuBtn_1Open]);
`;

const overlayViolations = (code: string) =>
  checkFile(code, { kind: 'page' }).filter((x) => x.code.startsWith('OVERLAY_') || x.tier === 3);

describe('runtime effects lift the open overlay into the top layer', () => {
  test('relative: top layer + per-frame follow, no resize/scroll listeners', () => {
    const fx = buildRelativeOverlayPosEffect(OV);
    expect(fx).toContain("setAttribute('popover', 'manual')");
    expect(fx).toContain("if (!lift.matches(':popover-open'))");
    expect(fx).toContain('requestAnimationFrame(function follow()');
    expect(fx).toContain('cancelAnimationFrame(raf)');
    expect(fx).not.toContain("addEventListener('scroll'");
    expect(fx).not.toContain("addEventListener('resize'");
    // closes once its trigger has been on screen and then leaves it
    expect(fx).toContain('if (onScreen) seen = true;');
    expect(fx).toContain('else if (seen) { setOverlayMenuBtn_1Open(false); return; }');
    // top/left only written when they change (no per-frame style invalidation)
    expect(fx).toContain('if (overlay.style.top !== t) overlay.style.top = t;');
  });

  test('fixed (modal): lifted too, backdrop + scroll lock unchanged', () => {
    const fx = buildFixedOverlayRuntimeEffect(OV);
    expect(fx).toContain("overlay.setAttribute('popover', 'manual'); overlay.showPopover();");
    expect(fx).toContain('prevOverflow');
    expect(fx).toContain('onBackdrop');
  });

  test('component masters keep instance-scoped lookups', () => {
    expect(buildRelativeOverlayPosEffect(OV, true)).toContain(`const lift = ovFind('${OV}');`);
    expect(buildFixedOverlayRuntimeEffect(OV, true)).toContain(`const overlay = ovFind('${OV}');`);
  });

  test('emitted effects carry no comments (NO_COMMENTS_IN_GENERATED_CODE)', () => {
    for (const fx of [buildRelativeOverlayPosEffect(OV), buildFixedOverlayRuntimeEffect(OV), buildRelativeOverlayPosEffect(OV, true)]) {
      expect(fx).not.toMatch(/\/\/|\/\*/);
    }
  });

  test('the UA popover box is reset at zero specificity', () => {
    expect(OVERLAY_TOP_LAYER_CSS.startsWith(':where([data-overlay][popover]){')).toBe(true);
    for (const decl of ['inset:auto', 'margin:0', 'padding:0', 'border:0', 'color:inherit', 'background:none', 'overflow:visible', 'width:auto', 'height:auto']) {
      expect(OVERLAY_TOP_LAYER_CSS).toContain(decl);
    }
  });

  test.each(['relative', 'fixed'] as const)('PRIME RULE: a fresh %s overlay passes the oracle and validates', (type) => {
    const out = createOverlayInCode(BASE, 'menu-btn', OV, cfg(type), trg);
    expect(out).toContain('showPopover()');
    expect(overlayViolations(out)).toEqual([]);
    expect(validateGeneratedCode(out)).toBeNull();
  });
});

describe('healOverlayTopLayerInCode — upgrades generated effects already in projects', () => {
  test.each([
    ['relative', OLD_RELATIVE, () => buildRelativeOverlayPosEffect(OV)],
    ['fixed', OLD_FIXED, () => buildFixedOverlayRuntimeEffect(OV)],
  ] as const)('the old %s effect becomes the current builder output, in place', (type, old, current) => {
    const fresh = createOverlayInCode(BASE, 'menu-btn', OV, cfg(type), trg);
    const legacy = withEffect(fresh, old);
    expect(legacy).not.toContain('showPopover');
    const healed = healOverlayTopLayerInCode(legacy);
    expect(healed).toBe(withEffect(fresh, current()));
    // the useState still sits above its effect (the TDZ rule)
    expect(healed.indexOf(`const [${VAR},`)).toBeLessThan(healed.indexOf(`, [${VAR}]);`));
    expect(healOverlayTopLayerInCode(healed)).toBe(healed);
    expect(overlayViolations(healed)).toEqual([]);
    expect(validateGeneratedCode(healed)).toBeNull();
  });

  test('a Babel-reformatted master effect (the reported Header) is upgraded to the scoped form', () => {
    const healed = healOverlayTopLayerInCode(MASTER);
    expect(healed).toContain(buildRelativeOverlayPosEffect('overlay-MotionLink-mvfttp2t-1-3', true));
    expect(healed).not.toContain("addEventListener('scroll', position, true)");
    expect(healed.match(/useLayoutEffect\(/g)).toHaveLength(1);
    // everything around the effect is untouched
    expect(healed.slice(0, healed.indexOf('  useLayoutEffect('))).toBe(MASTER.slice(0, MASTER.indexOf('  useLayoutEffect(')));
    expect(healed.slice(healed.indexOf('  const ovRootRef'))).toBe(MASTER.slice(MASTER.indexOf('  const ovRootRef')));
    expect(validateGeneratedCode(healed)).toBeNull();
    expect(healOverlayTopLayerInCode(healed)).toBe(healed);
  });

  test('a hand-written effect that does not read the overlay config is left alone', () => {
    const fresh = createOverlayInCode(BASE, 'menu-btn', OV, cfg('relative'), trg);
    const hand = `  useLayoutEffect(() => {
    if (!${VAR}) return;
    const position = () => { const overlay = document.querySelector('[data-id="${OV}"]'); if (!overlay) return; const trigger = document.querySelector('[data-id="menu-btn"]'); const r = trigger.getBoundingClientRect(); overlay.style.top = (r.bottom + 8) + 'px'; overlay.style.left = r.left + 'px'; };
    position(); window.addEventListener('scroll', position, true);
    return () => window.removeEventListener('scroll', position, true);
  }, [${VAR}]);
`;
    const code = withEffect(fresh, hand);
    expect(healOverlayTopLayerInCode(code)).toBe(code);
  });

  test('code sharing the opener line is kept', () => {
    const fresh = createOverlayInCode(BASE, 'menu-btn', OV, cfg('relative'), trg);
    const legacy = withEffect(fresh, '  const keep = 1; ' + OLD_RELATIVE.trimStart());
    const healed = healOverlayTopLayerInCode(legacy);
    expect(healed).toContain('  const keep = 1; useLayoutEffect(() => {');
    expect(healed).toContain('showPopover()');
  });

  test('files without overlays are returned as-is', () => {
    expect(healOverlayTopLayerInCode(BASE)).toBe(BASE);
  });
});

const MASTER = `'use client';
import React, { useState, useRef, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

function KaFiBi({
  style,
  ...rest
}: {
  style?: React.CSSProperties;
  [key: string]: any;
}) {
  const [overlay_MotionLinkMvfttp2t_1_3Open, setOverlay_MotionLinkMvfttp2t_1_3Open] = useState(false);
  useLayoutEffect(() => {
    if (!overlay_MotionLinkMvfttp2t_1_3Open) return;
    const position = () => {
      const overlay = ovFind('overlay-MotionLink-mvfttp2t-1-3');
      if (!overlay) return;
      const raw = JSON.parse(overlay.getAttribute('data-overlay') || '{}');
      let cfg = raw;
      if (raw.responsive) {
        const ww = window.innerWidth;
        const bps = raw.responsiveBp;
        const owning = bps && bps.length ? bps.filter(b => ww <= b).sort((a, b) => a - b)[0] : Object.keys(raw.responsive).map(Number).filter(n => ww <= n).sort((a, b) => a - b)[0];
        if (owning !== undefined && raw.responsive[owning]) cfg = {
          ...raw,
          ...raw.responsive[owning]
        };
      }
      const trigger = ovFind(cfg.triggerId);
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const w = overlay.offsetWidth,
        h = overlay.offsetHeight;
      const g = 8,
        ox = cfg.offsetX || 0,
        oy = cfg.offsetY || 0;
      let top, left;
      switch (cfg.side || 'bottom') {
        case 'top':
          top = r.top - h - g + oy;
          break;
        case 'left':
          top = r.top + oy;
          left = r.left - w - g + ox;
          break;
        case 'right':
          top = r.top + oy;
          left = r.right + g + ox;
          break;
        default:
          top = r.bottom + g + oy;
      }
      if (left === undefined) {
        if (cfg.align === 'center') left = r.left + r.width / 2 - w / 2 + ox;else if (cfg.align === 'end') left = r.right - w + ox;else left = r.left + ox;
      } else if (cfg.align === 'center') top = r.top + r.height / 2 - h / 2 + oy;else if (cfg.align === 'end') top = r.bottom - h + oy;
      if (cfg.collision !== 'none') {
        const pad = cfg.collisionPadding ?? 20;
        left = Math.min(Math.max(left, pad), window.innerWidth - w - pad);
        top = Math.min(Math.max(top, pad), window.innerHeight - h - pad);
      }
      overlay.style.top = top + 'px';
      overlay.style.left = left + 'px';
    };
    const onOutside = e => {
      const ov = ovFind('overlay-MotionLink-mvfttp2t-1-3');
      if (ov && ov.contains(e.target)) return;
      const tid = ov ? JSON.parse(ov.getAttribute('data-overlay') || '{}').triggerId : null;
      const tr = tid ? ovFind(tid) : null;
      if (tr && tr.contains(e.target)) return;
      setOverlay_MotionLinkMvfttp2t_1_3Open(false);
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('mousedown', onOutside);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('mousedown', onOutside);
    };
  }, [overlay_MotionLinkMvfttp2t_1_3Open]);
  const ovRootRef = useRef(null);
  const ovGrace = useRef({});
  const ovFind = id => {
    const r = ovRootRef.current;
    if (!r) return document.querySelector('[data-id="' + id + '"]');
    if (r.getAttribute('data-mroot') === id || r.getAttribute('data-id') === id) return r;
    return r.querySelector('[data-id="' + id + '"]');
  };
  return <motion.div data-id="frame-ms3541bp-2" data-name="Header" ref={ovRootRef} {...rest} data-mroot="frame-ms3541bp-2" style={{ contain: 'layout paint', willChange: 'transform', overflow: 'hidden', position: 'absolute', width: '1440px' }}>
      <motion.div data-id="MotionLink-mvfttp2t-1" data-name="Blog" data-overlay-trigger='{"targetId":"overlay-MotionLink-mvfttp2t-1-3","trigger":"click","dismiss":"outside"}' onClick={() => setOverlay_MotionLinkMvfttp2t_1_3Open(!overlay_MotionLinkMvfttp2t_1_3Open)} style={{ position: 'relative' }}>Blog</motion.div>
      <AnimatePresence>{overlay_MotionLinkMvfttp2t_1_3Open && <motion.div key="overlay-MotionLink-mvfttp2t-1-3" data-id="overlay-MotionLink-mvfttp2t-1-3" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"MotionLink-mvfttp2t-1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} style={{ position: 'fixed', zIndex: '100', width: '377px', height: '200px' }}>
      </motion.div>}</AnimatePresence>
    </motion.div>;
}
export default KaFiBi;
`;
