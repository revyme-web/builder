import { describe, it, expect } from 'vitest';
import { applyPreview, clearPreview, restorePreview } from './MotionPropsEditor';

// The Appear/Enter editor injects the enter state as a LIVE !important preview so
// the user sees it while editing. Closing the popup must fully restore the DOM —
// the "Enter width 0 stays stale at 0 after close" bug was an injected layout prop
// (`width: 0 !important`) that survived because the Renderer re-paints base styles
// non-important. These lock the apply→clear contract (parent-frame path; no nodeId
// so the sandbox bridge isn't involved).

describe('MotionPropsEditor preview injection (DOM)', () => {
  it('injects a layout prop as !important and clearPreview fully removes it', () => {
    const el = document.createElement('div');
    el.style.width = '215px';
    applyPreview(el, { width: '0' });
    expect(el.style.getPropertyValue('width')).toMatch(/^0(px)?$/); // jsdom may normalise 0→0px
    expect(el.style.getPropertyPriority('width')).toBe('important'); // overrides base
    clearPreview(el, { width: '1' }); // teardown — only the KEY matters
    expect(el.style.getPropertyValue('width')).toBe(''); // removed, including !important
  });

  it('union teardown clears a previewed key even if it is no longer in the live props', () => {
    const el = document.createElement('div');
    applyPreview(el, { width: '0', height: '0' });
    // The component tracks every injected key and clears the FULL set on close,
    // so a key added-then-dropped mid-edit can't be left stale.
    clearPreview(el, { width: '1', height: '1' });
    expect(el.style.getPropertyValue('width')).toBe('');
    expect(el.style.getPropertyValue('height')).toBe('');
  });

  it('clears transform + opacity previews too', () => {
    const el = document.createElement('div');
    applyPreview(el, { opacity: '0', scale: '0.5' });
    expect(el.style.getPropertyValue('opacity')).toBe('0');
    expect(el.style.getPropertyValue('transform')).toContain('scale(0.5)');
    clearPreview(el, { opacity: '1', scale: '1' });
    expect(el.style.getPropertyValue('opacity')).toBe('');
    expect(el.style.getPropertyValue('transform')).toBe('');
  });
});

describe('restorePreview — teardown returns to the RESTING value, not removed', () => {
  it('restores a layout prop the preview overwrote (the bar-collapses-to-0 bug)', () => {
    const el = document.createElement('div');
    el.style.setProperty('height', '52px'); // the bar's authored resting height
    applyPreview(el, { height: '0' });        // enter preview → height: 0 !important
    expect(el.style.getPropertyPriority('height')).toBe('important');
    restorePreview(el, ['height'], { height: '52px' }); // teardown restores 52px
    expect(el.style.getPropertyValue('height')).toBe('52px');
    expect(el.style.getPropertyPriority('height')).toBe(''); // !important dropped
  });

  it('removes a key with no authored resting value (opacity → default)', () => {
    const el = document.createElement('div');
    applyPreview(el, { opacity: '0' });
    restorePreview(el, ['opacity'], {}); // no resting opacity → remove → default 1
    expect(el.style.getPropertyValue('opacity')).toBe('');
  });

  it('always clears the transform preview on restore', () => {
    const el = document.createElement('div');
    applyPreview(el, { scale: '0.5' });
    expect(el.style.getPropertyValue('transform')).toContain('scale(0.5)');
    restorePreview(el, [], undefined);
    expect(el.style.getPropertyValue('transform')).toBe('');
  });
});
