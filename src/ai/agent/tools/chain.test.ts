// chain.test.ts — P7 (iv): declared chains, proofs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueMutation, validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { getNodesSnapshot } from '@/code/stores/store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { getDefaultStore } from 'jotai';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ToolContext } from '@/ai/agent';
import { chainTool } from './chain';
import { restoreSnapshot } from '@/code/mutation/history';
import { ALL_TOOLS } from './index';

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  validateGeneratedCode: vi.fn(),
  // P8: les outils structure/action routent via queueToolMutation(ctx) qui
  // résout le fichier actif de la queue pour les runs non-branchés.
  getQueueActiveFilePath: vi.fn(() => 'app/page.client.tsx'),
}));

vi.mock('@/code/mutation/history', () => ({
  sealPendingHistory: vi.fn(),
  restoreSnapshot: vi.fn(),
}));

vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: vi.fn(),
}));

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

describe('chain tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGeneratedCode).mockReset();
    vi.mocked(validateGeneratedCode).mockReturnValue(null);
    vi.mocked(getNodesSnapshot).mockReset();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    getDefaultStore().set(projectVersionAtom, 7);
  });

  it('commits link by link with a manifest carrying versions', async () => {
    const result = await chainTool.execute(
      {
        steps: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
          { tool: 'set_styles', args: { node_id: '$ref:box', styles: { color: 'red' } } },
        ],
      },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.chain).toBe('ok');
    expect(data.results).toHaveLength(2);
    expect(data.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(data.ref_ids.box).toBe(data.results[0].node_id);
    expect(data.manifest).toHaveLength(2);
    expect(data.manifest.map((m: { state: string }) => m.state)).toEqual(['committed', 'committed']);
    for (const m of data.manifest) {
      expect(typeof m.versionBefore).toBe('number');
      expect(typeof m.versionAfter).toBe('number');
    }
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  it('mid-chain fault compensates committed links, pends the rest — never pseudo-success', async () => {
    const result = await chainTool.execute(
      {
        steps: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
          { tool: 'nope', args: {} },
          { tool: 'set_styles', args: { node_id: '$ref:box', styles: { color: 'red' } } },
        ],
      },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.chain).toBe('compensated');
    expect(data.failed_step).toBe(1);
    expect(data.results[0].ok).toBe(true);
    expect(data.results[1].ok).toBe(false);
    expect(data.results[2].error).toMatch(/skipped \(chain compensated/);
    expect(data.manifest.map((m: { state: string }) => m.state)).toEqual(['compensated', 'failed', 'pending']);
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
    // D-T3 reason contract: the rewind is labeled chain compensation.
    expect(vi.mocked(restoreSnapshot).mock.calls[0][1]).toMatchObject({ reason: 'chain-compensate' });
  });

  it('queue-level validation failure compensates like a tool error', async () => {
    // Baseline clean, then the link's write leaves rejected code.
    vi.mocked(validateGeneratedCode).mockReturnValueOnce(null).mockReturnValueOnce('invalid: unbalanced JSX');
    const result = await chainTool.execute(
      { steps: [{ tool: 'add_node', args: { parent_id: 'root', tag: 'div' } }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.chain).toBe('compensated');
    expect(data.manifest[0].state).toBe('failed');
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('aborted chain compensates without starting new work', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ToolContext = { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: controller.signal };
    const result = await chainTool.execute(
      { steps: [{ tool: 'add_node', args: { parent_id: 'root', tag: 'div' } }] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
  });

  it('is registered with a label and never nested in batch', async () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain('chain');
    const { TOOL_LABELS } = await import('../prompts/tool-labels');
    expect(TOOL_LABELS.chain).toBeTruthy();
    const { buildToolMap } = await import('./registry');
    const { PROPERTY_TOOLS } = await import('./semantic-property');
    const { STRUCTURE_TOOLS } = await import('./semantic-structure');
    const { ACTION_TOOLS } = await import('./action-layer');
    expect(buildToolMap([...PROPERTY_TOOLS, ...STRUCTURE_TOOLS, ...ACTION_TOOLS]).has('chain')).toBe(false);
  });
});
