// src/ai/agent/tools/batch.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { queueMutation, validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { getNodesSnapshot } from '@/code/stores/store';
import { projectFS } from '@/code/project/project-fs';
import type { Mutation } from '@/code/mutation/mutation-queue';
import type { CanvasNode } from '@/code/parsing/parser';
import type { ToolContext } from '@/ai/agent';
import { batchTool, checkBatchEndGate, isBatchViewportRendered } from './batch';
import { restoreSnapshot } from '@/code/mutation/history';

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  validateGeneratedCode: vi.fn(),
  // P8: les outils structure/action routent via queueToolMutation(ctx) qui
  // résout le fichier actif de la queue pour les runs non-branchés.
  getQueueActiveFilePath: vi.fn(() => 'app/page.client.tsx'),
}));

// The rollback path restores through the unique primitive — mocked here so
// batch unit tests assert the routing (real no-resurrection behavior is
// covered in restore-snapshot.test.ts with real modules).
vi.mock('@/code/mutation/history', () => ({
  sealPendingHistory: vi.fn(),
  restoreSnapshot: vi.fn(),
}));

vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: vi.fn(),
}));

type AddNodeMutation = Extract<Mutation, { type: 'addNode' }>;
type UpdateStylesMutation = Extract<Mutation, { type: 'updateStyles' }>;
type RemoveNodeMutation = Extract<Mutation, { type: 'removeNode' }>;

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

function makeAbortedCtx(): ToolContext {
  const controller = new AbortController();
  controller.abort();
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: controller.signal };
}

function mutationAt(index: number): Mutation {
  return vi.mocked(queueMutation).mock.calls[index][0] as Mutation;
}

