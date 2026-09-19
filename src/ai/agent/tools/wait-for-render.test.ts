import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitForRender } from './wait-for-render';
import { collectLayoutSnapshot } from './design-audit';
import { getNodesSnapshot } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';

vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: vi.fn(),
}));

vi.mock('./design-audit', () => ({
  collectLayoutSnapshot: vi.fn(),
}));

describe('waitForRender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('borne: ready précoce (rects déjà là → waitedMs < intervalle, 1 seul poll)', async () => {
    const snapshot: any[] = [
      { id: 'n1', rect: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    vi.mocked(getNodesSnapshot).mockReturnValue(snapshot as unknown as Map<string, CanvasNode>);
    vi.mocked(collectLayoutSnapshot).mockReturnValue(snapshot);

    const result = await waitForRender({
      vpId: 'desktop',
      nodeIds: ['n1'],
      timeoutMs: 5000,
      intervalMs: 500,
    });

    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
    expect(result.waitedMs).toBeLessThanOrEqual(500);
    expect(result.withRect).toBe(1);
  });

  it('timeout: aucun rect → pending après ~timeoutMs, pas de throw', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map());
    vi.mocked(collectLayoutSnapshot).mockReturnValue([]);

    await expect(
      waitForRender({
        vpId: 'desktop',
        nodeIds: ['n1'],
        timeoutMs: 200,
        intervalMs: 100,
      }),
    ).resolves.not.toThrow();

    const result = await waitForRender({
      vpId: 'desktop',
      nodeIds: ['n1'],
      timeoutMs: 200,
      intervalMs: 100,
    });

    expect(result.status).toBe('pending');
    expect(result.ready).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(200);
  });

  it('unavailable: viewport inconnu → immédiat', async () => {
    const result = await waitForRender({
      vpId: 'unknown-vp',
      timeoutMs: 1200,
      intervalMs: 100,
    });

    expect(result.status).toBe('unavailable');
    expect(result.ready).toBe(false);
    expect(result.waitedMs).toBe(0);
  });

  it('culled/ghost: nœud demandé sans rect → pending borné, jamais de deadlock', async () => {
    // Contrat borné : un helper partagé ne peut pas distinguer « pas encore
    // rendu » de « jamais » (nœud culled/ghost) — la réponse honnête est
    // pending APRÈS la borne, jamais une attente infinie ni un faux ready.
    // L'appelant (batch) traite pending comme avant (proceed + warning).
    const snapshot: any[] = [
      { id: 'n1', rect: null },
      { id: 'n2', rect: { x: 0, y: 0, width: 200, height: 200 } },
    ];
    vi.mocked(getNodesSnapshot).mockReturnValue(snapshot as unknown as Map<string, CanvasNode>);
    vi.mocked(collectLayoutSnapshot).mockReturnValue(snapshot);

    const result = await waitForRender({
      vpId: 'desktop',
      nodeIds: ['n1'],
      timeoutMs: 300,
      intervalMs: 100,
    });

    expect(result.status).toBe('pending');
    expect(result.ready).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(300);
  });

  it('no nodeIds: withRect > 0 globally → ready', async () => {
    const snapshot: any[] = [
      { id: 'n1', rect: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    vi.mocked(getNodesSnapshot).mockReturnValue(snapshot as unknown as Map<string, CanvasNode>);
    vi.mocked(collectLayoutSnapshot).mockReturnValue(snapshot);

    const result = await waitForRender({
      vpId: 'desktop',
      timeoutMs: 1200,
      intervalMs: 100,
    });

    expect(result.status).toBe('ready');
    expect(result.ready).toBe(true);
    expect(result.withRect).toBe(1);
  });

  it('P6 (T4): every verdict carries the {epoch, coverage, unmeasured} envelope', async () => {
    const snapshot: any[] = [
      { id: 'n1', rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'n2', rect: null },
    ];
    vi.mocked(getNodesSnapshot).mockReturnValue(snapshot as unknown as Map<string, CanvasNode>);
    vi.mocked(collectLayoutSnapshot).mockReturnValue(snapshot);

    const result = await waitForRender({
      vpId: 'desktop',
      nodeIds: ['n1'],
      timeoutMs: 1200,
      intervalMs: 100,
    });

    expect(result.status).toBe('ready');
    expect(result.coverage).toEqual({ withRect: 1, total: 2 });
    expect(result.unmeasured).toEqual(['n2']);
    expect(result.unmeasuredTotal).toBe(1);
    expect(result.epoch).toBeDefined();
    expect(typeof result.epoch.stale).toBe('boolean');
  });
});
