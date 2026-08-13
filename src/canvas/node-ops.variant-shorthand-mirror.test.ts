// Live-drag mirroring must respect a variant's LONGHAND overrides when the
// primary writes the SHORTHAND.
//
// User report 2026-08-13: dragging the Footer's Padding slider on the primary
// updated every replica tile in the DOM — including `variant-1`, which owns its
// own paddingTop/Right/Bottom/Left. On mouseup it snapped back to the override
// (the commit re-renders from source), so the corruption was purely the live
// preview.
//
// Why it slipped through: the mirror filter drops keys in
// `getVariantOverriddenKeys`, and that set holds the keys the variant actually
// AUTHORED — the four longhands. The write coming from the Padding control is
// the shorthand `padding` (plus `''` deletes for the sides), and `padding` is
// not in the set, so it mirrored — with `important: true`, which beats the
// variant's own values.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/code/svg/refit-group', () => ({
  moveChildAndRefitGroup: vi.fn(() => null),
  refitGroupChain: vi.fn(),
  normalizeGroupOnResize: vi.fn(),
}));
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(), flushNow: vi.fn(), setForceRender: vi.fn(),
}));
vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (p: string) => p.startsWith('components/'),
  getLayoutForPage: () => null,
  isLayoutFile: () => false,
}));
vi.mock('@/code/project/project-fs', () => ({ projectFS: { readFile: () => '' } }));
vi.mock('@/code/variants/variant-config', () => ({ parseVariantConfig: () => [] }));

import { updateNodeStyles, setStyleContext } from './node-ops';
import { setActiveBridge } from './canvas-bridge';
import { injectNodeIntoCache } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';

const patchStyles = vi.fn();
const rectCache = new Map<string, DOMRect>();

const stubBridge = {
  getRect: () => null, getChildRects: () => [], getComputedValue: () => '',
  getComputedValues: () => ({}), getContainerRect: () => null,
  getElementIdsAtPoint: () => [], patchAttrsAndStyles: vi.fn(),
  injectCSS: vi.fn(), removeCSS: vi.fn(),
  patchStyles,
  rectCache,
} as any;

/** The Footer's Frame 37: variant-1 owns all four padding sides. */
function seedNode(variantStyles: Record<string, string>) {
  injectNodeIntoCache({
    id: 'div-msp237ef-30', type: 'div', name: 'Frame 37', parentId: 'root',
    children: [], styles: { padding: '50px' }, textContent: '', attrs: {},
    motionVariants: { 'variant-1': variantStyles },
  } as unknown as CanvasNode);
}

/** Exactly what the Padding control emits: shorthand + `''` deletes. */
const PADDING_WRITE = {
  padding: '117px', paddingTop: '', paddingRight: '', paddingBottom: '', paddingLeft: '',
};

const contentEl = document.createElement('div');

/** The styles mirrored onto the variant-1 tile, or null if it wasn't patched. */
function variantPatch(): Record<string, string> | null {
  const call = patchStyles.mock.calls.find(([, prefix]: any[]) => prefix === 'variant-1-');
  return call ? call[2] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  rectCache.clear();
  // The node renders on BOTH the primary and the variant-1 tile.
  rectCache.set(':div-msp237ef-30', new DOMRect(0, 0, 100, 100));
  rectCache.set('variant-1-:div-msp237ef-30', new DOMRect(0, 0, 100, 100));
  setActiveBridge(stubBridge);
  setStyleContext('components/HeWeZa.tsx', 'desktop', 1440);
});

