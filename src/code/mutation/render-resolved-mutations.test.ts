// render-resolved-mutations.test.ts — Pins the ONE list that decides whether a
// flush is allowed to arm the canvas-update render skip.
//
// Background (live find 2026-07-25, "Reset Override works one time out of two"):
// a reset writes the removal into code, but the value it REVEALS lives either in
// a render-baked stylesheet rule (`@media`/`@container`, `:lang()`, `::after`,
// `:hover`) or in the `{...base, ...default, ...variant}` merge
// `resolveVariantStyles` computes. The imperative patch can only CLEAR the
// element's inline value, which re-exposes the stale baked rule (page replica)
// or drops the property entirely instead of falling back to the base (component
// variant). So the flush MUST NOT skip the render.
//
// The predicate used to be an inline two-type check (`updateContainerStyle` /
// `clearContainerStyles`), leaving every variant / locale / pseudo / hover /
// conditional reset uncovered — those only looked correct when some unrelated
// later render happened to fire, which is exactly the intermittency reported.

import { describe, expect, it, vi } from 'vitest';
import {
  RENDER_RESOLVED_MUTATIONS, flushNeedsRender,
  IMPERATIVELY_PATCHED_MUTATIONS, flushIsFullyImperative,
  decideFlushRenderGate,
} from './render-resolved-mutations';

describe('RENDER_RESOLVED_MUTATIONS — stylesheet-backed storage', () => {
  it.each([
    'updateContainerStyle',   // @media / @container replica rules
    'clearContainerStyles',   // wipe all responsive overrides for a node
    'updateLocaleStyle',      // :lang() rules
    'updatePseudoStyle',      // ::before / ::after rules
    'removePseudo',
    'updateCssHover',         // :hover rules
    'removeCssHover',
  ])('%s needs a render (its value lives in regenerated CSS, not inline)', (type) => {
    expect(RENDER_RESOLVED_MUTATIONS.has(type)).toBe(true);
  });
});

describe('RENDER_RESOLVED_MUTATIONS — variant-merge storage', () => {
  // These were the REGRESSION: previously excluded on the theory that "variant
  // styles resolve into each tile's inline styles at render, so the instant
  // patch already shows a removal". True for a SET, false for a REMOVAL —
  // clearing the inline drops the property instead of falling back to the base.
  it.each([
    'updateVariantStyle',
    'setConditionalStyle',
    'setConditionalOrder',
    'setVariantVisibility',
    'setVariantCmsStyle',
    'setVariantAttr',
    'setVariantInlineVariable',
    'setVariantBorderVariable',
    'removeVariantStyleVariable',
    'bindResponsiveStyleVariable',
    'unbindResponsiveStyleVariable',
    'setResponsiveStyleBase',
  ])('%s needs a render (its value is the resolveVariantStyles merge)', (type) => {
    expect(RENDER_RESOLVED_MUTATIONS.has(type)).toBe(true);
  });
});

describe('RENDER_RESOLVED_MUTATIONS — inline/structural stay OUT', () => {
  // Inline writes ARE fully represented by the imperative patch, and structural
  // mutations have their own `structuralPending` path. Adding them here would
  // force a full render on every drag commit — the hot path the canvas-update
  // skip exists to protect.
  it.each(['updateStyles', 'updateHtmlAttrs', 'move', 'reorder', 'addNode', 'removeNode', 'addCanvasNode'])(
    '%s does NOT force a render',
    (type) => { expect(RENDER_RESOLVED_MUTATIONS.has(type)).toBe(false); },
  );
});

