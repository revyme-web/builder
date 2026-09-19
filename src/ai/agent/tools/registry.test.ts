// src/ai/agent/tools/registry.test.ts
//
// Registry helpers: category filtering, name→tool map for runtime dispatch,
// and uniqueness enforcement. All pure functions — no module state.

import { describe, it, expect } from 'vitest';
import { getToolsByCategory, buildToolMap, assertUniqueToolNames } from './registry';
import { ALL_TOOLS } from './index';
import type { AgentTool } from '@/ai/agent';

function makeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'tool',
    description: 'A tool',
    inputSchema: {},
    category: 'read',
    async execute() {
      return { content: [{ type: 'text', text: 'x' }] };
    },
    ...overrides,
  };
}

describe('getToolsByCategory', () => {
  const tools = [
    makeTool({ name: 'read-a' }),
    makeTool({ name: 'read-b' }),
    makeTool({ name: 'sem-c', category: 'semantic' }),
    makeTool({ name: 'cms-d', category: 'cms' }),
  ];

  it('returns everything when no categories are given', () => {
    expect(getToolsByCategory(tools)).toEqual(tools);
    expect(getToolsByCategory(tools, [])).toEqual(tools);
  });

  it('filters to the requested categories only', () => {
    const read = getToolsByCategory(tools, ['read']);
    expect(read.map((t) => t.name)).toEqual(['read-a', 'read-b']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(getToolsByCategory(tools, ['meta'])).toEqual([]);
  });
});

describe('buildToolMap', () => {
  it('maps two distinct tools by name', () => {
    const a = makeTool({ name: 'a' });
    const b = makeTool({ name: 'b' });
    const map = buildToolMap([a, b]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(a);
    expect(map.get('b')).toBe(b);
  });

  it('throws on duplicate tool names', () => {
    const a = makeTool({ name: 'dup' });
    const b = makeTool({ name: 'dup', category: 'semantic' });
    expect(() => buildToolMap([a, b])).toThrow('Duplicate tool name: "dup".');
  });
});

describe('assertUniqueToolNames', () => {
  it('does not throw on unique names', () => {
    expect(() =>
      assertUniqueToolNames([makeTool({ name: 'a' }), makeTool({ name: 'b' })]),
    ).not.toThrow();
  });

  it('throws on duplicate names', () => {
    expect(() =>
      assertUniqueToolNames([makeTool({ name: 'a' }), makeTool({ name: 'a' })]),
    ).toThrow(/Duplicate tool name/);
  });
});

describe('ALL_TOOLS', () => {
  it('registers the submit_plan meta tool with a plan+steps schema', () => {
    const plan = ALL_TOOLS.find((t) => t.name === 'submit_plan');
    expect(plan).toBeDefined();
    expect(plan!.category).toBe('meta');
    expect(plan!.inputSchema).toHaveProperty('plan');
    expect(plan!.inputSchema).toHaveProperty('steps');
    expect(assertUniqueToolNames(ALL_TOOLS)).toBeUndefined();
  });
});
