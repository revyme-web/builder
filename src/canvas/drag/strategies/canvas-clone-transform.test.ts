// canvas-clone-transform.test.ts — detaching a variant child to the canvas must
// convert motion MOTION transform props (rotate/scale/skew) into a CSS
// `transform`, since the clone is a plain <div> canvas node (not motion.*).

import { describe, test, expect } from 'vitest';
import { buildCanvasCloneDescriptor } from '../clone-descriptor';

function node(id: string, extra: Record<string, unknown>): any {
  return {
    id, type: 'div', parentId: 'root', children: [], styles: {}, attrs: {},
    textContent: '', motionVariants: null, ...extra,
  };
}

describe('buildCanvasCloneDescriptor — motion props → CSS transform on detach', () => {
  test("a variant's rotate/skew become a CSS transform; motion props dropped", () => {
    const nodes = new Map<string, any>([
      ['root', node('root', { parentId: null })],
      ['bar', node('bar', {
        styles: { position: 'absolute', backgroundColor: '#97cffc', left: '10px', top: '10px' },
        motionVariants: { default: {}, 'variant-1': { rotate: '53', skewX: '20' } },
      })],
    ]);
    // idMap empty → this is the ROOT clone of the drag.
    const def = buildCanvasCloneDescriptor('bar', nodes, new Map(), undefined, 'variant-1')!;
    expect(def).not.toBeNull();
    expect(def.styles!.transform).toContain('rotate(53deg)');
    expect(def.styles!.transform).toContain('skewX(20deg)');
    // The motion motion props themselves are removed (invalid CSS on a plain div).
    expect(def.styles!.rotate).toBeUndefined();
    expect(def.styles!.skewX).toBeUndefined();
    // Non-transform styles preserved.
    expect(def.styles!.backgroundColor).toBe('#97cffc');
  });

  test('no motion transform props → no transform key', () => {
    const nodes = new Map<string, any>([
      ['root', node('root', { parentId: null })],
      ['bar', node('bar', {
        styles: { position: 'absolute', left: '10px', top: '10px' },
        motionVariants: { default: {}, 'variant-1': { backgroundColor: '#000' } },
      })],
    ]);
    const def = buildCanvasCloneDescriptor('bar', nodes, new Map(), undefined, 'variant-1')!;
    expect(def.styles!.transform).toBeUndefined();
  });

  test('a DESIGN component instance detaches as a LEAF (no expanded children) + strips data-responsive', () => {
    const nodes = new Map<string, any>([
      ['root', node('root', { parentId: null, children: ['inst'] })],
      // The instance + its EXPANDED internals (componentInstanceId set) — these must NOT be cloned as children.
      ['inst', node('inst', {
        type: 'WoVuWo', isComponentInstance: true, componentFile: '@/components/WoVuWo', children: ['inst:root'],
        attrs: { 'data-responsive': '{"768":{"initialVariant":"variant-1"},"_bp":[375,768,1440]}' },
      })],
      ['inst:root', node('inst:root', { componentInstanceId: 'inst', children: ['inst:child'] })],
      ['inst:child', node('inst:child', { componentInstanceId: 'inst' })],
    ]);
    // Drag out of the tablet replica (768) where the instance shows variant-1.
    const def = buildCanvasCloneDescriptor('inst', nodes, new Map(), 768)!;
    expect(def).not.toBeNull();
    expect(def.children).toBeUndefined();                 // LEAF — no injected expanded internals
    expect(def.attrs!['initialVariant']).toBe('variant-1'); // the dragged variant is baked
    expect(def.attrs!['data-responsive']).toBeUndefined();  // stripped on the viewport-less canvas
  });

  test('a CODE/Code component keeps its real slot children on detach', () => {
    const nodes = new Map<string, any>([
      ['root', node('root', { parentId: null, children: ['code-component'] })],
      ['code-component', node('code-component', { type: 'CodeComponent', isCodeComponent: true, children: ['slotchild'] })],
      ['slotchild', node('slotchild', { type: 'div' })], // real slot content, NOT an expanded internal
    ]);
    const def = buildCanvasCloneDescriptor('code-component', nodes, new Map())!;
    expect(def.children?.length).toBe(1); // slot child preserved
  });
});

// ── FIT text drag-out: the id pairing must survive the clone ─────────────────
// The whole fit system (panel classification, typing re-fit, Font Size "fit",
// unwrap) keys on wrapper id === `<textId>-svg`. A fresh unpaired id turned the
// canvas clone into an anonymous <svg> → SHAPE controls for a text node.
describe('buildCanvasCloneDescriptor — FIT text keeps the -svg id pairing', () => {
  test('wrapper clone id = inner text clone id + "-svg"', () => {
    const nodes = new Map<string, any>([
      ['root', node('root', { parentId: null, children: ['t1-svg'] })],
      ['t1-svg', node('t1-svg', {
        type: 'svg', name: 'FIT', children: ['t1-fo'],
        styles: { width: '100%', height: 'auto' },
        attrs: { viewBox: '0 0 1010 78', xmlns: 'http://www.w3.org/2000/svg' },
      })],
      ['t1-fo', node('t1-fo', {
        type: 'foreignObject', parentId: 't1-svg', children: ['t1'],
        attrs: { width: '100%', height: '100%' },
      })],
      ['t1', node('t1', {
        type: 'p', parentId: 't1-fo', textContent: 'ELIAS',
        styles: { fontSize: '41px', margin: '0' },
      })],
    ]);
    const def = buildCanvasCloneDescriptor('t1-svg', nodes, new Map())!;
    expect(def).not.toBeNull();
    expect(def.id.endsWith('-svg')).toBe(true);
    const fo = def.children![0];
    const text = fo.children![0];
    expect(def.id).toBe(`${text.id}-svg`);      // the pairing every fit path keys on
    expect(text.textContent).toBe('ELIAS');
    expect(def.name).toBe('FIT');
  });
});
