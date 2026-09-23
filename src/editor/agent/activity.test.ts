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

// The one agent works in the CMS too. `cms_` in front of the verb defeats the
// prefix rule, so unlisted these all read "Edited 1 layer".
describe('CMS and manual calls', () => {
  test('a collection build reads as what was built, with the bulk tool counted per item', () => {
    const steps = foldActivity([
      t('cms_create_collection'),
      t('cms_add_field'), t('cms_add_field'), t('cms_add_field'),
      { ...t('cms_add_items'), count: 8 },
    ]);
    const label = steps.map((s) => s.label).join(' | ');
    expect(label).toContain('8 items');
    expect(label).toContain('3 fields');
    expect(label).toContain('1 collection');
    expect(label).not.toMatch(/layer/);
  });

  test('loading a manual is a read, never a change to the document', () => {
    const [step] = foldActivity([t('load_manual')]);
    expect(step.kind).toBe('read');
  });

  test('works through the MCP-qualified name the CLI engine reports', () => {
    const [step] = foldActivity([t('mcp__revyme__cms_add_field')]);
    expect(step.label).toMatch(/field/);
  });
});

describe('the capability-audit tool families read as what they changed', () => {
  test('every new tool has an explicit phrasing — none falls back to "edited a layer"', () => {
    const tools = [
      'show_variant', 'add_connection', 'remove_connection', 'rename_variant', 'remove_variant',
      'create_token', 'remove_token', 'set_dark_token', 'set_typography_preset', 'apply_typography_preset', 'set_font',
      'set_list_config', 'set_pagination', 'link_rows_to_pages', 'create_collection_pages', 'unbind_cms_field', 'bind_cms_prop',
      'cms_reorder_items', 'cms_reorder_fields', 'cms_duplicate_collection',
      'delete_page', 'rename_page', 'duplicate_page', 'set_page_metadata', 'set_site_metadata',
      'set_motion', 'remove_motion', 'set_text_effect',
      'set_locales', 'translate_texts', 'add_language_switcher', 'add_built_in_component',
      'set_variant_visibility', 'detach_instance', 'add_component_prop', 'set_text_on_breakpoint', 'set_pseudo_style', 'translate_attribute',
      'add_list_search', 'add_form_field', 'add_submit_button', 'set_background_video', 'set_form_destination',
      'set_smooth_scroll', 'set_page_transition', 'set_cursor', 'set_glide', 'create_template', 'assign_template',
      'add_viewport', 'set_viewport_width', 'remove_viewport', 'reset_overrides', 'change_list_source',
      'add_shape', 'add_icon', 'create_icon_set', 'insert_section', 'upload_image', 'write_override', 'set_code_overrides', 'bind_variable',
      'connect_slot', 'write_plugin', 'set_text_fit', 'create_branch', 'switch_branch', 'apply_branch', 'delete_branch',
    ];
    for (const name of tools) {
      const [step] = foldActivity([t(name)]);
      expect(step.kind, name).toBe('write');
      expect(step.label, name).not.toMatch(/layer/);
    }
  });

  test('the publish check is a review, like the design audit', () => {
    expect(foldActivity([t('check_project')])[0].kind).toBe('review');
  });

  test('reads stay reads: motion, texts, built-ins', () => {
    for (const name of ['get_motion', 'list_texts', 'list_built_in_components', 'list_viewports', 'search_icons', 'find_assets', 'list_sections', 'list_overrides', 'list_templates', 'component_example', 'list_branches', 'get_slots', 'list_plugins', 'get_dialect']) {
      expect(foldActivity([t(name)])[0].kind, name).toBe('read');
    }
  });

  test('a localisation pass reads as languages + translations, a variant pass as variants + transitions', () => {
    const i18n = foldActivity([t('set_locales'), t('translate_texts'), t('translate_texts'), t('add_language_switcher')]);
    const l = i18n.map((s) => s.label).join(' | ');
    expect(l).toMatch(/language/);
    expect(l).toMatch(/2 translations/);
    expect(l).toMatch(/language switcher/);
    const variants = foldActivity([t('create_variant'), t('add_connection'), t('add_connection'), t('show_variant')]);
    const v = variants.map((s) => s.label).join(' | ');
    expect(v).toMatch(/variant/);
    expect(v).toMatch(/2 transitions/);
  });

  test('sizing / grid / transform act on layers and keep the layer noun', () => {
    for (const name of ['set_size_units', 'set_grid', 'set_transform', 'wrap_in_layout', 'reorder_on_breakpoint']) {
      expect(foldActivity([t(name)])[0].label, name).toMatch(/layer/);
    }
  });
});
