import { describe, it, expect } from 'vitest';
import { checkFile, type FileKind } from './check-file';

// A page's data-id="root" collides with the template root in the canvas node map,
// so styling it (padding/background) is dropped on the canvas (renders live →
// mismatch). TEMPLATED_PAGE_ROOT_STYLED bounces it — but ONLY for a page inside a
// route group, never a plain page or the template LayoutClient itself.

const CANVAS = `/** @canvas {"viewports":[{"id":"desktop","label":"Desktop","width":1440,"isPrimary":true,"order":0}],"positions":{"desktop":{"x":0,"y":0}}} */`;

const page = (rootStyle: string) => `'use client';
${CANVAS}
export default function Page() {
  return <div data-id="root" data-name="Doc Page" style={${rootStyle}}>
    <div data-id="doc" data-name="Document" style={{ position: 'relative', width: '100%', height: 'auto' }}>
      <p data-id="title" data-name="Title" style={{ position: 'relative', width: 'auto', height: 'auto', margin: '0' }}>Privacy Policy</p>
    </div>
  </div>;
}`;

const BARE_ROOT = `{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }`;
const PADDED_ROOT = `{ position: 'relative', width: '100%', height: 'auto', padding: '140px 24px 120px' }`;
const BG_ROOT = `{ position: 'relative', width: '100%', height: 'auto', backgroundColor: '#000000' }`;

const codes = (code: string, opts: { kind: FileKind; path?: string }) => checkFile(code, opts).map((x) => x.code);
const TEMPLATED = 'app/(Body)/privacy/page.client.tsx';

describe('TEMPLATED_PAGE_ROOT_STYLED', () => {
  it('bounces padding on a templated page root', () => {
    expect(codes(page(PADDED_ROOT), { kind: 'page', path: TEMPLATED })).toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('bounces a background on a templated page root', () => {
    expect(codes(page(BG_ROOT), { kind: 'page', path: TEMPLATED })).toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('bounces overflowX on a templated page root (the double-scrollbar prop)', () => {
    const OVERFLOW_ROOT = `{ position: 'relative', width: '100%', height: 'auto', overflowX: 'hidden' }`;
    expect(codes(page(OVERFLOW_ROOT), { kind: 'page', path: TEMPLATED })).toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('bounces minHeight on a templated page root', () => {
    const MINH_ROOT = `{ position: 'relative', width: '100%', height: 'auto', minHeight: '100vh' }`;
    expect(codes(page(MINH_ROOT), { kind: 'page', path: TEMPLATED })).toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('passes a bare templated page root (padding lives on the doc)', () => {
    expect(codes(page(BARE_ROOT), { kind: 'page', path: TEMPLATED })).not.toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('does NOT fire on a PLAIN (non-templated) page — its root IS the artboard', () => {
    expect(codes(page(PADDED_ROOT), { kind: 'page', path: 'app/about/page.client.tsx' })).not.toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('does NOT fire on the template LayoutClient itself (it owns the root)', () => {
    expect(codes(page(PADDED_ROOT), { kind: 'template', path: 'app/(Body)/LayoutClient.tsx' })).not.toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('does NOT fire without a path (kind-only check)', () => {
    expect(codes(page(PADDED_ROOT), { kind: 'page' })).not.toContain('TEMPLATED_PAGE_ROOT_STYLED');
  });

  it('names the offending props in the message', () => {
    const vs = checkFile(page(PADDED_ROOT), { kind: 'page', path: TEMPLATED });
    const msg = vs.find((x) => x.code === 'TEMPLATED_PAGE_ROOT_STYLED')!.message;
    expect(msg).toContain('padding');
    expect(msg).toContain('Document');
  });
});
