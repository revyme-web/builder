import { describe, test, expect } from 'vitest';
import { parseComponentCursorCalls, getComponentCursorForNode } from './cursor-parser';

const wrap = (call: string) => `'use client';

import Pointer from '@/components/Pointer';
import { withCursor } from '@revyme/runtime';

export default function Page() {
  return <button data-id="cta" ${call}>Click</button>;
}
`;

describe('parseComponentCursorCalls', () => {
  test('reads side / align scalars', () => {
    const code = wrap(`{...withCursor(Pointer, { side: 'top', align: 'end' })}`);
    const calls = parseComponentCursorCalls(code);
    expect(calls).toHaveLength(1);
    expect(calls[0].side).toBe('top');
    expect(calls[0].align).toBe('end');
  });

  test('reads enterExit boolean', () => {
    const code = wrap(`{...withCursor(Pointer, { enterExit: true })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.enterExit).toBe(true);
  });

  test('omitting enterExit defaults to undefined (runtime treats as false)', () => {
    const code = wrap(`{...withCursor(Pointer, { mode: 'follow' })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.enterExit).toBeUndefined();
  });

  test('reads numeric width / height', () => {
    const code = wrap(`{...withCursor(Pointer, { width: 80, height: 80 })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.width).toBe(80);
    expect(cursor?.height).toBe(80);
  });

  test('reads CSS-string width / height', () => {
    const code = wrap(`{...withCursor(Pointer, { width: '100%', height: '4rem' })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.width).toBe('100%');
    expect(cursor?.height).toBe('4rem');
  });

  test('rejects unknown enum values for side / align (returns undefined)', () => {
    const code = wrap(`{...withCursor(Pointer, { side: 'sideways', align: 'whatever' })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.side).toBeUndefined();
    expect(cursor?.align).toBeUndefined();
  });

  test('reads transition object alongside top-level scalars', () => {
    const code = wrap(`{...withCursor(Pointer, { side: 'left', transition: { type: 'spring', stiffness: 200, damping: 20 } })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.side).toBe('left');
    expect(cursor?.transition?.type).toBe('spring');
    expect(cursor?.transition?.stiffness).toBe(200);
    expect(cursor?.transition?.damping).toBe(20);
  });

  test('two cursors in different elements parse independently', () => {
    const code = `'use client';
import Pointer from '@/components/Pointer';
import Star from '@/components/Star';
import { withCursor } from '@revyme/runtime';

export default function Page() {
  return (
    <div data-id="root">
      <button data-id="a" {...withCursor(Pointer, { mode: 'follow' })}>A</button>
      <button data-id="b" {...withCursor(Star, { mode: 'replace' })}>B</button>
    </div>
  );
}
`;
    const calls = parseComponentCursorCalls(code);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.nodeId).sort()).toEqual(['a', 'b']);
    expect(calls.find((c) => c.nodeId === 'a')?.componentName).toBe('Pointer');
    expect(calls.find((c) => c.nodeId === 'b')?.componentName).toBe('Star');
  });

  test('returns null for nodes without a cursor', () => {
    const code = wrap(``);
    expect(getComponentCursorForNode(code, 'cta')).toBeNull();
  });

  test('PascalCase component is NOT flagged as a variable', () => {
    const code = wrap(`{...withCursor(Pointer, { mode: 'follow' })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.componentName).toBe('Pointer');
    expect(cursor?.isVariable).toBe(false);
  });

  test('camelCase identifier is detected and flagged as a variable', () => {
    // Cursor-as-variable case: the first arg is a destructured prop on a
    // component master, not an imported component. The parser must still
    // pick it up (so the row stays visible) AND mark it `isVariable` so the
    // tool renders the purple bound-variable pill.
    const code = wrap(`{...withCursor(myCursor, { mode: 'follow' })}`);
    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.componentName).toBe('myCursor');
    expect(cursor?.isVariable).toBe(true);
  });
});
