// src/ai/agent/prompts/tool-labels.ts
//
// Short human labels for agent tools, used by the UI to describe an in-flight
// tool call (RuntimeEvent 'tool_call' carries `label`). Unknown tool names
// fall back to a humanized form of the raw name.

export const TOOL_LABELS: Record<string, string> = {
  set_styles: 'Updating styles',
  set_layout: 'Setting layout',
  set_size: 'Setting size',
  set_position: 'Setting position',
  set_typography: 'Setting typography',
  set_text: 'Updating text',
  set_rich_text: 'Updating rich text',
  set_attr: 'Updating attributes',
  change_tag: 'Changing tag',
  add_node: 'Adding element',
  add_canvas_node: 'Adding canvas element',
  delete_node: 'Deleting element',
  move_node: 'Moving element',
  reorder_node: 'Reordering element',
  duplicate_node: 'Duplicating element',
  apply_file_edit: 'Rewriting file',
  batch: 'Running batch',
  get_node_tree: 'Reading page',
  get_selection: 'Reading selection',
  get_node: 'Reading element',
  get_layout: 'Measuring layout',
  get_visuals: 'Reading rendered styles',
  audit_design: 'Auditing design',
  verify_effect: 'Verifying request effect',
  get_composition: 'Analyzing composition',
  list_pages: 'Listing pages',
  list_components: 'Listing components',
  get_component: 'Reading component',
  add_component_instance: 'Adding component instance',
  set_component_prop: 'Setting component prop',
  get_design_tokens: 'Reading design tokens',
  set_token: 'Setting design token',
  read_source: 'Reading source',
  turn_diff: 'Reading turn diff',
  list_collections: 'Listing collections',
  get_active_file: 'Reading active file',
  get_viewport_width: 'Reading viewport',
  submit_plan: 'Sharing plan',
  submit_design_intent: 'Setting design intent',
  set_motion_preset: 'Adding motion preset',
  set_page_variable: 'Declaring page variable',
  set_page_interaction: 'Wiring page interaction',
  create_overlay: 'Creating overlay',
  set_variant: 'Setting variant',
  create_variant: 'Creating variant',
  extract_component: 'Extracting component',
  create_component: 'Creating component',
  chain: 'Running chain',
  bind_cms_list: 'Binding collection list',
  bind_cms_field: 'Binding field',
  set_form: 'Mapping form states',
  create_page: 'Creating page',
  set_page: 'Switching page',
  get_screenshot: 'Capturing screenshot',
};

function humanize(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? humanize(name);
}
