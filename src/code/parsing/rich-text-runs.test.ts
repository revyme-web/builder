// rich-text-runs.test.ts — run extraction + surgery on mixed-content inner JSX.

import { describe, it, expect, vi } from 'vitest';
import { extractTextRuns, replaceRunWithText, replaceRunWithCall, escapeJsxText, nodeInnerSpan, RUN_KEY_RE } from './rich-text-runs';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

const INNER = `I'm <span style={{
        color: 'var(--color-primary)'
      }}>Jenny,</span><br />Product Designer`;

describe('extractTextRuns', () => {
  it('extracts bare text + span inner text in document order', () => {
    const runs = extractTextRuns(INNER);
    expect(runs.map(r => r.text)).toEqual(["I'm", 'Jenny,', 'Product Designer']);
    expect(runs.every(r => r.key === null)).toBe(true);
    // offsets round-trip: slicing the inner string at each run yields its text
    for (const r of runs) expect(INNER.slice(r.start, r.end)).toBe(r.text);
  });

  it('captures existing {t(key)} runs with their persisted key', () => {
    const inner = `I'm <span style={{ color: 'red' }}>{t('p-1__r1')}</span> done`;
    const runs = extractTextRuns(inner);
    expect(runs.map(r => [r.text, r.key])).toEqual([["I'm", null], ['', 'p-1__r1'], ['done', null]]);
  });

  it('recurses through nested marks and skips whitespace-only segments', () => {
    const inner = `<span><b>Bold</b> tail</span>\n  `;
    const runs = extractTextRuns(inner);
    expect(runs.map(r => r.text)).toEqual(['Bold', 'tail']);
  });

  it('returns [] on unparseable input', () => {
    expect(extractTextRuns('<span')).toEqual([]);
  });
});

describe('run surgery', () => {
  it('replaceRunWithText splices in place, entity-escaping unsafe chars', () => {
    const runs = extractTextRuns(INNER);
    const out = replaceRunWithText(INNER, runs[1], 'Jenny <3 {css}');
    expect(out).toContain(`>Jenny &lt;3 &#123;css&#125;</span>`);
    expect(out).toContain("I'm <span");
    expect(out).toContain('Product Designer');
  });

  it('replaceRunWithCall swaps the run for a translation call', () => {
    const runs = extractTextRuns(INNER);
    const out = replaceRunWithCall(INNER, runs[2], 'p-x__r2');
    expect(out).toContain(`<br />{t('p-x__r2')}`);
    expect(out).not.toContain('Product Designer');
  });

  it('escapeJsxText escapes &, angle brackets and braces', () => {
    expect(escapeJsxText('a & <b> {c}')).toBe('a &amp; &lt;b&gt; &#123;c&#125;');
  });
});

describe('nodeInnerSpan', () => {
  it('locates the children region of a node in a full file', () => {
    const code = `export default function P() {
  return <div data-id="root"><p data-id="rich">Hi <span>there</span></p></div>;
}`;
    const span = nodeInnerSpan(code, 'rich');
    expect(span).toBeTruthy();
    expect(code.slice(span!.start, span!.end)).toBe('Hi <span>there</span>');
  });

  it('returns null for self-closing or missing nodes', () => {
    const code = `export default function P() { return <img data-id="i" />; }`;
    expect(nodeInnerSpan(code, 'i')).toBeNull();
    expect(nodeInnerSpan(code, 'nope')).toBeNull();
  });
});

describe('RUN_KEY_RE', () => {
  it('splits host id and index; leaves plain ids alone', () => {
    expect(RUN_KEY_RE.exec('p-ms6-1c__r2')?.slice(1)).toEqual(['p-ms6-1c', '2']);
    expect(RUN_KEY_RE.exec('p-ms6-1c')).toBeNull();
  });
});
