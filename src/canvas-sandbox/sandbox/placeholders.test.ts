// placeholders.test.ts — reparentLive's mid-drag contracts. Since central
// drag locks made the Renderer skip the dragged node entirely, the imperative
// re-home IS the only thing that moves the element's DOM parent during a
// canvas↔frame transition — these tests pin the exit normalization and the
// absolute-entry (index -1) behavior that the drag strategies rely on.

import { describe, it, expect, beforeEach } from 'vitest';
import { reparentLive } from './placeholders';
import { setContentRoot } from './sandbox-state';

const node = (dni: string, dataId?: string): HTMLElement => {
  const el = document.createElement('div');
  el.setAttribute('data-node-id', dni);
  el.setAttribute('data-id', dataId ?? dni);
  return el;
};

let root: HTMLElement;
let frame: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  setContentRoot(root);
  frame = node('frame-1');
  root.appendChild(frame);
});

describe('reparentLive — exit to canvas root (mid-drag unparent)', () => {
  it('lifts the element to the content root and applies the exit styles', () => {
    const el = node('x');
    frame.appendChild(el);
    reparentLive('x', '', null, 0, { position: 'absolute', left: '1219px', top: '1404px' });
    expect(el.parentElement).toBe(root);
    expect(el.style.left).toBe('1219px');
    expect(el.style.top).toBe('1404px');
  });

  it('removes replica copies (same data-id) so their siblings reflow', () => {
    const el = node('x');
    frame.appendChild(el);
    const tabletFrame = node('tablet-frame-1', 'frame-1');
    root.appendChild(tabletFrame);
    const tabletCopy = node('tablet-x', 'x');
    tabletFrame.appendChild(tabletCopy);
    reparentLive('x', '', null, 0, {});
    expect(el.parentElement).toBe(root);
    expect(tabletCopy.isConnected).toBe(false);
  });

  it('normalizes a replica-prefixed subtree to canonical ids (replica-frame exit)', () => {
    // Exit FROM the tablet copy: the lifted element must become the canonical
    // canvas-root element, or per-frame patchStyles('', id) lookups and the
    // Renderer's patchCanvasNodes reconciliation miss it and a drag-locked
    // duplicate gets built at the root mid-drag.
    const tabletFrame = node('tablet-frame-1', 'frame-1');
    root.appendChild(tabletFrame);
    const el = node('tablet-x', 'x');
    const child = node('tablet-c', 'c');
    el.appendChild(child);
    tabletFrame.appendChild(el);
    reparentLive('x', 'tablet-', null, 0, { left: '5px' });
    expect(el.parentElement).toBe(root);
    expect(el.getAttribute('data-node-id')).toBe('x');
    expect(child.getAttribute('data-node-id')).toBe('c');
    expect(el.getAttribute('data-id')).toBe('x'); // data-id untouched
    expect(el.style.left).toBe('5px');
  });
});

describe('reparentLive — absolute entry (index -1, canvas node → frame)', () => {
  it('appends into the parent without renumbering sibling CSS order, and fans a replica clone', () => {
    const sibling = node('s');
    sibling.style.order = '3'; // code-driven order must survive
    frame.appendChild(sibling);
    const tabletFrame = node('tablet-frame-1', 'frame-1');
    root.appendChild(tabletFrame);
    const el = node('x');
    root.appendChild(el); // canvas node at the content root
    reparentLive('x', '', 'frame-1', -1, { position: 'absolute', left: '79px', top: '159px' });
    expect(el.parentElement).toBe(frame);
    expect(el.style.left).toBe('79px');
    expect(sibling.style.order).toBe('3'); // NOT renumbered
    // Replica fan-out: a prefixed clone appears in the tablet copy instantly.
    const clone = tabletFrame.querySelector('[data-node-id="tablet-x"]') as HTMLElement;
    expect(clone).not.toBeNull();
    expect(clone.getAttribute('data-id')).toBe('x');
  });

  // The clone alone is NOT enough: the host's per-frame drag fan-out
  // (`updateNodeStyles`, node-ops) only patches a viewport whose
  // `${prefix}:${nodeId}` key is in the rectCache — that cache IS its list of
  // "which viewports render this node". Mid-drag the mutation queue is held, so
  // no render (and therefore no `allRects`) runs until mouseup: without an
  // explicit per-replica emit here the tablet copy appeared at entry and then
  // sat frozen for the whole gesture while the primary followed the cursor.
  it('emits a rectUpdate for each replica clone under its OWN prefix', () => {
    const orig = window.parent.postMessage.bind(window.parent);
    const events: unknown[] = [];
    (window.parent as { postMessage: unknown }).postMessage = ((msg: unknown) => { events.push(msg); }) as never;
    try {
      const tabletFrame = node('tablet-frame-1', 'frame-1');
      const mobileFrame = node('mobile-frame-1', 'frame-1');
      root.append(tabletFrame, mobileFrame);
      const el = node('x');
      root.appendChild(el);

      reparentLive('x', '', 'frame-1', -1, { position: 'absolute', left: '79px', top: '159px' });

      const rects = events
        .map((e) => (e as { payload?: { type?: string; nodeId?: string; vpPrefix?: string } })?.payload)
        .filter((p): p is { type: string; nodeId: string; vpPrefix: string } =>
          p?.type === 'rectUpdate' && p.nodeId === 'x');
      const prefixes = rects.map((r) => r.vpPrefix).sort();
      expect(prefixes).toEqual(['', 'mobile-', 'tablet-']);
    } finally {
      (window.parent as { postMessage: unknown }).postMessage = orig as never;
    }
  });
});

