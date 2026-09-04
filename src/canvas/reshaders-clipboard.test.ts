// reshaders-clipboard.test.ts — the hidden text/html envelope reshaders
// writes for "Copy code component": extracted from the raw single-quoted
// form and from Chrome's sanitized double-quoted, entity-encoded form.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));

import { extractReshadersEnvelopeFromHtml } from './reshaders-clipboard';

const envelope = {
  revymeClipboard: 1,
  data: { version: 1, timestamp: 1, nodes: [{ id: 'a', type: 'Glow', name: "Glow 'n' go", styles: {} }], components: [{ tagName: 'Glow', masterPath: 'components/Glow.tsx', kind: 'code', files: [] }] },
};
const json = JSON.stringify(envelope);

describe('extractReshadersEnvelopeFromHtml', () => {
  it('reads the raw single-quoted form reshaders writes', () => {
    const html = `<meta charset="utf-8"><span data-revyme-clipboard='${json.replace(/'/g, '&#39;')}' style="display:none"></span>`;
    const env = extractReshadersEnvelopeFromHtml(html);
    expect(env?.revymeClipboard).toBe(1);
    expect(env?.data.nodes[0].name).toBe("Glow 'n' go");
  });
  it('reads the sanitized double-quoted, entity-encoded form Chrome returns', () => {
    const encoded = json.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const html = `<span data-revyme-clipboard="${encoded}"></span>`;
    const env = extractReshadersEnvelopeFromHtml(html);
    expect(env?.data.components?.[0].tagName).toBe('Glow');
  });
  it('ignores html without the marker, and non-envelopes', () => {
    expect(extractReshadersEnvelopeFromHtml('<span data-revyme-import="{}"></span>')).toBeNull();
    expect(extractReshadersEnvelopeFromHtml(`<span data-revyme-clipboard='{"hello":1}'></span>`)).toBeNull();
    expect(extractReshadersEnvelopeFromHtml('')).toBeNull();
  });
});
