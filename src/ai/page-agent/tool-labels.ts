// tool-labels.ts — friendly, user-facing status text for page-agent tools.
//
// The agent loop reports raw tool names (`get_node_tree`,
// `update_node_styles`, …). The chat used to show "Turn 3:
// update_node_styles" — this maps each tool to a human "-ing…" phrase
// so the user sees what's happening, not the plumbing.

const TOOL_LABELS: Record<string, string> = {
  // ─── Read / inspect ───
  get_node_tree: 'Reading the page',
  find_nodes: 'Looking around',
  get_node_styles: 'Inspecting styles',
  list_files: 'Browsing files',
  read_file: 'Reading the code',
  get_design_tokens: 'Checking the design system',
  // ─── Animation ───
  add_appear: 'Adding an animation',
  remove_appear: 'Removing an animation',
  add_hover: 'Wiring up hover',
  remove_hover: 'Removing hover',
  add_loop: 'Adding a loop',
  remove_loop: 'Removing a loop',
  // ─── Mutations ───
  update_node_styles: 'Updating styles',
  update_node_text: 'Rewriting text',
  add_node: 'Adding an element',
  remove_node: 'Removing an element',
  move_node: 'Moving things around',
  reorder_node: 'Reordering',
  rename_node: 'Renaming',
  update_html_attrs: 'Updating attributes',
  change_tag: 'Changing the element type',
  add_preset_token: 'Extracting a preset',
  update_preset_token: 'Updating presets',
  edit_file: 'Editing the code',
};

/** Friendly "-ing…" status for a single tool. Unmapped / future tools
 *  fall back to a generic playful phrase rather than leaking the name. */
function toolLabel(toolName: string): string {
  return `${TOOL_LABELS[toolName] ?? 'Cooking'}…`;
}

/** Friendly status for a turn's batch of tool calls. Picks the LAST
 *  tool — in a multi-tool turn the agent typically reads first then
 *  mutates, so the final call is the most interesting thing it did. */
export function turnLabel(toolNames: string[]): string {
  if (toolNames.length === 0) return 'Thinking…';
  return toolLabel(toolNames[toolNames.length - 1]!);
}
