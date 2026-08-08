// stable-atom-expedite.test.ts — the mirror's canvas budget must not become the
// panel's latency.
//
// `useStableAtomSync` defers mirroring code/nodes into the stable atoms by
// 450ms so the canvas iframe paints before the ~14-atom parser cascade. Right
// for a drag or an undo; wrong for a PANEL edit, because the properties panel
// reads the mirror — binding a CMS field parsed in 5ms and appeared ~466ms
// later (trace 2026-08-08). `expediteStableAtomSync()` marks the next mirror as
// panel-originated so it runs on the next tick instead.

import { describe, it, expect, beforeEach } from 'vitest';
import { expediteStableAtomSync, consumeExpedite } from './useStableAtomSync';

describe('expedite flag', () => {
  beforeEach(() => { consumeExpedite(); }); // clear any leak between tests

  it('is off by default — drags and undo keep the paint-first budget', () => {
    expect(consumeExpedite()).toBe(false);
  });

  it('arms for a panel-originated write', () => {
    expediteStableAtomSync();
    expect(consumeExpedite()).toBe(true);
  });

  it('is ONE-SHOT — one click cannot leave the mirror permanently eager', () => {
    expediteStableAtomSync();
    expect(consumeExpedite()).toBe(true);
    expect(consumeExpedite()).toBe(false);
  });

  it('repeated arming before a read still consumes exactly once', () => {
    expediteStableAtomSync();
    expediteStableAtomSync();
    expect(consumeExpedite()).toBe(true);
    expect(consumeExpedite()).toBe(false);
  });
});
