import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  parseCloseOverlayForNode,
  addCloseOverlayInCode,
  removeCloseOverlayInCode,
  setCloseOverlayDelayInCode,
  overlayCloseSetter,
} from './close-overlay-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const OVERLAY_ID = 'overlay-menu-1';
const SETTER = overlayCloseSetter(OVERLAY_ID);

const PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function P() {
  return (
    <div data-id="root">
      <motion.div data-id="${OVERLAY_ID}" data-overlay='{"type":"fixed","triggerId":"btn","side":"bottom","align":"center","offsetX":0,"offsetY":0}'>
        <button data-id="closer" type="button">X</button>
      </motion.div>
    </div>
  );
}`;

describe('close-overlay-gen', () => {
  it('overlayCloseSetter derives a setX...Open name', () => {
    expect(SETTER).toMatch(/^setOverlay/);
    expect(SETTER.endsWith('Open')).toBe(true);
  });

  it('add → parse round-trips a click close interaction', () => {
    const out = addCloseOverlayInCode(PAGE, 'closer', 'click', OVERLAY_ID);
    expect(out).toContain(`${SETTER}(false)`);
    parses(out);
    const parsed = parseCloseOverlayForNode(out, 'closer');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ trigger: 'click', overlayId: OVERLAY_ID, delay: 0 });
  });

  it('parse returns nothing for a node with no close handler', () => {
    expect(parseCloseOverlayForNode(PAGE, 'closer')).toHaveLength(0);
  });

  it('setDelay wraps the close in setTimeout and parse reads the delay', () => {
    const added = addCloseOverlayInCode(PAGE, 'closer', 'click', OVERLAY_ID);
    const delayed = setCloseOverlayDelayInCode(added, 'closer', 'click', OVERLAY_ID, 1.5);
    expect(delayed).toContain('setTimeout');
    expect(delayed).toContain('1500');
    parses(delayed);
    const parsed = parseCloseOverlayForNode(delayed, 'closer');
    expect(parsed[0]).toMatchObject({ overlayId: OVERLAY_ID, delay: 1.5 });
  });

  it('setDelay(0) unwraps setTimeout back to a direct close', () => {
    const added = addCloseOverlayInCode(PAGE, 'closer', 'click', OVERLAY_ID);
    const delayed = setCloseOverlayDelayInCode(added, 'closer', 'click', OVERLAY_ID, 2);
    const undelayed = setCloseOverlayDelayInCode(delayed, 'closer', 'click', OVERLAY_ID, 0);
    expect(undelayed).not.toContain('setTimeout');
    expect(parseCloseOverlayForNode(undelayed, 'closer')[0]).toMatchObject({ delay: 0 });
    parses(undelayed);
  });

  it('remove strips the close handler (even when delayed)', () => {
    const added = addCloseOverlayInCode(PAGE, 'closer', 'click', OVERLAY_ID);
    const delayed = setCloseOverlayDelayInCode(added, 'closer', 'click', OVERLAY_ID, 1);
    const removed = removeCloseOverlayInCode(delayed, 'closer', 'click', OVERLAY_ID);
    expect(removed).not.toContain(SETTER);
    expect(parseCloseOverlayForNode(removed, 'closer')).toHaveLength(0);
    parses(removed);
  });

  it('detects a close wired with mouseEnter too', () => {
    const out = addCloseOverlayInCode(PAGE, 'closer', 'mouseEnter', OVERLAY_ID);
    const parsed = parseCloseOverlayForNode(out, 'closer');
    expect(parsed[0]).toMatchObject({ trigger: 'mouseEnter', overlayId: OVERLAY_ID });
  });
});