describe('shorthand write vs variant longhand overrides', () => {
  it('does not mirror `padding` onto a variant that owns every side', () => {
    seedNode({
      paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px',
    });
    updateNodeStyles({ id: 'div-msp237ef-30', styles: { ...PADDING_WRITE }, contentEl, domOnly: true });

    const patch = variantPatch();
    // Either the tile isn't patched at all, or the patch carries no padding.
    if (patch) {
      expect(patch.padding, 'primary padding leaked onto the variant').toBeUndefined();
      for (const lh of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        expect(patch[lh], `${lh} leaked onto the variant`).toBeUndefined();
      }
    }
  });

  it('mirrors only the sides the variant does NOT own', () => {
    seedNode({ paddingTop: '16px' }); // variant owns the TOP only
    updateNodeStyles({ id: 'div-msp237ef-30', styles: { ...PADDING_WRITE }, contentEl, domOnly: true });

    const patch = variantPatch();
    expect(patch).toBeTruthy();
    expect(patch!.paddingTop).toBeUndefined();     // the variant's own value survives
    expect(patch!.padding).toBeUndefined();        // never the flattening shorthand
    expect(patch!.paddingRight).toBe('117px');     // the free sides still follow live
    expect(patch!.paddingBottom).toBe('117px');
    expect(patch!.paddingLeft).toBe('117px');
  });

  it('still mirrors the shorthand when the variant overrides nothing related', () => {
    seedNode({ backgroundColor: '#fff' });
    updateNodeStyles({ id: 'div-msp237ef-30', styles: { ...PADDING_WRITE }, contentEl, domOnly: true });

    const patch = variantPatch();
    expect(patch).toBeTruthy();
    expect(patch!.padding).toBe('117px');
  });

  // A multi-value shorthand can't be split per side without parsing it —
  // dropping is the safe half of that trade, since the commit re-render
  // restores the correct value regardless.
  it('drops a multi-value shorthand rather than mis-splitting it', () => {
    seedNode({ paddingTop: '16px' });
    updateNodeStyles({
      id: 'div-msp237ef-30',
      styles: { padding: '10px 20px', paddingTop: '', paddingRight: '', paddingBottom: '', paddingLeft: '' },
      contentEl, domOnly: true,
    });

    const patch = variantPatch();
    if (patch) {
      expect(patch.padding).toBeUndefined();
      // The `''` delete may still mirror (harmless — the variant has no own
      // paddingRight); what must never happen is a mis-split value.
      expect(patch.paddingRight ?? '').not.toContain('10px 20px');
      expect(patch.paddingRight ?? '').not.toBe('10px');
    }
  });

  // The PARENT-FRAME DOM fan-out — a second, independent copy of the same
  // filter that runs BEFORE the bridge path whenever the canvas renders inline
  // (i.e. `[data-node-id]` resolves). Fixing only the bridge left this one
  // still injecting the primary's padding onto the tile, which is why the bug
  // survived the first fix.
  it('parent-frame DOM path also respects the overrides', () => {
    seedNode({
      paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px',
    });
    const root = document.createElement('div');
    const primaryVp = document.createElement('div');
    primaryVp.setAttribute('data-viewport', 'desktop');
    const primary = document.createElement('div');
    primary.setAttribute('data-node-id', 'div-msp237ef-30');
    primary.setAttribute('data-id', 'div-msp237ef-30');
    primaryVp.appendChild(primary);
    const variantVp = document.createElement('div');
    variantVp.setAttribute('data-viewport', 'variant-1');
    const replica = document.createElement('div');
    replica.setAttribute('data-id', 'div-msp237ef-30');
    replica.style.paddingTop = '16px';
    variantVp.appendChild(replica);
    root.append(primaryVp, variantVp);

    updateNodeStyles({ id: 'div-msp237ef-30', styles: { ...PADDING_WRITE }, contentEl: root, domOnly: true });

    expect(primary.style.padding, 'primary should still get the new value').toBe('117px');
    expect(replica.style.padding, 'primary padding leaked onto the variant tile').toBe('');
    expect(replica.style.paddingTop, "the variant's own override was wiped").toBe('16px');
  });

  // The INVERSE pairing. Which form a variant stores depends on how the
  // override was authored — re-adding an override can flip four longhands into
  // a single shorthand — so both directions must hold or the bug just returns
  // wearing the other hat.
  it('does not mirror longhands onto a variant that owns the shorthand', () => {
    seedNode({ padding: '16px' }); // variant stored the SHORTHAND
    updateNodeStyles({
      id: 'div-msp237ef-30',
      // The expanded padding editor writes individual sides.
      styles: { paddingTop: '117px', paddingRight: '117px', paddingBottom: '117px', paddingLeft: '117px' },
      contentEl, domOnly: true,
    });

    const patch = variantPatch();
    if (patch) {
      for (const lh of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        expect(patch[lh], `${lh} clobbered the variant's shorthand`).toBeUndefined();
      }
    }
  });

  it('covers margin the same way', () => {
    seedNode({ marginTop: '8px', marginRight: '8px', marginBottom: '8px', marginLeft: '8px' });
    updateNodeStyles({
      id: 'div-msp237ef-30',
      styles: { margin: '24px', marginTop: '', marginRight: '', marginBottom: '', marginLeft: '' },
      contentEl, domOnly: true,
    });

    const patch = variantPatch();
    if (patch) expect(patch.margin).toBeUndefined();
  });
});
