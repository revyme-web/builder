import { describe, test, expect } from 'vitest';
import { foldActivity, normalizeToolName, countFor, type ActivityToolInput } from './activity';

const t = (name: string, over: Partial<ActivityToolInput> = {}): ActivityToolInput =>
  ({ id: Math.random().toString(36), name, ok: true, ...over });

describe('foldActivity', () => {
  test('collapses a run of reads into ONE line', () => {
    const steps = foldActivity([
      t('read_source'), t('read_source'), t('get_active_file'),
      t('get_node'), t('get_layout'), t('get_visuals'),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('read');
    expect(steps[0].calls).toBe(6);
  });

  // Looking at the page and reviewing an edit are different acts, so they must
  // not fold into one another and blur what the agent was doing.
  test('reads and reviews stay separate lines', () => {
    const steps = foldActivity([t('read_source'), t('audit_design'), t('read_source')]);
    expect(steps.map((s) => s.kind)).toEqual(['read', 'review', 'read']);
  });

  test('tallies writes by verb, stating the unit ONCE', () => {
    const steps = foldActivity([
      t('add_node'), t('add_node'), t('add_node'), t('set_styles'),
    ]);
    expect(steps).toHaveLength(1);
    // Not "edited 1 layer" — the unit has not changed between clauses.
    expect(steps[0].label).toBe('Added 3 layers, edited 1');
  });

  test('a clause measuring something ELSE keeps its own unit', () => {
    const steps = foldActivity([t('add_node'), t('create_variant')]);
    expect(steps[0].label).toBe('Added 1 layer, added 1 variant');
  });

  test('a busy step elides past three clauses rather than sprawling', () => {
    const steps = foldActivity([
      t('add_node'), t('set_styles'), t('move_node'), t('delete_node'),
    ]);
    expect(steps[0].label).toMatch(/\u2026$/);
    expect(steps[0].label.split(',')).toHaveLength(4);   // 3 clauses + the ellipsis
  });

  test('audit and verify read as a review, not as looking around', () => {
    const steps = foldActivity([t('audit_design'), t('verify_effect')]);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('review');
    expect(steps[0].label).toBe('Reviewed changes');
  });

  test('a batch counts its ops, not itself', () => {
    // One "Running batch" row standing in for 15 real changes is the bug.
    const steps = foldActivity([t('batch', { count: countFor({ ops: new Array(15).fill({}) }) })]);
    expect(steps[0].label).toContain('15');
  });

  test('a failed write is never counted as a change', () => {
    const steps = foldActivity([
      t('add_node', { ok: false, detail: 'Revyme wouldn’t accept that code' }),
      t('add_node'),
    ]);
    expect(steps[0].label).toBe('Added 1 layer');
    expect(steps[0].failures).toEqual(['Revyme wouldn’t accept that code']);
  });

  test('a write group that entirely failed still reports itself', () => {
    const steps = foldActivity([
      t('apply_file_edit', { ok: false, detail: 'The file had changed' }),
    ]);
    expect(steps[0].label).toBe('Adjusted an edit');
  });

  test('read → write → read reads as three steps, in order', () => {
    const steps = foldActivity([
      t('get_node_tree'), t('add_node'), t('add_node'), t('get_layout'),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['read', 'write', 'read']);
    expect(steps[1].label).toBe('Added 2 layers');
  });

  test('every screenshot stands alone and keeps its image', () => {
    const steps = foldActivity([
      t('get_screenshot', { image: 'data:a' }),
      t('get_screenshot', { image: 'data:b' }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0].images).toEqual(['data:a']);
    expect(steps[1].images).toEqual(['data:b']);
  });

  test('a still-running last call marks the step live', () => {
    const steps = foldActivity([t('add_node'), t('add_node', { ok: null })]);
    expect(steps[0].running).toBe(true);
  });

  test('reads name their dominant subject', () => {
    expect(foldActivity([t('list_components'), t('get_component'), t('get_component')])[0].label)
      .toBe('Inspected 3 components');
    expect(foldActivity([t('get_node_tree')])[0].label).toBe('Inspected the page');
  });

  test('duration accumulates across the folded calls', () => {
    const steps = foldActivity([t('add_node', { ms: 400 }), t('add_node', { ms: 600 })]);
    expect(steps[0].ms).toBe(1000);
  });
});

describe('foldActivity — sub-steps', () => {
  test('a folded step carries each call, phrased on its own', () => {
    const steps = foldActivity([
      t('add_node', { ms: 900 }), t('set_styles', { ms: 600 }), t('move_node'),
    ]);
    expect(steps[0].substeps.map((x) => x.label)).toEqual([
      'Added 1 layer', 'Edited 1 layer', 'Moved 1 layer',
    ]);
    expect(steps[0].substeps[0].ms).toBe(900);
  });

  // A step of one would expand into a copy of itself, so it must not offer to.
  test('a single-call step carries NO sub-steps', () => {
    expect(foldActivity([t('add_node')])[0].substeps).toEqual([]);
  });

  test('a call carries the reasoning that preceded it', () => {
    const steps = foldActivity([
      t('add_node', { note: 'IconNode cannot take onTap, so wrap it.' }),
      t('set_styles'),
    ]);
    expect(steps[0].substeps[0].note).toBe('IconNode cannot take onTap, so wrap it.');
    expect(steps[0].substeps[1].note).toBeUndefined();
  });

  test('a failed call says so in the expansion', () => {
    const steps = foldActivity([t('apply_file_edit', { ok: false }), t('apply_file_edit')]);
    expect(steps[0].substeps[0].label).toBe('Adjusted an edit');
    expect(steps[0].substeps[0].ok).toBe(false);
  });
});

describe('countFor', () => {
  test('finds the bulk array under whichever key the tool used', () => {
    expect(countFor({ ops: [1, 2, 3] })).toBe(3);
    expect(countFor({ edits: [1, 2] })).toBe(2);
    expect(countFor({ node_id: 'x' })).toBe(1);
    expect(countFor(undefined)).toBe(1);
    expect(countFor({ ops: [] })).toBe(1);
  });
});

describe('normalizeToolName', () => {
  // The transport's name for itself is not a fact about the user's website.
  test('strips the MCP wrapper so raw names never reach the UI', () => {
    expect(normalizeToolName('mcp__revyme__revyme_edit_file')).toBe('edit_file');
    expect(normalizeToolName('mcp__revyme__revyme_submit_files')).toBe('submit_files');
    expect(normalizeToolName('add_node')).toBe('add_node');
  });

  test('MCP writes are classified as writes, not unknown rows', () => {
    const steps = foldActivity([
      t('mcp__revyme__revyme_edit_file'), t('mcp__revyme__revyme_edit_file'),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('write');
    expect(steps[0].label).toBe('Edited 2 layers');
  });

  test('MCP reads fold in with native reads', () => {
    const steps = foldActivity([t('read_source'), t('mcp__revyme__revyme_read_file')]);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('read');
  });
});