describe('flushNeedsRender', () => {
  it('is false for an inline-only flush (the 60fps drag-commit path)', () => {
    expect(flushNeedsRender(['updateStyles', 'updateStyles'])).toBe(false);
  });

  it('is true when ANY mutation in the batch is render-resolved', () => {
    // The real shape of a replica style commit: the inline write for the
    // primary mirror plus the @media rule for the tile. One render-resolved
    // member is enough — the batch lands as one code change, one render.
    expect(flushNeedsRender(['updateStyles', 'updateContainerStyle'])).toBe(true);
  });

  it('is true for a component-variant reset batch', () => {
    expect(flushNeedsRender(['updateVariantStyle'])).toBe(true);
  });

  it('is false for an empty flush', () => {
    expect(flushNeedsRender([])).toBe(false);
  });
});

describe('RENDER_RESOLVED_MUTATIONS — CMS field bindings', () => {
  // `{item.title}` is painted by `applyNodeCmsBindings` at render time, per row,
  // from the collection data. There is no inline patch that can express it, so
  // binding / unbinding / re-pointing a field is INVISIBLE until a render runs:
  // pressing × on the Content pill rewrote the JSX correctly but every row in
  // the list kept painting the old value until a page switch (2026-07-25).
  it.each([
    'bindField',
    'unbindField',
    'bindStyleToMap',
    'bindPropToMap',
    'unbindPropFromMap',
    'setVariantCmsText',
    'setVariantCmsStyle',
    'clearCmsOrphan',
    'setCmsNavHref',
    'changeCollectionSource',
    'bindToCmsCollection',
    'unbindFromCmsCollection',
  ])('%s needs a render (the value is resolved per row at render time)', (type) => {
    expect(RENDER_RESOLVED_MUTATIONS.has(type)).toBe(true);
    expect(flushNeedsRender([type])).toBe(true);
  });

  it('still lets an ordinary style flush skip the render', () => {
    expect(flushNeedsRender(['updateStyle', 'move'])).toBe(false);
  });

  it('one binding mutation in a mixed flush is enough', () => {
    expect(flushNeedsRender(['updateStyle', 'unbindField'])).toBe(true);
  });
});

// ─── The inverted render-skip gate ──────────────────────────────────────────
//
// The skip used to be the DEFAULT — any flush not on the render-resolved
// allow-list suppressed its render — so every mutation type nobody remembered
// to add landed in the code but never on the canvas until a page switch. That
// produced a steady drip of "the code updated but the canvas didn't" reports
// (CMS bindings, slot connect/disconnect, layers DnD, …), each fixed one call
// site at a time. `onBeforeFlush` now asks the inverted question: skip ONLY
// when the whole flush was already applied to the DOM imperatively.

describe('flushIsFullyImperative — what may skip its render', () => {
  it('skips a pure style flush (node-ops patched the DOM before queueing)', () => {
    expect(flushIsFullyImperative(['updateStyles'])).toBe(true);
    expect(flushIsFullyImperative(['updateStyles', 'updateStyles'])).toBe(true);
  });

  it('does NOT skip an empty flush', () => {
    expect(flushIsFullyImperative([])).toBe(false);
  });

  it('does NOT skip when ANY mutation in the flush is non-imperative', () => {
    expect(flushIsFullyImperative(['updateStyles', 'move'])).toBe(false);
    expect(flushIsFullyImperative(['updateStyles', 'disconnectSlot'])).toBe(false);
  });

  // The whole point of the inversion: a type nobody thought about renders.
  it.each([
    'disconnectSlot',      // removing a slot connection — the report that forced this
    'connectSlot',
    'reorderSlot',
    'unbindField',         // CMS content unbind
    'move',
    'reorder',
    'addNode',
    'removeNode',
    'updateNodeText',
    'changeTag',
    'someFutureMutationNobodyHasWrittenYet',
  ])('%s renders by default (not on the imperative list)', (type) => {
    expect(flushIsFullyImperative([type])).toBe(false);
  });

  it('keeps the imperative list small and closed', () => {
    // Growing this set silently re-opens the invisible-edit class of bug —
    // only add a type whose DOM result is ALREADY applied before it flushes.
    expect([...IMPERATIVELY_PATCHED_MUTATIONS]).toEqual(['updateStyles']);
  });

  it('never lets a render-resolved mutation be treated as imperative', () => {
    for (const type of RENDER_RESOLVED_MUTATIONS) {
      expect(flushIsFullyImperative([type])).toBe(false);
      expect(flushNeedsRender([type])).toBe(true);
    }
  });
});

