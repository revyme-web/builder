import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// NODE_MISSING_POSITION — every NEWLY-inserted styled node must declare an
// explicit `position`. Live find 2026-07-06: service rows authored without
// position → Make Component had nothing to transfer → the master root's
// absolute leaked onto the instance and the row stacked over its siblings.

const PAGE = (child: string) => `'use client';
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
    ${child}
  </div>;
}`;

const hits = (code: string, kind: 'page' | 'component' = 'page', existing: Set<string> = new Set(['root'])) =>
  checkFile(code, { kind, existingDataIds: existing }).filter((x) => x.code === 'NODE_MISSING_POSITION');

describe('NODE_MISSING_POSITION — new nodes must declare position', () => {
  it('a new styled node WITHOUT position bounces', () => {
    const code = PAGE(`<div data-id="x" data-name="X" style={{ order: '0', flex: '0 0 auto', width: '100%' }}></div>`);
    expect(hits(code)).toHaveLength(1);
  });

  it('position: relative passes', () => {
    const code = PAGE(`<div data-id="x" data-name="X" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%' }}></div>`);
    expect(hits(code)).toHaveLength(0);
  });

  it('a PRE-EXISTING node without position is exempt (new-node-only gate)', () => {
    const code = PAGE(`<div data-id="x" data-name="X" style={{ order: '0', flex: '0 0 auto' }}></div>`);
    expect(hits(code, 'page', new Set(['root', 'x']))).toHaveLength(0);
  });

  it('a COMPONENT INSTANCE without position gets the instance-specific message', () => {
    const code = PAGE(`<Card data-id="card-1" data-name="Card" style={{ order: '0', flex: '0 0 auto' }} />`);
    const found = hits(code);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('absolute');
    expect(found[0].message).toContain('...style spread');
  });

  it('a COMPONENT INSTANCE with NO style prop at all bounces too', () => {
    const code = PAGE(`<Card data-id="card-1" data-name="Card" />`);
    expect(hits(code)).toHaveLength(1);
  });

  it('svg internals and spread-carrying nodes are exempt', () => {
    const svg = PAGE(`<svg data-id="x" data-name="FIT" style={{ width: '100%', height: 'auto' }} viewBox="0 0 10 10"></svg>`);
    expect(hits(svg)).toHaveLength(0);
    const spread = PAGE(`<div data-id="x" data-name="X" style={{ order: '0', ...style }}></div>`);
    expect(hits(spread)).toHaveLength(0);
  });

  it('standalone checks (no existingDataIds) stay silent', () => {
    const code = PAGE(`<div data-id="x" data-name="X" style={{ order: '0', flex: '0 0 auto' }}></div>`);
    expect(checkFile(code, { kind: 'page' }).filter((x) => x.code === 'NODE_MISSING_POSITION')).toHaveLength(0);
  });
});
