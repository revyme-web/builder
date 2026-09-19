// src/ai/agent/tools/semantic-property.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueMutation, flushNow, setActiveFilePath } from '@/code/mutation/mutation-queue';
import {
  setStylesTool,
  setTextTool,
  setRichTextTool,
  setAttrTool,
  changeTagTool,
  PROPERTY_TOOLS,
} from './semantic-property';
import type { AgentTool, ToolContext } from '@/ai/agent';
import { getPresetTokens } from '@/code/project/preset-ops';
import { setTokenTool } from './semantic-property';

vi.mock('@/code/mutation/mutation-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/mutation/mutation-queue')>();
  return {
    ...actual,
    queueMutation: vi.fn(),
    flushNow: vi.fn(),
  };
});

vi.mock('@/code/project/preset-ops', () => ({
  getPresetTokens: vi.fn(() => []),
}));

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}
describe('semantic property tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Deterministic unbranched routing scope for the assertions below.
    setActiveFilePath('app/page.client.tsx');
  });

  it('set_styles without viewport queues updateStyles', async () => {
    const ctx = makeCtx();
    const result = await setStylesTool.execute(
      { node_id: 'box', styles: { color: 'red', display: '' } },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'updateStyles',
        nodeId: 'box',
        styles: { color: 'red', display: '' },
      },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ applied: 2, viewport: null });
  });

  it('set_styles with viewport queues updateContainerStyle', async () => {
    const ctx = makeCtx();
    await setStylesTool.execute({ node_id: 'box', styles: { display: 'none' }, viewport: 768 }, ctx);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'updateContainerStyle',
        nodeId: 'box',
        maxWidth: 768,
        styles: { display: 'none' },
      },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('set_text queues updateText', async () => {
    const ctx = makeCtx();
    await setTextTool.execute({ node_id: 'title', text: 'Hello' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'updateText',
        nodeId: 'title',
        text: 'Hello',
      },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('set_rich_text queues updateChildrenHTML', async () => {
    const ctx = makeCtx();
    await setRichTextTool.execute({ node_id: 'body', html: '<p>Hi</p>' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'updateChildrenHTML',
        nodeId: 'body',
        html: '<p>Hi</p>',
      },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('set_attr queues updateHtmlAttrs with attrs passed through as-is', async () => {
    const ctx = makeCtx();
    await setAttrTool.execute({ node_id: 'img', attrs: { href: '', src: 'x' } }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'updateHtmlAttrs',
        nodeId: 'img',
        attrs: { href: '', src: 'x' },
      },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('change_tag queues changeTag', async () => {
    const ctx = makeCtx();
    await changeTagTool.execute({ node_id: 'wrap', tag: 'section' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'changeTag',
        nodeId: 'wrap',
        newTag: 'section',
      },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('PROPERTY_TOOLS exports all six tools with category semantic (P7 adds set_token)', () => {
    expect(PROPERTY_TOOLS).toHaveLength(6);
    for (const tool of PROPERTY_TOOLS) {
      expect(tool.category).toBe('semantic');
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeTruthy();
    }
    const names = PROPERTY_TOOLS.map((t: AgentTool) => t.name);
    expect(names).toEqual(['set_styles', 'set_text', 'set_rich_text', 'set_attr', 'change_tag', 'set_token']);
  });
});

describe('set_token — P7 (v) targeted token write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues updatePresetToken for a known token and returns the previous value', async () => {
    vi.mocked(getPresetTokens).mockReturnValue([{ name: 'color-brand', value: '#6366f1', category: 'color' }]);
    const result = await setTokenTool.execute({ name: 'color-brand', value: '#4f46e5' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(queueMutation).toHaveBeenCalledWith(
      { type: 'updatePresetToken', name: 'color-brand', value: '#4f46e5' },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ name: 'color-brand', value: '#4f46e5', previous: '#6366f1' });
  });

  it('refuses unknown tokens (orphans forbidden) without queueing', async () => {
    vi.mocked(getPresetTokens).mockReturnValue([{ name: 'color-brand', value: '#6366f1', category: 'color' }]);
    const result = await setTokenTool.execute({ name: 'nope', value: '#000' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text).error).toContain('Unknown token');
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('refuses empty values and accepts the -- prefix', async () => {
    vi.mocked(getPresetTokens).mockReturnValue([{ name: 'color-brand', value: '#6366f1', category: 'color' }]);
    const empty = await setTokenTool.execute({ name: 'color-brand', value: '  ' }, makeCtx());
    expect(empty.isError).toBe(true);
    const prefixed = await setTokenTool.execute({ name: '--color-brand', value: '#4f46e5' }, makeCtx());
    expect(prefixed.isError).toBeUndefined();
    expect(queueMutation).toHaveBeenCalledWith(
      { type: 'updatePresetToken', name: 'color-brand', value: '#4f46e5' },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'main' },
    );
  });
});

describe('set_token value validation (M3)', () => {
  it('refuses CSS-breakout values', async () => {
    const { setTokenTool } = await import('./semantic-property');
    vi.mocked((await import('@/code/project/preset-ops')).getPresetTokens).mockReturnValue([
      { name: 'color-brand', value: '#6366f1', category: 'color' },
    ]);
    const ctx = makeCtx();
    for (const bad of ['a; } .x{color:red', '{x}', 'a<b', 'line1\nline2']) {
      const r = await setTokenTool.execute({ name: 'color-brand', value: bad }, ctx);
      expect(r.isError, bad).toBe(true);
    }
  });
});
