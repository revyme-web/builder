// scroll-fx-overlay-state-carveout.test.ts — X-ing the Appear on an overlay
// must never delete the overlay's own open state. An overlay's state is
// `<cn>Open` (overlay-gen `stateVarName`), and the scroll-fx clear swept every
// `<cn>[A-Z]` const, so it dropped `const [<cn>Open, set<Cn>Open] = useState`
// while the positioning effect, the trigger's onClick and the
// `{<cn>Open && …}` gate kept using it. Live repro (2026-10-21): "References
// undefined identifiers: overlay_MotionLinkMvfttp2t_1_3Open,
// setOverlay_MotionLinkMvfttp2t_1_3Open — would crash" blocked the removal.
import { describe, test, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import { setScrollFxInCode, getOpeningTag } from './generator-motion-scroll-fx';
import { removeMotionPropFromCode } from './generator-motion-props';
import { validateGeneratedCode } from '../mutation/mutation-queue';

const OV = 'overlay-MotionLink-mvfttp2t-1-3';

/** Trimmed from the reported component: a relative dropdown overlay with the
 *  baked-in Appear (`initial → animate` + `exit`) and an enter `transition`. */
const CODE = `'use client';
import React, { useState, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function KaFiBi() {
  const [overlay_MotionLinkMvfttp2t_1_3Open, setOverlay_MotionLinkMvfttp2t_1_3Open] = useState(false);
  useLayoutEffect(() => {
    if (!overlay_MotionLinkMvfttp2t_1_3Open) return;
    const onOutside = () => {
      setOverlay_MotionLinkMvfttp2t_1_3Open(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => {
      document.removeEventListener('mousedown', onOutside);
    };
  }, [overlay_MotionLinkMvfttp2t_1_3Open]);
  return <motion.div data-id="root">
      <motion.div data-id="MotionLink-mvfttp2t-1" data-overlay-trigger='{"targetId":"${OV}","trigger":"click","dismiss":"outside"}' onClick={() => setOverlay_MotionLinkMvfttp2t_1_3Open(!overlay_MotionLinkMvfttp2t_1_3Open)}>
        Blog
      </motion.div><AnimatePresence>{overlay_MotionLinkMvfttp2t_1_3Open && <motion.div key="${OV}" data-id="${OV}" data-name="Overlay" data-overlay='{"type":"relative","triggerId":"MotionLink-mvfttp2t-1","side":"bottom","align":"center","offsetX":0,"offsetY":10}' initial={{
                  opacity: 0,
                  y: 20
                }} animate={{
                  opacity: 1,
                  y: 0
                }} exit={{
                  opacity: 0,
                  y: 20
                }} style={{
                  position: 'fixed',
                  width: '377px'}}
          transition={{ type: 'instant' }}
          >
    </motion.div>}</AnimatePresence>
  </motion.div>;
}
`;

const STATE_DECL = 'const [overlay_MotionLinkMvfttp2t_1_3Open, setOverlay_MotionLinkMvfttp2t_1_3Open] = useState(false);';

describe('overlay open state survives Appear removal', () => {
  test('the scroll-fx clear keeps `<cn>Open` (in-view Appear form)', () => {
    const out = setScrollFxInCode(CODE, OV, null);
    expect(out).toContain(STATE_DECL);
    expect(out).toContain('}, [overlay_MotionLinkMvfttp2t_1_3Open]);');
    expect(validateGeneratedCode(out)).toBeNull();
  });

  test('the overlay Appear X strips initial/animate/exit/transition and nothing else', () => {
    let out = CODE;
    for (const p of ['initial', 'animate', 'exit', 'transition']) out = removeMotionPropFromCode(out, OV, p);
    const tag = getOpeningTag(out, OV)!.tag;
    expect(tag).not.toMatch(/\b(initial|animate|exit|transition)=/);
    expect(tag).toContain("position: 'fixed'");
    expect(tag).toContain('data-overlay=');
    expect(out).toContain(STATE_DECL);
    expect(out).toContain('{overlay_MotionLinkMvfttp2t_1_3Open && <motion.div');
    expect(validateGeneratedCode(out)).toBeNull();
  });
});