// ─── removeElement re-emits the reflowed siblings' scope ────────────────────
// Deleting a node reflows its siblings into the gap; without a scope re-emit
// the host's rect caches freeze at the pre-delete layout ("can't select right
// after delete" — live find 2026-07-21).
import { removeElement } from './placeholders';

describe('removeElement — sibling scope refresh', () => {
  it('removes every copy and emits rect updates for each parent scope', () => {
    const events: unknown[] = [];
    const orig = window.parent.postMessage.bind(window.parent);
    const spy = (msg: unknown) => { events.push(msg); };
    // sandbox emit posts to parent — intercept
    (window.parent as { postMessage: unknown }).postMessage = spy as never;
    try {
      const parentA = node('frame-a');
      const parentB = node('tablet-frame-a', 'frame-a-x');
      parentB.setAttribute('data-id', 'frame-a');
      root.appendChild(parentA);
      root.appendChild(parentB);
      const childA = node('victim'); const sibA = node('sib-a');
      const childB = node('tablet-victim', 'victim'); const sibB = node('tablet-sib-a', 'sib-a');
      parentA.append(childA, sibA);
      parentB.append(childB, sibB);

      removeElement('victim');

      expect(parentA.querySelector('[data-id="victim"]')).toBeNull();
      expect(parentB.querySelector('[data-id="victim"]')).toBeNull();
      // scope refresh emitted rect updates that cover the surviving siblings
      const raw = JSON.stringify(events);
      expect(raw).toContain('rectUpdate');
      expect(raw).toContain('sib-a');
    } finally {
      (window.parent as { postMessage: unknown }).postMessage = orig as never;
    }
  });
});

// ─── liftNode/restoreNode — pre-lift inline snapshot ────────────────────────
// The strategies' restore styles come from the parsed MODEL; a prop the
// renderer resolved from CONDITIONAL styles (a component root's
// `height: variant === 'x' ? … : '418px'`) has no model entry, so the
// model-based restore cleared it and the instance stayed collapsed after
// every layout drag until a page switch (user report 2026-07-27). The lift
// snapshots the DOM's own inline values for every touched prop; the restore
// replays them over the model styles.
describe('liftNode/restoreNode — pre-lift inline snapshot', () => {
  it('restores a conditionally-resolved inline height the model does not know', async () => {
    const { liftNode, restoreNode } = await import('./placeholders');
    const el = node('inst-1');
    // The renderer applies MODEL styles inline (patchElement) + the RESOLVED
    // conditional height — this is the pre-lift DOM truth:
    el.style.height = '418px';
    el.style.position = 'relative';
    el.style.flex = '1 0 0px';
    frame.appendChild(el);

    liftNode('inst-1', '', {
      position: 'absolute', left: '10px', top: '20px',
      width: '900px', height: '418px', zIndex: '9999',
      pointerEvents: 'none', flex: '',
    });
    expect(el.style.position).toBe('absolute');
    expect(el.parentElement).toBe(root); // reparented to contentRoot

    // The MODEL-based restore clears height ('' = the model has no height —
    // it lives in conditionalStyles). The snapshot must win.
    restoreNode('inst-1', 'frame-1', '', 0, {
      position: 'relative', left: '0px', top: '0px',
      width: '', height: '', zIndex: '', pointerEvents: '', flex: '1 0 0px',
    });
    expect(el.parentElement).toBe(frame);
    expect(el.style.height).toBe('418px');       // ← the fix
    expect(el.style.position).toBe('relative');
    expect(el.style.zIndex).toBe('');
    // Lift-touched flex restores to its pre-lift inline value.
    expect(el.style.flex).toBe('1 0 0px');
    // Snapshot consumed — a later restore can't replay stale values.
    expect(el.hasAttribute('data-lift-inline-snapshot')).toBe(false);
  });

  it('props with NO pre-lift inline value restore to empty (model fallback intact)', async () => {
    const { liftNode, restoreNode } = await import('./placeholders');
    const el = node('plain-1');
    frame.appendChild(el);
    liftNode('plain-1', '', { position: 'absolute', width: '100px', height: '50px' });
    restoreNode('plain-1', 'frame-1', '', 0, { position: 'relative', width: '', height: '' });
    expect(el.style.height).toBe('');        // was never inline pre-lift
    // Snapshot wins for touched props: pre-lift the element had NO inline
    // position, so it returns to stylesheet/patch-driven positioning —
    // exactly its pre-lift state, not the model's guess.
    expect(el.style.position).toBe('');
  });
});

