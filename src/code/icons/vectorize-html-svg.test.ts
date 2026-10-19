import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sandbox layout needs a real browser; here the unwrapping is mocked and
// the test pins what the DROP does with its answer (user report 2026-10-19:
// an exported logo dropped back in became an empty vector).
const vectorize = vi.fn();
vi.mock('./vectorize-html-svg', async (orig) => ({
  ...(await orig<typeof import('./vectorize-html-svg')>()),
  vectorizeHtmlSvg: (text: string) => vectorize(text),
}));

import { preflightSvgFiles } from './create-vector-set-from-svgs';
import { describeVectorizeFailure } from './vectorize-html-svg';

const realVectorize = async (text: string) =>
  (await vi.importActual<typeof import('./vectorize-html-svg')>('./vectorize-html-svg')).vectorizeHtmlSvg(text);

const SNAPSHOT = '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="70" viewBox="0 0 210 70"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></div></foreignObject></svg>';
const file = (name: string, text: string) => new File([text], name, { type: 'image/svg+xml' });

describe('preflightSvgFiles — an HTML-snapshot SVG comes in as vectors', () => {
  beforeEach(() => vectorize.mockReset());

  it('is unwrapped and the VECTOR markup is what gets imported', async () => {
    vectorize.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 70"><g transform="matrix(1 0 0 1 0 0)"><path d="M0 0h10v10z" fill="rgb(0, 0, 0)"/></g></svg>' });
    const r = await preflightSvgFiles([file('Frame@1x.svg', SNAPSHOT)]);
    expect(r.skipped).toEqual([]);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0].text).toContain('<path d="M0 0h10v10z"');
    expect(r.valid[0].text).not.toContain('foreignObject');
  });

  it('one with no vector form is skipped with a reason, never an empty vector', async () => {
    vectorize.mockResolvedValue({ reason: 'text' });
    const r = await preflightSvgFiles([file('Frame@1x.svg', SNAPSHOT)]);
    expect(r.valid).toEqual([]);
    expect(r.skipped[0].reason).toContain('live text');
  });

  it('ordinary SVGs never go through the unwrapper', async () => {
    const r = await preflightSvgFiles([file('icon.svg', '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>')]);
    expect(vectorize).not.toHaveBeenCalled();
    expect(r.valid).toHaveLength(1);
  });
});

describe('vectorizeHtmlSvg — input it refuses before any layout', () => {
  it('non-SVG / no foreignObject', async () => {
    expect(await realVectorize('<html/>')).toEqual({ reason: 'unparseable' });
    expect(await realVectorize('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0"/></svg>')).toEqual({ reason: 'no-foreign-object' });
  });

  it('failure reasons read as something the user can act on', () => {
    expect(describeVectorizeFailure('text')).toContain('live text');
    expect(describeVectorizeFailure('html-img')).toContain('raster image');
    expect(describeVectorizeFailure('box-box-shadow')).toContain('box-shadow');
  });
});
