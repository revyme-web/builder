// Verifies wiring a design-component INSTANCE's event prop to a "close overlay"
// handler (Increment D): an instance inside a fixed overlay gets
// `event1={() => setOverlayXOpen(false)}`, so the component's own X dismisses it.

import { describe, it, expect } from 'vitest';
import {
  setInstanceEventCloseHandlerInCode,
  removeInstanceEventHandlerInCode,
  parseInstanceEventBindings,
} from './instance-event-gen';

const INST = `export default function Page() {
  return <div data-id="root">
    <RoTaWe data-id="inst-1" data-name="Frame" style={{ position: 'absolute' }} />
  </div>;
}`;

describe('instance event → close overlay binding', () => {
  it('binds an event prop to `() => setOverlayXOpen(false)`', () => {
    const out = setInstanceEventCloseHandlerInCode(INST, 'inst-1', 'event1', 'setOverlayXOpen');
    expect(out).toMatch(/event1=\{\(\)\s*=>\s*setOverlayXOpen\(false\)\}/);
    const b = parseInstanceEventBindings(out, 'inst-1', ['event1']);
    expect(b[0].bound).toBe(true);
    expect(b[0].handler).toContain('setOverlayXOpen(false)');
    expect(b[0].delay).toBe(0);
  });

  it('replaces an existing handler instead of duplicating the attr', () => {
    const once = setInstanceEventCloseHandlerInCode(INST, 'inst-1', 'event1', 'setAOpen');
    const twice = setInstanceEventCloseHandlerInCode(once, 'inst-1', 'event1', 'setBOpen');
    expect((twice.match(/event1=/g) ?? []).length).toBe(1);
    expect(twice).toContain('setBOpen(false)');
    expect(twice).not.toContain('setAOpen');
  });

  it('unbind removes the event-prop attr', () => {
    const bound = setInstanceEventCloseHandlerInCode(INST, 'inst-1', 'event1', 'setOverlayXOpen');
    const out = removeInstanceEventHandlerInCode(bound, 'inst-1', 'event1');
    expect(out).not.toMatch(/event1=/);
    expect(parseInstanceEventBindings(out, 'inst-1', ['event1'])[0].bound).toBe(false);
    // the instance tag itself survives
    expect(out).toContain('data-id="inst-1"');
  });

  it('unknown instance id is a no-op', () => {
    expect(setInstanceEventCloseHandlerInCode(INST, 'nope', 'event1', 'setXOpen')).toBe(INST);
    expect(removeInstanceEventHandlerInCode(INST, 'nope', 'event1')).toBe(INST);
  });
});
