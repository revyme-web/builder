// figma-paste.test.ts — the post-convert asset-upload sweep: dedupe, pooled
// uploads, per-upload progress (drives the import toast's "Importing images…
// n/N"), and the never-lose-content failure fallback.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => ({
  toast: { loading: vi.fn(() => 'toast-1'), success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/backend', () => ({ backend: { uploadAsset: vi.fn() } }));
vi.mock('@/backend/project-id', () => ({ getProjectId: () => 'proj-1' }));
vi.mock('@/backend/autosave', () => ({ flushSaveNow: vi.fn(async () => {}) }));
vi.mock('@/code/stores/fresh-site-store', () => ({ setTemplatePromptArmed: vi.fn() }));
vi.mock('@/code/mutation/mutation-queue', () => ({ flushNow: vi.fn() }));
vi.mock('@/code/features/paste-engine', () => ({ executePaste: vi.fn() }));
vi.mock('@/code/import/figma/convert', () => ({ convertFigmaPayload: vi.fn() }));
vi.mock('@/code/import/figma/clipboard-html', () => ({ extractFigmaPayloadFromHtml: vi.fn() }));
vi.mock('./transform', () => ({ transformManager: { getTransform: vi.fn() } }));
vi.mock('./node-ops', () => ({
  getInteractingViewport: vi.fn(() => ({ vpId: '' })),
  getActiveFilePath: vi.fn(() => '/page.tsx'),
}));
vi.mock('@/code/stores/viewport-store', () => ({ getViewportWidths: vi.fn(() => []) }));
vi.mock('@/code/stores/store', () => ({ selectedIdsAtom: {}, nodesAtom: {} }));
vi.mock('@/shared/font-loader', () => ({ loadGoogleFont: vi.fn() }));
vi.mock('@/code/project/preset-ops', () => ({ ensureGoogleFontImport: vi.fn() }));

import { uploadClipboardAssets } from './figma-paste';
import { backend } from '@/backend';
import { toast } from 'sonner';

// Valid base64 PNG headers (magic bytes pass sniffImageMime) — distinct strings
// so they count as distinct assets.
const PNG_A = 'data:image/png;base64,iVBORw0KGgo=';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAA=';

const node = (id: string, dataUrl?: string): { id: string; styles: Record<string, string> } => ({
  id,
  styles: dataUrl ? { backgroundImage: `url(${dataUrl})` } : {},
});

beforeEach(() => {
  vi.mocked(backend.uploadAsset).mockReset();
  vi.mocked(toast.error).mockClear();
});

describe('uploadClipboardAssets', () => {
  it('uploads each unique data URL, swaps refs, and reports n/N progress', async () => {
    vi.mocked(backend.uploadAsset).mockImplementation(
      async (_pid: string, file: File) => `https://cdn/${file.name}`,
    );
    const a = node('n1', PNG_A);
    const b = node('n2', PNG_B);
    const progress: Array<[number, number]> = [];
    await uploadClipboardAssets({ nodes: [a, b] }, (done, total) => progress.push([done, total]));

    expect(backend.uploadAsset).toHaveBeenCalledTimes(2);
    expect(a.styles.backgroundImage).toBe('url(https://cdn/figma-n1.png)');
    expect(b.styles.backgroundImage).toBe('url(https://cdn/figma-n2.png)');
    // (0,2) seed, one tick per settled upload, ending complete.
    expect(progress.length).toBe(3);
    expect(progress[0]).toEqual([0, 2]);
    expect(progress[2]).toEqual([2, 2]);
  });

  it('dedupes identical data URLs — one upload, every reference swapped, total reflects it', async () => {
    vi.mocked(backend.uploadAsset).mockResolvedValue('https://cdn/one.png');
    const a = node('n1', PNG_A);
    const b = node('n2', PNG_A);
    const progress: Array<[number, number]> = [];
    await uploadClipboardAssets({ nodes: [a, b] }, (done, total) => progress.push([done, total]));

    expect(backend.uploadAsset).toHaveBeenCalledTimes(1);
    expect(a.styles.backgroundImage).toBe('url(https://cdn/one.png)');
    expect(b.styles.backgroundImage).toBe('url(https://cdn/one.png)');
    expect(progress).toEqual([[0, 1], [1, 1]]);
  });

  it('a failed upload keeps the inline data URL and raises the kept-inline toast', async () => {
    vi.mocked(backend.uploadAsset).mockRejectedValue(new Error('500'));
    const a = node('n1', PNG_A);
    await uploadClipboardAssets({ nodes: [a] });

    expect(a.styles.backgroundImage).toBe(`url(${PNG_A})`); // content never lost
    expect(toast.error).toHaveBeenCalledWith("1 image couldn't upload — kept inline");
  });

  it('no data URLs → no uploads, no progress ticks', async () => {
    const a = node('n1');
    const b = { id: 'n2', styles: { backgroundImage: 'url(https://already-hosted.png)' } };
    const progress: Array<[number, number]> = [];
    await uploadClipboardAssets({ nodes: [a, b] }, (done, total) => progress.push([done, total]));

    expect(backend.uploadAsset).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
  });
});
