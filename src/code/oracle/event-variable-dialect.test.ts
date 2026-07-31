import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const COMP = (propMeta: string, params: string, childAttr: string) => `'use client';

/** @name "Card" */
${propMeta}

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'A', x: 0, y: 0, isPrimary: true }];

function Card({ ${params} }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup><MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div layout={true} data-id="card-root" data-name="Card" {...rest} style={{ position: 'absolute', width: '320px', height: '180px', backgroundColor: '#ffffff', overflow: 'hidden', ...style }} animate={variant}>
      <motion.div layout={true} data-id="card-btn" data-name="Button" ${childAttr} style={{ position: 'absolute', left: '20px', top: '20px', width: '120px', height: '40px', backgroundColor: '#3b82f6' }} animate={variant}></motion.div>
    </motion.div>
  </MotionConfig></LayoutGroup>;
}
export default withResponsiveProps(Card);`;

const ev = (code: string, kind: 'page' | 'component' = 'component') =>
  checkFile(code, { kind }).filter((x) => x.code.startsWith('EVENT_')).map((x) => x.code);

describe('event variable dialect', () => {
  const PM = `/** @propMeta {"event1":{"type":"event","label":"On Card Click"}} */`;

  it('a bare event prop fired by onClick={event1} passes clean', () => {
    expect(ev(COMP(PM, "style, initialVariant = 'default', event1, ...rest", 'onClick={event1}'))).toEqual([]);
  });

  it('onMouseEnter + setTimeout-delay forms pass', () => {
    expect(ev(COMP(PM, "style, initialVariant = 'default', event1, ...rest", 'onMouseEnter={event1}'))).toEqual([]);
    expect(ev(COMP(PM, "style, initialVariant = 'default', event1, ...rest", 'onClick={() => setTimeout(event1, 500)}'))).toEqual([]);
  });

  it('per-variant ternary fire passes', () => {
    expect(ev(COMP(PM, "style, initialVariant = 'default', event1, ...rest", "onClick={initialVariant === 'variant-2' ? undefined : event1}"))).toEqual([]);
  });

  it('event prop WITH a default bounces (EVENT_VAR_HAS_DEFAULT)', () => {
    const out = ev(COMP(PM, "style, initialVariant = 'default', event1 = '', ...rest", 'onClick={event1}'));
    expect(out).toContain('EVENT_VAR_HAS_DEFAULT');
  });

  it('calling the event at render bounces (EVENT_FIRE_CALLED_AT_RENDER)', () => {
    const out = ev(COMP(PM, "style, initialVariant = 'default', event1, ...rest", 'onClick={event1()}'));
    expect(out).toContain('EVENT_FIRE_CALLED_AT_RENDER');
  });

  it('overlay event trigger WITHOUT eventName bounces', () => {
    const PAGE = `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Card from '@/components/Card';

export default function Page() {
  const [overlayCard_1Open, setOverlayCard_1Open] = useState(false);
  useLayoutEffect(() => {
    if (!overlayCard_1Open) return;
    const position = () => { const overlay = document.querySelector('[data-id="overlay-card-1"]'); if (!overlay) return; const cfg = JSON.parse(overlay.getAttribute('data-overlay') || '{}'); const trigger = document.querySelector('[data-id="' + cfg.triggerId + '"]'); if (!trigger) return; const r = trigger.getBoundingClientRect(); overlay.style.top = (r.bottom + 8) + 'px'; overlay.style.left = r.left + 'px'; };
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [overlayCard_1Open]);
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '900px' }}>
  <Card data-id="card-inst" data-name="Card" data-overlay-trigger='{"targetId":"overlay-card-1","trigger":"event","dismiss":"outside"}' event1={() => setOverlayCard_1Open(true)} style={{ position: 'relative' }} />
  <AnimatePresence>{overlayCard_1Open && (
    <motion.div key="overlay-card-1" data-id="overlay-card-1" data-overlay='{"type":"relative","triggerId":"card-inst","side":"bottom","align":"start","offsetX":0,"offsetY":8}' initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} style={{ position: 'fixed', zIndex: '50', width: '200px', height: '100px', backgroundColor: '#ffffff' }}>
  </motion.div>
  )}</AnimatePresence>
</div>
  );
}`;
    const out = checkFile(PAGE, { kind: 'page' }).filter((x) => x.code === 'OVERLAY_CONFIG_INVALID');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].message).toContain('eventName');
  });
});