describe('batch tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean code by default: a validation failure has to be triggered on purpose.
    vi.mocked(validateGeneratedCode).mockReset();
    vi.mocked(validateGeneratedCode).mockReturnValue(null);
    // add_node (via resolveCreateId) lit désormais getNodesSnapshot — un mock
    // throw d'un test précédent survivrait sinon (clearAllMocks ne réinitialise
    // pas les implémentations) et casserait les tests suivants.
    vi.mocked(getNodesSnapshot).mockReset();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
  });

  it('chains ref_id across add_node + set_styles, mapping to real node ids', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
          { tool: 'add_node', args: { parent_id: '$ref:box', tag: 'p' }, ref_id: 'p' },
          { tool: 'set_styles', args: { node_id: '$ref:p', styles: { color: 'red' } } },
        ],
      },
      ctx,
    );
    // Batch arms the checkpoint once; nested tools call it too (idempotent).
    expect(ctx.ensureCheckpoint).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.results).toHaveLength(3);
    for (const r of data.results) expect(r.ok).toBe(true);

    const first = mutationAt(0) as AddNodeMutation;
    const second = mutationAt(1) as AddNodeMutation;
    expect(first.type).toBe('addNode');
    expect(second.type).toBe('addNode');
    // The 2nd add_node received the real node_id created by the 1st.
    expect(second.parentId).toBe(first.node.id);
    const third = mutationAt(2) as UpdateStylesMutation;
    expect(third.type).toBe('updateStyles');
    expect(third.nodeId).toBe(second.node.id);
    expect(third.styles).toEqual({ color: 'red' });

    expect(data.ref_ids.box).toBe(first.node.id);
    expect(data.ref_ids.p).toBe(second.node.id);
    expect(data.results[0].node_id).toBe(first.node.id);
    expect(data.results[1].node_id).toBe(second.node.id);
  });

  it('reports an unknown tool without queueing anything for it', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute({ operations: [{ tool: 'nope', args: {} }] }, ctx);
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.results).toHaveLength(1);
    expect(data.results[0].ok).toBe(false);
    expect(data.results[0].error).toBe('Unknown tool');
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('rollback reason names the valid tools next to the frozen short error', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute({ operations: [{ tool: 'nope', args: {} }] }, ctx);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.reason).toBe(data.reason); // present
    expect(data.reason).toContain('Unknown tool "nope"');
    expect(data.reason).toContain('Valid tools:');
    expect(data.reason).toContain('set_styles');
    expect(data.reason).toContain('duplicate_node');
  });

  it('rejects more than 20 operations at schema validation time', () => {
    const ops = Array.from({ length: 21 }, () => ({ tool: 'set_styles', args: { node_id: 'x', styles: {} } }));
    expect(() => z.object(batchTool.inputSchema).parse({ operations: ops })).toThrow();
  });

  it('accepts exactly 20 operations', () => {
    const ops = Array.from({ length: 20 }, () => ({ tool: 'set_styles', args: { node_id: 'x', styles: {} } }));
    const parsed = z.object(batchTool.inputSchema).parse({ operations: ops });
    expect(parsed.operations).toHaveLength(20);
  });

  it('normalises model-flavoured op shapes at schema time (op/operation/tool-key/flat args)', () => {
    // E2E réel 2026-08-15 : glm-4.7-flash inventait ces formes — toutes
    // doivent être réparées en {tool, args} par le preprocess du schéma.
    const parsed = z.object(batchTool.inputSchema).parse({
      operations: [
        { op: 'add_node', parent_id: 'root', tag: 'section', styles: { padding: 64 }, ref_id: 'sec' },
        { operation: 'set_styles', args: { node_id: 'x', styles: '{"color":"red"}' } },
        { set_text: { node_id: 'y', text: 'hi' } },
      ],
    });
    const ops = parsed.operations as Array<{ tool: string; args: Record<string, unknown>; ref_id?: string }>;
    expect(ops[0]).toEqual({
      tool: 'add_node',
      args: { parent_id: 'root', tag: 'section', styles: { padding: '64' } },
      ref_id: 'sec',
    });
    expect(ops[1]).toEqual({ tool: 'set_styles', args: { node_id: 'x', styles: { color: 'red' } } });
    expect(ops[2]).toEqual({ tool: 'set_text', args: { node_id: 'y', text: 'hi' } });
  });

  it('marks the whole batch as errored when any operation fails, keeping prior results', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root' }, ref_id: 'a' },
          { tool: 'unknown', args: {} },
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.results).toHaveLength(2);
    expect(data.results[0].ok).toBe(true);
    expect(typeof data.results[0].node_id).toBe('string');
    expect(data.results[1]).toEqual({ tool: 'unknown', ok: false, error: 'Unknown tool' });
    expect(data.ref_ids.a).toBe(data.results[0].node_id);
  });

  it('leaves unresolved $ref: values untouched so the nested tool validates them', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute(
      { operations: [{ tool: 'delete_node', args: { node_id: '$ref:missing' } }] },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const m = mutationAt(0) as RemoveNodeMutation;
    expect(m.type).toBe('removeNode');
    expect(m.nodeId).toBe('$ref:missing');
  });

  it('records a nested tool error and rolls the bulk back, skipping later ops', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'duplicate_node', args: { node_id: 'ghost' } },
          { tool: 'set_text', args: { node_id: 'x', text: 'hi' } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.results[0].ok).toBe(false);
    expect(data.results[0].error).toContain('ghost');
    expect(data.results[1].tool).toBe('set_text');
    expect(data.results[1].ok).toBe(false);
    expect(data.results[1].error).toMatch(/^skipped \(bulk rolled back after ".+"\)$/);
    // The later op must NOT have run — the bulk is atomic.
    expect(vi.mocked(queueMutation)).toHaveBeenCalledTimes(0);
  });

  it('catches an execute() throw and rolls the bulk back', async () => {
    vi.mocked(getNodesSnapshot).mockImplementation(() => {
      throw new Error('boom');
    });
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'duplicate_node', args: { node_id: 'src' } },
          { tool: 'set_text', args: { node_id: 'x', text: 'hi' } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.results[0].ok).toBe(false);
    expect(data.results[0].error).toBe('boom');
    expect(data.results[1].tool).toBe('set_text');
    expect(data.results[1].ok).toBe(false);
    expect(data.results[1].error).toMatch(/^skipped \(bulk rolled back after "boom"\)$/);
    expect(vi.mocked(queueMutation)).toHaveBeenCalledTimes(0);
  });

  it('treats an aborted signal as failure: no new op starts, bulk rolled back (D-T5)', async () => {
    const ctx = makeAbortedCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' } },
          { tool: 'set_text', args: { node_id: 'x', text: 'hi' } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.reason).toMatch(/Aborted mid-batch/);
    // The aborted op carries its own entry; the rest are skipped.
    expect(data.results[0]).toEqual({
      tool: 'add_node',
      ok: false,
      error: 'Aborted mid-batch — bulk rolled back.',
    });
    expect(data.results[1].ok).toBe(false);
    expect(data.results[1].error).toMatch(/^skipped \(bulk rolled back after "/);
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(restoreSnapshot).mock.calls[0][1]).toMatchObject({ reason: 'batch-rollback' });
  });

  it('rolls back the whole bulk when the generator leaves code validateGeneratedCode rejects', async () => {
    // baseline + after op 1 clean; after op 2 the generator wrote bad code.
    vi.mocked(validateGeneratedCode)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('invalid: unbalanced JSX');
    const ctx = makeCtx();
    // The pre-batch FS state, captured before execute — the rollback must
    // restore EXACTLY this (not the post-op state, not an empty map).
    const preBatch = projectFS.getSnapshot();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'a' },
          { tool: 'add_node', args: { parent_id: '$ref:a', tag: 'p' }, ref_id: 'b' },
          { tool: 'set_styles', args: { node_id: '$ref:b', styles: { color: 'red' } } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.reason).toBe('invalid: unbalanced JSX');
    // Rollback restores through the unique primitive (Porte 5 / D-T3) — never
    // a raw loadSnapshot (which would leave the queue base stale).
    expect(restoreSnapshot).toHaveBeenCalledTimes(1);
    const [snap, opts] = vi.mocked(restoreSnapshot).mock.calls[0] as [
      Map<string, string>,
      { activeFile?: unknown; reason?: string },
    ];
    expect(snap).toBeInstanceOf(Map);
    // Identity, not just shape: the restored snapshot IS the pre-batch state.
    expect(snap).toEqual(preBatch);
    expect(opts).toMatchObject({ reason: 'batch-rollback' });
    expect(typeof opts.activeFile).toBe('string');
    expect(data.results).toHaveLength(3);
    expect(data.results[0].ok).toBe(true);
    expect(typeof data.results[0].node_id).toBe('string');
    // The failing op carries the validation message; the rest are skipped.
    expect(data.results[1]).toEqual({ tool: 'add_node', ok: false, error: 'invalid: unbalanced JSX' });
    expect(data.results[2].tool).toBe('set_styles');
    expect(data.results[2].ok).toBe(false);
    expect(data.results[2].error).toMatch(/^skipped \(bulk rolled back after "invalid: unbalanced JSX"\)$/);
  });

  it('success includes the diagnostics block (changes, id arrays, audit)', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'set_text', args: { node_id: 'x', text: 'hi' } },
          { tool: 'set_styles', args: { node_id: 'x', styles: { color: 'red' } } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('ok');
    // queueMutation is mocked so no file changes — the shapes are what matter.
    expect(Array.isArray(data.changes)).toBe(true);
    expect(data.changes).toHaveLength(0);
    expect(data.created_ids).toEqual([]);
    expect(data.modified_ids).toEqual([]);
    expect(data.removed_ids).toEqual([]);
    expect(data.audit).toBeDefined();
    expect(data.audit.viewport).toBe('desktop'); // from the default interactingViewportIdAtom
    expect(typeof data.audit.checked).toBe('number');
    expect(Array.isArray(data.audit.violations)).toBe(true);
    // P6 (T4): the audit always carries the epoch envelope, even unavailable.
    expect(data.audit.epoch).toBeDefined();
    expect(typeof data.audit.epoch.stale).toBe('boolean');
    expect(data.audit.coverage).toBeDefined();
    expect(Array.isArray(data.audit.unmeasured)).toBe(true);
    expect(typeof data.audit.unmeasuredTotal).toBe('number');
  });

  it('audit block reports status + reason for the run', async () => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
    const ctx = makeCtx();
    const result = await batchTool.execute(
      { operations: [{ tool: 'set_text', args: { node_id: 'x', text: 'hi' } }] },
      ctx,
    );
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.audit.status).toBe('unavailable'); // nothing was touched → nothing to audit
    expect(data.audit.reason).toContain('No nodes were created or modified');
    expect(typeof data.audit.checked).toBe('number');
  });

