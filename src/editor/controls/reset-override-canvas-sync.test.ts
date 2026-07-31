// reset-override-canvas-sync.test.ts — "Reset Override ALWAYS updates the DOM".
//
// The bug (live find 2026-07-25): resetting an override wrote the removal into
// code correctly, but the canvas only caught up roughly every other time. The
// value a reset REVEALS is never in the element's inline style — it's in a
// render-baked stylesheet rule (`@media`, `:lang()`, `::after`, `:hover`) or in
// the `resolveVariantStyles` merge. The imperative patch can only CLEAR the
// inline, so whether the DOM matched the code depended on some unrelated later
// render happening to fire.
//
// The fix funnels every reset affordance through
// `forceRenderAfterExternalEdit`. These tests pin the funnel at the MENU path
// (`getOverrideMenuItems`), which is what every non-plain control in the editor
// builds its Reset Override entry from — including the ~15 tools that supply a
// bespoke `onResetOverride` handler (SvgShapeTool, OverlayTool,
// ComponentPropsTool, CollectionListTool, SketchTool, …).

import { describe, expect, it, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above the imports, so the spy has to be created with
// `vi.hoisted`. PARTIAL mock (importOriginal spread): `@/canvas/node-ops` is a
// hub — mutation-queue imports `clearCanvasStyles` from it — so replacing the
// whole module breaks the graph. Only the render-forcing call is stubbed.
const { forceRenderAfterExternalEdit } = vi.hoisted(() => ({
  forceRenderAfterExternalEdit: vi.fn(),
}));
vi.mock('@/canvas/node-ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/canvas/node-ops')>()),
  forceRenderAfterExternalEdit,
}));

import { getOverrideMenuItems, type MenuContext } from './control-menu-items';

function makeCtx(over: Partial<MenuContext> = {}): MenuContext {
  return {
    property: 'opacity',
    nodeId: 'node-1',
    value: '0.5',
    hasVariable: false,
    variableRef: null,
    // A reset entry only exists on a non-primary tile that HAS an override.
    hasOverride: true,
    isComponentFile: false,
    isPrimary: false,
    isDefaultLocale: true,
    activeLocale: 'en',
    hasLocaleOverride: false,
    createVariable: () => {},
    removeVariable: () => {},
    updateStyle: vi.fn(),
    updateStyles: vi.fn(),
    ...over,
  };
}

function clickReset(ctx: MenuContext): void {
  const item = getOverrideMenuItems(ctx).find((i) => i.label === 'Reset Override');
  expect(item, 'Reset Override entry must exist for an overridden non-primary tile').toBeDefined();
  item!.onClick();
}

beforeEach(() => { forceRenderAfterExternalEdit.mockClear(); });

describe('Reset Override → canvas sync', () => {
  it('forces a render on the GENERIC path (updateStyle clear)', () => {
    const ctx = makeCtx();
    clickReset(ctx);
    expect(ctx.updateStyle).toHaveBeenCalledWith('opacity', '');
    expect(forceRenderAfterExternalEdit).toHaveBeenCalledTimes(1);
  });

  it('forces a render on the SHORTHAND-alias path (batched longhand clear)', () => {
    // padding on a replica can live purely in the longhands, so the reset
    // clears every alias key in one batch. Same canvas-sync obligation.
    const ctx = makeCtx({ property: 'padding' });
    clickReset(ctx);
    expect(ctx.updateStyles).toHaveBeenCalled();
    expect(forceRenderAfterExternalEdit).toHaveBeenCalledTimes(1);
  });

  it('forces a render for a tool-supplied CUSTOM onResetOverride handler', () => {
    // This is the half that used to be uncovered: a tool that queues its own
    // mutations never touched updateNodeStyles, so nothing forced the render.
    const onResetOverride = vi.fn();
    const ctx = makeCtx({ onResetOverride });
    clickReset(ctx);
    expect(onResetOverride).toHaveBeenCalledTimes(1);
    // Generic clear must NOT also run — the custom handler owns the write.
    expect(ctx.updateStyle).not.toHaveBeenCalled();
    expect(forceRenderAfterExternalEdit).toHaveBeenCalledTimes(1);
    expect(forceRenderAfterExternalEdit).toHaveBeenCalledWith(
      'control-menu:reset-override',
      expect.objectContaining({ property: 'opacity', custom: true }),
    );
  });

  it('forces the render AFTER the reset write (so the flush sees the removal)', () => {
    const order: string[] = [];
    const ctx = makeCtx({ onResetOverride: () => { order.push('reset'); } });
    forceRenderAfterExternalEdit.mockImplementation(() => { order.push('render'); });
    clickReset(ctx);
    expect(order).toEqual(['reset', 'render']);
  });

  it('still clears the locale band, and forces the render once for the pair', () => {
    // A replica :lang() band rule is an override too — one Reset Override
    // returns the artboard fully to the primary state. Both writes land, then
    // ONE render covers them.
    const resetLocaleOverride = vi.fn();
    const ctx = makeCtx({ resetLocaleOverride });
    clickReset(ctx);
    expect(resetLocaleOverride).toHaveBeenCalledWith('opacity');
    expect(forceRenderAfterExternalEdit).toHaveBeenCalledTimes(1);
  });

  it('does not fire when there is no Reset Override entry (primary tile)', () => {
    const items = getOverrideMenuItems(makeCtx({ isPrimary: true }));
    expect(items.find((i) => i.label === 'Reset Override')).toBeUndefined();
    expect(forceRenderAfterExternalEdit).not.toHaveBeenCalled();
  });
});
