import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

const PAGE = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';
import blog from '@/cms/blog.json';

export default function Page() {
  const item = blog[0];
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
${body}
</div>
  );
}`;

const count = (body: string) =>
  checkFile(PAGE(body), { kind: 'page' }).filter((x) => x.code === 'DANGEROUS_INNER_HTML').length;

describe('CMS content binds to text nodes, never dangerouslySetInnerHTML', () => {
  it('dangerouslySetInnerHTML bounces (does not resolve in the builder)', () => {
    expect(count(`<div data-id="field-body" data-name="Body" style={{ position: 'relative' }} dangerouslySetInnerHTML={{ __html: item.body }} />`)).toBe(1);
  });
  it('flags it regardless of attribute order', () => {
    expect(count(`<div data-id="field-body" dangerouslySetInnerHTML={{ __html: item.body }} data-name="Body" style={{ position: 'relative' }} />`)).toBe(1);
  });
  it('a TEXT NODE bound to the field is the correct, passing shape', () => {
    expect(count(`<p data-id="field-body" data-name="Body" style={{ position: 'relative', fontSize: '17px', color: '#fff' }}>{item.body}</p>`)).toBe(0);
  });
  it('no dynamic content at all → not flagged', () => {
    expect(count(`<p data-id="t" data-name="Text" style={{ position: 'relative' }}>Hi</p>`)).toBe(0);
  });
});
