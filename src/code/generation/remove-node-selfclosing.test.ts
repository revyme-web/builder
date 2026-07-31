import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { removeNodeInCode } from './generator-crud';
import { parse } from '@babel/parser';

function parses(src: string): boolean {
  try { parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; }
  catch { return false; }
}

const PAGE = (body: string) => `'use client';
import React from 'react';
export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative' }}>
${body}
</div>
  );
}`;

// A card whose descendants include SELF-CLOSING <div/> of the SAME tag (dot
// clusters, progress bars) — the exact shape that broke the string-based
// closing-tag depth matcher (it counted each `<div … />` as an unmatched open).
const CARD = `      <div data-id="card" data-name="Card" style={{ display: 'flex', flexDirection: 'column' }}>
        <div data-id="progress" style={{ display: 'flex' }}>
          <div data-id="pb0" style={{ width: '3px' }} />
          <div data-id="pb1" style={{ width: '3px' }} />
          <div data-id="pb2" style={{ width: '3px' }} />
        </div>
        <div data-id="dots" style={{ display: 'flex' }}>
          <div data-id="d0" style={{ width: '4px' }} />
          <div data-id="d1" style={{ width: '4px' }} />
        </div>
      </div>`;

describe('removeNodeInCode — self-closing same-tag children', () => {
  it('deletes a container full of self-closing <div/> children → valid JSX, node gone, siblings intact', () => {
    const code = PAGE(`${CARD}\n      <p data-id="after" style={{ margin: 0 }}>After</p>`);
    const out = removeNodeInCode(code, 'card');
    expect(out).not.toBe(code);              // actually changed — NOT a silent revert
    expect(parses(out)).toBe(true);          // NOT unterminated JSX
    expect(out).not.toContain('data-id="card"');
    expect(out).not.toContain('data-id="pb0"');
    expect(out).not.toContain('data-id="d1"');
    expect(out).toContain('data-id="after"'); // sibling survives
    expect(out).toContain('data-id="root"');  // parent survives
  });

  it('deletes one self-closing child without eating its siblings', () => {
    const code = PAGE(CARD);
    const out = removeNodeInCode(code, 'pb1');
    expect(parses(out)).toBe(true);
    expect(out).not.toContain('data-id="pb1"');
    expect(out).toContain('data-id="pb0"');
    expect(out).toContain('data-id="pb2"');
    expect(out).toContain('data-id="card"');
  });
});