// ─── decideFlushRenderGate ──────────────────────────────────────────────────
//
// Arming isn't the only way the skip flag gets set: `node-ops.updateNodeStyles`
// marks it directly whenever it patches the DOM. So a flush carrying something
// the patch CAN'T express must DISARM, or a style write moments earlier eats its
// render. Live case: applying a background video queues `setVideoFill` AND an
// `updateStyles` that clears the competing fills — the style write armed the
// skip, the render carrying the new `<video>` child was dropped with
// `CanvasRenderer:skip-canvasUpdating`, and it only appeared after a page switch
// (user trace 2026-07-26).

describe('decideFlushRenderGate', () => {
  const base = {
    isTextEditing: false,
    isStructuralPending: false,
    consumeForceRender: () => false,
  };

  it('arms the skip for a pure imperative flush', () => {
    expect(decideFlushRenderGate({ ...base, mutationTypes: ['updateStyles'] })).toBe('arm-skip');
  });

  it('DISARMS for the background-video flush (the reported case)', () => {
    expect(decideFlushRenderGate({ ...base, mutationTypes: ['setVideoFill', 'updateStyles'] }))
      .toBe('disarm-skip');
    expect(decideFlushRenderGate({ ...base, mutationTypes: ['removeVideoFill', 'updateStyles'] }))
      .toBe('disarm-skip');
  });

  it('DISARMS for any non-imperative flush', () => {
    for (const t of ['move', 'addNode', 'unbindField', 'disconnectSlot', 'updateNodeText']) {
      expect(decideFlushRenderGate({ ...base, mutationTypes: [t] })).toBe('disarm-skip');
    }
  });

  it('disarms an EMPTY flush rather than arming it', () => {
    expect(decideFlushRenderGate({ ...base, mutationTypes: [] })).toBe('disarm-skip');
  });

  it('leaves the decision alone while text editing', () => {
    expect(decideFlushRenderGate({ ...base, isTextEditing: true, mutationTypes: ['updateStyles'] }))
      .toBe('leave');
  });

  it('leaves the decision alone while a structural change is pending', () => {
    expect(decideFlushRenderGate({ ...base, isStructuralPending: true, mutationTypes: ['updateStyles'] }))
      .toBe('leave');
  });

  it('leaves the decision alone when a force-render was armed', () => {
    expect(decideFlushRenderGate({
      ...base, mutationTypes: ['updateStyles'], consumeForceRender: () => true,
    })).toBe('leave');
  });

  // The one-shot force-render flag must SURVIVE to the next flush when a
  // higher-priority state short-circuits ahead of it — that ordering is
  // behaviour, not an accident.
  it('does NOT consume the force-render flag while text editing', () => {
    const consumeForceRender = vi.fn(() => true);
    decideFlushRenderGate({ ...base, isTextEditing: true, mutationTypes: ['updateStyles'], consumeForceRender });
    expect(consumeForceRender).not.toHaveBeenCalled();
  });

  it('does NOT consume it while a structural change is pending', () => {
    const consumeForceRender = vi.fn(() => true);
    decideFlushRenderGate({ ...base, isStructuralPending: true, mutationTypes: ['updateStyles'], consumeForceRender });
    expect(consumeForceRender).not.toHaveBeenCalled();
  });

  // A non-imperative flush renders anyway, so consuming the flag here is
  // harmless — but it MUST still end up disarmed, never armed.
  it('a force-render + non-imperative flush still disarms', () => {
    expect(decideFlushRenderGate({
      ...base, mutationTypes: ['setVideoFill'], consumeForceRender: () => true,
    })).toBe('disarm-skip');
  });
});
