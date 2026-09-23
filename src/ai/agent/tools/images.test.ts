import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { searchImagesTool } from './images';
import { ALL_TOOLS } from './index';
import { buildToolManifest } from '../tool-manifest';
import { foldActivity } from '@/editor/agent/activity';
import type { ToolContext } from '@/ai/agent';

const ctx: ToolContext = { ensureCheckpoint: () => { throw new Error('a search must never arm the checkpoint'); }, vpWidth: 1440, signal: new AbortController().signal };
const reply = (body: unknown, ok = true, status = 200) => vi.fn(async () => ({ ok, status, json: async () => body }));
const run = async (args: Record<string, unknown>) => {
  const r = await searchImagesTool.execute(args, ctx);
  const first = r.content[0];
  return { isError: !!r.isError, data: JSON.parse(first.type === 'text' ? first.text : '{}') };
};
afterEach(() => vi.unstubAllGlobals());

describe('search_images', () => {
  it('asks the SERVICE — the Unsplash key never comes near the tab', async () => {
    const fetchMock = reply({ success: true, results: [{ url: 'https://images.unsplash.com/photo-1?w=800', alt: 'latte art' }] });
    vi.stubGlobal('fetch', fetchMock);
    const out = await run({ query: 'latte art, warm light', count: 3, orientation: 'portrait', width: 800 });
    const url = String((fetchMock.mock.calls as unknown as string[][])[0][0]);
    expect(url).toContain('/api/agent/images?');
    expect(url).toContain('query=latte+art%2C+warm+light');
    expect(url).toContain('count=3');
    expect(url).toContain('orientation=portrait');
    expect(url).toContain('width=800');
    expect(url).not.toMatch(/unsplash\.com|client_id|Client-ID/i);
    expect(out).toEqual({ isError: false, data: { results: [{ url: 'https://images.unsplash.com/photo-1?w=800', alt: 'latte art' }] } });
  });

  it('is a READ — it never arms the checkpoint (the ctx above throws if it does)', async () => {
    vi.stubGlobal('fetch', reply({ success: true, results: [] }));
    await expect(run({ query: 'x' })).resolves.toBeTruthy();
  });

  // Whatever goes wrong, the model's next move must not be a made-up URL.
  it('every failure forbids inventing a URL', async () => {
    vi.stubGlobal('fetch', reply({ success: false, error: 'Image search failed (the hourly image-search limit was reached). Do NOT invent image URLs — carry on without images and say so.' }));
    expect((await run({ query: 'x' }))).toMatchObject({ isError: true, data: { error: expect.stringMatching(/NOT invent/) } });

    vi.stubGlobal('fetch', reply({}, false, 502));
    expect((await run({ query: 'x' })).data.error).toMatch(/NOT invent/);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    const down = await run({ query: 'x' });
    expect(down.isError).toBe(true);
    expect(down.data.error).toMatch(/NOT invent/);
  });

  it('no results is not an error — it is a nudge to re-word, still without inventing', async () => {
    vi.stubGlobal('fetch', reply({ success: true, results: [] }));
    const out = await run({ query: 'zxqv' });
    expect(out.isError).toBe(false);
    expect(out.data.hint).toMatch(/NOT invent/);
  });

  it('validates like the bridge does: a query is required, an odd orientation is refused', () => {
    const schema = z.object(searchImagesTool.inputSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ query: 'x' }).success).toBe(true);
    expect(schema.safeParse({ query: 'x', orientation: 'diagonal' }).success).toBe(false);
  });

  it('is on the one tool surface, serializable for the service, with snake_case arguments', () => {
    expect(ALL_TOOLS.filter((t) => t.name === 'search_images')).toHaveLength(1);
    expect(buildToolManifest().some((t) => t.name === 'search_images')).toBe(true);
    for (const key of Object.keys(searchImagesTool.inputSchema)) expect(key).toMatch(/^[a-z][a-z_]*$/);
  });

  it('teaches both places an image goes, in the description the model always sees', () => {
    expect(searchImagesTool.description).toContain("backgroundImage: 'url(<url>)'");
    expect(searchImagesTool.description).toMatch(/bare `url`/);
    expect(searchImagesTool.description).toMatch(/NEVER write an image URL from memory/);
  });

  it('reads in the transcript as looking, not as a change to the document', () => {
    const [step] = foldActivity([{ id: '1', name: 'search_images', ok: true }]);
    expect(step.kind).toBe('read');
    expect(step.label).not.toMatch(/edited|layer/i);
  });
});