// ─── liftNode/restoreNode — pre-lift TRACKING state ─────────────────────────
// Second layer of the lesson-42 bug: the restore's applyTwoPass TRACKS every
// key it writes, and tracked keys are reconciled by the next render's
// stale-clear against the node's resolved styles. An instance wrapper's
// variant-sized width/height are BUILD-ONLY inline props with no model entry —
// restore them tracked, and whatever render comes next (an unrelated grid
// drag's commit, an undo, anything) stale-clears them and the instance
// collapses (user report 2026-07-27, "grid drag above collapses the instance
// below"). The restore must return the TRACKING state to pre-lift truth, not
// just the inline values.
describe('liftNode/restoreNode — pre-lift tracking state', () => {
  it('untracks lift-touched keys that were NOT tracked pre-lift (build-only inline props survive the next stale-clear)', async () => {
    const { liftNode, restoreNode } = await import('./placeholders');
    const { getTrackedStyleKeys } = await import('@/canvas/Renderer');
    const el = node('inst-2');
    // Build-only inline size (renderNodes' instance-wrapper sizing) — inline
    // in the DOM but in NO render's key set and NOT tracked:
    el.style.height = '418px';
    el.style.width = '921px';
    frame.appendChild(el);

    liftNode('inst-2', '', {
      position: 'absolute', left: '10px', top: '20px',
      width: '921px', height: '418px', zIndex: '9999', pointerEvents: 'none',
    });
    restoreNode('inst-2', 'frame-1', '', 0, {
      position: '', left: '', top: '',
      width: '', height: '', zIndex: '', pointerEvents: '',
      order: '2', // caller-only key the lift never touched — commit intent
    });

    // Inline values restored (lesson-42 layer 1)…
    expect(el.style.height).toBe('418px');
    expect(el.style.width).toBe('921px');
    // …and the tracking state matches pre-lift (layer 2): the next render's
    // stale-clear must NOT see height/width as reconcilable keys.
    const tracked = getTrackedStyleKeys(el);
    expect(tracked?.has('height') ?? false).toBe(false);
    expect(tracked?.has('width') ?? false).toBe(false);
    expect(tracked?.has('position') ?? false).toBe(false);
    // Caller-only keys ARE model-bound commit intent — they stay tracked so
    // the stale-clear can reconcile them when the model drops them.
    expect(tracked?.has('order')).toBe(true);
    // Both snapshot attributes consumed.
    expect(el.hasAttribute('data-lift-inline-snapshot')).toBe(false);
    expect(el.hasAttribute('data-lift-tracked-keys')).toBe(false);
  });

  it('keys tracked BEFORE the lift stay tracked after restore (pending reconciliation preserved)', async () => {
    const { liftNode, restoreNode } = await import('./placeholders');
    const { getTrackedStyleKeys, trackImperativeStyleKeys } = await import('@/canvas/Renderer');
    const el = node('inst-3');
    el.style.padding = '12px';
    frame.appendChild(el);
    // A prior imperative commit (bridge patchStyles) tracked padding and no
    // render has reconciled it yet — the ⌘Z-after-padding guarantee.
    trackImperativeStyleKeys(el, ['padding']);

    liftNode('inst-3', '', { position: 'absolute', padding: '0px' });
    restoreNode('inst-3', 'frame-1', '', 0, { position: '', padding: '' });

    expect(el.style.padding).toBe('12px');   // pre-lift inline value restored
    // Pre-lift it WAS tracked → must remain tracked (untracking it would
    // reopen the ⌘Z hole: model drops padding, nothing clears the inline).
    expect(getTrackedStyleKeys(el)?.has('padding')).toBe(true);
    // The lift-added position was NOT tracked pre-lift → untracked again.
    expect(getTrackedStyleKeys(el)?.has('position') ?? false).toBe(false);
  });
});