it('does not blame the batch when the active file was already invalid', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(
        new Map([['app/page.client.tsx', 'export default function Page() { return <div data-id="root"']]),
      );
      vi.mocked(validateGeneratedCode).mockReturnValue('baseline file already broken');
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [
            { tool: 'add_node', args: { parent_id: 'root', tag: 'div' } },
            { tool: 'set_styles', args: { node_id: 'x', styles: { color: 'red' } } },
          ],
        },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.bulk).toBe('ok');
      for (const r of data.results) expect(r.ok).toBe(true);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });
});

describe('batch tool — multi-viewport audit (CHANTIER C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGeneratedCode).mockReset();
    vi.mocked(validateGeneratedCode).mockReturnValue(null);
    vi.mocked(getNodesSnapshot).mockReset();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
  });

  it('audits every viewport an op explicitly wrote (set_styles viewport=375 → mobile), listed in the audit block', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(
        new Map([['app/page.client.tsx', 'export default function Page() { return <div data-id="root"><section data-id="hero" /></div>; }']]),
      );
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [
            { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
            { tool: 'set_styles', args: { node_id: '$ref:box', styles: { padding: '80px 24px' }, viewport: 375 } },
          ],
        },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.bulk).toBe('ok');
      // add_node reports a node_id → the audit ran; the mobile override the
      // batch wrote must be audited ALONGSIDE the interacting viewport.
      expect(Array.isArray(data.audit.viewports)).toBe(true);
      expect(data.audit.viewports.map((v: { id: string }) => v.id)).toEqual(['desktop', 'mobile']);
      // Backward-compat top-level fields mirror the first (interacting) entry.
      expect(data.audit.viewport).toBe('desktop');
      expect(typeof data.audit.checked).toBe('number');
      expect(Array.isArray(data.audit.violations)).toBe(true);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });

  it('audits tablet+mobile too when the batch touched a page that already carries responsive code, even without viewport args', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(
        new Map([['app/page.client.tsx', BATCH_TESTIMONIAL_PAGE.replace("import React from 'react';", "import React from 'react';\nconst __mq0 = useMediaQuery('(max-width: 768px)');")]]),
      );
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [
            { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
            { tool: 'set_styles', args: { node_id: '$ref:box', styles: { color: 'red' } } },
          ],
        },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.audit.viewports.map((v: { id: string }) => v.id)).toEqual(['desktop', 'tablet', 'mobile']);
      // The list is ordered deterministically: interacting first, then width desc.
      const mobile = data.audit.viewports.find((v: { id: string }) => v.id === 'mobile');
      expect(mobile.width).toBe(375);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });

  it('audits ONLY the interacting viewport when the batch neither names a viewport nor touches responsive code', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', BATCH_TESTIMONIAL_PAGE]]));
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [
            { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
            { tool: 'set_styles', args: { node_id: '$ref:box', styles: { color: 'red' } } },
          ],
        },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.audit.viewports.map((v: { id: string }) => v.id)).toEqual(['desktop']);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });

  it('the unavailable audit (nothing touched) still carries an empty viewports list', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', BATCH_TESTIMONIAL_PAGE]]));
      const ctx = makeCtx();
      const result = await batchTool.execute(
        { operations: [{ tool: 'set_text', args: { node_id: 'x', text: 'hi' } }] },
        ctx,
      );
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.audit.status).toBe('unavailable');
      expect(data.audit.viewports).toEqual([]);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });
});

