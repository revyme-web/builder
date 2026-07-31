// CodeComponentHost.test.ts — Unit tests for extractCodeComponentProps.
//
// Purpose: lock in the canvas/live-render symmetry for code components.
// Code components like MatrixRain spread `...props.style` on their inner wrapper to
// inherit width/height. extractCodeComponentProps must forward node.styles as a
// `style` prop, while filtering out canvas-positioning props that belong
// only on the Renderer's outer wrapper.

import { describe, it, expect } from 'vitest';
import { extractCodeComponentProps } from './CodeComponentHost';
import type { CanvasNode } from '@/code/parsing/parser';

function makeNode(overrides: Partial<CanvasNode>): CanvasNode {
  return {
    id: 'code-component-1',
    type: 'MatrixRain',
    parentId: null,
    children: [],
    styles: {},
    attrs: {},
    textContent: null,
    isCodeComponent: true,
    ...overrides,
  } as CanvasNode;
}

describe('extractCodeComponentProps', () => {
  it('forwards node.styles as the `style` prop so code components can self-size', () => {
    const node = makeNode({
      styles: { width: '100%', height: '100%', backgroundColor: '#020617' },
    });
    const props = extractCodeComponentProps(node);
    expect(props.style).toEqual({
      width: '100%',
      height: '100%',
      backgroundColor: '#020617',
    });
  });

  it('strips canvas-positioning props (position, left, top) from the forwarded style', () => {
    // These belong only on the outer Renderer wrapper. Forwarding them to the
    // code component's inner wrapper would re-apply absolute positioning relative to
    // the outer, visually offsetting the code component.
    const node = makeNode({
      styles: {
        position: 'absolute',
        left: '120px',
        top: '40px',
        width: '300px',
        height: '200px',
        backgroundColor: '#020617',
      },
    });
    const props = extractCodeComponentProps(node);
    expect(props.style).toEqual({
      width: '300px',
      height: '200px',
      backgroundColor: '#020617',
    });
    expect(props.style.position).toBeUndefined();
    expect(props.style.left).toBeUndefined();
    expect(props.style.top).toBeUndefined();
  });

  it('strips transform/order/flex/margin (parent-context layout props)', () => {
    const node = makeNode({
      styles: {
        transform: 'rotate(45deg)',
        transformOrigin: '50% 50%',
        order: '2',
        flex: '1 1 auto',
        flexShrink: '0',
        alignSelf: 'stretch',
        marginTop: '10px',
        gridColumn: '1 / 3',
        width: '100%',
        height: '100%',
      },
    });
    const props = extractCodeComponentProps(node);
    expect(props.style).toEqual({ width: '100%', height: '100%' });
  });

  it('does not add a style prop when node.styles is empty', () => {
    const node = makeNode({ styles: {} });
    const props = extractCodeComponentProps(node);
    expect(props.style).toBeUndefined();
  });

  it('does not add a style prop when every node style is canvas-only', () => {
    const node = makeNode({
      styles: { position: 'absolute', left: '10px', top: '20px' },
    });
    const props = extractCodeComponentProps(node);
    expect(props.style).toBeUndefined();
  });

  it('still passes non-style attrs through (and skips data-* / className / style attrs)', () => {
    const node = makeNode({
      attrs: {
        speed: '1.5',
        bgColor: '#000000',
        'data-id': 'code-component-1',
        'data-name': 'MatrixRain',
        className: 'foo',
        // Defensive: even if some path leaks `style` into attrs, we strip it
        // and let node.styles be the source of truth instead.
        style: '{ "width": "50%" }',
      },
      styles: { width: '100%' },
    });
    const props = extractCodeComponentProps(node);
    expect(props.speed).toBe(1.5);          // numeric coerce
    expect(props.bgColor).toBe('#000000');
    expect(props['data-id']).toBeUndefined();
    expect(props.className).toBeUndefined();
    expect(props.style).toEqual({ width: '100%' });
  });

  it('forwards data-responsive (per-viewport prop overrides) intact', () => {
    const node = makeNode({
      attrs: { 'data-responsive': '{"768":{"speed":2}}' },
    });
    const props = extractCodeComponentProps(node);
    expect(props['data-responsive']).toBe('{"768":{"speed":2}}');
  });

  it('merges componentProps on top of attrs', () => {
    const node = makeNode({
      attrs: { speed: '1' },
      componentProps: { speed: '2.5', fontSize: '20' },
    });
    const props = extractCodeComponentProps(node);
    expect(props.speed).toBe(2.5);
    expect(props.fontSize).toBe(20);
  });
});
