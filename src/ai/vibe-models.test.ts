import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import {
  fetchVibeModels, resetVibeModelCache, vibeModelLabel, groupByVendor,
  FALLBACK_MODELS, FALLBACK_DEFAULT, type VibeModel,
} from './vibe-models';

const LIVE: VibeModel[] = [
  { id: 'anthropic/claude-fable-5', label: 'Claude Fable 5', vendor: 'anthropic', tier: 'best' },
  { id: 'google/gemini-9-flash', label: 'Gemini 9 Flash', vendor: 'google', tier: 'fast' },
];

describe('vibeModelLabel', () => {
  it('resolves a known id to its label', () => {
    expect(vibeModelLabel('anthropic/claude-fable-5', FALLBACK_MODELS)).toBe('Claude Fable 5');
  });

  it('falls back to the slug tail for an id the catalog no longer lists', () => {
    expect(vibeModelLabel('vendor/next-gen-9000', FALLBACK_MODELS)).toBe('next-gen-9000');
  });

  it("empty selection ('' → undefined) shows the default model's label", () => {
    const defaultLabel = FALLBACK_MODELS.find((m) => m.id === FALLBACK_DEFAULT)!.label;
    expect(vibeModelLabel(undefined, FALLBACK_MODELS)).toBe(defaultLabel);
  });
});

describe('groupByVendor', () => {
  it('groups in stable vendor order and drops empty vendors', () => {
    const groups = groupByVendor(LIVE);
    expect(groups.map((g) => g.vendor)).toEqual(['anthropic', 'google']); // no openai group
    expect(groups[0]!.label).toBe('Claude');
    expect(groups[1]!.models[0]!.id).toBe('google/gemini-9-flash');
  });

  it('covers all three vendors with the fallback catalog', () => {
    expect(groupByVendor(FALLBACK_MODELS).map((g) => g.vendor)).toEqual(['anthropic', 'openai', 'google']);
  });
});

describe('fetchVibeModels', () => {
  beforeEach(() => resetVibeModelCache());
  afterEach(() => vi.unstubAllGlobals());

  it('returns the live catalog and caches it (one fetch per session)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: LIVE, defaultModel: 'google/gemini-9-flash' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchVibeModels();
    const second = await fetchVibeModels();
    expect(first.models).toEqual(LIVE);
    expect(first.defaultModel).toBe('google/gemini-9-flash');
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static mirror on failure WITHOUT caching it', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('service down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchVibeModels();
    expect(result.models).toEqual(FALLBACK_MODELS);
    expect(result.defaultModel).toBe(FALLBACK_DEFAULT);

    // next call retries the service instead of serving the cached failure
    await fetchVibeModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an empty models array as a failure shape and uses the mirror', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [], defaultModel: '' }),
    }));
    const result = await fetchVibeModels();
    expect(result.models).toEqual(FALLBACK_MODELS);
    expect(result.defaultModel).toBe(FALLBACK_DEFAULT);
  });
});
