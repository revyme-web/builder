import { describe, it, expect } from 'vitest';
import { buildToolManifest, findTool } from './tool-manifest';
import { ALL_TOOLS } from './tools';

describe('tool manifest', () => {
  const manifest = buildToolManifest();

  it('serializes every registered tool', () => {
    expect(manifest).toHaveLength(ALL_TOOLS.length);
    expect(manifest.length).toBeGreaterThan(20);
  });

  it('every entry is transport-safe (survives a JSON round trip)', () => {
    const round = JSON.parse(JSON.stringify(manifest));
    expect(round).toEqual(manifest);
  });

  it('every entry carries a name, a non-empty description and an object schema', () => {
    for (const e of manifest) {
      expect(e.name).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(e.description.length).toBeGreaterThan(10);
      expect(e.inputSchema).toHaveProperty('type', 'object');
    }
  });

  it('names are unique — a duplicate would shadow a tool in the model’s view', () => {
    const names = manifest.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('findTool resolves a manifest entry back to its executable tool', () => {
    for (const e of manifest) {
      const t = findTool(e.name);
      expect(t).not.toBeNull();
      expect(typeof t!.execute).toBe('function');
    }
    expect(findTool('no_such_tool')).toBeNull();
  });

  it('exposes the write tools the agent needs, not just reads', () => {
    const names = new Set(manifest.map((e) => e.name));
    for (const required of ['set_styles', 'add_node', 'delete_node', 'batch', 'get_node_tree', 'apply_file_edit']) {
      expect(names).toContain(required);
    }
  });
});
