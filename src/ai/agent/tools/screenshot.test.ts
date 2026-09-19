// src/ai/agent/tools/screenshot.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentToolResult } from '@/ai/agent';

vi.mock('./wait-for-render', () => ({
  waitForRender: vi.fn(),
}));

vi.mock('@/canvas/canvas-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/canvas/canvas-bridge')>();
  return { ...actual, getCanvasBridge: vi.fn() };
});

vi.mock('@/canvas/node-ops', () => ({
  findNodeRect: vi.fn(),
  getViewportPrefix: vi.fn((vp: string) => vp),
}));

vi.mock('@/shared/debug-trace', () => ({
  trace: { fn: vi.fn(), action: vi.fn(), error: vi.fn(), dom: vi.fn(), before: vi.fn(), after: vi.fn() },
}));

import { waitForRender } from './wait-for-render';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { findNodeRect, getViewportPrefix } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';
import { getScreenshotTool } from './screenshot';
import { ALL_TOOLS } from './index';

const mockBridge = {
  captureElement: vi.fn(),
};

describe('get_screenshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    vi.mocked(findNodeRect).mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);
    vi.mocked(getViewportPrefix).mockImplementation((vp: string) => vp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // re-apply mocks that restoreAllMocks clears
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
  });

  it('image retournée comme BLOC image (pas dans du JSON texte) ; texte résumé présent en parallèle ; width/height depuis findNodeRect', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 42, withRect: 1, ready: true } as any);
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA';
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce(dataUrl);
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1280, height: 720 } as DOMRect);

    const result = (await (getScreenshotTool as any).execute(
      { viewport: 'desktop', pixelRatio: 1, format: 'png' },
      {} as any,
    )) as AgentToolResult;

    // Must have an image block
    const imageBlock = result.content.find((c) => c.type === 'image') as Extract<AgentToolResult['content'][number], { type: 'image' }> | undefined;
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.dataUrl).toBe(dataUrl);
    expect(imageBlock!.alt).toBe('screenshot desktop');

    // Must have a text block with JSON summary
    const textBlock = result.content.find((c) => c.type === 'text') as Extract<AgentToolResult['content'][number], { type: 'text' }> | undefined;
    expect(textBlock).toBeDefined();
    const parsed = JSON.parse(textBlock!.text);
    expect(parsed.viewport).toBe('desktop');
    expect(parsed.width).toBe(1280);
    expect(parsed.height).toBe(720);
    expect(parsed.status).toBe('ready');
    expect(parsed.waitedMs).toBe(42);
    // JSON must NOT contain the image dataUrl (it is a separate block)
    expect(textBlock!.text).not.toContain('data:image');
    expect(JSON.stringify(parsed)).not.toContain('data:image');
  });

  it('width/height depuis findNodeRect mocké sont reflétés par viewport', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce('data:image/png;base64,xxx');
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 10, y: 20, width: 375, height: 667 } as DOMRect);

    const result = await (getScreenshotTool as any).execute({ viewport: 'mobile', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;
    const text = (result.content.find((c) => c.type === 'text') as any).text as string;
    const parsed = JSON.parse(text);
    expect(parsed.width).toBe(375);
    expect(parsed.height).toBe(667);
    expect(findNodeRect).toHaveBeenCalledWith('root', 'mobile');
  });

  it('capture null → unavailable + guidance backgroundColor, pas de throw, pas de bloc image', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce(null);
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    const result = await (getScreenshotTool as any).execute({ viewport: 'mobile', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    expect(result.content.some((c) => c.type === 'image')).toBe(false);
    const text = (result.content.find((c) => c.type === 'text') as any).text as string;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('unavailable');
    expect(parsed.viewport).toBe('mobile');
    expect(text).toMatch(/backgroundColor|réessai|unavailable/i);
  });

  it('sans bridge captureElement → unavailable + guidance, JAMAIS de vide silencieux', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(getCanvasBridge).mockReturnValue({} as any); // no captureElement
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 800, height: 600 } as DOMRect);

    const result = await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    expect(result.content.length).toBeGreaterThan(0);
    const text = (result.content.find((c) => c.type === 'text') as any).text as string;
    expect(JSON.parse(text).status).toBe('unavailable');
    expect(text).toMatch(/backgroundColor|réessai|unavailable/i);
  });

  it('rendu non prêt → pending, pas d\'image partielle, conseil présent', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'pending', waitedMs: 800, withRect: 0, ready: false } as any);
    // capture should NOT be called
    const result = await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    expect(mockBridge.captureElement).not.toHaveBeenCalled();
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
    const text = (result.content.find((c) => c.type === 'text') as any).text as string;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('pending');
    expect(parsed.waitedMs).toBe(800);
    expect(text).toMatch(/pending|attendez|réessayez|wait/i);
  });

  it('waitForRender unavailable viewport → unavailable + guidance', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'unavailable', waitedMs: 0, withRect: 0, ready: false } as any);
    vi.mocked(findNodeRect).mockReturnValueOnce(null);

    const result = await (getScreenshotTool as any).execute({ viewport: 'unknown-vp', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    expect(result.content.some((c) => c.type === 'image')).toBe(false);
    const text = (result.content.find((c) => c.type === 'text') as any).text as string;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe('unavailable');
    expect(parsed.viewport).toBe('unknown-vp');
  });

  it('pixelRatio transmis au bridge', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce('data:image/png;base64,test');
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 3, format: 'png' }, {} as any);

    expect(mockBridge.captureElement).toHaveBeenCalledWith('root', 'desktop', expect.objectContaining({ pixelRatio: 3 }));
  });

  it('format jpeg transmis, backgroundColor blanc pour jpeg', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce('data:image/jpeg;base64,test');
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'jpeg' }, {} as any);

    expect(mockBridge.captureElement).toHaveBeenCalledWith('root', 'desktop', expect.objectContaining({ format: 'jpeg', backgroundColor: '#ffffff' }));
  });

  it('format png par défaut ne force pas backgroundColor', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce('data:image/png;base64,test');
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any);

    expect(mockBridge.captureElement).toHaveBeenCalledWith('root', 'desktop', expect.objectContaining({ format: 'png' }));
    const opts = vi.mocked(mockBridge.captureElement).mock.calls[0][2] as any;
    expect(opts.backgroundColor).toBeUndefined();
  });

  it('viewports array mode captures multi viewport — image+texte par viewport', async () => {
    vi.mocked(waitForRender)
      .mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any)
      .mockResolvedValueOnce({ status: 'ready', waitedMs: 5, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement)
      .mockResolvedValueOnce('data:image/png;base64,img1')
      .mockResolvedValueOnce('data:image/png;base64,img2');
    vi.mocked(findNodeRect)
      .mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect)
      .mockReturnValueOnce({ x: 0, y: 0, width: 768, height: 1024 } as DOMRect);

    const result = await (getScreenshotTool as any).execute({ viewports: ['desktop', 'tablet'], pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    expect(mockBridge.captureElement).toHaveBeenCalledTimes(2);
    expect(mockBridge.captureElement).toHaveBeenNthCalledWith(1, 'root', 'desktop', expect.anything());
    expect(mockBridge.captureElement).toHaveBeenNthCalledWith(2, 'root', 'tablet', expect.anything());
    // Should have 2 image blocks and 2 text blocks
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect(result.content.filter((c) => c.type === 'text')).toHaveLength(2);
    const images = result.content.filter((c) => c.type === 'image') as Extract<AgentToolResult['content'][number], { type: 'image' }>[];
    expect(images[0].dataUrl).toBe('data:image/png;base64,img1');
    expect(images[0].alt).toBe('screenshot desktop');
    expect(images[1].dataUrl).toBe('data:image/png;base64,img2');
    expect(images[1].alt).toBe('screenshot tablet');
    const texts = result.content.filter((c) => c.type === 'text') as Extract<AgentToolResult['content'][number], { type: 'text' }>[];
    expect(JSON.parse(texts[0].text).viewport).toBe('desktop');
    expect(JSON.parse(texts[0].text).width).toBe(1440);
    expect(JSON.parse(texts[1].text).viewport).toBe('tablet');
    expect(JSON.parse(texts[1].text).width).toBe(768);
  });

  it('viewports array partiel : un capture null → unavailable pour ce viewport seulement', async () => {
    vi.mocked(waitForRender)
      .mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any)
      .mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement)
      .mockResolvedValueOnce('data:image/png;base64,good')
      .mockResolvedValueOnce(null);
    vi.mocked(findNodeRect)
      .mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect)
      .mockReturnValueOnce({ x: 0, y: 0, width: 375, height: 667 } as DOMRect);

    const result = await (getScreenshotTool as any).execute({ viewports: ['desktop', 'mobile'], pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    // One image (desktop ready) + two texts (one ready, one unavailable)
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(result.content.filter((c) => c.type === 'text')).toHaveLength(2);
    const texts = result.content.filter((c) => c.type === 'text').map((c: any) => JSON.parse(c.text));
    expect(texts[0].status).toBe('ready');
    expect(texts[1].status).toBe('unavailable');
  });

  it('default viewport is "active" when none specified', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce('data:image/png;base64,test');
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    await (getScreenshotTool as any).execute({ pixelRatio: 1, format: 'png' }, {} as any);

    expect(waitForRender).toHaveBeenCalledWith(expect.objectContaining({ vpId: 'active' }));
    expect(mockBridge.captureElement).toHaveBeenCalledWith('root', 'active', expect.anything());
  });

  it('trace.fn screenshot:capture appelé avec vpId, bytes, status, waitedMs', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 10, withRect: 1, ready: true } as any);
    const dataUrl = 'data:image/png;base64,abc123';
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce(dataUrl);
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any);

    expect(trace.fn).toHaveBeenCalledWith('screenshot:capture', expect.objectContaining({ vpId: 'desktop', bytes: dataUrl.length, status: 'ready', waitedMs: 10 }));
  });

  it('trace pending et unavailable aussi tracés', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'pending', waitedMs: 800, withRect: 0, ready: false } as any);
    await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any);
    expect(trace.fn).toHaveBeenCalledWith('screenshot:capture', expect.objectContaining({ vpId: 'desktop', status: 'pending', waitedMs: 800, bytes: 0 }));

    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockResolvedValueOnce(null);
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);
    await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any);
    expect(trace.fn).toHaveBeenCalledWith('screenshot:capture', expect.objectContaining({ vpId: 'desktop', status: 'unavailable', bytes: 0 }));
  });

  it('enregistrement présent dans ALL_TOOLS', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_screenshot');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_screenshot');
    expect(tool!.category).toBe('meta');
  });

  it('JAMAIS de throw, JAMAIS de vide silencieux même en erreur', async () => {
    vi.mocked(waitForRender).mockRejectedValueOnce(new Error('boom'));
    const result = await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe('text');
  });

  it('captureElement qui throw (taint) → unavailable propre, pas de throw', async () => {
    vi.mocked(waitForRender).mockResolvedValueOnce({ status: 'ready', waitedMs: 0, withRect: 1, ready: true } as any);
    vi.mocked(mockBridge.captureElement).mockRejectedValueOnce(new Error('tainted canvas'));
    vi.mocked(findNodeRect).mockReturnValueOnce({ x: 0, y: 0, width: 1440, height: 900 } as DOMRect);

    const result = await (getScreenshotTool as any).execute({ viewport: 'desktop', pixelRatio: 1, format: 'png' }, {} as any) as AgentToolResult;

    expect(result.content.some((c) => c.type === 'image')).toBe(false);
    const text = (result.content.find((c) => c.type === 'text') as any).text as string;
    expect(JSON.parse(text).status).toBe('unavailable');
    expect(text).toMatch(/backgroundColor|réessai|unavailable/i);
  });
});

// NOTE: the fork's second describe block here — vision gating against
// SYSTEM_PROMPT and a fake provider driven through runUnifiedTurn — tests the
// BRAIN (system prompt + turn loop), which lives in the ai-generator service,
// not in the builder. It is re-created there against the same tool contract;
// what stays here is the tool's own behaviour.
