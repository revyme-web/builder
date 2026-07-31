import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// NO_LAYOUT_PARENT_RELATIVE_CHILD — a container is either a LAYOUT frame
// (display:flex/grid → relative flow children) or a FREEFORM frame (no layout
// → absolute children the canvas free-drags). A relative child under a
// no-layout parent renders in flow but DRAGS as an absolute move, so the
// source stops matching the canvas. New-child-only.

const PAGE = (parentStyle: string, childTag: string) => `'use client';
import React from 'react';
import ServiceCard from '@/components/ServiceCard';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
    <div data-id="wrap" data-name="Wrap" style={{ ${parentStyle} }}>
      ${childTag}
    </div>
  </div>;
}`;

const hits = (code: string, existing: Set<string> = new Set(['root', 'wrap'])) =>
  checkFile(code, { kind: 'page', existingDataIds: existing }).filter((x) => x.code === 'NO_LAYOUT_PARENT_RELATIVE_CHILD');

describe('NO_LAYOUT_PARENT_RELATIVE_CHILD — no-layout parents demand absolute children', () => {
  it('a relative child of a block (no display) parent bounces', () => {
    const vs = hits(PAGE(
      "position: 'relative', width: '100%', height: 'auto', order: '0'",
      `<div data-id="card" data-name="Card" style={{ position: 'relative', width: '100%', height: '200px' }}></div>`,
    ));
    expect(vs).toHaveLength(1);
    expect(vs[0].elementId).toBe('card');
    expect(vs[0].tier).toBe(2);
  });

  it('a COMPONENT INSTANCE with position relative under a block parent bounces too', () => {
    const vs = hits(PAGE(
      "position: 'relative', width: '100%', height: 'auto', order: '0'",
      `<ServiceCard data-id="card-inst" data-name="Card" style={{ position: 'relative', width: '100%', height: '400px' }} />`,
    ));
    expect(vs).toHaveLength(1);
    expect(vs[0].elementId).toBe('card-inst');
  });

  it('the same child under a display:flex parent passes', () => {
    expect(hits(PAGE(
      "position: 'relative', width: '100%', height: 'auto', order: '0', display: 'flex', flexDirection: 'column'",
      `<div data-id="card" data-name="Card" style={{ position: 'relative', width: '100%', height: '200px', flex: '0 0 auto' }}></div>`,
    ))).toHaveLength(0);
  });

  it('an absolute + pinned child under a block parent passes (freeform is correct there)', () => {
    expect(hits(PAGE(
      "position: 'relative', width: '100%', height: '400px'",
      `<div data-id="badge" data-name="Badge" data-pinned="true" style={{ position: 'absolute', left: '10px', top: '10px', width: '40px', height: '40px' }}></div>`,
    ))).toHaveLength(0);
  });

  it('a position-less child (in-flow by default) under a block parent bounces', () => {
    expect(hits(PAGE(
      "position: 'relative', width: '100%', height: 'auto'",
      `<div data-id="card" data-name="Card" style={{ width: '100%', height: '200px' }}></div>`,
    ))).toHaveLength(1);
  });

  it('pre-existing children are never flagged (new-node gate)', () => {
    expect(hits(PAGE(
      "position: 'relative', width: '100%', height: 'auto'",
      `<div data-id="card" data-name="Card" style={{ position: 'relative', width: '100%', height: '200px' }}></div>`,
    ), new Set(['root', 'wrap', 'card']))).toHaveLength(0);
  });

  it('an expression display on the parent is indeterminate — skipped', () => {
    expect(hits(PAGE(
      "position: 'relative', width: '100%', display: cond ? 'flex' : 'block'",
      `<div data-id="card" data-name="Card" style={{ position: 'relative', width: '100%', height: '200px' }}></div>`,
    ))).toHaveLength(0);
  });
});
