// src/ai/agent/tools/schema.test.ts
//
// Schema conversion: AgentTool (zod raw shape) → ProviderTool (provider-ready
// JSON Schema). Pure function tests — no providers, no network.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toProviderTool, toProviderTools, toHostToolDescriptors } from './schema';
import type { AgentTool, ProviderTool } from '@/ai/agent';

const textResult = { content: [{ type: 'text' as const, text: 'x' }] };

function makeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'echo',
    description: 'Echo a value',
    inputSchema: { value: z.string(), n: z.number() },
    category: 'semantic',
    async execute() {
      return textResult;
    },
    ...overrides,
  };
}

describe('toProviderTool', () => {
  it('converts a zod raw shape into a provider-ready object schema', () => {
    const result = toProviderTool(makeTool());
    expect(result.input_schema.type).toBe('object');
    const props = result.input_schema.properties as Record<string, { type?: string }>;
    expect(props.value.type).toBe('string');
    expect(props.n.type).toBe('number');
  });

  it('omits the $schema marker', () => {
    const result = toProviderTool(makeTool());
    expect('$schema' in result.input_schema).toBe(false);
  });

  it('reports name and description as-is', () => {
    const tool = makeTool({ name: 'rename', description: 'Renamed tool' });
    const result = toProviderTool(tool);
    expect(result.name).toBe('rename');
    expect(result.description).toBe('Renamed tool');
  });
});

describe('toHostToolDescriptors', () => {
  it('strips `type: object` from object-typed properties (host zod-v3 record() would crash the CLI zod-v4 plugin runtime), keeping description', () => {
    const tool = makeTool({
      inputSchema: {
        value: z.string(),
        styles: z.record(z.string(), z.string()),
        nested: z.object({ a: z.string() }),
      },
    });
    const [result] = toHostToolDescriptors([tool]);
    const props = result.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.value.type).toBe('string');
    expect('type' in props.styles).toBe(false);
    expect('type' in props.nested).toBe(false);
  });

  it('leaves the provider form untouched (toProviderTool keeps type: object)', () => {
    const tool = makeTool({ inputSchema: { styles: z.record(z.string(), z.string()) } });
    const provider = toProviderTool(tool);
    const props = provider.input_schema.properties as Record<string, { type?: string }>;
    expect(props.styles.type).toBe('object');
  });
});

describe('toProviderTools', () => {
  it('returns an empty array for no tools', () => {
    expect(toProviderTools([])).toEqual([]);
  });

  it('maps every tool through toProviderTool', () => {
    const tools = [makeTool({ name: 'a' }), makeTool({ name: 'b' })];
    const results: ProviderTool[] = toProviderTools(tools);
    expect(results.map((t) => t.name)).toEqual(['a', 'b']);
  });
});
