// A code component paints its forwarded styles (fill, radius, …) on its OWN root
// via `...props.style`, on top of the instance wrapper the DOM live-patch hits —
// so a Fill drag on a Marquee showed nothing until mouse-up (user report
// 2026-10-15). renderCodeComponentStyleLive re-renders it in place instead.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateCodeComponentProps = vi.fn();
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => ({ updateCodeComponentProps }),
}));

import { renderCodeComponentStyleLive, setCodeComponentNodesForTest, rememberMountedSlotChildren, renderCodeComponentDirect } from './CodeComponentHost';
import type { CanvasNode } from '@/code/parsing/parser';

const node = (over: Partial<CanvasNode>): CanvasNode => ({
  id: 'mq', type: 'Marquee', parentId: 'page', children: [], attrs: {}, textContent: null,
  isCodeComponent: true, componentFile: 'components/Marquee.tsx',
  styles: { position: 'relative', width: '400px', backgroundColor: '#f46767' },
  ...over,
} as CanvasNode);

beforeEach(() => updateCodeComponentProps.mockClear());

describe('renderCodeComponentStyleLive', () => {
  it('re-renders a code component with the dragged fill in its forwarded style', () => {
    setCodeComponentNodesForTest(new Map([['mq', node({})]]));
    expect(renderCodeComponentStyleLive('mq', { backgroundColor: '#3f1818' })).toBe(true);
    const [id, props] = updateCodeComponentProps.mock.calls[0];
    expect(id).toBe('mq');
    expect(props.style.backgroundColor).toBe('#3f1818');
    expect(props.style.width).toBe('400px');          // the rest of the forward is kept
    expect(props.style).not.toHaveProperty('position'); // wrapper-only stays on the wrapper
  });

  it('a component-master VARIANT tile previews through that variant\'s branch only', () => {
    setCodeComponentNodesForTest(new Map([['mq', node({ conditionalStyles: { width: { 'default-hover': '500px', default: '400px' } } })]]));
    renderCodeComponentStyleLive('mq', { backgroundColor: '#000' }, 'default-hover');
    const props = updateCodeComponentProps.mock.calls[0][1];
    expect(props.__variantStyles.backgroundColor).toEqual({ 'default-hover': '#000' });
    expect(props.__variantStyles.width).toEqual({ 'default-hover': '500px', default: '400px' });
    expect(props.style.backgroundColor).toBe('#f46767');   // the base forward is untouched
  });

  it('a base edit on a key with variant branches moves its default branch too', () => {
    setCodeComponentNodesForTest(new Map([['mq', node({ conditionalStyles: { backgroundColor: { 'default-hover': '#111', default: '#f46767' } } })]]));
    renderCodeComponentStyleLive('mq', { backgroundColor: '#3f1818' });
    const props = updateCodeComponentProps.mock.calls[0][1];
    expect(props.__variantStyles.backgroundColor).toEqual({ 'default-hover': '#111', default: '#3f1818' });
  });

  it('does nothing for a plain node, a design-component instance, or wrapper-only keys', () => {
    setCodeComponentNodesForTest(new Map([
      ['div', node({ id: 'div', isCodeComponent: false, componentFile: undefined })],
      ['card', node({ id: 'card', isCodeComponent: false, componentFile: 'components/Card.tsx' })],
      ['mq', node({})],
    ]));
    expect(renderCodeComponentStyleLive('div', { backgroundColor: '#000' })).toBe(false);
    expect(renderCodeComponentStyleLive('card', { backgroundColor: '#000' })).toBe(false);
    expect(renderCodeComponentStyleLive('mq', { left: '10px', display: 'none' })).toBe(false);
    expect(renderCodeComponentStyleLive('missing', { backgroundColor: '#000' })).toBe(false);
    expect(updateCodeComponentProps).not.toHaveBeenCalled();
  });

  // The live re-render rebuilt props from the node alone, and connected slot
  // children come from the slot connections at mount — so the Marquee showed its
  // empty "Connect Content" state for the whole drag (user report 2026-10-15).
  it('keeps the connected slot children the instance was mounted with — style AND prop drags', () => {
    setCodeComponentNodesForTest(new Map([['mq', node({})]]));
    const kids = [{ id: 'frame-1' }] as unknown as Parameters<typeof rememberMountedSlotChildren>[1];
    rememberMountedSlotChildren('mq', kids);
    renderCodeComponentStyleLive('mq', { backgroundColor: '#3f1818' });
    renderCodeComponentDirect('mq', { speed: 80 });
    for (const [, props] of updateCodeComponentProps.mock.calls) expect(props.__slotChildren).toBe(kids);
    rememberMountedSlotChildren('mq', []);   // disconnected → nothing carried
    renderCodeComponentDirect('mq', { speed: 90 });
    const calls = updateCodeComponentProps.mock.calls;
    expect(calls[calls.length - 1][1]).not.toHaveProperty('__slotChildren');
  });
});

