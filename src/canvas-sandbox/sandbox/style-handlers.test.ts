import { describe, it, expect } from 'vitest';
import { applyTwoPass } from './style-handlers';

// A REPLICA / component-variant style edit COMMITS to an `@container`/@media
// rule with `!important` (updateContainerQueryStyle). The LIVE drag preview
// must therefore patch the DOM with `!important` too — a plain inline patch
// (no priority) loses to the stale `!important` rule still carrying the
// pre-drag value, so the canvas wouldn't move during the drag and only jumped
// on release (live find 2026-07-03). ControlProvider.updateStyleLive passes
// `important: true` for the replica/variant branch; this locks in that
// applyTwoPass honours it.
describe('applyTwoPass — important flag (replica/variant live drag)', () => {
  it('sets inline !important when important=true (beats a stale @container !important rule)', () => {
    const el = document.createElement('div');
    applyTwoPass(el, { padding: '96px' }, true);
    expect(el.style.getPropertyPriority('padding')).toBe('important');
    expect(el.style.padding).toBe('96px');
  });

  it('sets a plain inline value when important=false (primary/base edit)', () => {
    const el = document.createElement('div');
    applyTwoPass(el, { padding: '96px' }, false);
    expect(el.style.getPropertyPriority('padding')).toBe('');
    expect(el.style.padding).toBe('96px');
  });

  it('camelCase keys are kebab-cased for the important setProperty path', () => {
    const el = document.createElement('div');
    applyTwoPass(el, { paddingTop: '40px' }, true);
    expect(el.style.getPropertyPriority('padding-top')).toBe('important');
    expect(el.style.paddingTop).toBe('40px');
  });
});

// ─── data-live-important residue tracking ───────────────────────────────────
// A replica live-scrub patches inline with !important; the commit skips the
// render, so renderNodes must know which props to sweep (the undo-stale bug).
import { trackLiveImportant, untrackLiveImportant } from './style-handlers';

describe('live-important residue marker', () => {
  it('important set marks the element; plain set unmarks', () => {
    const el = document.createElement('div');
    applyTwoPass(el, { paddingTop: '44px' }, true);
    expect(el.getAttribute('data-live-important')).toBe('padding-top');
    expect(el.style.getPropertyPriority('padding-top')).toBe('important');
    applyTwoPass(el, { paddingTop: '20px' }, false);
    expect(el.getAttribute('data-live-important')).toBeNull();
  });

  it('accumulates multiple props and removes one at a time', () => {
    const el = document.createElement('div');
    trackLiveImportant(el, 'padding-top');
    trackLiveImportant(el, 'max-width');
    trackLiveImportant(el, 'max-width');
    expect(el.getAttribute('data-live-important')!.split(',').sort()).toEqual(['max-width', 'padding-top']);
    untrackLiveImportant(el, 'padding-top');
    expect(el.getAttribute('data-live-important')).toBe('max-width');
    untrackLiveImportant(el, 'max-width');
    expect(el.getAttribute('data-live-important')).toBeNull();
  });
});

// batch fan-out marks replica-target patches too (the unmarked gap that kept
// a tablet replica's inline stale through undo — live find 2026-07-21)
import { patchMultipleStyles } from './style-handlers';
import { setContentRoot } from './sandbox-state';

describe('patchMultipleStyles residue marking', () => {
  it('marks replica-target batch patches, leaves primary unmarked', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    setContentRoot(root);
    const mk = (dni: string, id: string) => {
      const el = document.createElement('div');
      el.setAttribute('data-node-id', dni);
      el.setAttribute('data-id', id);
      root.appendChild(el);
      return el;
    };
    const desktop = mk('badge', 'badge');
    const tablet = mk('tablet-badge', 'badge');
    patchMultipleStyles([
      { nodeId: 'badge', vpPrefix: '', styles: { width: '120px' }, important: false },
      { nodeId: 'badge', vpPrefix: 'tablet-', styles: { width: '120px' }, important: false },
    ] as never);
    expect(desktop.getAttribute('data-live-important')).toBeNull();
    expect(tablet.getAttribute('data-live-important')).toBe('width');
  });
});