const BATCH_TESTIMONIAL_PAGE = `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}>
      <div data-id="testimonials" data-name="Testimonials" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '24px', padding: '80px 40px' }}>
        <div data-id="testimonial-1" data-name="Card" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p data-id="testimonial-1-quote" data-name="Quote" style={{ position: 'relative', flex: '0 0 auto', order: '0' }}>Revyme is fast.</p>
          <p data-id="testimonial-1-author" data-name="Author" style={{ position: 'relative', flex: '0 0 auto', order: '1' }}>Alice Chen</p>
        </div>
        <div data-id="testimonial-2" data-name="Card" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p data-id="testimonial-2-quote" data-name="Quote" style={{ position: 'relative', flex: '0 0 auto', order: '0' }}>Shipping in hours.</p>
          <p data-id="testimonial-2-author" data-name="Author" style={{ position: 'relative', flex: '0 0 auto', order: '1' }}>Marcus Reid</p>
        </div>
      </div>
    </div>
  );
}`;

describe('batch tool — effect verdict (P5)', () => {
  beforeEach(() => {
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
  });

  it('a success batch with a request arg carries an informational effect verdict', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', BATCH_TESTIMONIAL_PAGE]]));
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [{ tool: 'set_text', args: { node_id: 'testimonial-1-quote', text: 'x' } }],
          request: 'Add a testimonials section with 2-3 cards, each with a quote and the name of the person',
        },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.bulk).toBe('ok');
      expect(data.effect).toBeDefined();
      expect(data.effect.satisfied).toBe(true);
      expect(data.effect.scope).toBe('app/page.client.tsx');
      expect(data.effect.missing).toEqual([]);
      expect(data.effect.feedback).toContain('Request satisfied');
      expect(data.effect.checks).toHaveLength(4);
      expect(data.effect.checks[0]).toMatchObject({ label: 'testimonials section', present: true });
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });

  it('the effect verdict reports NOT satisfied when structure lacks content', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      const emptyQuote = BATCH_TESTIMONIAL_PAGE.replace('<p data-id="testimonial-1-quote" data-name="Quote" style={{ position: \'relative\', flex: \'0 0 auto\', order: \'0\' }}>Revyme is fast.</p>', '<p data-id="testimonial-1-quote" data-name="Quote" style={{ position: \'relative\', flex: \'0 0 auto\', order: \'0\' }}></p>');
      expect(emptyQuote).not.toBe(BATCH_TESTIMONIAL_PAGE);
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', emptyQuote]]));
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [{ tool: 'set_text', args: { node_id: 'testimonial-1-quote', text: 'x' } }],
          request: 'Add a testimonials section with 2-3 cards, each with a quote and the name of the person',
        },
        ctx,
      );
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.effect.satisfied).toBe(false);
      expect(data.effect.missing).toEqual(['testimonial-1 quote is empty — add the quote text.']);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });

  it('the effect verdict carries a `nodes` write-path check over the batch’s own ids (P6 iv)', async () => {
    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', BATCH_TESTIMONIAL_PAGE]]));
      const ctx = makeCtx();
      const result = await batchTool.execute(
        {
          operations: [{ tool: 'add_node', args: { parent_id: 'testimonials', tag: 'div' }, ref_id: 'box' }],
          request: 'Add a testimonials section with 2-3 cards, each with a quote and the name of the person',
        },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.effect).toBeDefined();
      // The created id flows into the verdict's `nodes` check…
      expect(data.effect.nodes).toBeDefined();
      expect(data.effect.nodes.checked).toContain(data.results[0].node_id);
      // …and the queue is mocked here so the id never landed in code — the
      // check honestly reports it missing (shape proof, not satisfaction).
      expect(data.effect.nodes.missing.join('\n')).toContain(data.results[0].node_id);
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });

  it('no request arg → no effect block (non-breaking)', async () => {    const preTest = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', BATCH_TESTIMONIAL_PAGE]]));
      const ctx = makeCtx();
      const result = await batchTool.execute(
        { operations: [{ tool: 'set_text', args: { node_id: 'x', text: 'hi' } }] },
        ctx,
      );
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.bulk).toBe('ok');
      expect(data.effect).toBeUndefined();
    } finally {
      projectFS.loadSnapshot(preTest);
    }
  });
});