// ─── commitMergedOrder — atomic templated-root drop endgame (2026-07-28) ─────
// One sandbox task: placeholders out, dragged restored, PARTICIPANT sections
// arranged into their new sequence using their own DOM slots, rank stamps
// cleared, chrome brackets RESTORED. Template chrome and overlays are never
// moved or touched — "the overlay must be completely ignored in all drag
// calculations" (user, 2026-07-28) — and the footer's merge bracket never
// passes through order 0 (the mobile footer-under-hero window).
describe('commitMergedOrder', () => {
  it('arranges participants in their own slots; chrome + overlay untouched; brackets restored', async () => {
    const { commitMergedOrder } = await import('./placeholders');
    const parent = node('root-merged');
    root.appendChild(parent);
    const header = node('layout::header'); parent.appendChild(header);
    header.style.order = '-100000';
    // In-root OVERLAY (fixed video) — a real DOM child here, but NOT a participant.
    const overlay = node('overlay-u');
    overlay.style.position = 'absolute';
    parent.appendChild(overlay);
    const secA = node('sec-a'); parent.appendChild(secA);
    const secB = node('sec-b'); parent.appendChild(secB);
    for (const [el, v] of [[secA, '10'], [secB, '20']] as const) {
      el.style.setProperty('order', v, 'important');
      el.setAttribute('data-live-important', 'order');
    }
    const ph = document.createElement('div');
    ph.setAttribute('data-placeholder-id', 'ph-1');
    ph.setAttribute('data-layout-placeholder', 'true');
    parent.appendChild(ph);
    const footer = node('layout::footer'); parent.appendChild(footer);
    footer.style.setProperty('order', '1000000', 'important'); // drag bracket stamp
    const dragged = node('sec-c');
    dragged.style.position = 'absolute';
    root.appendChild(dragged); // lifted out of the parent

    // Reorder: sec-c drops between the two — participants only.
    commitMergedOrder('root-merged', '',
      ['sec-a', 'sec-c', 'sec-b'],
      [{ nodeId: 'sec-c', styles: { position: '', order: '' } }],
      ['ph-1'],
      [{ nodeId: 'layout::footer', order: '100013' }],
    );

    expect(parent.querySelector('[data-placeholder-id]')).toBeNull();
    const ids = Array.from(parent.children).map(el => el.getAttribute('data-node-id'));
    // Participants took the participant SLOTS (where sec-a/sec-b/sec-c's flow
    // positions were); header + overlay + footer never moved.
    expect(ids.indexOf('layout::header')).toBe(0);
    expect(ids.indexOf('overlay-u')).toBe(1);
    expect(ids.filter(id => id?.startsWith('sec-'))).toEqual(['sec-a', 'sec-c', 'sec-b']);
    expect(ids.indexOf('layout::footer')).toBe(ids.length - 1);
    // Participant stamps cleared; overlay style untouched; footer RESTORED to
    // its merge bracket (never 0).
    expect(secA.style.order).toBe('');
    expect(secB.style.order).toBe('');
    expect(secA.getAttribute('data-live-important')).toBeNull();
    expect(footer.style.order).toBe('100013');
    expect(header.style.order).toBe('-100000');
    // The dragged section is back in flow with its restore styles.
    expect(dragged.parentElement).toBe(parent);
    expect(dragged.style.position).toBe('');
  });

  it('a PORTALED overlay (not a child of the parent) is never yanked back', async () => {
    const { commitMergedOrder } = await import('./placeholders');
    const parent = node('root-merged');
    root.appendChild(parent);
    const secA = node('sec-a'); parent.appendChild(secA);
    const secB = node('sec-b'); parent.appendChild(secB);
    const portal = document.createElement('div');
    root.appendChild(portal);
    const overlay = node('overlay-u'); portal.appendChild(overlay);
    commitMergedOrder('root-merged', '', ['sec-b', 'sec-a'], [], []);
    expect(overlay.parentElement).toBe(portal);
    expect(Array.from(parent.children).map(el => el.getAttribute('data-node-id'))).toEqual(['sec-b', 'sec-a']);
  });

  it('missing parent or ids are a safe no-op', async () => {
    const { commitMergedOrder } = await import('./placeholders');
    expect(() => commitMergedOrder('nope', '', ['x'], [], [])).not.toThrow();
  });
});
