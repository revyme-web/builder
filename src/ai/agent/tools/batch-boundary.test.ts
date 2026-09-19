import { describe, it, expect } from 'vitest';
import { NON_BATCHABLE_TOOL_NAMES } from './action-layer-rich';
import { PROPERTY_TOOLS, STRUCTURE_TOOLS, ACTION_TOOLS, RICH_ACTION_TOOLS } from './index';

// `set_motion_preset` inside a batch reported "Unknown tool" — the name was
// right, the placement was wrong. The model then hunted for a tool that
// existed all along, wasting a round trip and rolling back the batch.
describe('the batch boundary', () => {
  it('lists exactly the rich tools as non-batchable', () => {
    expect([...NON_BATCHABLE_TOOL_NAMES].sort()).toEqual(RICH_ACTION_TOOLS.map((t) => t.name).sort());
  });

  it('names the tools that actually tripped this', () => {
    expect(NON_BATCHABLE_TOOL_NAMES).toContain('set_motion_preset');
    expect(NON_BATCHABLE_TOOL_NAMES).toContain('set_variant');
    expect(NON_BATCHABLE_TOOL_NAMES).toContain('create_component');
  });

  it('never overlaps the batchable set — a tool is one or the other', () => {
    const batchable = new Set([...PROPERTY_TOOLS, ...STRUCTURE_TOOLS, ...ACTION_TOOLS].map((t) => t.name));
    for (const name of NON_BATCHABLE_TOOL_NAMES) expect(batchable.has(name)).toBe(false);
  });

  it('is derived from the registry, so a new rich tool is covered automatically', () => {
    // Not a hand-written list: adding a tool to RICH_ACTION_TOOLS must extend
    // this without anyone remembering to update a second copy.
    expect(NON_BATCHABLE_TOOL_NAMES.length).toBe(RICH_ACTION_TOOLS.length);
    expect(NON_BATCHABLE_TOOL_NAMES.length).toBeGreaterThan(5);
  });
});