describe('batch tool — pure ACTION_TOOLS inside the batch', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGeneratedCode).mockReset();
    vi.mocked(validateGeneratedCode).mockReturnValue(null);
    vi.mocked(getNodesSnapshot).mockReset();
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>());
  });

  it('runs the pure ACTION_TOOLS inside the batch (set_layout/set_size/set_position/set_typography) via $ref, queuing mutations in order', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'box' },
          { tool: 'set_layout', args: { node_id: '$ref:box', display: 'flex', gap: '24px' } },
          { tool: 'set_size', args: { node_id: '$ref:box', width: '640px', height: '480px' } },
          { tool: 'set_position', args: { node_id: '$ref:box', mode: 'absolute', top: '0px' } },
          { tool: 'set_typography', args: { node_id: '$ref:box', fontSize: '32px', color: '#6366f1' } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('ok');
    expect(data.results).toHaveLength(5);
    for (const r of data.results) expect(r.ok).toBe(true);

    const created = mutationAt(0) as AddNodeMutation;
    expect(created.type).toBe('addNode');
    const boxId = created.node.id;
    // set_layout writes one updateStyles per field; the rest write one each.
    expect(mutationAt(1)).toMatchObject({ type: 'updateStyles', nodeId: boxId, styles: { display: 'flex' } });
    expect(mutationAt(2)).toMatchObject({ type: 'updateStyles', nodeId: boxId, styles: { gap: '24px' } });
    expect(mutationAt(3)).toMatchObject({
      type: 'updateStyles',
      nodeId: boxId,
      styles: { width: '640px', height: '480px' },
    });
    expect(mutationAt(4)).toMatchObject({
      type: 'updateStyles',
      nodeId: boxId,
      styles: { position: 'absolute', top: '0px' },
    });
    expect(mutationAt(5)).toMatchObject({
      type: 'updateStyles',
      nodeId: boxId,
      styles: { fontSize: '32px', color: '#6366f1' },
    });
    expect(vi.mocked(queueMutation)).toHaveBeenCalledTimes(6);

    expect(data.ref_ids.box).toBe(boxId);
    expect(data.results[2].node_id).toBe(boxId);
    expect(data.results[3].node_id).toBe(boxId);
    expect(data.results[4].node_id).toBe(boxId);
  });

  it('applies a purely-ACTION_TOOLS batch to an existing node', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'set_size', args: { node_id: 'hero', width: '320px' } },
          { tool: 'set_typography', args: { node_id: 'hero', fontSize: '24px', lineHeight: '1.5', color: '#111111' } },
          { tool: 'set_layout', args: { node_id: 'hero', display: 'block' } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('ok');
    expect(data.results).toHaveLength(3);
    for (const r of data.results) expect(r.ok).toBe(true);
    expect(data.results[0].node_id).toBe('hero');

    expect(mutationAt(0)).toMatchObject({ type: 'updateStyles', nodeId: 'hero', styles: { width: '320px' } });
    expect(mutationAt(1)).toMatchObject({
      type: 'updateStyles',
      nodeId: 'hero',
      styles: { fontSize: '24px', lineHeight: '1.5', color: '#111111' },
    });
    expect(mutationAt(2)).toMatchObject({ type: 'updateStyles', nodeId: 'hero', styles: { display: 'block' } });
    expect(vi.mocked(queueMutation)).toHaveBeenCalledTimes(3);
  });

  it('rejects a rich primitive absent from the allow-list (set_variant), rolling back and skipping the rest without extra mutations', async () => {
    const ctx = makeCtx();
    const result = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'a' },
          { tool: 'set_variant', args: { node_id: '$ref:a', variant: 'primary' } },
          { tool: 'set_layout', args: { node_id: '$ref:a', display: 'flex' } },
        ],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.bulk).toBe('rolled_back');
    expect(data.reason).toContain('Unknown tool "set_variant"');
    expect(data.results).toHaveLength(3);
    expect(data.results[0].ok).toBe(true);
    expect(data.results[1]).toEqual({ tool: 'set_variant', ok: false, error: 'set_variant cannot run inside batch — call it directly, on its own' });
    expect(data.results[2].tool).toBe('set_layout');
    expect(data.results[2].ok).toBe(false);
    expect(data.results[2].error).toMatch(/^skipped \(bulk rolled back after "Unknown tool "set_variant"\..+"\)$/);
    // Only the first op ran — the forbidden op and everything after it never
    // reached the mutation queue.
    expect(vi.mocked(queueMutation)).toHaveBeenCalledTimes(1);
    expect((mutationAt(0) as AddNodeMutation).type).toBe('addNode');
  });

  it('recovers after a rollback: a corrected batch on the same ctx succeeds and queues its own mutations', async () => {
    const ctx = makeCtx();
    const first = await batchTool.execute({ operations: [{ tool: 'set_variant', args: {} }] }, ctx);
    expect(first.isError).toBe(true);
    const firstData = JSON.parse((first.content[0] as any).text);
    expect(firstData.bulk).toBe('rolled_back');
    expect(vi.mocked(queueMutation)).not.toHaveBeenCalled();

    const second = await batchTool.execute(
      {
        operations: [
          { tool: 'add_node', args: { parent_id: 'root', tag: 'div' }, ref_id: 'a' },
          { tool: 'set_size', args: { node_id: '$ref:a', width: '240px' } },
        ],
      },
      ctx,
    );
    expect(second.isError).toBeUndefined();
    const secondData = JSON.parse((second.content[0] as any).text);
    expect(secondData.bulk).toBe('ok');
    expect(secondData.results).toHaveLength(2);
    for (const r of secondData.results) expect(r.ok).toBe(true);

    const created = mutationAt(0) as AddNodeMutation;
    expect(created.type).toBe('addNode');
    expect(mutationAt(1)).toMatchObject({ type: 'updateStyles', nodeId: created.node.id, styles: { width: '240px' } });
    expect(vi.mocked(queueMutation)).toHaveBeenCalledTimes(2);
    expect(secondData.ref_ids.a).toBe(created.node.id);
  });
});
describe('checkBatchEndGate — P6 (T1b) end-of-batch file gate', () => {
  const CLEAN = BATCH_TESTIMONIAL_PAGE;
  const MISSING_ID = BATCH_TESTIMONIAL_PAGE.replace(
    '<p data-id="testimonial-1-author" data-name="Author"',
    '<p data-name="Author"',
  );
  const NO_ROOT = BATCH_TESTIMONIAL_PAGE.replace('data-id="root"', 'data-id="main"');

  it('clean → clean: null', () => {
    expect(checkBatchEndGate(CLEAN, CLEAN, 'app/page.client.tsx')).toBeNull();
  });

  it('clean → fresh MISSING_DATA_ID: rollback reason naming the code', () => {
    expect(MISSING_ID).not.toBe(CLEAN);
    const reason = checkBatchEndGate(CLEAN, MISSING_ID, 'app/page.client.tsx');
    expect(reason).not.toBeNull();
    expect(reason!).toContain('Oracle file gate blocked batch');
    expect(reason!).toContain('[MISSING_DATA_ID]');
  });

  it('clean → fresh PAGE_ROOT_REQUIRED (I4a): rollback reason', () => {
    const reason = checkBatchEndGate(CLEAN, NO_ROOT, 'app/page.client.tsx');
    expect(reason).not.toBeNull();
    expect(reason!).toContain('[PAGE_ROOT_REQUIRED]');
  });

  it('dirty → dirty (same breakage): grandfathered, null', () => {
    expect(checkBatchEndGate(MISSING_ID, MISSING_ID, 'app/page.client.tsx')).toBeNull();
  });

  it('import-shape introduced at batch end never bounces (T3 shadow lives at flush)', () => {
    const withImport = `import _ from 'lodash';\n${CLEAN}`;
    expect(checkBatchEndGate(CLEAN, withImport, 'app/page.client.tsx')).toBeNull();
  });
});

describe('isBatchViewportRendered — P6 (M3) strict render rule', () => {
  it('ready only when every existing touched id is measured', () => {
    expect(isBatchViewportRendered(['a', 'b'], new Set(['a', 'b']), new Set(['a', 'b']))).toBe(true);
  });
  it('one measured node on a partial snapshot is pending', () => {
    expect(isBatchViewportRendered(['a', 'b'], new Set(['a', 'b']), new Set(['a']))).toBe(false);
  });
  it('deleted ids (absent from the map) need no layout', () => {
    expect(isBatchViewportRendered(['a', 'gone'], new Set(['a']), new Set(['a']))).toBe(true);
  });
  it('unknown ids (stale map) stay pending, never ready', () => {
    expect(isBatchViewportRendered(['ghost'], new Set(['a']), new Set(['a']))).toBe(false);
    expect(isBatchViewportRendered([], new Set(['a']), new Set(['a']))).toBe(false);
  });
});
