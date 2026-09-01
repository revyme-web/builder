import { describe, it, expect } from 'vitest';
import { applyDetailPageBindings } from './cms-page-bindings';
import { shouldClearEmptiedText } from '@/canvas/Renderer';
import type { CanvasNode } from '../parsing/parser';

function makeNode(partial: Partial<CanvasNode>): CanvasNode {
  return {
    id: partial.id ?? 'node',
    type: partial.type ?? 'div',
    styles: partial.styles ?? {},
    children: partial.children ?? [],
    ...partial,
  } as CanvasNode;
}

describe('applyDetailPageBindings', () => {
  it('returns same map when item is null (no preview chosen yet)', () => {
    const nodes = new Map<string, CanvasNode>([['n', makeNode({ id: 'n' })]]);
    expect(applyDetailPageBindings(nodes, null)).toBe(nodes);
  });

  it('substitutes a text binding into textContent', () => {
    const nodes = new Map<string, CanvasNode>([
      ['heading', makeNode({
        id: 'heading', type: 'p',
        binding: { field: 'title', property: 'text' },
      } as any)],
    ]);
    const out = applyDetailPageBindings(nodes, { title: 'Alice Johnson' });
    expect(out.get('heading')!.textContent).toBe('Alice Johnson');
    // Original untouched
    expect(nodes.get('heading')!.textContent).toBeUndefined();
  });

  it('substitutes a regular style binding (color) as a plain string', () => {
    const nodes = new Map<string, CanvasNode>([
      ['frame', makeNode({
        id: 'frame', type: 'div',
        styleBindings: [{ styleProp: 'backgroundColor', field: 'brand' }],
      })],
    ]);
    const out = applyDetailPageBindings(nodes, { brand: '#ff00aa' });
    expect(out.get('frame')!.styles.backgroundColor).toBe('#ff00aa');
  });

  it('wraps a backgroundImage binding in url(...)', () => {
    // Regression: previously the substitution dropped the bare URL into
    // `backgroundImage`, which CSS treats as invalid → image never showed
    // on canvas even though Next.js evaluated the template literal fine
    // on the live site.
    const nodes = new Map<string, CanvasNode>([
      ['photo-frame', makeNode({
        id: 'photo-frame', type: 'div',
        styleBindings: [{ styleProp: 'backgroundImage', field: 'photo' }],
      })],
    ]);
    const out = applyDetailPageBindings(nodes, { photo: '/images/alice.jpg' });
    expect(out.get('photo-frame')!.styles.backgroundImage).toBe('url("/images/alice.jpg")');
  });

  it('does NOT double-wrap an already-wrapped url() value', () => {
    const nodes = new Map<string, CanvasNode>([
      ['photo-frame', makeNode({
        id: 'photo-frame', type: 'div',
        styleBindings: [{ styleProp: 'backgroundImage', field: 'photo' }],
      })],
    ]);
    const out = applyDetailPageBindings(nodes, { photo: 'url("/images/alice.jpg")' });
    expect(out.get('photo-frame')!.styles.backgroundImage).toBe('url("/images/alice.jpg")');
  });

  it('substitutes attrBindings (multi-attr — e.g. img src + alt)', () => {
    const nodes = new Map<string, CanvasNode>([
      ['avatar', makeNode({
        id: 'avatar', type: 'img',
        attrBindings: [
          { property: 'src', field: 'photo' },
          { property: 'alt', field: 'name' },
        ],
      } as any)],
    ]);
    const out = applyDetailPageBindings(nodes, { photo: '/images/a.jpg', name: 'Alice' });
    const cloned = out.get('avatar')!;
    expect(cloned.attrs!.src).toBe('/images/a.jpg');
    expect(cloned.attrs!.alt).toBe('Alice');
  });

  it('passes nodes without bindings through by reference', () => {
    const plain = makeNode({ id: 'plain' });
    const bound = makeNode({
      id: 'bound', type: 'p',
      binding: { field: 'title', property: 'text' },
    } as any);
    const nodes = new Map([['plain', plain], ['bound', bound]]);
    const out = applyDetailPageBindings(nodes, { title: 'X' });
    expect(out.get('plain')).toBe(plain);   // same reference
    expect(out.get('bound')).not.toBe(bound); // cloned
  });

  // ── Regression: the bake is not cosmetic, it is load-bearing ──────────────
  //
  // Live 2026-09-01: changing padding-right on a `/collection-1/[slug]` page
  // made every image and paragraph vanish from the canvas while the live
  // preview stayed correct. A style edit ends in `forceRenderAfterExternalEdit`,
  // and that imperative path shipped the RAW parser map instead of the baked
  // one. A bound node parses with EMPTY textContent, so `patchElement` reached
  // `shouldClearEmptiedText`, which cleared 72 paragraphs in a single pass.
  //
  // These two assertions are the whole bug: unbaked = "clear me", baked =
  // "leave me alone". Any render path that skips the bake wipes the page.
  describe('detail-page nodes must be baked before they reach the renderer', () => {
    const boundParagraph = () => makeNode({
      id: 'p1', type: 'p',
      binding: { field: 'body', property: 'text' },
    } as any);

    it('an UNBAKED bound node looks empty and would be cleared', () => {
      const node = boundParagraph();
      expect(node.textContent).toBeUndefined();
      // hasActiveTextBinding is false on a detail page: values live in the
      // node, not in a bindingData record, so nothing vetoes the clear.
      expect(shouldClearEmptiedText(node, node.textContent, false, true)).toBe(true);
    });

    it('a BAKED bound node carries its text and is left alone', () => {
      const nodes = new Map<string, CanvasNode>([['p1', boundParagraph()]]);
      const baked = applyDetailPageBindings(nodes, { body: 'Meridian Architects is a practice…' }).get('p1')!;

      expect(baked.textContent).toBe('Meridian Architects is a practice…');
      expect(shouldClearEmptiedText(baked, baked.textContent, false, true)).toBe(false);
    });

    it('a field MISSING from the item still reads as empty', () => {
      // The preview record not carrying the field is indistinguishable from
      // never baking, so this documents the boundary rather than hiding it.
      const nodes = new Map<string, CanvasNode>([['p1', boundParagraph()]]);
      const baked = applyDetailPageBindings(nodes, { unrelated: 'x' }).get('p1')!;
      expect(shouldClearEmptiedText(baked, baked.textContent, false, true)).toBe(true);
    });
  });
});
