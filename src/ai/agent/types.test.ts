// src/ai/agent/types.test.ts — wiring smoke test.
//
// Proves the module is usable as a standalone unit: the barrel + relative
// imports resolve, the frozen interfaces are structurally sound, and the
// zod schema → provider JSON Schema pipeline is viable. Deliberately imports
// NO Revyme modules (no projectFS, no jotai) — this test is isolated to the
// agent module.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type {
  AgentProvider,
  AgentTool,
  AgentToolResult,
  AgentMessage,
  ProviderEvent,
  ProviderTool,
  RunAgentOptions,
  ToolContext,
} from '@/ai/agent';
import type { AgentEditorContext } from './types';

const mockProviderTool: ProviderTool = {
  name: 'echo',
  description: 'Echo a value',
  input_schema: { type: 'object', properties: { value: { type: 'string' } } },
};

const streamOptions = {
  model: 'claude-3-7-sonnet',
  system: 'You are a builder agent.',
  messages: [],
  tools: [mockProviderTool],
  signal: new AbortController().signal,
};

const mockProvider: AgentProvider = {
  id: 'anthropic',
  async *streamMessage(): AsyncIterable<ProviderEvent> {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'message_stop', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } };
  },
};

const toolSchema = z.object({ value: z.string() });

const mockTool: AgentTool = {
  name: 'echo',
  description: 'Echo a value',
  inputSchema: { value: z.string() },
  category: 'semantic',
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<AgentToolResult> {
    ctx.ensureCheckpoint();
    const parsed = toolSchema.parse(args);
    return { content: [{ type: 'text', text: `echoed: ${parsed.value}` }] };
  },
};

const mockToolContext: ToolContext = {
  ensureCheckpoint: () => {},
  vpWidth: 1440,
  signal: new AbortController().signal,
};

const mockMessage: AgentMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'Change the hero color.' }],
};

const mockEditorContext: AgentEditorContext = {
  activeFilePath: 'components/TestCard.tsx',
  selectedNodeIds: ['node-1'],
  activeViewportWidth: 1440,
  mentions: [],
  images: [],
};

const runOptions: RunAgentOptions = {
  provider: mockProvider,
  model: 'claude-3-7-sonnet',
  system: 'You are a builder agent.',
  messages: [mockMessage],
  tools: [mockTool],
  vpWidth: 1440,
  signal: new AbortController().signal,
};

describe('agent module wiring', () => {
  it('streams text_delta then message_stop from a provider', async () => {
    const events: ProviderEvent[] = [];
    for await (const ev of mockProvider.streamMessage(streamOptions)) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: 'text_delta', text: 'hello' });
    expect(events[1]).toEqual({
      type: 'message_stop',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('executes a tool with zod-validated args into a non-error result', async () => {
    const args = { value: 'hello' };
    const parsed = toolSchema.parse(args);
    expect(parsed).toEqual(args);

    const result = await mockTool.execute(args, mockToolContext);
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toBe('echoed: hello');
  });

  it('converts a tool inputSchema to a provider-ready JSON Schema', () => {
    const jsonSchema = z.toJSONSchema(z.object(mockTool.inputSchema));
    expect('properties' in jsonSchema).toBe(true);
  });

  it('constructs a full RunAgentOptions conforming to the interface', () => {
    expect(runOptions.model).toBe('claude-3-7-sonnet');
    expect(runOptions.tools).toContain(mockTool);
    expect(runOptions.system).toBe('You are a builder agent.');
    expect(runOptions.vpWidth).toBe(1440);
  });
});
