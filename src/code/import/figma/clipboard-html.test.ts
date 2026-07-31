// clipboard-html.test.ts — payload extraction must survive BOTH clipboard
// forms: the plugin's raw single-quoted attribute, and Chrome's sanitized
// re-serialization (async clipboard.read() re-parses html and emits
// double-quoted attributes with entity-encoded values) — the live find
// 2026-07-14: the regex-only extractor missed the sanitized form, so the
// paste fell through to the internal clipboard and re-pasted the user's
// previous node.

import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { extractFigmaPayloadFromHtml } from './clipboard-html';

const PAYLOAD = {
  version: '5.0',
  source: 'figma-plugin',
  nodes: [{ id: 'a', name: "Nk's Frame", kind: 'div', styles: { width: '10px' }, children: [] }],
  rootNodeIds: ['a'],
};

const rawPluginHtml = () => {
  const json = JSON.stringify(PAYLOAD).replace(/'/g, '&#39;');
  return `<meta charset="utf-8"><span data-revyme-import='${json}' style="display:none"></span>`;
};

const chromeSanitizedHtml = () => {
  // Chrome re-serializes: double-quoted attrs, values entity-encoded.
  const json = JSON.stringify(PAYLOAD)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<span data-revyme-import="${json}" style="display: none;"></span>`;
};

describe('extractFigmaPayloadFromHtml', () => {
  it("parses the plugin's raw single-quoted form", () => {
    const p = extractFigmaPayloadFromHtml(rawPluginHtml());
    expect(p).not.toBeNull();
    expect(p!.nodes).toHaveLength(1);
    expect(p!.nodes[0].name).toBe("Nk's Frame");
  });

  it("parses Chrome's sanitized double-quoted entity-encoded form", () => {
    const p = extractFigmaPayloadFromHtml(chromeSanitizedHtml());
    expect(p).not.toBeNull();
    expect(p!.rootNodeIds).toEqual(['a']);
    expect(p!.nodes[0].name).toBe("Nk's Frame");
  });

  it('rejects html without the marker', () => {
    expect(extractFigmaPayloadFromHtml('<div>hello</div>')).toBeNull();
  });

  it('rejects marker html whose json is not a plugin payload', () => {
    expect(extractFigmaPayloadFromHtml(`<span data-revyme-import='{"foo":1}'></span>`)).toBeNull();
  });
});
