/**
 * @vitest-environment jsdom
 *
 * Regression tests for sandbox-code-host's mount dedup logic.
 *
 * The critical case: when a code component is dragged from canvas-root into
 * a viewport (or vice-versa), the Renderer structurally rebuilds the wrapper
 * `<div data-code-component>` — same `data-node-id`, but a brand-new DOM
 * node. Without the container-identity guard the dedup key matches and
 * mountCodeComponent skips re-mounting, leaving the React root attached to
 * a detached element while the live wrapper paints empty.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mountCodeComponent, mountCodeComponentsBatch, unmountCodeComponent } from './sandbox-code-host';
import { clearCodeComponentCache } from '@/canvas/code-component-runtime';

const CODE_COMPONENT_CODE = `'use client';
/** @label "Tester" */
/** @comment "test" */
/** @controls { "kind": { "type": "select", "label": "Kind", "default": "a", "options": [{ "label": "A", "value": "a" }, { "label": "B", "value": "b" }] } } */
import { withResponsiveProps } from '@revyme/runtime';

function Tester({ kind = 'a', ...props }) {
  return <div data-code-component-marker="yes" data-kind={kind} style={{ width: 100, height: 100, ...props.style }}>code-component-{kind}</div>;
}

export default withResponsiveProps(Tester);
`;

function makeContainer(parent: HTMLElement, nodeId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-id', nodeId);
  el.setAttribute('data-node-id', nodeId);
  el.setAttribute('data-code-component', 'true');
  parent.appendChild(el);
  return el;
}

describe('sandbox-code-host mountCodeComponent', () => {
  let contentRoot: HTMLElement;

  beforeEach(() => {
    clearCodeComponentCache();
    document.body.innerHTML = '';
    contentRoot = document.createElement('div');
    document.body.appendChild(contentRoot);
  });

  it('mounts a code component on the wrapper container', async () => {
    const nodeId = 'code-component-1';
    makeContainer(contentRoot, nodeId);
    mountCodeComponent(contentRoot, nodeId, CODE_COMPONENT_CODE, { kind: 'a' }, 1440);
    await new Promise(r => setTimeout(r, 20));
    const codeComponent = contentRoot.querySelector('[data-code-component-marker="yes"]');
    expect(codeComponent).not.toBeNull();
    expect(codeComponent!.getAttribute('data-kind')).toBe('a');
    unmountCodeComponent(nodeId);
  });

  it('re-mounts when the wrapper DOM is rebuilt with the same data-node-id', async () => {
    // This simulates the move-into-viewport flow: the Renderer destroys the
    // old wrapper and creates a fresh one with the SAME data-node-id, after
    // which the parent CodeComponentHost forwards mountCodeComponent again.
    const nodeId = 'code-component-2';
    const oldEl = makeContainer(contentRoot, nodeId);

    mountCodeComponent(contentRoot, nodeId, CODE_COMPONENT_CODE, { kind: 'a' }, 1440);
    await new Promise(r => setTimeout(r, 20));
    expect(oldEl.querySelector('[data-code-component-marker="yes"]')).not.toBeNull();

    // Structural rebuild: remove old, create new container with same id.
    oldEl.remove();
    const newEl = makeContainer(contentRoot, nodeId);

    // Same code + same props as before — the buggy version would skip
    // mounting on `newEl` because the cached entry's hashes still match.
    mountCodeComponent(contentRoot, nodeId, CODE_COMPONENT_CODE, { kind: 'a' }, 1440);
    await new Promise(r => setTimeout(r, 20));

    const codeComponent = newEl.querySelector('[data-code-component-marker="yes"]');
    expect(codeComponent).not.toBeNull();
    expect(codeComponent!.getAttribute('data-kind')).toBe('a');
    unmountCodeComponent(nodeId);
  });

  it('skips re-mount when called repeatedly with same container/code/props', async () => {
    const nodeId = 'code-component-3';
    const el = makeContainer(contentRoot, nodeId);
    mountCodeComponent(contentRoot, nodeId, CODE_COMPONENT_CODE, { kind: 'a' }, 1440);
    await new Promise(r => setTimeout(r, 20));
    const firstCodeComponent = el.querySelector('[data-code-component-marker="yes"]');
    mountCodeComponent(contentRoot, nodeId, CODE_COMPONENT_CODE, { kind: 'a' }, 1440);
    await new Promise(r => setTimeout(r, 20));
    const secondCodeComponent = el.querySelector('[data-code-component-marker="yes"]');
    // Same container, same node — React root is reused, the inner element
    // is the same DOM node (no remount).
    expect(secondCodeComponent).toBe(firstCodeComponent);
    unmountCodeComponent(nodeId);
  });
});

describe('sandbox-code-host mountCodeComponentsBatch', () => {
  let contentRoot: HTMLElement;

  beforeEach(() => {
    clearCodeComponentCache();
    document.body.innerHTML = '';
    contentRoot = document.createElement('div');
    document.body.appendChild(contentRoot);
  });

  it('mounts every forwarded instance in ONE synchronous pass (no dominos)', async () => {
    // Mirrors the advisors hero: N instances of the SAME component, distinct
    // ids + distinct props. The parent forwards them all in one batch; this
    // asserts they all mount from a single call (the per-message serialization
    // that caused the cascade is gone).
    const ids = ['cnt-1', 'cnt-2', 'cnt-3', 'cnt-4', 'cnt-5', 'cnt-6'];
    for (const id of ids) makeContainer(contentRoot, id);

    mountCodeComponentsBatch(
      contentRoot,
      ids.map((id, i) => ({ nodeId: id, code: CODE_COMPONENT_CODE, props: { kind: i % 2 ? 'b' : 'a' }, vpWidth: 1440 })),
    );
    await new Promise(r => setTimeout(r, 30));

    const mountedMarkers = contentRoot.querySelectorAll('[data-code-component-marker="yes"]');
    expect(mountedMarkers.length).toBe(ids.length);
    for (const id of ids) unmountCodeComponent(id);
  });

  it('skips an instance whose container is absent without aborting the rest', async () => {
    // Resilience: one missing container (e.g. a ghost-only id) must not stop
    // the remaining instances in the batch from mounting.
    makeContainer(contentRoot, 'present-1');
    makeContainer(contentRoot, 'present-2');

    mountCodeComponentsBatch(contentRoot, [
      { nodeId: 'present-1', code: CODE_COMPONENT_CODE, props: { kind: 'a' }, vpWidth: 1440 },
      { nodeId: 'missing-x', code: CODE_COMPONENT_CODE, props: { kind: 'a' }, vpWidth: 1440 },
      { nodeId: 'present-2', code: CODE_COMPONENT_CODE, props: { kind: 'b' }, vpWidth: 1440 },
    ]);
    await new Promise(r => setTimeout(r, 30));

    expect(contentRoot.querySelectorAll('[data-code-component-marker="yes"]').length).toBe(2);
    unmountCodeComponent('present-1');
    unmountCodeComponent('present-2');
  });
});

import { isVectorSetSource, disableCanvasAnimations } from './sandbox-code-host';
import { buildIconSetFile } from '@/code/icons/icon-set-template';

describe('canvas animation suppression (CDN + vector sets)', () => {
  const VECTOR_SET = buildIconSetFile('FooSet', 'Foo Set', [
    { id: 'icon-1', displayName: 'Vector', svgJSX: '<svg viewBox="0 0 100 100"></svg>', leftPx: 0 },
  ]);

  it('detects a real built vector-set file (marker stays in sync with the builder)', () => {
    expect(isVectorSetSource(VECTOR_SET)).toBe(true);
  });

  it('does NOT flag an ordinary code component', () => {
    expect(isVectorSetSource(CODE_COMPONENT_CODE)).toBe(false);
  });

  it('suppresses canvas animation for CDN URLs, vector sets — but not plain components', () => {
    expect(disableCanvasAnimations('https://cdn.example.com/Foo.js')).toBe(true);
    expect(disableCanvasAnimations(VECTOR_SET)).toBe(true);
    expect(disableCanvasAnimations(CODE_COMPONENT_CODE)).toBe(false);
  });
});

import { resolveVariantProps } from './sandbox-code-host';

describe('resolveVariantProps — per-artboard variant style resolution', () => {
  // A vector-set instance whose width/height are `initialVariant === 'v' ? a : b`
  // ternaries, parsed into conditionalStyles and shipped as __variantStyles.
  const VS = {
    width: { 'variant-1': '542px', default: '430px' },
    height: { 'variant-1': '214px', default: '170px' },
  };
  const props = () => ({
    name: 'icon-1',
    style: { position: 'absolute', width: '430px', height: '170px', left: '20%' },
    __variantStyles: VS,
  });

  it('resolves the variant-1 branch on the variant-1 tile', () => {
    const out = resolveVariantProps(props(), 'variant-1');
    expect(out.style.width).toBe('542px');
    expect(out.style.height).toBe('214px');
    // Non-variant props untouched.
    expect(out.style.left).toBe('20%');
    // __variantStyles is stripped so it never reaches the component.
    expect(out).not.toHaveProperty('__variantStyles');
    expect(out.name).toBe('icon-1');
  });

  it('falls back to the default branch on the primary tile (viewport id is not a variant)', () => {
    const out = resolveVariantProps(props(), 'desktop');
    expect(out.style.width).toBe('430px');
    expect(out.style.height).toBe('170px');
  });

  it('falls back to the default branch for a null variant', () => {
    const out = resolveVariantProps(props(), null);
    expect(out.style.width).toBe('430px');
  });

  it('is a no-op when there are no __variantStyles', () => {
    const p = { name: 'x', style: { width: '100px' } };
    expect(resolveVariantProps(p, 'variant-1')).toBe(p);
  });
});

describe('resolveVariantProps — per-variant PROP overrides (__variantProps)', () => {
  // An icon-set instance whose `name` (which vector to show) is overridden per
  // master variant: name={variant === 'variant-1' ? 'icon-2' : 'icon-1'} →
  // node.attrConditional, shipped as __variantProps.
  const props = () => ({
    name: 'icon-1',
    style: { width: '100px' },
    __variantProps: { name: { 'variant-1': 'icon-2', default: 'icon-1' } },
  });

  it('resolves the per-variant name on the variant-1 tile', () => {
    const out = resolveVariantProps(props(), 'variant-1');
    expect(out.name).toBe('icon-2');
    expect(out).not.toHaveProperty('__variantProps');
    expect(out.style).toEqual({ width: '100px' });
  });

  it('falls back to the default name on the primary tile', () => {
    expect(resolveVariantProps(props(), 'desktop').name).toBe('icon-1');
    expect(resolveVariantProps(props(), null).name).toBe('icon-1');
  });

  it('resolves __variantStyles AND __variantProps together', () => {
    const p = {
      name: 'icon-1',
      style: { width: '100px' },
      __variantStyles: { width: { 'variant-1': '200px', default: '100px' } },
      __variantProps: { name: { 'variant-1': 'icon-2', default: 'icon-1' } },
    };
    const out = resolveVariantProps(p, 'variant-1');
    expect(out.style.width).toBe('200px');
    expect(out.name).toBe('icon-2');
    expect(out).not.toHaveProperty('__variantStyles');
    expect(out).not.toHaveProperty('__variantProps');
  });
});

describe('resolveVariantProps — motion-transform props stay on the container, not the inner', () => {
  it('does NOT resolve a per-variant rotate onto the inner style (avoids double rotation + handle fight)', () => {
    const props = {
      name: 'icon-1',
      style: { width: '100px', rotate: '0' },
      __variantStyles: {
        width: { 'variant-1': '200px', default: '100px' },
        rotate: { 'variant-1': '-200.7', default: '0' },
      },
    };
    const out = resolveVariantProps(props, 'variant-1');
    // size still resolves...
    expect(out.style.width).toBe('200px');
    // ...but rotate is left at its base (the container owns the rotation).
    expect(out.style.rotate).toBe('0');
  });
});

// Typed coercion for per-variant PROP branches (2026-07-31): ternary branches
// parse as strings — 'false' must become boolean false (truthy-string bug)
// and numeric branches real numbers.
describe('resolveVariantProps — typed branch coercion', () => {
  it('coerces boolean and numeric branches', () => {
    const out = resolveVariantProps({
      invert: false, curveRadius: 14, fillColor: '#28282c',
      __variantProps: {
        invert: { Hover: 'true', default: 'false' },
        curveRadius: { Hover: '18', default: '14' },
        fillColor: { Hover: '#8C3030', default: '#28282c' },
      },
    }, 'Hover');
    expect(out.invert).toBe(true);
    expect(out.curveRadius).toBe(18);
    expect(out.fillColor).toBe('#8C3030');
    const def = resolveVariantProps({
      invert: false,
      __variantProps: { invert: { Hover: 'true', default: 'false' } },
    }, null);
    expect(def.invert).toBe(false);
  });
});
